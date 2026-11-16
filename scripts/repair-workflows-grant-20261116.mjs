/** Incident-specific operator repair. Never invoked by startup, seeds, API or CI deploy.
 * Default = read-only. --prepare creates ONE isolated branch; never merges main.
 * Run on the existing Dolt host with existing operator access, only after owner approval.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const TENANT = 'acme-demo', PLUGIN = 'workflows-iga';
export const BEFORE = 'bbekruc3q1ej303tu23o7j3u1a35a3nf';
export const INCIDENT_HEAD = 'h2psqme55ikbip7cha1l2cete1f5duq0';
export const BRANCH = 'repair/workflows-grant-20261116';
const expected = { hooks: [], install: false, uiComponents: false };
const json = x => typeof x === 'string' ? JSON.parse(x) : x;
export async function prepareRepair(c, prepare = false, evidence = { before: BEFORE, head: INCIDENT_HEAD }) {
  const [heads] = await c.query("SELECT hashof('main') h");
  assert.match(evidence.before, /^[a-z0-9]{32}$/); assert.match(evidence.head, /^[a-z0-9]{32}$/);
  assert.equal(heads[0].h, evidence.head, 'main changed: stop and review current evidence, do not rebase automatically');
  const [dirty] = await c.query('SELECT * FROM dolt_status');
  assert.equal(dirty.length, 0, 'working set is not clean');
  const sql = 'SELECT tenant,plugin,installed,enabled,faulted,grants_json FROM plugin_runtime_state';
  const where = ' WHERE tenant=? AND plugin=?';
  const [old] = await c.query(sql + ` AS OF '${evidence.before}'` + where, [TENANT, PLUGIN]);
  const [now] = await c.query(sql + where, [TENANT, PLUGIN]);
  assert.equal(old.length, 1); assert.equal(now.length, 1);
  for (const row of [old[0], now[0]]) {
    assert.equal(Number(row.installed), 1); assert.equal(Number(row.enabled), 1); assert.equal(Number(row.faulted), 0);
  }
  assert.deepEqual(json(old[0].grants_json), { install: true });
  assert.deepEqual(json(now[0].grants_json), expected);
  if (!prepare) return { checked: true, changed: false, branch: BRANCH };
  // Refuses if this branch already exists. Does not reset, delete, merge or alter other rows.
  await c.query('CALL DOLT_CHECKOUT(?, ?, ?)', ['-b', BRANCH, evidence.head]);
  await c.beginTransaction();
  try {
    const [r] = await c.query('UPDATE plugin_runtime_state SET grants_json=? WHERE tenant=? AND plugin=? AND installed=1 AND enabled=1 AND faulted=0 AND grants_json=CAST(? AS JSON)', [JSON.stringify({ install: true }), TENANT, PLUGIN, JSON.stringify(json(now[0].grants_json))]);
    assert.equal(r.affectedRows, 1, 'concurrent state change: stop');
    const [diff] = await c.query('SELECT table_name FROM dolt_status');
    assert.deepEqual(diff.map(x => x.table_name), ['plugin_runtime_state']);
    await c.commit();
    await c.query("CALL DOLT_ADD('plugin_runtime_state')");
    await c.query('CALL DOLT_COMMIT(?, ?, ?, ?)', ['-m', 'Restore only workflows-iga install grant after 2026-11-16 incident', '--author', 'Lyam operator <operator@example.invalid>']);
    return { checked: true, changed: true, branch: BRANCH, mainUnchanged: true, requiresHumanReviewAndApply: true };
  } catch (e) { await c.rollback(); throw e; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.env.DOLT_DB, 'DOLT_DB required');
  assert.ok(/^[a-zA-Z0-9_]+$/.test(process.env.DOLT_DB), 'invalid database');
  assert.ok(process.argv.slice(2).every(x => x === '--prepare'), 'only --prepare is accepted');
  const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
  const { createConnection } = require('mysql2/promise');
  const c = await createConnection({ host: process.env.DOLT_HOST ?? '127.0.0.1', port: Number(process.env.DOLT_PORT ?? 3307), user: process.env.DOLT_USER ?? 'root', password: process.env.DOLT_PASSWORD ?? '', database: `${process.env.DOLT_DB}/main` });
  try { console.log(JSON.stringify(await prepareRepair(c, process.argv.includes('--prepare')))); } finally { await c.end(); }
}
