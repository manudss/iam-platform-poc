import { Optional } from '@nestjs/common';
import { VersioningService } from '../versioning/versioning.service.js';
import { OrgService } from './orgs.js';
import { currentBranch } from '../workspace/context.js';
import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import { AuthGuard, assertNotBranchTest } from '../auth/auth.guard.js';
import { ProfileService } from './profile.service.js';
import { Context, settingFor } from './fields.js';

/** Profile fields: definitions come from the base and from plugins; the admin configures them; people edit their values. Writes of configuration need the admin capability and a working branch. */
@UseGuards(AuthGuard)
@Controller('tenants/:tenant')
export class ProfileController {
  constructor(private readonly p: ProfileService, private readonly orgs: OrgService, @Optional() private readonly v?: VersioningService) {}
  /** Read-only sections other plugins add to a profile. Roles come from the existing assignments and cannot be changed from a profile. */
  private async sections(t: string, subject: string, ref: 'live' | 'work') {
    const roles = await (this.v ? this.v.at(ref === 'live' ? 'main' : currentBranch(false), async (c) => { const [r] = await c.query('select a.role_id id, r.label from assignments a left join roles r on r.id=a.role_id where a.identity_id=? order by a.role_id', [subject]); return r as { id: string; label: string | null }[]; }).catch(() => undefined) : undefined);
    return { readOnly: true, organizations: await this.orgs.section(t, subject, ref), roles };
  }

  @UseGuards(AdminGuard) @Get('profile-fields') async fields(@Param('tenant') t: string) {
    const [wc, lc, wcat, lcat] = [await this.p.config(t, 'work'), await this.p.config(t, 'live'), await this.p.catalogue(t, 'work'), await this.p.catalogue(t, 'live')];
    const eff = (cat: typeof wcat, cfg: typeof wc) => Object.fromEntries(cat.map((f) => [f.fullKey, settingFor(f, cfg)]));
    return { tenant: t, catalogue: wcat, working: { config: wc, settings: eff(wcat, wc) }, live: { config: lc, catalogue: lcat, settings: eff(lcat, lc) } };
  }
  @UseGuards(AdminGuard) @Put('profile-fields') async put(@Param('tenant') t: string, @Body() b: { config?: unknown }) { return { saved: true, config: await this.p.saveConfig(t, b?.config) }; }
  @Get('profile-schema') async schema(@Param('tenant') t: string, @Query('context') c: string, @Query('ref') ref?: string) {
    if (!['signup', 'self', 'admin'].includes(c)) throw new BadRequestException('context: signup, self or admin');
    return { context: c, fields: await this.p.schema(t, c as Context, ref === 'work' ? 'work' : 'live') };
  }
  /** Components the active plugins contribute to a profile surface. surface=admin needs the admin capability (it feeds the administrator's user sheet). */
  @Get('profile-components') async components(@Param('tenant') t: string, @Query('surface') surface: string, @Query('ref') ref: string | undefined, @Req() req: { headers: Record<string, unknown> }) {
    if (!['self', 'admin'].includes(surface)) throw new BadRequestException('surface: self or admin');
    if (surface === 'admin') new AdminGuard().canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as never);
    return { surface, components: await this.p.components(t, surface as 'self' | 'admin', ref === 'work' ? 'work' : 'live') };
  }
  /** The administrator's configuration view: every component of every active plugin, defaults and effective surfaces. */
  @UseGuards(AdminGuard) @Get('profile-components-inventory') async componentsInventory(@Param('tenant') t: string, @Query('ref') ref?: string) {
    return { components: await this.p.componentsInventory(t, ref === 'live' ? 'live' : 'work') };
  }
  /** How much profile data a plugin holds for this tenant; the console shows it in the uninstall confirmation. */
  @UseGuards(AdminGuard) @Get('plugins/:id/profile-values') async pluginValues(@Param('tenant') t: string, @Param('id') id: string) {
    return { plugin: id, values: await this.p.pluginValueCount(t, id) };
  }
  /** The subject is the token's, never a value from the request. */
  /** A branch-test token (claim set by the core at sign-in) reads and edits its profile on the TESTED branch; every other token stays live. */
  private ref(req: { user?: { branch?: string } }): 'live' | 'work' { return req.user?.branch ? 'work' : 'live'; }
  @Get('me/profile') async me(@Param('tenant') t: string, @Req() req: { user: { sub: string; branch?: string } }) { return { ...(await this.p.self(t, req.user.sub, this.ref(req))), sections: await this.sections(t, req.user.sub, this.ref(req)) }; }
  @Patch('me/profile') patchMe(@Param('tenant') t: string, @Req() req: { user: { sub: string; branch?: string } }, @Body() b: unknown) { return this.p.patchSelf(t, req.user.sub, b, this.ref(req)); }
  /** Validators (administrators for now; finer roles come with the permission model). */
  @UseGuards(AdminGuard) @Get('profile-reviews') reviews(@Param('tenant') t: string, @Req() req: { user?: { branch?: string } }) { assertNotBranchTest(req); return this.p.reviews(t); }
  @UseGuards(AdminGuard) @Post('profile-reviews/:id/accept') accept(@Param('tenant') t: string, @Param('id') id: string, @Req() req: { user: { sub: string; branch?: string } }) { assertNotBranchTest(req); return this.p.resolveReview(t, id, true, req.user.sub); }
  @UseGuards(AdminGuard) @Post('profile-reviews/:id/refuse') refuse(@Param('tenant') t: string, @Param('id') id: string, @Req() req: { user: { sub: string; branch?: string } }) { assertNotBranchTest(req); return this.p.resolveReview(t, id, false, req.user.sub); }
  /** What the console may show this person: whether they are an administrator, and which plugins are live. Display only: the server checks every call again. */
  @Get('me/access') async access(@Param('tenant') t: string, @Req() req: { user: { sub: string; branch?: string }; headers: Record<string, unknown> }) {
    let admin = true; try { new AdminGuard().canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as never); } catch { admin = false; }
    const plugins = Object.fromEntries((await this.p.activePlugins(t, req.user.branch ? 'work' : 'live')).map((id) => [id, true]));
    const restricted = (process.env.IAM_API_ADMIN_SUBJECTS ?? '').split(',').some((x) => x.trim());
    return { subject: req.user.sub, admin, restricted, plugins };
  }
  @UseGuards(AdminGuard) @Get('users/:id/profile') async user(@Param('tenant') t: string, @Param('id') id: string) { return { ...(await this.p.admin(t, id)), sections: await this.sections(t, id, 'work') }; }
  @UseGuards(AdminGuard) @Patch('users/:id/profile') patchUser(@Param('tenant') t: string, @Param('id') id: string, @Req() req: { user: { sub: string } }, @Body() b: unknown) { return this.p.patchAdmin(t, id, b, req.user.sub); }
}
