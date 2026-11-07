import { Body, Controller, Delete, Get, Inject, Injectable, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Optional } from '@nestjs/common';
import type { Connection } from 'mysql2/promise';
import { VersioningService } from '../versioning/versioning.service.js';
import { ProfileService } from '../profile/profile.service.js';
import { ApplicationBus } from '../events/application-bus.service.js';
import { currentBranch } from '../workspace/context.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { loadPluginModule } from '../plugins/v1/loader.js';

/**
 * Application connector (plugin `app-connector`): validation and registry logic live in the plugin folder
 * (`plugins/app-connector/handlers.mjs`); this file is the core adapter. It owns the storage wiring
 * (Dolt on a branch, reviewable, mergeable; memory store for tests), feeds the plugin's registry engine
 * its dependencies and exposes the admin controller. Secrets never live here: `secret_ref` is only the
 * name of an entry in the secret store.
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

interface AppConnectorPluginModule {
  APP_CONNECTOR_PLUGIN: string;
  APP_CONNECTOR_DDL: string;
  appConnectorConfig: (a: AppConnector) => string;
  checkUrl: (v: unknown, what: string) => string;
  build: (id: string, b: Record<string, unknown>, base?: AppConnector) => AppConnector;
  createAppRegistry: (deps: {
    pluginActive: (tenant: string, id: string, ref: 'live' | 'work') => Promise<boolean>;
    store: AppConnectorStore;
    emit: (type: string, tenant: string, payload: Record<string, string>) => void;
    branch: () => string;
  }) => {
    list: (t: string) => Promise<State>;
    liveApps: (t: string) => Promise<AppConnector[]>;
    get: (t: string, id: string) => Promise<AppConnector>;
    create: (t: string, actor: string, b: Record<string, unknown>) => Promise<AppConnector>;
    update: (t: string, actor: string, id: string, b: Record<string, unknown>) => Promise<AppConnector>;
    remove: (t: string, actor: string, id: string) => Promise<State>;
  };
  DEMO_APP_CONNECTORS: AppConnector[];
}
const plugin = loadPluginModule('app-connector', 'handlers.mjs') as AppConnectorPluginModule;

export const APP_CONNECTOR_PLUGIN = plugin.APP_CONNECTOR_PLUGIN;
export const APP_CONNECTOR_DDL = plugin.APP_CONNECTOR_DDL;
export const appConnectorConfig = plugin.appConnectorConfig;
export const checkUrl = plugin.checkUrl;
export const build = plugin.build;
export const DEMO_APP_CONNECTORS = plugin.DEMO_APP_CONNECTORS;

export class MemoryAppConnectorStore implements AppConnectorStore {
  private live = new Map<string, State>(); private work = new Map<string, State>();
  async list(t: string, ref: 'live' | 'work') { const s = (ref === 'live' ? this.live : this.work).get(t) ?? this.live.get(t) ?? { apps: [] }; const o = structuredClone(s); o.apps.sort((a, b) => a.id.localeCompare(b.id)); return o; }
  async write(t: string, _a: string, fn: (s: State) => void) { const s = await this.list(t, 'work'); fn(s); this.work.set(t, s); this.live.set(t, structuredClone(s)); }
}

type Row = { id: string; name: string; description: string; protocol: Protocol; enabled: number; config: string };
const fromRow = (r: Row): AppConnector => { const c = JSON.parse(r.config) as Pick<AppConnector, 'redirect_uris' | 'entity_id' | 'acs_url' | 'attribute_mapping' | 'allowed_roles' | 'secret_ref'>; return { id: r.id, name: r.name, description: r.description, protocol: r.protocol, enabled: !!r.enabled, ...c }; };

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

@Injectable()
export class AppConnectorService {
  private readonly registry: ReturnType<AppConnectorPluginModule['createAppRegistry']>;
  constructor(profile: ProfileService, @Inject(APP_CONNECTOR_STORE) store: AppConnectorStore, @Optional() events?: ApplicationBus) {
    this.registry = plugin.createAppRegistry({
      pluginActive: (t, id, ref) => profile.pluginActive(t, id, ref),
      store,
      emit: (type, tenant, payload) => events?.emit({ type, tenant, branch: currentBranch(), at: new Date().toISOString(), payload }),
      branch: () => currentBranch(),
    });
  }
  list(t: string) { return this.registry.list(t); }
  /** Applications as they are LIVE (Dolt main): what the protocol plugins serve. Empty while the plugin is off. */
  liveApps(t: string) { return this.registry.liveApps(t); }
  get(t: string, id: string) { return this.registry.get(t, id); }
  create(t: string, actor: string, b: Record<string, unknown>) { return this.registry.create(t, actor, b); }
  update(t: string, actor: string, id: string, b: Record<string, unknown>) { return this.registry.update(t, actor, id, b); }
  remove(t: string, actor: string, id: string) { return this.registry.remove(t, actor, id); }
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
