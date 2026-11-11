// Real Temporal dev server (temporal CLI binary, no Docker) + real Dolt + in-process worker.
// TEMPORAL_BIN and DOLT_BIN needed; skipped with a message otherwise.
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module.js';
import { AuthGuard } from './auth/auth.guard.js';
import { TemporalService } from './temporal/temporal.service.js';
import { DoltService } from './dolt/dolt.service.js';
import { startTestBus, TestBus } from './testing/test-bus.js';

// Step 3 cleanup (decision 6): AppModule requires a reachable bus - one nats+core pair for this spec file.
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const root = resolve(process.cwd(), '../..');
const tBin = process.env.TEMPORAL_BIN, dBin = process.env.DOLT_BIN;
const have = !!tBin && existsSync(tBin) && !!dBin && existsSync(dBin);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Temporal activation workflow (real Temporal dev server + real Dolt)', { skip: !have && 'TEMPORAL_BIN / DOLT_BIN not set' }, () => {
  let temporal: ChildProcess, dolt: ChildProcess, dir: string, mod: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-temporal-'));
    const home = join(dir, 'h'), data = join(dir, 'd'); mkdirSync(home); mkdirSync(data);
    const env = { ...process.env, HOME: home };
    for (const [k, v] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(dBin!, ['config', '--global', '--add', k, v], { env });
    assert.equal(spawnSync(dBin!, ['sql'], { cwd: data, env, input: readFileSync(resolve(root, 'data/demo/01-schema.sql')) }).status, 0);
    dolt = spawn(dBin!, ['sql-server', '--host', '127.0.0.1', '--port', '13308', '--data-dir', data], { cwd: data, env, stdio: 'ignore' });
    temporal = spawn(tBin!, ['server', 'start-dev', '--headless', '--ip', '127.0.0.1', '--port', '17234', '--http-port', '18234', '--metrics-port', '19234', '--db-filename', join(dir, 't.db')], { stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:18234/api/v1/namespaces')).ok) break; } catch { /* retry */ } await sleep(300); }
    await sleep(1000);
    Object.assign(process.env, { IAM_TEMPORAL_ADDR: '127.0.0.1:17234', DOLT_PORT: '13308', DOLT_DATABASE: 'iam' });
    delete process.env.IAM_PG_URL;
    mod = await Test.createTestingModule({ imports: [AppModule] }).overrideGuard(AuthGuard).useValue({ canActivate: () => true }).compile(); // guard covered elsewhere
    await mod.init();
  });
  after(async () => {
    await mod?.close(); delete process.env.IAM_TEMPORAL_ADDR;
    // Wait for database writers to exit before removing their files. kill() only sends a signal.
    const stop = async (child?: ChildProcess) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    };
    await Promise.all([stop(temporal), stop(dolt)]);
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('workflow verifies the Dolt commit, then journals the activation', async () => {
    const head = await mod.get(DoltService).head();
    const r = await mod.get(TemporalService).activate('acme-demo', head);
    assert.equal(r.commit, head);
    assert.equal(r.seq, 1);
    assert.equal((await mod.get(TemporalService).activate('acme-demo', head)).seq, 2);
  });
  it('a commit that is not on Dolt main fails the workflow and nothing is journaled', async () => {
    await assert.rejects(() => mod.get(TemporalService).activate('acme-demo', 'v'.repeat(32)), /not on Dolt main|Workflow execution failed/);
    const { ActivationService } = await import('./activation/activation.service.js');
    assert.equal((await mod.get(ActivationService).list('acme-demo')).length, 2);
  });
});
