import { Optional } from '@nestjs/common';
import { BranchRegistries } from './branch-registries.js';
import { currentBranch, workspaceMode } from '../../workspace/context.js';
import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpException, NotFoundException, Param, Post, Put, Res, UseGuards } from '@nestjs/common';
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { AuthGuard } from '../../auth/auth.guard.js';
import { AdminGuard } from '../../auth/admin.guard.js';
import { Grants, PluginError, PluginRegistry } from './registry.js';
import { installArchive, loadInstalledPlugin, removeInstalledPlugin } from './archive.js';
import { defaultPluginsDir, refreshPluginCatalogue } from './loader.js';
import { ProfileService } from '../../profile/profile.service.js';
import { pluginChanges } from './pending-diff.js';

const STATUS: Record<string, number> = { 'unknown-plugin': 404, 'grant-required': 403, 'base-required': 409, 'in-use': 409, 'not-installed': 409, 'missing-dependency': 409, 'invalid-settings': 400, 'invalid-manifest': 400, 'migration-changed': 409, 'base-config-invalid': 409, 'plugin-failed': 503, 'invalid-archive': 400, 'already-exists': 409, 'signature-invalid': 400 };
function wrap<T>(f: () => Promise<T> | T): Promise<T> {
  return Promise.resolve().then(f).catch((e) => {
    if (e instanceof PluginError) throw new HttpException({ code: e.code, message: e.message }, STATUS[e.code] ?? 400);
    throw e;
  });
}
/** Only the grants the console form can express; anything else in the body is ignored. */
function grants(b: unknown): Grants {
  const o = (b && typeof b === 'object' ? (b as { grants?: Grants }).grants : undefined) ?? {};
  return { install: o.install === true, uiComponents: o.uiComponents === true, hooks: Array.isArray(o.hooks) ? o.hooks.filter((h): h is string => typeof h === 'string') : [] };
}

/**
 * Admin console API for plugins, one tenant at a time (token tenant must equal :tenant).
 * Reading the list, the screens and the settings forms needs a sign-in. Changing anything (install, settings, enable, disable) also needs
 * the admin capability, because enabling is where sensitive hooks, SQL migrations and component screens are granted.
 */
@UseGuards(AuthGuard)
@Controller('tenants/:tenant/plugins')
export class PluginsAdminController {
  constructor(private readonly reg: PluginRegistry, @Optional() private readonly branches: BranchRegistries, @Optional() private readonly profile?: ProfileService) {}
  private async registry(write=false) { return workspaceMode() ? this.branches.get(currentBranch(write)) : this.reg; }

  @Get() async list(@Param('tenant') t: string) { return { tenant: t, plugins: (await this.registry()).list(t) }; }
  @Get('screens') async screens(@Param('tenant') t: string) { return { tenant: t, screens: (await this.registry()).screens(t) }; }
  @Get('menu') async menu(@Param('tenant') t: string) { return { tenant: t, entries: (await this.registry()).menu(t) }; }
  /** Plugins modified on the current workspace branch but not yet on main; the console shows them in the
   * pending panel and badges their gallery cards. Empty outside workspace mode or on main. */
  @Get('pending') async pending(@Param('tenant') t: string) {
    if (!workspaceMode()) return { workspace: false, branch: 'main', pending: [] };
    const branch = currentBranch();
    if (branch === 'main') return { workspace: true, branch, pending: [] };
    const [work, main] = await Promise.all([this.branches.get(branch), this.branches.get('main')]);
    const [workList, mainList] = [work.list(t), main.list(t)];
    const ids = [...new Set([...workList, ...mainList].map((p) => p.id))];
    const cfg = async (reg: typeof work) => Object.fromEntries(await Promise.all(ids.map(async (id) => {
      try { const c = await reg.exportConfig(t, id); return [id, Object.fromEntries(Object.entries(c.settings).map(([k, v]) => [k, String(v)]))] as const; } catch { return [id, {}] as const; }
    })));
    const [ws, ms] = await Promise.all([cfg(work), cfg(main)]);
    return { workspace: true, branch, pending: pluginChanges(workList, mainList, ws, ms) };
  }

