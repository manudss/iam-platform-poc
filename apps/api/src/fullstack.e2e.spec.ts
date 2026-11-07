// FULL local chain in ONE test, no stub: real Dolt (data) -> real DoltService export -> ActivationService with REAL PostgreSQL journal
// -> REAL Rust core (applies the version, decides) -> the core emits activation.applied on the REAL bus -> durable consumer (real PostgreSQL ledger).
// Not covered here: Temporal (temporal.e2e.spec.ts), Docker Compose containers (CI job `compose`), gRPC (compose-app.e2e.spec.ts), a real external effect behind the consumer.
// Skipped if any of the dolt, postgres, nats binaries or the core binary is missing.
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'mysql2/promise';
import pg from 'pg';
import { ActivationService } from './activation/activation.service.js';
import { DoltService } from './dolt/dolt.service.js';
import { startBusHarness, busBinsPresent, BusHarness } from './testing/bus-harness.js';

const root = resolve(process.cwd(), '../..');
const doltBin = process.env.DOLT_BIN, pgBin = process.env.PG_BIN;
const have = !!doltBin && existsSync(doltBin) && !!pgBin && existsSync(join(pgBin, 'postgres')) && busBinsPresent;
const CORE = 'http://127.0.0.1:18095', ADMIN = 'local-demo-admin-token', T = 'acme-demo'; // local fictional value
const DP = 13319, PGP = 15435, NP = 14225;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('full chain: Dolt -> NestJS activation -> PostgreSQL journal -> Rust core -> bus -> durable consumer', { skip: !have && 'a required binary is missing' }, () => {
  let dolt: ChildProcess, pgp: ChildProcess, bus: BusHarness, dir: string, svc: ActivationService, pool: pg.Pool;
  const handled: string[] = [];
  const sql = async (q: string) => { const c = await createConnection({ host: '127.0.0.1', port: DP, user: 'root', database: 'iam' }); try { await c.query(q); await c.query("call dolt_commit('-Am', 'fullstack change')"); } finally { await c.end(); } };
  const decide = async (id: string) => (await (await fetch(`${CORE}/v1/decide`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant: T, principal: `User::"${id}"`, action: 'Action::"approve"', resource: 'Request::"r1"', context: {} }) })).json()) as { allow: boolean; version?: { seq: number } };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-full-'));
    const home = join(dir, 'home'), data = join(dir, 'data'); mkdirSync(home); mkdirSync(data);
    const env = { ...process.env, HOME: home };
    for (const [k, v] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(doltBin!, ['config', '--global', '--add', k, v], { env });
    assert.equal(spawnSync(doltBin!, ['sql'], { cwd: data, env, input: readFileSync(resolve(root, 'data/demo/01-schema.sql')) }).status, 0);
    dolt = spawn(doltBin!, ['sql-server', '--host', '127.0.0.1', '--port', String(DP), '--data-dir', data], { cwd: data, env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { if (spawnSync(doltBin!, ['--host', '127.0.0.1', '--port', String(DP), '--no-tls', '-u', 'root', 'sql', '-q', 'select 1'], { env }).status === 0) break; await sleep(150); }
    assert.equal(spawnSync(join(pgBin!, 'initdb'), ['-D', join(dir, 'pg'), '-U', 'poc', '--auth=trust', '-E', 'UTF8']).status, 0);
    pgp = spawn(join(pgBin!, 'postgres'), ['-D', join(dir, 'pg'), '-p', String(PGP), '-k', dir, '-c', 'listen_addresses=127.0.0.1'], { stdio: 'ignore' });
    process.env.IAM_PG_URL = `postgres://poc@127.0.0.1:${PGP}/postgres`;
    pool = new pg.Pool({ connectionString: process.env.IAM_PG_URL });
    for (let k = 0; k < 100; k++) { try { await pool.query('select 1'); break; } catch { await sleep(200); } }
    bus = await startBusHarness({ natsPort: NP, corePort: 18095, token: ADMIN });
    Object.assign(process.env, { DOLT_PORT: String(DP), DOLT_DATABASE: 'iam' });
    svc = new ActivationService(undefined, new DoltService());
    await bus.host.serveService('fullstack-consumer', ['activation.applied'], async (env) => {
      const p = env.payload as { tenant: string; seq: number };
      handled.push(`${p.tenant}:${p.seq}`);
    });
  });
  after(async () => {
    await svc?.onModuleDestroy(); await pool?.end();
    delete process.env.IAM_PG_URL;
    await bus?.close(); pgp?.kill(); dolt?.kill(); await sleep(800);
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  it('data change in Dolt -> activation applied in the core -> decision flips -> event consumed exactly once by the idempotent consumer', async () => {
    assert.equal((await decide('demo-alice')).allow, false); // fail closed before any activation
    await sql("insert into assignments values ('demo-alice','payment-approver')");
    const head = await new DoltService().head();
    const a = await svc.activate(T, head, 'req-full-0001');
    assert.equal(a.state, 'applied'); assert.equal(a.seq, 1);
    const d = await decide('demo-alice');
    assert.equal(d.allow, true); assert.equal(d.version?.seq, 1); // the REAL core applied the REAL Dolt export
    assert.deepEqual((await pool.query('select state, seq from activations')).rows.map((r) => [r.state, r.seq]), [['applied', 1]]); // durable PG journal
    for (let i = 0; i < 60 && !handled.includes(`${T}:1`); i++) { await sleep(100); } // push delivery: nothing to relay
    assert.deepEqual(handled.filter((k) => k === `${T}:1`), [`${T}:1`]);
  });
  it('same request id again: no new seq, no new event; a SoD-violating data version is computed by the core after the next activation', async () => {
    const again = await svc.activate(T, await new DoltService().head(), 'req-full-0001');
    assert.equal(again.seq, 1);
    await sql("insert into assignments values ('demo-bob','payment-approver')"); // bob is creator and approver in the demo data => SoD
    const b = await svc.activate(T, await new DoltService().head(), 'req-full-0002');
    assert.equal(b.seq, 2); assert.equal(b.state, 'applied');
    assert.equal((await decide('demo-bob')).allow, false);
    assert.equal((await decide('demo-alice')).allow, true);
    for (let i = 0; i < 60 && !handled.includes(`${T}:2`); i++) { await sleep(100); }
    assert.deepEqual([...handled].sort(), [`${T}:1`, `${T}:2`]);
  });
});
