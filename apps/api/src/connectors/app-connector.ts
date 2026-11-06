import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Connection } from 'mysql2/promise';
import { VersioningService } from '../versioning/versioning.service.js';
import { ProfileService } from '../profile/profile.service.js';
import { AppEvents } from '../events/app-events.service.js';
import { currentBranch } from '../workspace/context.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';

/**
 * Application connector (plugin `app-connector`): the declaration of a third-party application (service provider / relying party)
 * that will sign in through this platform acting as the identity provider, in OIDC or SAML. Step 1 of the SSO plan: configuration only,
 * no protocol endpoint yet. Configuration lives in Dolt (so on a branch, reviewable, mergeable). Secrets never live here:
 * `secret_ref` is only the name of an entry in the secret store.
 */
export type Protocol = 'oidc' | 'saml';
export interface AppConnector {
  id: string; name: string; description: string; protocol: Protocol; enabled: boolean;
  /** OIDC: exact redirect URIs (no wildcard). */
  redirect_uris: string[];
  /** SAML: the SP entity id and assertion consumer service URL. */
  entity_id: string | null; acs_url: string | null;
  /** Claim or attribute name sent to the application -> profile key it is read from. */
  attribute_mapping: Record<string, string>;
  /** Roles allowed to open the application (empty = nobody until configured; closed by default). */
  allowed_roles: string[];
  /** Name of the secret in the secret store (client secret or signing key). Never the secret itself. */
  secret_ref: string | null;
}
type State = { apps: AppConnector[] };
export interface AppConnectorStore {
  list(t: string, ref: 'live' | 'work'): Promise<State>;
  write(t: string, actor: string, fn: (s: State) => void): Promise<void>;
}
export const APP_CONNECTOR_STORE = 'APP_CONNECTOR_STORE';
export const APP_CONNECTOR_PLUGIN = 'app-connector';

export class MemoryAppConnectorStore implements AppConnectorStore {
  private live = new Map<string, State>(); private work = new Map<string, State>();
  async list(t: string, ref: 'live' | 'work') { const s = (ref === 'live' ? this.live : this.work).get(t) ?? this.live.get(t) ?? { apps: [] }; const o = structuredClone(s); o.apps.sort((a, b) => a.id.localeCompare(b.id)); return o; }
  async write(t: string, _a: string, fn: (s: State) => void) { const s = await this.list(t, 'work'); fn(s); this.work.set(t, s); this.live.set(t, structuredClone(s)); }
}

export const APP_CONNECTOR_DDL = 'create table if not exists app_connectors (tenant varchar(32) not null, id varchar(32) not null, name varchar(80) not null, description varchar(240) not null, protocol varchar(8) not null, enabled tinyint not null, config longtext not null, primary key (tenant, id))';
type Row = { id: string; name: string; description: string; protocol: Protocol; enabled: number; config: string };
const fromRow = (r: Row): AppConnector => { const c = JSON.parse(r.config) as Pick<AppConnector, 'redirect_uris' | 'entity_id' | 'acs_url' | 'attribute_mapping' | 'allowed_roles' | 'secret_ref'>; return { id: r.id, name: r.name, description: r.description, protocol: r.protocol, enabled: !!r.enabled, ...c }; };
export const appConnectorConfig = (a: AppConnector) => JSON.stringify({ redirect_uris: a.redirect_uris, entity_id: a.entity_id, acs_url: a.acs_url, attribute_mapping: a.attribute_mapping, allowed_roles: a.allowed_roles, secret_ref: a.secret_ref });

