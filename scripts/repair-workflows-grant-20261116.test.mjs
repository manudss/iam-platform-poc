import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareRepair, BEFORE, INCIDENT_HEAD } from './repair-workflows-grant-20261116.mjs';
const row = grants => ({ tenant: 'acme-demo', plugin: 'workflows-iga', installed: 1, enabled: 1, faulted: 0, grants_json: JSON.stringify(grants) });
function connection({ head = INCIDENT_HEAD, old = { install: true }, now = { hooks: [], install: false, uiComponents: false }, dirty = [], affected = 1 } = {}) {
  const calls = [];
  return { calls,
    async query(sql, params) {
      calls.push([sql, params]);
      if (sql.includes("hashof('main')")) return [[{ h: head }]];
      if (sql === 'SELECT * FROM dolt_status') return [dirty];
      if (sql.includes('AS OF')) return [[row(old)]];
      if (sql.startsWith('SELECT tenant')) return [[row(now)]];
      if (sql.startsWith('UPDATE')) return [{ affectedRows: affected }];
      if (sql.startsWith('SELECT table_name')) return [[{ table_name: 'plugin_runtime_state' }]];
      return [[]];
    },
    async beginTransaction() { calls.push(['begin']); }, async commit() { calls.push(['commit']); }, async rollback() { calls.push(['rollback']); },
  };
}
test('default only reads evidence', async () => {
  const c = connection(); assert.equal((await prepareRepair(c)).changed, false);
  assert.ok(c.calls.every(([s]) => s.startsWith('SELECT')));
});
test('prepares just the exact row on a new branch and never merges main', async () => {
  const c = connection(); const r = await prepareRepair(c, true);
  assert.equal(r.mainUnchanged, true);
  const update = c.calls.find(([s]) => s.startsWith('UPDATE'));
  assert.deepEqual(update[1], ['{"install":true}', 'acme-demo', 'workflows-iga', '{"hooks":[],"install":false,"uiComponents":false}']);
  assert.ok(!c.calls.some(([s]) => /MERGE|RESET|DROP|DELETE/i.test(s)));
});
for (const [name, options] of Object.entries({ changedMain: { head: 'new' }, dirty: { dirty: [{ table_name: 'identities' }] }, changedOld: { old: { install: false } }, changedNow: { now: { install: true } } })) {
  test('refuses before writing: ' + name, async () => {
    const c = connection(options); await assert.rejects(prepareRepair(c, true));
    assert.ok(c.calls.every(([s]) => s.startsWith('SELECT')));
  });
}
test('rolls back concurrent row mismatch', async () => {
  const c = connection({ affected: 0 }); await assert.rejects(prepareRepair(c, true));
  assert.ok(c.calls.some(([s]) => s === 'rollback')); assert.ok(!c.calls.some(([s]) => s.includes('DOLT_COMMIT')));
});

test('real isolated Dolt: exact branch repair, main unchanged, refuses second execution', { skip: !process.env.DOLT_BIN }, async () => {
  const { spawn, spawnSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createRequire } = await import('node:module');
  const { createConnection } = createRequire(new URL('../apps/api/package.json', import.meta.url))('mysql2/promise');
  const dir = mkdtempSync(join(tmpdir(), 'lyam-repair-test-'));
  const home = join(dir, 'home'), data = join(dir, 'repair_fixture'); mkdirSync(home); mkdirSync(data);
  const env = { ...process.env, HOME: home };
  const cli = args => { const r = spawnSync(process.env.DOLT_BIN, args, { cwd: data, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  cli(['config', '--global', '--add', 'user.name', 'repair-test']); cli(['config', '--global', '--add', 'user.email', 'test@example.invalid']);
  cli(['init']);
  cli(['sql', '-q', `CREATE TABLE plugin_runtime_state (tenant varchar(32),plugin varchar(64),installed boolean,enabled boolean,faulted boolean,grants_json JSON,PRIMARY KEY(tenant,plugin)); INSERT INTO plugin_runtime_state VALUES ('acme-demo','workflows-iga',1,1,0,'{"install":true}'),('other','workflows-iga',1,1,0,'{}')`]);
  cli(['add', '.']); cli(['commit', '-m', 'before incident']);
  const before = JSON.parse(cli(['sql', '-r', 'json', '-q', "SELECT hashof('HEAD') h"])).rows[0].h;
  cli(['sql', '-q', `UPDATE plugin_runtime_state SET grants_json='{"hooks":[],"install":false,"uiComponents":false}' WHERE tenant='acme-demo'`]);
  cli(['add', '.']); cli(['commit', '-m', 'incident fixture']);
  const head = JSON.parse(cli(['sql', '-r', 'json', '-q', "SELECT hashof('HEAD') h"])).rows[0].h;
  const child = spawn(process.env.DOLT_BIN, ['sql-server', '--host', '127.0.0.1', '--port', '13317'], { cwd: data, env, stdio: 'ignore' });
  let c;
  try {
    for (let i = 0; i < 50; i++) { try { c = await createConnection({ host: '127.0.0.1', port: 13317, user: 'root', database: 'repair_fixture' }); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    assert.ok(c, 'Dolt did not start');
    assert.equal((await prepareRepair(c, false, { before, head })).changed, false);
    assert.equal((await prepareRepair(c, true, { before, head })).mainUnchanged, true);
    const [fixed] = await c.query("SELECT grants_json FROM plugin_runtime_state WHERE tenant='acme-demo'");
    assert.deepEqual(fixed[0].grants_json, { install: true });
    const [main] = await c.query("SELECT grants_json FROM plugin_runtime_state AS OF 'main' WHERE tenant='acme-demo'");
    assert.equal(main[0].grants_json.install, false);
    const [other] = await c.query("SELECT grants_json FROM plugin_runtime_state WHERE tenant='other'");
    assert.deepEqual(other[0].grants_json, {});
    await assert.rejects(prepareRepair(c, true, { before, head }));
  } finally { await c?.end(); child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)); rmSync(dir, { recursive: true, force: true }); }
});