  @Get(':id/form') form(@Param('tenant') t: string, @Param('id') id: string) { return wrap(async () => (await this.registry()).form(t, id)); }
  /** How much profile data a plugin holds for this tenant; the console shows it in the uninstall confirmation.
   * Lives here, not on ProfileController: the plugin HTTP catch-all (@All(':id/{*path}')) is registered before it. */
  @UseGuards(AdminGuard) @Get(':id/profile-values') async pluginValues(@Param('tenant') t: string, @Param('id') id: string) {
    return { plugin: id, values: this.profile ? await this.profile.pluginValueCount(t, id) : 0 };
  }

  /** The plugin's stored values as a CSV attachment: the uninstall confirmation exports everything before
   * the data disappears, without one HTTP call per user. Values are CSV-escaped and quoted, never raw. */
  @UseGuards(AdminGuard) @Get(':id/export') async exportCsv(@Param('tenant') t: string, @Param('id') id: string, @Res() res: { setHeader: (k: string, v: string) => void; type: (c: string) => { send: (b: unknown) => void } }) {
    const rows = this.profile ? await this.profile.pluginValues(t, id) : [];
    const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['subject,field,value', ...rows.map((r) => [cell(r.subject), cell(r.field), cell(r.value)].join(','))].join('\n') + '\n';
    res.setHeader('Content-Disposition', `attachment; filename="${id}-values.csv"`);
    res.type('text/csv; charset=utf-8').send(csv);
  }

  /** Packaged component screens (constat 4): the console import()s a screen's .mjs straight from the plugin's
   * signed folder, so a screen's code ships with the plugin and disappears with it. Sign-in only (like the
   * screens inventory); the plugin must be active for the tenant and the file must be a screen component the
   * manifest declares, never an arbitrary package file (the server-side handlers stay private). */
  @Get(':id/assets/{*path}')
  async screenAsset(@Param('tenant') t: string, @Param('id') id: string, @Param('path') path: string[] | string, @Res() res: { type: (c: string) => { send: (b: unknown) => void } }) {
    const tail = (Array.isArray(path) ? path.join('/') : (path ?? '')).replace(/^\/+/, '');
    const reg = await this.registry();
    const impl = reg.impl(id);
    if (!impl) throw new NotFoundException(`unknown plugin ${id}`);
    if (!reg.isActive(t, id)) throw new ForbiddenException(`plugin ${id} is not enabled on this branch`);
    const isScreen = impl.manifest.screens?.some((sc) => sc.render === 'component' && sc.component === tail);
    const isProfileComponent = impl.manifest.profileComponents?.some((pc) => pc.component === tail);
    if (!isScreen && !isProfileComponent) throw new NotFoundException(`${tail} is not a declared component of plugin ${id}`);
    const base = resolve(defaultPluginsDir(), id);
    const file = resolve(base, tail);
    if (!file.startsWith(base + sep)) throw new BadRequestException('assets stay inside the plugin folder');
    try { if (!statSync(file).isFile()) throw 0; } catch { throw new NotFoundException(`no asset ${tail}`); }
    res.type('text/javascript; charset=utf-8').send(readFileSync(file));
  }

  @UseGuards(AdminGuard) @Post(':id/install')
  install(@Param('tenant') t: string, @Param('id') id: string, @Body() b: unknown) { return wrap(async () => { await (await this.registry(true)).install(t, id, grants(b)); const adopted = this.profile ? await this.profile.adoptPlugin(t, id) : 0; return { installed: id, ...(adopted ? { adoptedValues: adopted } : {}) }; }); }

  @UseGuards(AdminGuard) @Put(':id/settings')
  settings(@Param('tenant') t: string, @Param('id') id: string, @Body() b: { values?: Record<string, unknown> }) {
    if (!b?.values || typeof b.values !== 'object' || Array.isArray(b.values)) throw new BadRequestException('values object required');
    return wrap(async () => { await (await this.registry(true)).configure(t, id, b.values!); return { configured: id }; });
  }