/** Dolt: table `app_connectors`, written on the working branch, live after Apply like every other administrator change. Fictional data only. */
export class DoltAppConnectorStore implements AppConnectorStore {
  constructor(private readonly v: VersioningService, private readonly workBranch: (write: boolean) => string) {}
  async list(t: string, ref: 'live' | 'work'): Promise<State> {
    return this.v.at(ref === 'live' ? 'main' : this.workBranch(false), async (c) => {
      const [ex] = await c.query("select count(*) n from information_schema.tables where table_schema=database() and table_name='app_connectors'");
      if (Number((ex as { n: number }[])[0].n) < 1) return { apps: [] };
      const [r] = await c.query('select id, name, description, protocol, enabled, config from app_connectors where tenant=? order by id', [t]);
      return { apps: (r as Row[]).map(fromRow) };
    });
  }
  async write(t: string, actor: string, fn: (s: State) => void) {
    await this.v.writeOn(this.workBranch(true), async (c: Connection) => {
      await c.query(APP_CONNECTOR_DDL);
      const [r] = await c.query('select id, name, description, protocol, enabled, config from app_connectors where tenant=?', [t]);
      const before: State = { apps: (r as Row[]).map(fromRow) }, after = structuredClone(before); fn(after);
      const bm = new Map(before.apps.map((x) => [x.id, JSON.stringify(x)])), am = new Map(after.apps.map((x) => [x.id, JSON.stringify(x)]));
      for (const id of bm.keys()) if (!am.has(id)) await c.query('delete from app_connectors where tenant=? and id=?', [t, id]);
      for (const a of after.apps) if (bm.get(a.id) !== JSON.stringify(a)) await c.query('insert into app_connectors values (?,?,?,?,?,?,?) on duplicate key update name=values(name), description=values(description), protocol=values(protocol), enabled=values(enabled), config=values(config)', [t, a.id, a.name, a.description, a.protocol, a.enabled ? 1 : 0, appConnectorConfig(a)]);
      const [d] = await c.query("select table_name from dolt_status where table_name='app_connectors'");
      if ((d as unknown[]).length) { await c.query("call dolt_add('app_connectors')"); await c.query("call dolt_commit('-m', ?)", [`app-connector: ${actor} changed the application registry`]); }
    });
  }
}

