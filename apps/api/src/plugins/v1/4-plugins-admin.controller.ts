import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpException, Param, Post, Put, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../auth/auth.guard.js';
import { AdminGuard } from '../../auth/admin.guard.js';
import { Grants, PluginError, PluginRegistry } from './registry.js';

const STATUS: Record<string, number> = { 'unknown-plugin': 404, 'grant-required': 403, 'base-required': 409, 'in-use': 409, 'not-installed': 409, 'missing-dependency': 409, 'invalid-settings': 400, 'invalid-manifest': 400, 'migration-changed': 409 };
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
  constructor(private readonly reg: PluginRegistry) {}

  @Get() list(@Param('tenant') t: string) { return { tenant: t, plugins: this.reg.list(t) }; }
  @Get('screens') screens(@Param('tenant') t: string) { return { tenant: t, screens: this.reg.screens(t) }; }
  @Get(':id/form') form(@Param('tenant') t: string, @Param('id') id: string) { return wrap(() => this.reg.form(t, id)); }

  @UseGuards(AdminGuard) @Post(':id/install')
  install(@Param('tenant') t: string, @Param('id') id: string, @Body() b: unknown) { return wrap(async () => { await this.reg.install(t, id, grants(b)); return { installed: id }; }); }

  @UseGuards(AdminGuard) @Put(':id/settings')
  settings(@Param('tenant') t: string, @Param('id') id: string, @Body() b: { values?: Record<string, unknown> }) {
    if (!b?.values || typeof b.values !== 'object' || Array.isArray(b.values)) throw new BadRequestException('values object required');
    return wrap(async () => { await this.reg.configure(t, id, b.values!); return { configured: id }; });
  }

  @UseGuards(AdminGuard) @Post(':id/enable')
  enable(@Param('tenant') t: string, @Param('id') id: string, @Body() b: unknown) { return wrap(async () => { await this.reg.enable(t, id, grants(b)); return { enabled: id }; }); }

  @UseGuards(AdminGuard) @Post(':id/disable')
  disable(@Param('tenant') t: string, @Param('id') id: string) { return wrap(async () => { await this.reg.disable(t, id); return { disabled: id }; }); }
}