  @UseGuards(AdminGuard) @Post(':id/enable')
  enable(@Param('tenant') t: string, @Param('id') id: string, @Body() b: unknown) { return wrap(async () => { await (await this.registry(true)).enable(t, id, grants(b)); const adopted = this.profile ? await this.profile.adoptPlugin(t, id) : 0; return { enabled: id, ...(adopted ? { adoptedValues: adopted } : {}) }; }); }

  /** Plan step 8: imports a signed plugin archive (zip from scripts/plugin-pack.mjs --zip, base64 in { archive }).
   * The package is validated, verified against the trust store (Ed25519, decision 3), written into the plugins
   * folder and registered into the running registries. Per-tenant install/enable stays a separate granted step. */
  @UseGuards(AdminGuard) @Post('import-archive')
  importArchive(@Param('tenant') t: string, @Body() b: { archive?: unknown }) {
    if (typeof b?.archive !== 'string' || !b.archive) throw new BadRequestException('archive: base64 zip from scripts/plugin-pack.mjs --zip');
    let buf: Buffer;
    try { buf = Buffer.from(b.archive, 'base64'); } catch { throw new BadRequestException('archive is not valid base64'); }
    if (!buf.length) throw new BadRequestException('archive is empty');
    return wrap(async () => {
      const dir = defaultPluginsDir();
      const manifest = installArchive(dir, buf);
      // Atomic install (P0-7): if loading or registering the module fails, the installed folder is rolled back -
      // an invalid module never leaves a final folder behind.
      try {
        const impl = loadInstalledPlugin(dir, manifest.id);
        if (!this.reg.impl(manifest.id)) this.reg.register(impl);
        this.branches?.registerEverywhere(impl);
      } catch (e) {
        removeInstalledPlugin(dir, manifest.id);
        throw e;
      }
      // Invalidate the shared catalogue (P1): the new package is visible to every consumer (auth methods,
      // menus, future branch registries) without a restart.
      refreshPluginCatalogue();
      return { imported: manifest.id, version: manifest.version, tenant: t, note: 'Registered in the running registries and the shared catalogue refreshed: new branch registries and the auth-method catalogue see it without a restart. Per-tenant install/enable stays a separate granted step.' };
    });
  }

  /** Manual refresh of the shared plugin catalogue (P1, Emmanuel's refresh button backend): re-scans and
   * re-verifies every package. Plugin-affecting actions (archive import, uninstall) already invalidate the
   * catalogue; this endpoint is the admin's explicit path, used by the console's refresh button. */
  @UseGuards(AdminGuard) @Post('refresh')
  refresh(@Param('tenant') t: string) { return wrap(async () => { refreshPluginCatalogue(); this.reg.invalidateInventories(); this.branches?.invalidateInventoriesEverywhere(); return { refreshed: true, tenant: t }; }); }

  @UseGuards(AdminGuard) @Post(':id/disable')
  disable(@Param('tenant') t: string, @Param('id') id: string) { return wrap(async () => { await (await this.registry(true)).disable(t, id); return { disabled: id }; }); }

  /** Plan D: destructive uninstall. The plugin must be disabled first; the tenant's rows go, and the down migrations
   * drop the owned tables when no other tenant still has it installed. Refuses when an applied migration lacks an inverse.
   * The profile configuration the plugin leaves behind (field settings, component overrides) is purged with it. */
  @UseGuards(AdminGuard) @Post(':id/uninstall')
  uninstall(@Param('tenant') t: string, @Param('id') id: string) {
    return wrap(async () => {
      await (await this.registry(true)).uninstall(t, id);
      const purge = this.profile ? await this.profile.purgePlugin(t, id) : undefined;
      return { uninstalled: id, profileConfig: purge };
    });
  }
}
