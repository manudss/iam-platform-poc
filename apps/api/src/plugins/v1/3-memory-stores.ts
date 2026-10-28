import type { MigrationStore, SettingsStore } from './registry.js';

/** In-memory stores for tests and the local demo. A PostgreSQL store implements the same two interfaces. */
export class MemoryMigrationStore implements MigrationStore {
  log: { plugin: string; id: string; sql: string[] }[] = [];
  rows: { plugin: string; table: string; row: Record<string, unknown> }[] = [];
  private sums = new Map<string, { id: string; checksum: string }[]>();
  async applied(pluginId: string) { return this.sums.get(pluginId) ?? []; }
  async apply(pluginId: string, id: string, checksum: string, sql: string[]) {
    this.log.push({ plugin: pluginId, id, sql });
    this.sums.set(pluginId, [...(this.sums.get(pluginId) ?? []), { id, checksum }]);
  }
  async seed(plugin: string, table: string, row: Record<string, unknown>) { this.rows.push({ plugin, table, row }); }
}
export class MemorySettingsStore implements SettingsStore {
  private m = new Map<string, Record<string, unknown>>();
  async get(t: string, p: string) { return this.m.get(`${t}/${p}`); }
  async put(t: string, p: string, v: Record<string, unknown>) { this.m.set(`${t}/${p}`, v); }
}
