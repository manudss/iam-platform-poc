import { All, Controller, HttpException, NotFoundException, Optional, Param, Req, Res } from '@nestjs/common';
import { PluginError, PluginRegistry } from './registry.js';
import { BranchRegistries } from './branch-registries.js';
import { validateSettings } from './settings.js';
import { PluginContext } from './hooks.js';
import { currentBranch, workspaceMode } from '../../workspace/context.js';
import { AuthGuard } from '../../auth/auth.guard.js';
import { AdminGuard } from '../../auth/admin.guard.js';

const STATUS: Record<string, number> = { 'unknown-plugin': 404, 'grant-required': 403, 'base-required': 409, 'in-use': 409, 'not-installed': 409, 'missing-dependency': 409, 'invalid-settings': 400, 'invalid-manifest': 400, 'migration-changed': 409, 'base-config-invalid': 409, 'plugin-failed': 503 };

/**
 * Serves the `httpRoutes` the active plugins declare, mounted under /tenants/:tenant/plugins/:id/ (step 3).
 * Auth comes from the route declaration: `user` (a signed-in member of the tenant, the default), `admin`
 * (the admin capability too) or `public` (sign-in pages and protocol endpoints only, a manifest v3 grant).
 * Admin-console routes (:id/form, :id/install, ...) are registered by PluginsAdminController first and win.
 */
@Controller('tenants/:tenant/plugins')
export class PluginHttpController {
  constructor(private readonly reg: PluginRegistry, @Optional() private readonly branches: BranchRegistries, private readonly auth: AuthGuard, private readonly admin: AdminGuard) {}
  private async registry() { return workspaceMode() ? this.branches.get(currentBranch(false)) : this.reg; }

  @All(':id/{*path}')
  async dispatch(@Param('tenant') tenant: string, @Param('id') id: string, @Param('path') path: string[] | string, @Req() req: { method: string; query: Record<string, unknown>; body: unknown; user?: unknown; headers: Record<string, unknown> }, @Res() res: { status: (n: number) => { json: (b: unknown) => void }; json: (b: unknown) => void }) {
    const tail = Array.isArray(path) ? path.join('/') : (path ?? '');
    const reg = await this.registry();
    let match;
    try { match = reg.httpRoute(tenant, id, req.method, tail); } catch (e) {
      if (e instanceof PluginError) throw new HttpException({ code: e.code, message: e.message }, STATUS[e.code] ?? 400);
      throw e;
    }
    if (!match) throw new NotFoundException(`no route ${req.method} /plugins/${id}/${tail}`);
    const guardCtx = { switchToHttp: () => ({ getRequest: () => req }) } as never;
    if (match.auth !== 'public') {
      await this.auth.canActivate(guardCtx);
      if (match.auth === 'admin') this.admin.canActivate(guardCtx);
    }
    const settings = validateSettings(match.impl.manifest.settings, (await reg.settingsFor(tenant, id)) ?? {}).values;
    const ctx: PluginContext = { tenant, settings };
    try {
      const out = await match.handler({ method: req.method, params: match.params, query: req.query, body: req.body, user: req.user }, ctx);
      if (out && typeof out === 'object' && ('status' in out || 'body' in out)) res.status((out as { status?: number }).status ?? 200).json((out as { body?: unknown }).body ?? null);
      else res.status(200).json(out ?? {});
    } catch (e) {
      if (e instanceof PluginError) throw new HttpException({ code: e.code, message: e.message }, STATUS[e.code] ?? 400);
      throw e;
    }
  }
}
