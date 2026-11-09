import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DoltProfileStore, FieldRoute } from './store.js';
import { VersioningService } from '../versioning/versioning.service.js';

/** The DoltProfileStore commit set always includes the legacy values table: ensure() may have just created it on
 * the branch, and an uncommitted CREATE on main makes every later Apply fail with "uncommitted changes from
 * another session" (seen on the hosted preview after the demo seed ran a live put with only plugin-mapped
 * fields). This fake emulates just enough Dolt to observe what gets staged. */
function fakeDolt() {
  const dirty = new Set<string>();
  const staged: string[] = [];
  const commits: string[] = [];
  const conn = {
    staged, commits, dirty,
    async query(sql: string, params: unknown[] = []): Promise<[unknown[], unknown]> {
      if (sql.startsWith('create table if not exists profile_field_values')) { dirty.add('profile_field_values'); return [[], {}]; }
      if (sql.startsWith('select count(*) n from information_schema.tables')) return [[{ n: String(params[0]).startsWith('plg_') ? 1 : 0 }], {}];
      if (sql.startsWith('select table_name from dolt_status where table_name in')) {
        const names = [...sql.matchAll(/'(\w+)'/g)].map((m) => m[1]);
        return [names.filter((n) => dirty.has(n)).map((n) => ({ table_name: n })), {}];
      }
      if (sql.startsWith('call dolt_add')) { staged.push(String(params[0])); return [[], {}]; }
      if (sql.startsWith('call dolt_commit')) { commits.push(String(params[0])); dirty.clear(); return [[{ hash: 'h' }], {}]; }
      if (sql.startsWith('insert into') || sql.startsWith('delete from')) { const m = sql.match(/(?:insert into|delete from) `?(\w+)`?/); if (m) dirty.add(m[1]); return [[], {}]; }
      throw new Error('unexpected SQL: ' + sql);
    },
  };
  const v = { at: async (_r: string, fn: (c: unknown) => Promise<unknown>) => fn(conn), lock: async (fn: () => Promise<unknown>) => fn(), writeOn: async (_b: string, fn: (c: unknown) => Promise<unknown>) => fn(conn) } as unknown as VersioningService;
  const routes: FieldRoute[] = [{ fullKey: 'hr-attributes.job_title', type: 'string', table: 'plg_hr_attributes_values', column: 'job_title' }];
  const s = new DoltProfileStore(v, () => 'work');
  s.setCatalogue(async () => routes);
  return { conn, s };
}

describe('DoltProfileStore commits the legacy values table it may have just created', () => {
  it('a live put with only plugin-mapped fields stages profile_field_values too (the hosted-demo seed case)', async () => {
    const { conn, s } = fakeDolt();
    await s.put('acme', 'demo-alice', { 'hr-attributes.job_title': 'Engineer' }, 'live', 'demo-seed');
    assert.deepEqual(conn.staged.sort(), ['plg_hr_attributes_values', 'profile_field_values']);
    assert.equal(conn.commits.length, 1);
    assert.equal(conn.dirty.size, 0, 'nothing left uncommitted');
  });
  it('an unmapped field keeps the previous behaviour (the values table is staged once)', async () => {
    const { conn, s } = fakeDolt();
    await s.put('acme', 'demo-alice', { 'legacy.note': 'x' }, 'live', 'alice');
    assert.deepEqual(conn.staged, ['profile_field_values']);
    assert.equal(conn.commits.length, 1);
  });
  it('a working-branch put stages the same set', async () => {
    const { conn, s } = fakeDolt();
    await s.put('acme', 'demo-alice', { 'hr-attributes.job_title': 'Engineer' }, 'work', 'alice');
    assert.deepEqual(conn.staged.sort(), ['plg_hr_attributes_values', 'profile_field_values']);
  });
});
