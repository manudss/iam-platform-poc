// Plugin configuration versioned in a REAL Dolt server: propose on a branch, main untouched until merge, tenant isolation,
// and applying a merged version to a registry never widens grants. Skipped without DOLT_BIN (or dolt on PATH).
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DoltService } from '../../dolt/dolt.service.js';
import { PluginRegistry, PluginError } from './registry.js';
import { MemoryMigrationStore, MemorySettingsStore, MemoryStateStore } from './memory-stores.js';
import { authPassword, authPasswordLockout, notifyLog } from './builtin/index.js';

const root = resolve(process.cwd(), '../..');
const which = spawnSync('sh', ['-c', 'command -v dolt']).stdout.toString().trim();
const doltBin = process.env.DOLT_BIN ?? which;
const have = !!doltBin && existsSync(doltBin);
const T = 'acme-demo', LOCK = 'auth-password-lockout';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newRegistry = () => { const r = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore(), () => undefined, new MemoryStateStore()); for (const p of [authPassword, notifyLog, authPasswordLockout()]) r.register(p); return r; };

describe('plugin config versioned in real Dolt', { skip: !have && 'dolt binary missing' }, () => {
  let dolt: ChildProcess, dir: string; const svc = new DoltService();
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-plgdolt-'));
    const home = join(dir, 'home'), data = join(dir, 'data'); mkdirSync(home); mkdirSync(data);
    const env = { ...process.env, HOME: home };
    for (const [k, v] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(doltBin, ['config', '--global', '--add', k, v], { env });
    assert.equal(spawnSync(doltBin, ['sql'], { cwd: data, env, input: readFileSync(resolve(root, 'data/demo/01-schema.sql')) }).status, 0);
    dolt = spawn(doltBin, ['sql-server', '--host', '127.0.0.1', '--port', '13308', '--data-dir', data], { cwd: data, env, stdio: 'ignore' });
    Object.assign(process.env, { DOLT_PORT: '13308', DOLT_DATABASE: 'iam' });
    for (let i = 0; i < 100; i++) { if (spawnSync(doltBin, ['--host', '127.0.0.1', '--port', '13308', '--no-tls', '-u', 'root', 'sql', '-q', 'select 1'], { env }).status === 0) break; await sleep(150); }
  });
  after(async () => { dolt?.kill(); await sleep(800); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

  let commit = '';
  it('a proposal lives on a branch; main only changes at the explicit merge; other tenants see nothing', async () => {
    const reg = newRegistry();
    await reg.install(T, LOCK, { install: true }); await reg.configure(T, LOCK, { maxFailures: 4 }); await reg.enable(T, LOCK, { hooks: ['auth.authenticate'] });
    const cfg = await reg.exportConfig(T, LOCK);
    assert.deepEqual(cfg, { enabled: true, settings: { minLength: 12, allowedDomains: [], maxFailures: 4 } });
    const p = await svc.proposePluginConfig(T, LOCK, cfg);
    assert.deepEqual(await svc.pluginConfigAt(T, 'main'), [], 'main is untouched by a proposal');
    assert.equal((await svc.pluginConfigAt(T, p.branch)).length, 1);
    commit = (await svc.merge(p.branch)).commit;
    assert.deepEqual(await svc.pluginConfigAt(T, 'main'), [{ plugin: LOCK, enabled: true, settings: cfg.settings }]);
    assert.deepEqual(await svc.pluginConfigAt('other-tenant', 'main'), [], 'tenant isolation');
    assert.equal((await svc.pluginConfigAt(T, commit)).length, 1, 'readable at the exact commit');
  });

  it('applying a merged version uses the grants an admin already gave and never widens them', async () => {
    const [row] = await svc.pluginConfigAt(T, 'main');
    const ok = newRegistry();
    await ok.install(T, LOCK, { install: true, hooks: ['auth.authenticate'] } as never); // admin granted the sensitive hook earlier
    await ok.applyVersionedConfig(T, LOCK, row);
    assert.equal(ok.isActive(T, LOCK), true);
    assert.equal((await ok.exportConfig(T, LOCK)).settings.maxFailures, 4);
    await ok.applyVersionedConfig(T, LOCK, { enabled: false, settings: row.settings }); // a merged "disabled" version returns to base explicitly
    assert.equal(ok.isActive(T, LOCK), false);

    const noGrant = newRegistry();
    await noGrant.install(T, LOCK, { install: true });
    await assert.rejects(noGrant.applyVersionedConfig(T, LOCK, row), (e: PluginError) => e.code === 'grant-required');
    assert.equal(noGrant.isActive(T, LOCK), false, 'a data merge cannot grant a sensitive hook');
  });
});
