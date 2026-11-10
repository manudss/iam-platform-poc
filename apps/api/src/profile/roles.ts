import { BadRequestException, Controller, Delete, Get, Injectable, Param, Patch, Post, Body, UseGuards, Optional, Req } from '@nestjs/common';
import type { Connection } from 'mysql2/promise';
import { AdminGuard } from '../auth/admin.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { currentBranch, workspaceMode } from '../workspace/context.js';
import { screenAccessOn, askScreen } from '../auth/screen-decision.js';
import { loadPluginModule } from '../plugins/v1/loader.js';

/**
 * Role and separation-of-duties management. The management rules live in the directory plugin
 * (plugins/directory/roles.mjs); this core adapter wires the versioned connection and the HTTP routes.
 */
export interface RolesView { roles: { id: string; label: string; is_sensitive: boolean; assigned: number }[]; sodRules: { role_a: string; role_b: string }[] }
interface RolesPluginModule {
  createRolesManager: (deps: { run: <T>(write: boolean, fn: (c: Connection) => Promise<T>) => Promise<T> }) => {
    list: () => Promise<RolesView>;
    create: (actor: string, b: { id?: unknown; label?: unknown; is_sensitive?: unknown }) => Promise<RolesView>;
    update: (actor: string, id: string, b: { label?: unknown; is_sensitive?: unknown; id?: unknown }) => Promise<RolesView>;
    remove: (actor: string, id: string) => Promise<RolesView>;
    addRule: (actor: string, b: { role_a?: unknown; role_b?: unknown }) => Promise<RolesView>;
    removeRule: (actor: string, a: string, z: string, confirm: unknown) => Promise<RolesView>;
  };
}
const plugin = loadPluginModule('directory', 'roles.mjs') as RolesPluginModule;

@Injectable()
export class RolesService {
  private readonly manager: ReturnType<RolesPluginModule['createRolesManager']>;
  constructor(@Optional() private readonly v?: VersioningService) {
    this.manager = plugin.createRolesManager({
      run: <T>(write: boolean, fn: (c: Connection) => Promise<T>): Promise<T> => {
        if (!this.v) throw new BadRequestException('no database');
        const v = this.v, branch = currentBranch(write);
        if (!write) return v.at(branch, fn);
        return workspaceMode() ? v.writeOn(branch, fn) : v.lock(() => v.at(branch, fn));
      },
    });
  }
  list() { return this.manager.list(); }
  create(actor: string, b: { id?: unknown; label?: unknown; is_sensitive?: unknown }) { return this.manager.create(actor, b); }
  update(actor: string, id: string, b: { label?: unknown; is_sensitive?: unknown; id?: unknown }) { return this.manager.update(actor, id, b); }
  remove(actor: string, id: string) { return this.manager.remove(actor, id); }
  addRule(actor: string, b: { role_a?: unknown; role_b?: unknown }) { return this.manager.addRule(actor, b); }
  removeRule(actor: string, a: string, z: string, confirm: unknown) { return this.manager.removeRule(actor, a, z, confirm); }
}

@UseGuards(AuthGuard, AdminGuard)
@Controller('tenants/:tenant/roles')
export class RolesController {
  constructor(private readonly r: RolesService) {}
  private who(req: { user: { sub: string } }) { return req.user.sub; }
  /** Callers who do not open the Roles screen (a manager editing assignments) only see the roles Cedar lets them assign (assignment:change), the same rule as the merge gate. */
  @Get() async list(@Req() q: any) {
    const view = await this.r.list();
    if (!screenAccessOn() || typeof q?.user?.sub !== 'string') return view;
    const tenant = String(q.params?.tenant ?? process.env.IAM_TENANT ?? 'acme-demo');
    if ((await askScreen(tenant, q.user.sub, 'roles')).allow) return view;
    const { assignableRoleIds } = await import('../access/scope.js');
    const ok = await assignableRoleIds(tenant, q.user.sub, view.roles.map((r) => r.id));
    return { ...view, roles: view.roles.filter((r) => ok.has(r.id)), sodRules: view.sodRules.filter((x) => ok.has(x.role_a) && ok.has(x.role_b)) };
  }
  @Post() create(@Body() b: any, @Req() q: any) { return this.r.create(this.who(q), b); }
  @Patch(':id') update(@Param('id') id: string, @Body() b: any, @Req() q: any) { return this.r.update(this.who(q), id, b); }
  @Delete(':id') remove(@Param('id') id: string, @Req() q: any) { return this.r.remove(this.who(q), id); }
  @Post('sod-rules') addRule(@Body() b: any, @Req() q: any) { return this.r.addRule(this.who(q), b); }
  @Post('sod-rules/remove') removeRule(@Body() b: { role_a?: string; role_b?: string; confirm?: unknown }, @Req() q: any) { return this.r.removeRule(this.who(q), String(b?.role_a), String(b?.role_b), b?.confirm); }
}
