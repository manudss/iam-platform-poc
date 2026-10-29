// APPLICATION path against the REAL docker-compose services (Dolt, PostgreSQL, NATS containers started by the CI job `compose`), not only
// container smoke checks: Dolt (container) data change -> NestJS DoltService export -> ActivationService with the container PostgreSQL journal+outbox
// -> REAL Rust core binary (built by the CI job, gRPC enabled) applies it -> gRPC decision flips -> outbox relay -> NATS container -> idempotent consumer.
// Skipped unless COMPOSE_STACK=1 and the core binary exists. Core runs as a local process (it has no container image in this POC) bound to loopback.
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createConnection } from 'mysql2/promise';
import pg from 'pg';
import { ActivationService } from './activation/activation.service.js';
import { NatsService } from './integrations/nats.service.js';
import { ActivationConsumer } from './integrations/activation-consumer.js';
import { DoltService } from './dolt/dolt.service.js';
import { CoreGrpc } from './access/core-grpc.js';

const root = resolve(process.cwd(), '../..');
const coreBin = resolve(root, 'core/target/debug/iam-core');
const on = process.env.COMPOSE_STACK === '1' && existsSync(coreBin);
const PW = process.env.COMPOSE_PW ?? 'dev-only-change-me'; // .env.example value, local only
const HTTP = 'http://127.0.0.1:18098', GRPC = '127.0.0.1:18099', ADMIN = 'local-demo-admin-token', T = `compose-app-${Date.now()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('application path on the docker-compose services (Dolt, PostgreSQL, NATS containers + real core over gRPC)', { skip: !on && 'COMPOSE_STACK=1 and core binary required' }, () => {
  let core: ChildProcess, svc: ActivationService, ns: NatsService, cons: ActivationConsumer, pool: pg.Pool, g: CoreGrpc;
  const handled: string[] = [];
  const sql = async (q: string) => {
    const c = await createConnection({ host: '127.0.0.1', port: 3307, user: 'root', password: PW, database: 'iam' });
    try { await c.query(q); await c.query("call dolt_commit('-Am', 'compose-app change', '--author', 'poc <poc@example.invalid>')"); } finally { await c.end(); }
  };
  const decide = (id: string) => g.decide({ tenant: T, principal: `User::"${id}"`, action: 'Action::"approve"', resource: 'Request::"r1"', context: {} });

  before(async () => {
    Object.assign(process.env, { DOLT_PORT: '3307', DOLT_PASSWORD: PW, DOLT_DATABASE: 'iam', IAM_PG_URL: `postgres://postgres:${PW}@127.0.0.1:5433/runtime`,
      IAM_NATS_URL: '127.0.0.1:4222', IAM_CORE_URL: HTTP, IAM_CORE_ADMIN_TOKEN: ADMIN });
    pool = new pg.Pool({ connectionString: process.env.IAM_PG_URL });
    core = spawn(coreBin, [], { cwd: resolve(root, 'core'), env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18098', IAM_CORE_GRPC_ADDR: GRPC, IAM_ISSUER: HTTP, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar') }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${HTTP}/health`)).ok) break; } catch { await sleep(100); } }
    g = new CoreGrpc(GRPC);
    ns = new NatsService(); svc = new ActivationService(undefined, ns, new DoltService());
    cons = new ActivationConsumer(pool, async (e, key) => { if (e.tenant === T) handled.push(key); });
    await ns.publish('iam.activation.compose-app-warmup', { tenant: 'compose-app-warmup', seq: 0, commit: 'x', state: 'applied' }); // makes sure the stream exists
    await cons.start('127.0.0.1:4222', `compose-app-${Date.now()}`);
  });
  after(async () => {
    await cons?.stop(); await svc?.onModuleDestroy(); await ns?.onModuleDestroy(); await pool?.end(); g?.close(); core?.kill(); await sleep(300);
  });

  it('Dolt container change -> activation -> core (gRPC decision flips) -> outbox -> NATS container -> consumer once', async () => {
    assert.equal((await decide('demo-alice')).allow, false); // fail closed before activation
    await sql("insert into assignments values ('demo-alice','payment-approver')");
    const a = await svc.activate(T, await new DoltService().head(), `req-${T}-1`);
    assert.equal(a.state, 'applied'); assert.equal(a.seq, 1);
    const d = await decide('demo-alice');
    assert.equal(d.allow, true); assert.equal(d.version?.seq, 1);
    assert.equal((await decide('demo-bob')).allow, false); // bob only has payment-creator in the seed
    assert.equal((await svc.activate(T, await new DoltService().head(), `req-${T}-1`)).seq, 1); // idempotent per request id
    for (let i = 0; i < 80 && !handled.includes(`${T}:1`); i++) { await svc.relay(); await sleep(150); }
    assert.deepEqual(handled.filter((k) => k === `${T}:1`), [`${T}:1`]);
    // the handler runs inside the consumer's transaction: `handled` fills before the COMMIT, so wait for the row (same assertion, no race)
    let n = 0;
    for (let i = 0; i < 40 && n !== 1; i++) { n = (await pool.query('select count(*)::int n from processed_events where tenant=$1', [T])).rows[0].n; if (n !== 1) await sleep(100); }
    assert.equal(n, 1);
  });
});
