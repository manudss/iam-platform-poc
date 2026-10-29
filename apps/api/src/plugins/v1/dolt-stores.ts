import type { MigrationStore, SettingsStore, StateStore, StoredState } from './registry.js';
import { VersioningService } from '../../versioning/versioning.service.js';
import type { Connection } from 'mysql2/promise';

/** Non-secret runtime plugin data on Dolt main. Writes are serialized with the explorer, each with a commit. */
export class DoltPluginStore implements MigrationStore, SettingsStore, StateStore {
  constructor(private readonly v: VersioningService) {}
  private ready?: Promise<void>;
  private init() { return this.ready ??= this.v.lock(() => this.v.at('main', async c => {
    await c.query('create table if not exists plugin_runtime_state (tenant varchar(32), plugin varchar(64), installed boolean not null, enabled boolean not null, faulted boolean not null, grants_json json not null, primary key(tenant,plugin))');
    await c.query('create table if not exists plugin_runtime_settings (tenant varchar(32), plugin varchar(64), settings json not null, primary key(tenant,plugin))');
    await c.query('create table if not exists plugin_runtime_migrations (plugin varchar(64), id varchar(80), checksum varchar(64), primary key(plugin,id))');
    await c.query('create table if not exists plugin_runtime_seeds (tenant varchar(32), plugin varchar(64), primary key(tenant,plugin))');
    await this.commit(c, 'plugins: storage schema');
  })); }
  private async commit(c: Connection, msg: string) {
    const [d] = await c.query('select * from dolt_status'); if (!(d as unknown[]).length) return;
    for (const row of d as {table_name:string}[]) if (row.table_name.startsWith('plugin_runtime_') || row.table_name.startsWith('plg_')) await c.query('call dolt_add(?)', [row.table_name]); await c.query('call dolt_commit(\'-m\', ?)', [msg]);
  }
  private async read<T>(fn: (c: Connection) => Promise<T>) { await this.init(); return this.v.at('main', fn); }
  private async write(fn: (c: Connection) => Promise<void>, msg: string) { await this.init(); return this.v.lock(() => this.v.at('main', async c => { await fn(c); await this.commit(c, msg); })); }
  async applied(plugin: string) { return this.read(async c => { const [r] = await c.query('select id,checksum from plugin_runtime_migrations where plugin=?', [plugin]); return r as {id:string;checksum:string}[]; }); }
  async apply(plugin: string, id: string, checksum: string, sql: string[]) { await this.write(async c => {
    for (const s of sql) await c.query(s.replace(/\btext\b/gi, 'varchar(255)').replace(/\btimestamptz\b/gi, 'datetime'));
    await c.query('insert into plugin_runtime_migrations values (?,?,?)', [plugin,id,checksum]);
  }, `plugin migration: ${plugin}/${id}`); }
  async seed(tenant: string, plugin: string, table: string, row: Record<string, unknown>) {
    if (!/^plg_[a-z0-9_]+$/.test(table) || Object.keys(row).some(k => !/^[a-z_][a-z0-9_]*$/.test(k))) throw new Error('invalid seed');
    await this.write(async c => { const r = {...row,tenant}, cols = Object.keys(r); await c.query(`insert ignore into \`${table}\` (${cols.map(k=>`\`${k}\``).join(',')}) values (${cols.map(()=>'?').join(',')})`, Object.values(r)); await c.query('insert ignore into plugin_runtime_seeds values (?,?)',[tenant,plugin]); }, `plugin seed: ${plugin}`);
  }
  async seeded(t: string,p: string) { return this.read(async c => {const [r] = await c.query('select * from plugin_runtime_seeds where tenant=? and plugin=?',[t,p]);return (r as unknown[]).length>0;}); }
  async get(t: string,p: string) { return this.read(async c => {const [r] = await c.query('select settings from plugin_runtime_settings where tenant=? and plugin=?',[t,p]);const x = (r as {settings:unknown}[])[0]?.settings;return (typeof x==='string'?JSON.parse(x):x) as Record<string,unknown>|undefined;}); }
  async put(t: string,p: string,values: Record<string,unknown>) { await this.write(async c => {await c.query('insert into plugin_runtime_settings values (?,?,?) on duplicate key update settings=values(settings)',[t,p,JSON.stringify(values)]);},`plugin settings: ${p}`); }
  async loadAll(): Promise<StoredState[]> { return this.read(async c => {const [r]=await c.query('select * from plugin_runtime_state');return (r as Record<string,any>[]).map(x=>({tenant:x.tenant,plugin:x.plugin,installed:!!x.installed,enabled:!!x.enabled,faulted:!!x.faulted,grants:typeof x.grants_json==='string'?JSON.parse(x.grants_json):x.grants_json}));}); }
  async save(s: StoredState) { await this.write(async c => { await c.query('insert into plugin_runtime_state values (?,?,?,?,?,?) on duplicate key update installed=values(installed),enabled=values(enabled),faulted=values(faulted),grants_json=values(grants_json)',[s.tenant,s.plugin,s.installed,s.enabled,s.faulted,JSON.stringify(s.grants)]);},`plugin state: ${s.plugin}`); }
}
