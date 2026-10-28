import pg from 'pg';
import type { MigrationStore, SettingsStore, StateStore, StoredState } from './registry.js';

/**
 * PostgreSQL stores for plugin settings, enablement/grants/faults and the migration ledger.
 * - Migrations run for real, in one transaction per migration, and are recorded in plugin_migrations (checksum).
 * - Plugin tables are shared across tenants but every row carries `tenant` (enforced by the manifest validator); seed rows are written
 *   once per tenant and plugin with that tenant, so one tenant's data and seeds never appear in another's.
 * - Settings and state are keyed by (tenant, plugin). Secrets are stored as given in the POC (no encryption): use the OpenBao-backed
 *   secrets service for real secrets before any real use.
 */
export class PgPluginStore implements MigrationStore, SettingsStore, StateStore {
  private ready?: Promise<void>;
  constructor(private readonly pool: pg.Pool) {}

  private init() {
    this.ready ??= (async () => {
      await this.pool.query(`
        create table if not exists plugin_migrations (plugin text not null, id text not null, checksum text not null, applied_at timestamptz not null default now(), primary key (plugin, id));
        create table if not exists plugin_seeds (tenant text not null, plugin text not null, seeded_at timestamptz not null default now(), primary key (tenant, plugin));
        create table if not exists plugin_settings (tenant text not null, plugin text not null, values jsonb not null, updated_at timestamptz not null default now(), primary key (tenant, plugin));
        create table if not exists plugin_state (tenant text not null, plugin text not null, installed boolean not null, enabled boolean not null, faulted boolean not null, grants jsonb not null, updated_at timestamptz not null default now(), primary key (tenant, plugin));`);
    })();
    return this.ready;
  }

  async applied(plugin: string) {
    await this.init();
    return (await this.pool.query('select id, checksum from plugin_migrations where plugin = $1 order by applied_at, id', [plugin])).rows as { id: string; checksum: string }[];
  }
  async apply(plugin: string, id: string, checksum: string, sql: string[]) {
    await this.init();
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      for (const s of sql) await c.query(s);
      await c.query('insert into plugin_migrations (plugin, id, checksum) values ($1, $2, $3)', [plugin, id, checksum]);
      await c.query('commit');
    } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
  }
  async seed(tenant: string, plugin: string, table: string, row: Record<string, unknown>) {
    await this.init();
    if (!/^plg_[a-z0-9_]+$/.test(table)) throw new Error(`seed table ${table} is not a plugin table`);
    const r: Record<string, unknown> = { ...row, tenant };
    const cols = Object.keys(r);
    if (!cols.every((k) => /^[a-z_][a-z0-9_]*$/.test(k))) throw new Error('invalid seed column');
    await this.pool.query(`insert into ${table} (${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) on conflict do nothing`, cols.map((k) => r[k]));
    await this.pool.query('insert into plugin_seeds (tenant, plugin) values ($1, $2) on conflict do nothing', [tenant, plugin]);
  }
  async seeded(tenant: string, plugin: string) {
    await this.init();
    return (await this.pool.query('select 1 from plugin_seeds where tenant = $1 and plugin = $2', [tenant, plugin])).rowCount! > 0;
  }

  async get(tenant: string, plugin: string) {
    await this.init();
    return (await this.pool.query('select values from plugin_settings where tenant = $1 and plugin = $2', [tenant, plugin])).rows[0]?.values as Record<string, unknown> | undefined;
  }
  async put(tenant: string, plugin: string, values: Record<string, unknown>) {
    await this.init();
    await this.pool.query('insert into plugin_settings (tenant, plugin, values) values ($1, $2, $3) on conflict (tenant, plugin) do update set values = excluded.values, updated_at = now()', [tenant, plugin, JSON.stringify(values)]);
  }

  async loadAll(): Promise<StoredState[]> {
    await this.init();
    return (await this.pool.query('select tenant, plugin, installed, enabled, faulted, grants from plugin_state')).rows as StoredState[];
  }
  async save(s: StoredState) {
    await this.init();
    await this.pool.query('insert into plugin_state (tenant, plugin, installed, enabled, faulted, grants) values ($1, $2, $3, $4, $5, $6) on conflict (tenant, plugin) do update set installed = excluded.installed, enabled = excluded.enabled, faulted = excluded.faulted, grants = excluded.grants, updated_at = now()', [s.tenant, s.plugin, s.installed, s.enabled, s.faulted, JSON.stringify(s.grants)]);
  }
}
