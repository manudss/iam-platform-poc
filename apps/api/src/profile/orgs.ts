import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { Connection } from 'mysql2/promise';
import { VersioningService } from '../versioning/versioning.service.js';
import { ProfileService } from './profile.service.js';
import { ApplicationBus } from '../events/application-bus.service.js';
import { currentBranch } from '../workspace/context.js';
import { Body, Controller, Delete, Param, Patch, Post, Put, Get, Req, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';

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

const ID = /^[a-z0-9-]{1,32}$/;
@Injectable()
export class OrgService {
  constructor(private readonly profile: ProfileService, @Inject(ORG_STORE) private readonly store: OrgStore, @Optional() private readonly events?: ApplicationBus) {}
  private async need(t: string, ref: 'live' | 'work') { if (!(await this.profile.pluginActive(t, 'organizations', ref))) throw new NotFoundException('the organizations plugin is not enabled'); }
  async list(t: string) { await this.need(t, 'work'); return this.store.list(t, 'work'); }
  async create(t: string, actor: string, b: { id?: unknown; name?: unknown; parent_id?: unknown }) {
    await this.need(t, 'work');
    if (typeof b?.id !== 'string' || !ID.test(b.id)) throw new BadRequestException('id: lowercase letters, digits, hyphens; max 32');
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80) throw new BadRequestException('name: 1 to 80 characters');
    const parent = b.parent_id == null || b.parent_id === '' ? null : String(b.parent_id);
    await this.store.write(t, actor, (s) => {
      if (s.orgs.some((o) => o.id === b.id)) throw new ConflictException('organization already exists');
      if (parent && !s.orgs.some((o) => o.id === parent)) throw new BadRequestException('unknown parent organization');
      s.orgs.push({ id: b.id as string, name: (b.name as string).trim(), parent_id: parent });
    });
    return this.list(t);
  }
  async update(t: string, actor: string, id: string, b: { name?: unknown; parent_id?: unknown }) {
    await this.need(t, 'work');
    await this.store.write(t, actor, (s) => {
      const o = s.orgs.find((x) => x.id === id); if (!o) throw new NotFoundException('unknown organization');
      if (b?.name !== undefined) { if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80) throw new BadRequestException('name: 1 to 80 characters'); o.name = b.name.trim(); }
      if (b?.parent_id !== undefined) {
        const p = b.parent_id === null || b.parent_id === '' ? null : String(b.parent_id);
        if (p) { if (!s.orgs.some((x) => x.id === p)) throw new BadRequestException('unknown parent organization'); for (let c: string | null = p; c; c = s.orgs.find((x) => x.id === c)?.parent_id ?? null) if (c === id) throw new BadRequestException('an organization cannot be its own ancestor'); }
        o.parent_id = p;
      }
    });
    return this.list(t);
  }
  async remove(t: string, actor: string, id: string) {
    await this.need(t, 'work');
    await this.store.write(t, actor, (s) => {
      if (!s.orgs.some((o) => o.id === id)) throw new NotFoundException('unknown organization');
      if (s.orgs.some((o) => o.parent_id === id)) throw new ConflictException('the organization has children');
      if (s.members.some((m) => m.org_id === id)) throw new ConflictException('the organization still has members');
      s.orgs = s.orgs.filter((o) => o.id !== id);
    });
    return this.list(t);
  }
  /** An assignment by an administrator. It is not a profile field and no profile setting can open it to the person. */
  async assign(t: string, actor: string, subject: string, orgIds: unknown) {
    await this.need(t, 'work');
    if (!ID.test(subject)) throw new BadRequestException('invalid user id');
    if (!Array.isArray(orgIds) || orgIds.length > 20 || orgIds.some((x) => typeof x !== 'string')) throw new BadRequestException('orgIds: list of organization ids');
    const before = new Set((await this.store.list(t, 'work')).members.filter((m) => m.subject === subject).map((m) => m.org_id));
    await this.store.write(t, actor, (s) => {
      for (const id of orgIds as string[]) if (!s.orgs.some((o) => o.id === id)) throw new BadRequestException(`unknown organization ${id}`);
      s.members = s.members.filter((m) => m.subject !== subject).concat([...new Set(orgIds as string[])].map((org_id) => ({ subject, org_id })));
    });
    for (const org of [...new Set(orgIds as string[])]) if (!before.has(org)) this.events?.emit({ type: 'organization.member-added', tenant: t, branch: currentBranch(), at: new Date().toISOString(), payload: { subject, organization: org, actor } });
    return { subject, orgIds: [...new Set(orgIds as string[])] };
  }
  /** Read-only section shown on a profile (live for the person, working for the administrator). Empty when the plugin is off. */
  async section(t: string, subject: string, ref: 'live' | 'work') {
    if (!(await this.profile.pluginActive(t, 'organizations', ref))) return undefined;
    const s = await this.store.list(t, ref); const names = new Map(s.orgs.map((o) => [o.id, o.name]));
    return s.members.filter((m) => m.subject === subject).map((m) => ({ id: m.org_id, name: names.get(m.org_id) ?? m.org_id }));
  }
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