const ID = /^[a-z0-9-]{1,32}$/, KEY = /^[A-Za-z0-9_.:-]{1,64}$/, REF = /^[a-z0-9][a-z0-9/_.-]{0,63}$/;
const FORBIDDEN = ['secret', 'client_secret', 'private_key', 'password', 'token'];
/** Exact https URL, or http only on localhost (local tests). No wildcard, no fragment, no credentials in the URL. */
export function checkUrl(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length > 300) throw new BadRequestException(`${what}: a URL of at most 300 characters`);
  let u: URL; try { u = new URL(v); } catch { throw new BadRequestException(`${what}: not a valid URL`); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new BadRequestException(`${what}: https is required (http only for localhost)`);
  if (v.includes('*') || u.hash || u.username || u.password) throw new BadRequestException(`${what}: no wildcard, fragment or credentials`);
  return v;
}
const strs = (v: unknown, what: string, max: number): string[] => { if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string')) throw new BadRequestException(`${what}: a list of at most ${max} strings`); return [...new Set(v as string[])]; };

/** Validates a full or partial body and returns the new connector. `base` is the existing one for a partial update. */
export function build(id: string, b: Record<string, unknown>, base?: AppConnector): AppConnector {
  for (const k of Object.keys(b ?? {})) if (FORBIDDEN.includes(k.toLowerCase())) throw new BadRequestException(`${k}: secrets are never stored here; save it in the secret store and give its name in secret_ref`);
  const a: AppConnector = base ? structuredClone(base) : { id, name: '', description: '', protocol: 'oidc', enabled: false, redirect_uris: [], entity_id: null, acs_url: null, attribute_mapping: {}, allowed_roles: [], secret_ref: null };
  if (b.name !== undefined) { if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 80) throw new BadRequestException('name: 1 to 80 characters'); a.name = b.name.trim(); }
  if (b.description !== undefined) { if (typeof b.description !== 'string' || b.description.length > 240) throw new BadRequestException('description: at most 240 characters'); a.description = b.description; }
  if (b.protocol !== undefined) { if (b.protocol !== 'oidc' && b.protocol !== 'saml') throw new BadRequestException("protocol: 'oidc' or 'saml'"); a.protocol = b.protocol; }
  if (b.enabled !== undefined) { if (typeof b.enabled !== 'boolean') throw new BadRequestException('enabled: true or false'); a.enabled = b.enabled; }
  if (b.redirect_uris !== undefined) a.redirect_uris = strs(b.redirect_uris, 'redirect_uris', 10).map((u) => checkUrl(u, 'redirect_uris'));
  if (b.entity_id !== undefined) a.entity_id = b.entity_id === null || b.entity_id === '' ? null : (typeof b.entity_id === 'string' && b.entity_id.length <= 300 ? b.entity_id : (() => { throw new BadRequestException('entity_id: at most 300 characters'); })());
  if (b.acs_url !== undefined) a.acs_url = b.acs_url === null || b.acs_url === '' ? null : checkUrl(b.acs_url, 'acs_url');
  if (b.attribute_mapping !== undefined) {
    const m = b.attribute_mapping as Record<string, unknown>;
    if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).length > 30) throw new BadRequestException('attribute_mapping: an object of at most 30 entries');
    for (const [k, v] of Object.entries(m)) if (!KEY.test(k) || typeof v !== 'string' || !KEY.test(v)) throw new BadRequestException(`attribute_mapping.${k}: names use letters, digits and _ . : -`);
    a.attribute_mapping = m as Record<string, string>;
  }
  if (b.allowed_roles !== undefined) a.allowed_roles = strs(b.allowed_roles, 'allowed_roles', 50).map((r) => { if (!ID.test(r)) throw new BadRequestException(`allowed_roles: invalid role id ${r}`); return r; });
  if (b.secret_ref !== undefined) { if (b.secret_ref === null || b.secret_ref === '') a.secret_ref = null; else if (typeof b.secret_ref === 'string' && REF.test(b.secret_ref)) a.secret_ref = b.secret_ref; else throw new BadRequestException('secret_ref: the name of a secret in the secret store (lowercase letters, digits, / _ . -)'); }
  if (!a.name) throw new BadRequestException('name is required');
  if (a.protocol === 'oidc' && a.redirect_uris.length === 0) throw new BadRequestException('redirect_uris: at least one for an OIDC application');
  if (a.protocol === 'saml' && (!a.entity_id || !a.acs_url)) throw new BadRequestException('entity_id and acs_url are required for a SAML application');
  if (a.protocol === 'oidc') { a.entity_id = null; a.acs_url = null; } else a.redirect_uris = [];
  return a;
}

@Injectable()
export class AppConnectorService {
  constructor(private readonly profile: ProfileService, @Inject(APP_CONNECTOR_STORE) private readonly store: AppConnectorStore, @Optional() private readonly events?: AppEvents) {}
  private async need(t: string) { if (!(await this.profile.pluginActive(t, APP_CONNECTOR_PLUGIN, 'work'))) throw new NotFoundException('the app-connector plugin is not enabled'); }
  private emit(type: string, t: string, a: AppConnector, actor: string) { this.events?.emit({ type, tenant: t, branch: currentBranch(), at: new Date().toISOString(), payload: { app: a.id, protocol: a.protocol, actor } }); }
  async list(t: string) { await this.need(t); return this.store.list(t, 'work'); }
  /** Applications as they are LIVE (Dolt main): what the protocol plugins serve. Empty while the plugin is off. */
  async liveApps(t: string): Promise<AppConnector[]> { if (!(await this.profile.pluginActive(t, APP_CONNECTOR_PLUGIN, 'live'))) return []; return (await this.store.list(t, 'live')).apps; }
  async get(t: string, id: string) { await this.need(t); const a = (await this.store.list(t, 'work')).apps.find((x) => x.id === id); if (!a) throw new NotFoundException('unknown application'); return a; }
  async create(t: string, actor: string, b: Record<string, unknown>) {
    await this.need(t);
    if (typeof b?.id !== 'string' || !ID.test(b.id)) throw new BadRequestException('id: lowercase letters, digits, hyphens; max 32');
    const a = build(b.id, b); let ok = false;
    await this.store.write(t, actor, (s) => { if (s.apps.some((x) => x.id === a.id)) throw new ConflictException('application already exists'); s.apps.push(a); ok = true; });
    if (ok) this.emit('app.registered', t, a, actor);
    return a;
  }
  async update(t: string, actor: string, id: string, b: Record<string, unknown>) {
    await this.need(t); let out!: AppConnector;
    await this.store.write(t, actor, (s) => { const i = s.apps.findIndex((x) => x.id === id); if (i < 0) throw new NotFoundException('unknown application'); out = build(id, b ?? {}, s.apps[i]); s.apps[i] = out; });
    this.emit('app.updated', t, out, actor);
    return out;
  }
  async remove(t: string, actor: string, id: string) {
    await this.need(t); let gone!: AppConnector;
    await this.store.write(t, actor, (s) => { const a = s.apps.find((x) => x.id === id); if (!a) throw new NotFoundException('unknown application'); if (a.enabled) throw new ConflictException('disable the application before deleting it'); gone = a; s.apps = s.apps.filter((x) => x.id !== id); });
    this.emit('app.removed', t, gone, actor);
    return this.list(t);
  }
}

