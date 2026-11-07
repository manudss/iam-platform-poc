import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Connection } from 'mysql2/promise';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { VersioningService } from '../versioning/versioning.service.js';
import { ProfileService } from './profile.service.js';
import { ApplicationBus } from '../events/application-bus.service.js';
import { currentBranch } from '../workspace/context.js';
import { Body, Controller, Delete, Param, Patch, Post, Put, Get, Req, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { defaultPluginsDir } from '../plugins/v1/loader.js';
export interface Org { id: string; name: string; parent_id: string | null }
export interface OrgStore {
  list(t: string, ref: 'live' | 'work'): Promise<{ orgs: Org[]; members: { subject: string; org_id: string }[] }>;
  write(t: string, actor: string, fn: (s: { orgs: Org[]; members: { subject: string; org_id: string }[] }) => void): Promise<void>;
}
type State = { orgs: Org[]; members: { subject: string; org_id: string }[] };
export const ORG_STORE = 'ORG_STORE';

/** Tests and quick local demo. Organizations live in the working copy and the live copy is replaced on "apply", like a branch. */
export class MemoryOrgStore implements OrgStore {
  private live = new Map<string, State>(); private work = new Map<string, State>();
  async list(t: string, ref: 'live' | 'work') { const s = (ref === 'live' ? this.live : this.work).get(t) ?? this.live.get(t) ?? { orgs: [], members: [] }; return structuredClone(s); }
  async write(t: string, _a: string, fn: (s: State) => void) { const s = await this.list(t, 'work'); fn(s); this.work.set(t, s); this.live.set(t, structuredClone(s)); }
}

/** Dolt: tables `organizations` and `org_memberships`, written on the working branch, live after Apply, like every other administrator change. Fictional data only. */
export class DoltOrgStore implements OrgStore {
  constructor(private readonly v: VersioningService, private readonly workBranch: (write: boolean) => string) {}
  private async ensure(c: Connection) {
    await c.query('create table if not exists organizations (tenant varchar(32) not null, id varchar(32) not null, name varchar(80) not null, parent_id varchar(32) null, primary key (tenant, id))');
    await c.query('create table if not exists org_memberships (tenant varchar(32) not null, subject varchar(32) not null, org_id varchar(32) not null, primary key (tenant, subject, org_id))');
  }
  async list(t: string, ref: 'live' | 'work'): Promise<State> {
    return this.v.at(ref === 'live' ? 'main' : this.workBranch(false), async (c) => {
      const [ex] = await c.query("select count(*) n from information_schema.tables where table_schema=database() and table_name in ('organizations','org_memberships')");
      if (Number((ex as { n: number }[])[0].n) < 2) return { orgs: [], members: [] };
      const [o] = await c.query('select id, name, parent_id from organizations where tenant=? order by id', [t]);
      const [m] = await c.query('select subject, org_id from org_memberships where tenant=? order by subject, org_id', [t]);
      return { orgs: o as Org[], members: m as State['members'] };
    });
  }
  async write(t: string, actor: string, fn: (s: State) => void) {
    await this.v.writeOn(this.workBranch(true), async (c) => {
      await this.ensure(c);
      const [o] = await c.query('select id, name, parent_id from organizations where tenant=?', [t]); const [m] = await c.query('select subject, org_id from org_memberships where tenant=?', [t]);
      const before: State = { orgs: o as Org[], members: m as State['members'] }, after = structuredClone(before); fn(after);
      const key = (x: object) => JSON.stringify(x);
      const bo = new Map(before.orgs.map((x) => [x.id, key(x)])), ao = new Map(after.orgs.map((x) => [x.id, key(x)]));
      for (const id of bo.keys()) if (!ao.has(id)) await c.query('delete from organizations where tenant=? and id=?', [t, id]);
      for (const x of after.orgs) if (bo.get(x.id) !== key(x)) await c.query('insert into organizations values (?,?,?,?) on duplicate key update name=values(name), parent_id=values(parent_id)', [t, x.id, x.name, x.parent_id]);
      const bm = new Set(before.members.map(key)), am = new Set(after.members.map(key));
      for (const x of before.members) if (!am.has(key(x))) await c.query('delete from org_memberships where tenant=? and subject=? and org_id=?', [t, x.subject, x.org_id]);
      for (const x of after.members) if (!bm.has(key(x))) await c.query('insert into org_memberships values (?,?,?)', [t, x.subject, x.org_id]);
      const [d] = await c.query("select table_name from dolt_status where table_name in ('organizations','org_memberships')");
      if ((d as unknown[]).length) { await c.query("call dolt_add('organizations','org_memberships')"); await c.query("call dolt_commit('-m', ?)", [`organizations: ${actor} changed the directory`]); }
    });
  }
}


/** Management rules live in the organizations plugin (plugins/organizations/handlers.mjs); storage stays core. */
interface OrgsPluginModule {
  createOrgManager: (deps: {
    pluginActive: (tenant: string, id: string, ref: 'live' | 'work') => Promise<boolean>;
    store: OrgStore;
    emit: (type: string, tenant: string, payload: Record<string, string>) => void;
  }) => {
    list: (t: string) => Promise<State>;
    create: (t: string, actor: string, b: { id?: unknown; name?: unknown; parent_id?: unknown }) => Promise<State>;
    update: (t: string, actor: string, id: string, b: { name?: unknown; parent_id?: unknown }) => Promise<State>;
    remove: (t: string, actor: string, id: string) => Promise<State>;
    assign: (t: string, actor: string, subject: string, orgIds: unknown) => Promise<{ subject: string; orgIds: string[] }>;
    section: (t: string, subject: string, ref: 'live' | 'work') => Promise<{ id: string; name: string }[] | undefined>;
  };
}
const plugin = createRequire(import.meta.url)(resolve(defaultPluginsDir(), 'organizations', 'handlers.mjs')) as OrgsPluginModule;

@Injectable()
export class OrgService {
  private readonly manager: ReturnType<OrgsPluginModule['createOrgManager']>;
  constructor(profile: ProfileService, @Inject(ORG_STORE) store: OrgStore, @Optional() events?: ApplicationBus) {
    this.manager = plugin.createOrgManager({
      pluginActive: (t, id, ref) => profile.pluginActive(t, id, ref),
      store,
      emit: (type, tenant, payload) => events?.emit({ type, tenant, branch: currentBranch(), at: new Date().toISOString(), payload }),
    });
  }
  list(t: string) { return this.manager.list(t); }
  create(t: string, actor: string, b: { id?: unknown; name?: unknown; parent_id?: unknown }) { return this.manager.create(t, actor, b); }
  update(t: string, actor: string, id: string, b: { name?: unknown; parent_id?: unknown }) { return this.manager.update(t, actor, id, b); }
  remove(t: string, actor: string, id: string) { return this.manager.remove(t, actor, id); }
  /** An assignment by an administrator. It is not a profile field and no profile setting can open it to the person. */
  assign(t: string, actor: string, subject: string, orgIds: unknown) { return this.manager.assign(t, actor, subject, orgIds); }
  /** Read-only section shown on a profile (live for the person, working for the administrator). Empty when the plugin is off. */
  section(t: string, subject: string, ref: 'live' | 'work') { return this.manager.section(t, subject, ref); }
}

@UseGuards(AuthGuard, AdminGuard)
@Controller('tenants/:tenant/organizations')
export class OrgController {
  constructor(private readonly o: OrgService) {}
  @Get() list(@Param('tenant') t: string) { return this.o.list(t); }
  @Post() create(@Param('tenant') t: string, @Body() b: any, @Req() r: { user: { sub: string } }) { return this.o.create(t, r.user.sub, b); }
  @Patch(':id') update(@Param('tenant') t: string, @Param('id') id: string, @Body() b: any, @Req() r: { user: { sub: string } }) { return this.o.update(t, r.user.sub, id, b); }
  @Delete(':id') remove(@Param('tenant') t: string, @Param('id') id: string, @Req() r: { user: { sub: string } }) { return this.o.remove(t, r.user.sub, id); }
  @Put('memberships/:user') assign(@Param('tenant') t: string, @Param('user') u: string, @Body() b: { orgIds?: unknown }, @Req() r: { user: { sub: string } }) { return this.o.assign(t, r.user.sub, u, b?.orgIds); }
}
