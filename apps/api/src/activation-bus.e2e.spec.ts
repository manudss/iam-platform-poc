// The single activation circuit on REAL PostgreSQL and the REAL bus (nats-server + iam-core), Dolt stubbed
// (snapshot export is tested against real Dolt in activation.e2e.spec.ts). Step 3: the core owns and emits the
// durable activation.applied event when it applies a version; the API journals and pushes, it never re-emits.
// Skipped if a binary is missing.
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { ActivationService } from './activation/activation.service.js';
import { DoltService } from './dolt/dolt.service.js';
import { startBusHarness, busBinsPresent, coreBin, BusHarness } from './testing/bus-harness.js';

const root = resolve(process.cwd(), '../..');
const pgBin = process.env.PG_BIN;
const have = busBinsPresent && !!pgBin && existsSync(join(pgBin, 'postgres'));
const CORE = 'http://127.0.0.1:18093', ADMIN = 'local-demo-admin-token', PGP = 15433, NP = 14223;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dolt = { snapshotAt: async () => ({ assignments: [{ identity_id: 'demo-alice', role_id: 'payment-approver' }], sod_rules: [] }), tagActivation: async () => undefined } as unknown as DoltService;
const respawnCore = () => { const c = spawn(coreBin, [], { cwd: resolve(root, 'core'), env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18093', IAM_ISSUER: CORE, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar'), IAM_CORE_ADMIN_TOKEN: ADMIN, IAM_CORE_NATS_URL: `127.0.0.1:${NP}`, IAM_CORE_NATS_PASSWORD: 'core-dev' }, stdio: 'ignore' }); c.unref(); return c; };
const waitCore = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${CORE}/health`)).ok) return; } catch { await sleep(100); } } };

describe('single activation circuit (real PostgreSQL and bus; Dolt stubbed)', { skip: !have && 'NATS_SERVER_BIN, PG_BIN or core binary missing' }, () => {
  let pgp: ChildProcess, pgdir: string, bus: BusHarness;
  const received: { tenant: string; seq: number; commit: string }[] = [];
  const q = async (sql: string) => { const c = new pg.Client({ connectionString: process.env.IAM_PG_URL }); await c.connect(); try { return (await c.query(sql)).rows; } finally { await c.end(); } };
  const until = async (pred: () => boolean, ms = 8000) => { const t0 = Date.now(); while (!pred() && Date.now() - t0 < ms) await sleep(100); };

  before(async () => {
    pgdir = mkdtempSync(join(tmpdir(), 'iam-activation-bus-'));
    assert.equal(spawnSync(join(pgBin!, 'initdb'), ['-D', join(pgdir, 'd'), '-U', 'poc', '--auth=trust', '-E', 'UTF8']).status, 0);
    pgp = spawn(join(pgBin!, 'postgres'), ['-D', join(pgdir, 'd'), '-p', String(PGP), '-k', pgdir, '-c', 'listen_addresses=127.0.0.1'], { stdio: 'ignore' });
    process.env.IAM_PG_URL = `postgres://poc@127.0.0.1:${PGP}/postgres`;
    for (let k = 0; k < 100; k++) { try { await q('select 1'); break; } catch { await sleep(200); } }
    bus = await startBusHarness({ natsPort: NP, corePort: 18093, token: ADMIN });
    await bus.host.serveService('activation-test-consumer', ['activation.applied'], async (env) => {
      received.push(env.payload as { tenant: string; seq: number; commit: string });
    });
  });
  after(async () => { delete process.env.IAM_PG_URL; await bus?.close(); pgp?.kill(); if (pgdir) rmSync(pgdir, { recursive: true, force: true }); });

  it('the core applies and emits activation.applied on the bus; the API journals and never re-emits', async () => {
    const svc = new ActivationService(undefined, dolt);
    const a = await svc.activate('t1', 'aaaaaaaa', 'req-bus-0001');
    assert.equal(a.state, 'applied'); assert.equal(a.event, 'core');
    await until(() => received.some((e) => e.tenant === 't1' && e.seq === 1));
    assert.equal(received.filter((e) => e.tenant === 't1' && e.seq === 1).length, 1, 'one durable event, emitted by the core');
    await svc.onModuleDestroy();
  });
  it('retry of the same request: same activation, no new event; a new request is a new seq with its own event', async () => {
    const svc = new ActivationService(undefined, dolt);
    assert.equal((await svc.activate('t1', 'aaaaaaaa', 'req-bus-0001')).seq, 1); // already applied: no core call, no event
    const b = await svc.activate('t1', 'aaaaaaaa', 'req-bus-0002');
    assert.equal(b.seq, 2); assert.equal(b.event, 'core');
    await until(() => received.some((e) => e.tenant === 't1' && e.seq === 2));
    assert.equal(received.filter((e) => e.tenant === 't1' && e.seq === 1).length, 1, 'seq 1 emitted once');
    assert.equal(received.filter((e) => e.tenant === 't1' && e.seq === 2).length, 1, 'seq 2 emitted once');
    await svc.onModuleDestroy();
  });
  it('core down: failed in PostgreSQL; retry of the same request after the core is back applies it and the event flows', async () => {
    bus.core!.kill(); await sleep(300);
    const svc = new ActivationService(undefined, dolt);
    const f = await svc.activate('t2', 'bbbbbbbb', 'req-bus-0003');
    assert.equal(f.state, 'failed');
    assert.equal((await q("select state from activations where tenant='t2'"))[0].state, 'failed');
    bus.core = respawnCore(); await waitCore();
    const r = await svc.activate('t2', 'bbbbbbbb', 'req-bus-0003');
    assert.equal(r.state, 'applied'); assert.equal(r.seq, 1); assert.equal(r.event, 'core');
    await until(() => received.some((e) => e.tenant === 't2' && e.seq === 1));
    await svc.onModuleDestroy();
  });
  it('a failing durable handler is redelivered (at-least-once) with the same effect key', async () => {
    const seen: string[] = [];
    let failOnce = true;
    await bus.host.serveService('activation-flaky-consumer', ['activation.applied'], async (env) => {
      const p = env.payload as { tenant: string };
      if (p.tenant !== 'tc') return;
      seen.push(String(env.effect_key));
      if (failOnce) { failOnce = false; throw new Error('boom'); } // nak -> redelivery, same effect key
    });
    const svc = new ActivationService(undefined, dolt);
    const a = await svc.activate('tc', 'aaaaaaaa', 'req-bus-0004');
    assert.equal(a.event, 'core');
    await until(() => seen.length >= 2, 15000);
    assert.equal(seen.length, 2, 'the failure was redelivered');
    assert.equal(seen[0], seen[1]);
    await svc.onModuleDestroy();
  });
  it('background loop: after the core restarts and loses its version, tick() / the timer re-applies it by itself', async () => {
    const svc = new ActivationService(undefined, dolt);
    bus.core!.kill(); await sleep(300);
    bus.core = respawnCore(); await waitCore();
    assert.equal((await fetch(`${CORE}/v1/version?tenant=t1`)).status, 404); // fresh core, no memory
    const r = await svc.tick();
    assert.ok(r.reconciled.includes('t1') && r.reconciled.includes('t2'));
    assert.equal((await (await fetch(`${CORE}/v1/version?tenant=t1`)).json() as { seq: number }).seq, 2);
    // same thing driven by the timer
    bus.core!.kill(); await sleep(300);
    bus.core = respawnCore(); await waitCore();
    process.env.IAM_RECONCILE_INTERVAL_MS = '300'; svc.onModuleInit(); delete process.env.IAM_RECONCILE_INTERVAL_MS;
    for (let i = 0; i < 30 && (await fetch(`${CORE}/v1/version?tenant=t1`)).status !== 200; i++) await sleep(200);
    assert.equal((await fetch(`${CORE}/v1/version?tenant=t1`)).status, 200);
    await svc.onModuleDestroy();
  });
});