@UseGuards(AuthGuard, AdminGuard)
@Controller('tenants/:tenant/app-connectors')
export class AppConnectorController {
  constructor(private readonly a: AppConnectorService) {}
  @Get() list(@Param('tenant') t: string) { return this.a.list(t); }
  @Get(':id') get(@Param('tenant') t: string, @Param('id') id: string) { return this.a.get(t, id); }
  @Post() create(@Param('tenant') t: string, @Body() b: any, @Req() r: { user: { sub: string } }) { return this.a.create(t, r.user.sub, b); }
  @Patch(':id') update(@Param('tenant') t: string, @Param('id') id: string, @Body() b: any, @Req() r: { user: { sub: string } }) { return this.a.update(t, r.user.sub, id, b); }
  @Delete(':id') remove(@Param('tenant') t: string, @Param('id') id: string, @Req() r: { user: { sub: string } }) { return this.a.remove(t, r.user.sub, id); }
}

/** Fictional applications for the seeded demo (seed scripts only: the project installs empty). */
export const DEMO_APP_CONNECTORS: AppConnector[] = [
  { id: 'wiki', name: 'Company wiki', description: 'Internal knowledge base (fictional). Signs in with OpenID Connect.', protocol: 'oidc', enabled: true,
    redirect_uris: ['https://wiki.example.invalid/auth/callback', 'http://localhost:4300/callback'], entity_id: null, acs_url: null,
    attribute_mapping: { sub: 'id', email: 'email', name: 'display_name' }, allowed_roles: ['employee'], secret_ref: 'apps/wiki/client-secret' },
  { id: 'payroll', name: 'Payroll', description: 'Payroll portal (fictional). Signs in with SAML 2.0.', protocol: 'saml', enabled: true,
    redirect_uris: [], entity_id: 'https://payroll.example.invalid/saml/metadata', acs_url: 'https://payroll.example.invalid/saml/acs',
    attribute_mapping: { NameID: 'email', givenName: 'display_name', department: 'department' }, allowed_roles: ['hr-partner'], secret_ref: 'apps/payroll/signing-key' },
  { id: 'crm', name: 'Sales CRM', description: 'Customer relationship tool (fictional). Signs in with OpenID Connect; still being set up, so disabled.', protocol: 'oidc', enabled: false,
    redirect_uris: ['https://crm.example.invalid/oauth/callback', 'http://localhost:4300/callback'], entity_id: null, acs_url: null,
    attribute_mapping: { sub: 'id', email: 'email', groups: 'roles' }, allowed_roles: ['sales-rep'], secret_ref: 'apps/crm/client-secret' },
];
