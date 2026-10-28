// Outbox + core apply on REAL PostgreSQL, REAL NATS JetStream and the REAL Rust core. The Dolt service is a STUB here
// (snapshot export is tested against real Dolt in activation.e2e.spec.ts). Skipped if a binary is missing.
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect, JSONCodec } from 'nats';
import pg from 'pg';
import { ActivationService } from './activation/activation.service.js';
import { NatsService } from './integrations/nats.service.js';
import { DoltService } from './dolt/dolt.service.js';

const root = resolve(process.cwd(), '../..');
const coreBin = resolve(root, 'core/target/debug/iam-core');
const natsBin = process.env.NATS_SERVER_BIN, pgBin = process.env.PG_BIN;
const have = !!natsBin && existsSync(natsBin) && !!pgBin && existsSync(join(pgBin, 'postgres')) && existsSync(coreBin);
const CORE = 'http://127.0.0.1:18093', ADMIN = 'local-demo-admin-token', PGP = 15433, NP = 14223;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dolt = { snapshotAt: async () => ({ assignments: [{ identity_id: 'demo-alice', role_id: 'payment-approver' }], sod_rules: [] }), tagActivation: async () => undefined } as unknown as DoltService;

describe('outbox + core apply (real PostgreSQL, NATS, core; Dolt stubbed)', { skip: !have && 'NATS_SERVER_BIN, PG_BIN or core binary missing' }, () => {
  let pgp: ChildProcess, core: ChildProcess, nats: ChildProcess | undefined, dir: string;
  const q = async (sql: string) => { const c = new pg.Client({ connectionString: process.env.IAM_PG_URL }); await c.connect(); try { return (await c.query(sql)).rows; } finally { await c.end(); } };
  const startNats = async () => {
    nats = spawn(natsBin!, ['-js', '-a', '127.0.0.1', '-p', String(NP), '-sd', join(dir, 'nats')], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) { try { (await connect({ servers: `127.0.0.1:${NP}` })).close(); return; } catch { await sleep(100); } }
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-outbox-'));
    assert.equal(spawnSync(join(pgBin!, 'initdb'), ['-D', join(dir, 'd'), '-U', 'poc', '--auth=trust', '-E', 'UTF8']).status, 0);
    pgp = spawn(join(pgBin!, 'postgres'), ['-D', join(dir, 'd'), '-p', String(PGP), '-k', dir, '-c', 'listen_addresses=127.0.0.1'], { stdio: 'ignore' });
    process.env.IAM_PG_URL = `postgres://poc@127.0.0.1:${PGP}/postgres`;
    for (let k = 0; k < 100; k++) { try { await q('select 1'); break; } catch { await sleep(200); } }
    core = spawn(coreBin, [], { cwd: resolve(root, 'core'), env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18093', IAM_ISSUER: CORE, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar'), IAM_CORE_ADMIN_TOKEN: ADMIN }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${CORE}/health`)).ok) break; } catch { await sleep(100); } }
    Object.assign(process.env, { IAM_CORE_URL: CORE, IAM_CORE_ADMIN_TOKEN: ADMIN, IAM_NATS_URL: `127.0.0.1:${NP}` });
  });
  after(() => { delete process.env.IAM_PG_URL; delete process.env.IAM_NATS_URL; nats?.kill(); core?.kill(); pgp?.kill(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('NATS down: activation is applied in the core, the event stays in the outbox (unsent), nothing is lost', async () => {
    const n = new NatsService(), svc = new ActivationService(undefined, n, dolt);
    const a = await svc.activate('t1', 'aaaaaaaa', 'req-outbox-0001');
    assert.equal(a.state, 'applied'); assert.equal(a.event, 'not-published');
    assert.deepEqual((await q('select seq, sent_at is null as unsent from outbox')).map((r) => [r.seq, r.unsent]), [[1, true]]);
    const v = (await (await fetch(`${CORE}/v1/version?tenant=t1`)).json()) as { seq: number };
    assert.equal(v.seq, 1); // the core really applied it
    await svc.onModuleDestroy(); await n.onModuleDestroy();
  });
  it('after a restart of the API and NATS coming back, the relay publishes the pending event exactly once', async () => {
    await startNats();
    const n = new NatsService(), svc = new ActivationService(undefined, n, dolt); // new instance = "restart"
    assert.equal(await svc.relay(), 1);
    assert.equal(await svc.relay(), 0);
    const nc = await connect({ servers: `127.0.0.1:${NP}` });
    const cons = await nc.jetstream().consumers.get('IAM_EVENTS');
    const m = await cons.next({ expires: 3000 });
    assert.equal(m?.subject, 'iam.activation.t1');
    assert.equal(JSONCodec<{ seq: number }>().decode(m!.data).seq, 1);
    assert.equal(await cons.next({ expires: 1000 }), null); // exactly once: no duplicate
    await nc.close(); await svc.onModuleDestroy(); await n.onModuleDestroy();
  });
  it('retry of the same request: no new outbox row, no new event; a new request is a new seq with its own event', async () => {
    const n = new NatsService(), svc = new ActivationService(undefined, n, dolt);
    assert.equal((await svc.activate('t1', 'aaaaaaaa', 'req-outbox-0001')).seq, 1);
    assert.equal((await q('select count(*)::int as n from outbox'))[0].n, 1);
    const b = await svc.activate('t1', 'aaaaaaaa', 'req-outbox-0002');
    assert.equal(b.seq, 2); assert.equal(b.event, 'published');
    assert.equal((await q('select count(*)::int as n from outbox where sent_at is not null'))[0].n, 2);
    await svc.onModuleDestroy(); await n.onModuleDestroy();
  });
  it('core down: failed in PostgreSQL, no outbox row; retry of the same request after the core is back applies it', async () => {
    core.kill(); await sleep(300);
    const n = new NatsService(), svc = new ActivationService(undefined, n, dolt);
    const f = await svc.activate('t2', 'bbbbbbbb', 'req-outbox-0003');
    assert.equal(f.state, 'failed');
    assert.equal((await q("select count(*)::int as n from outbox where tenant='t2'"))[0].n, 0);
    assert.equal((await q("select state from activations where tenant='t2'"))[0].state, 'failed');
    core = spawn(coreBin, [], { cwd: resolve(root, 'core'), env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18093', IAM_ISSUER: CORE, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar'), IAM_CORE_ADMIN_TOKEN: ADMIN }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${CORE}/health`)).ok) break; } catch { await sleep(100); } }
    const r = await svc.activate('t2', 'bbbbbbbb', 'req-outbox-0003');
    assert.equal(r.state, 'applied'); assert.equal(r.seq, 1);
    assert.equal((await q("select count(*)::int as n from activations where tenant='t2'"))[0].n, 1);
    assert.equal((await q("select count(*)::int as n from outbox where tenant='t2'"))[0].n, 1);
    await svc.onModuleDestroy(); await n.onModuleDestroy();
  });
});
