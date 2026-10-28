// Plugin registry on REAL PostgreSQL (no Docker): migrations really create tables, state survives a restart, tenants are isolated.
// Needs PG_BIN = dir with initdb/postgres (npm i embedded-postgres). Skipped otherwise.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { PluginRegistry, PluginError } from './registry.js';
import { PgPluginStore } from './pg-stores.js';
import { authPassword, authPasswordLockout, notifyLog, orgManager } from './builtin/index.js';

const bin = process.env.PG_BIN;
const have = !!bin && existsSync(join(bin, 'postgres')) && existsSync(join(bin, 'initdb'));
const PORT = 15433;
const good = { subject: 'demo-user-1', credential: { password: 'demo-pass-1' } };

describe('plugin registry on real PostgreSQL', { skip: !have && 'PG_BIN not set or postgres binaries missing' }, () => {
  let proc: ChildProcess, dir: string, pool: pg.Pool;
  const make = async () => {
    const s = new PgPluginStore(pool);
    const r = new PluginRegistry(s, s, () => {}, s);
    for (const p of [authPassword, notifyLog, authPasswordLockout(), orgManager]) r.register(p);
    await r.load();
    return r;
  };
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-plg-pg-'));
    const i = spawnSync(join(bin!, 'initdb'), ['-D', join(dir, 'd'), '-U', 'poc', '--auth=trust', '-E', 'UTF8']);
    assert.equal(i.status, 0, String(i.stderr));
    proc = spawn(join(bin!, 'postgres'), ['-D', join(dir, 'd'), '-p', String(PORT), '-k', dir, '-c', 'listen_addresses=127.0.0.1'], { stdio: 'ignore' });
    pool = new pg.Pool({ connectionString: `postgres://poc@127.0.0.1:${PORT}/postgres`, max: 3 });
    for (let k = 0; k < 100; k++) { try { await pool.query('select 1'); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  });
  after(async () => { await pool?.end(); proc?.kill(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('install creates real tables and seeds per tenant; a second tenant does not see the first tenant\'s rows', async () => {
    const r = await make();
    await r.install('t1', 'org-manager', { install: true });
    await r.install('t2', 'org-manager', { install: true });
    await r.install('t1', 'org-manager', { install: true }); // idempotent
    const t = await pool.query("select tenant, id from plg_org_manager_orgs order by tenant");
    assert.deepEqual(t.rows, [{ tenant: 't1', id: 'root' }, { tenant: 't2', id: 'root' }]);
    assert.equal((await pool.query("select count(*)::int n from plugin_migrations where plugin = 'org-manager'")).rows[0].n, 1);
    await assert.rejects(r.install('t3', 'org-manager', {}), (e: PluginError) => e.code === 'grant-required');
  });

  it('settings, enablement, grants and fault survive a restart; return to base after disable is persisted too', async () => {
    let r = await make();
    await r.install('t1', 'auth-password-lockout', { install: true });
    await r.configure('t1', 'auth-password-lockout', { maxFailures: 2 });
    await r.enable('t1', 'auth-password-lockout', { hooks: ['auth.authenticate'] });
    assert.equal((await pool.query("select to_regclass('plg_auth_password_lockout_attempts') t")).rows[0].t, 'plg_auth_password_lockout_attempts');
    r = await make(); // restart
    assert.equal((await r.callSlot<any>('t1', 'auth.password', 'auth.authenticate', good)).servedBy, 'auth-password-lockout');
    assert.equal((await r.form('t1', 'auth-password-lockout')).groups.flatMap((g) => g.fields).find((f) => f.key === 'maxFailures')!.value, 2);
    assert.equal((await r.callSlot<any>('t2', 'auth.password', 'auth.authenticate', good)).servedBy, 'auth-password'); // other tenant untouched
    // a technical fault is persisted: after a restart the slot still refuses, the base is not asked
    const broken = authPasswordLockout(); broken.handlers['auth.authenticate'] = () => { throw new Error('boom'); };
    const s = new PgPluginStore(pool); const r2 = new PluginRegistry(s, s, () => {}, s);
    for (const p of [authPassword, notifyLog, broken, orgManager]) r2.register(p);
    await r2.load();
    await assert.rejects(r2.callSlot('t1', 'auth.password', 'auth.authenticate', good), (e: PluginError) => e.code === 'plugin-failed');
    r = await make();
    await assert.rejects(r.callSlot('t1', 'auth.password', 'auth.authenticate', good), (e: PluginError) => e.code === 'plugin-failed');
    await r.disable('t1', 'auth-password-lockout');
    r = await make();
    assert.equal((await r.callSlot<any>('t1', 'auth.password', 'auth.authenticate', good)).servedBy, 'auth-password');
  });
});
