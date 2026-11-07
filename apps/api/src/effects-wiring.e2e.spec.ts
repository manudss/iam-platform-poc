// WIRING of the opt-in EffectsService (IAM_EFFECTS=1), no stub: real Dolt data -> real DoltService export/snapshotAt -> ActivationService (real PostgreSQL journal)
// -> REAL Rust core (emits activation.applied on the REAL bus when it applies) -> EffectsService durable bus subscriber (Nest lifecycle, env-driven)
// -> notification sink + provisioning target started by this test on loopback.
// Nothing leaves the machine. Skipped if any of the dolt, postgres, nats binaries or the core binary is missing.
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
import { EffectsService } from './effects/effects.service.js';
import { startBusHarness, busBinsPresent, BusHarness } from './testing/bus-harness.js';
import { createServer, Server } from 'node:http';
import { DoltService } from './dolt/dolt.service.js';

const root = resolve(process.cwd(), '../..');
const doltBin = process.env.DOLT_BIN, pgBin = process.env.PG_BIN;
const have = !!doltBin && existsSync(doltBin) && !!pgBin && existsSync(join(pgBin, 'postgres')) && busBinsPresent;
const CORE = 'http://127.0.0.1:18096', ADMIN = 'local-demo-admin-token', T = 'acme-demo'; // local fictional value
const DP = 13329, PGP = 15445, NP = 14235, SINK = 18161, TARGET = 18162;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('EffectsService wiring: real Dolt export + PostgreSQL + core + bus -> local sink and provisioning target', { skip: !have && 'a required binary is missing' }, () => {
  let dolt: ChildProcess, pgp: ChildProcess, bus: BusHarness, dir: string, svc: ActivationService, eff: EffectsService, sink: Server, target: Server, pool: pg.Pool;
  type Call = { method: string; url: string; key: string; body: string };
  const sinkCalls: Call[] = [], targetCalls: Call[] = []; let sinkFail = 0;
  const listen = (port: number, calls: Call[], fail?: () => boolean) => new Promise<Server>((ok) => { const sv = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { if (fail?.()) { res.statusCode = 503; return res.end(); } const key = String(req.headers['idempotency-key'] ?? ''); if (!calls.some((c) => c.key === key)) calls.push({ method: req.method!, url: req.url!, key, body: b }); res.statusCode = 204; res.end(); }); }); sv.listen(port, '127.0.0.1', () => ok(sv)); });
  const pump = async (until: () => boolean) => { for (let i = 0; i < 150 && !until(); i++) { await sleep(100); } }; // push delivery: nothing to relay
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
    bus = await startBusHarness({ natsPort: NP, corePort: 18096, token: ADMIN });
    Object.assign(process.env, { DOLT_PORT: String(DP), DOLT_DATABASE: 'iam' });
    svc = new ActivationService(undefined, new DoltService());
    sink = await listen(SINK, sinkCalls, () => (sinkFail > 0 ? (sinkFail--, true) : false)); target = await listen(TARGET, targetCalls);
    Object.assign(process.env, { IAM_EFFECTS: '1', IAM_NOTIFY_SINK_URL: `http://127.0.0.1:${SINK}`, IAM_PROVISION_TARGET_URL: `http://127.0.0.1:${TARGET}` });
    eff = new EffectsService(new DoltService(), undefined, bus.ref); await eff.onModuleInit(); // the real Nest lifecycle hook, driven only by the environment
  });
  after(async () => {
    await eff?.onModuleDestroy(); sink?.close(); target?.close(); delete process.env.IAM_EFFECTS; await svc?.onModuleDestroy(); await pool?.end();
    delete process.env.IAM_PG_URL;
    await bus?.close(); pgp?.kill(); dolt?.kill(); await sleep(800);
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  it('activation 1 (real Dolt data): the sink gets the notification and the target gets the grant, once, with idempotency keys', async () => {
    await sql("insert into assignments values ('demo-alice','payment-approver')");
    const a = await svc.activate(T, await new DoltService().head(), 'req-eff-0001');
    assert.deepEqual([a.state, a.seq], ['applied', 1]);
    await pump(() => sinkCalls.length >= 3 && targetCalls.length >= 3);
    assert.equal(sinkCalls.length, 3); assert.equal(targetCalls.length, 3); // the seeded demo data already holds alice/mcp-operator and bob/payment-creator, plus the new alice grant
    const ai = sinkCalls.findIndex((c) => c.key.includes('demo-alice:payment-approver')), ti = targetCalls.findIndex((c) => c.url.includes('/Users/demo-alice/Roles/payment-approver'));
    assert.deepEqual(sinkCalls.map((c) => c.key).sort(), [`${T}:1:notify:demo-alice:mcp-operator:granted`, `${T}:1:notify:demo-alice:payment-approver:granted`, `${T}:1:notify:demo-bob:payment-creator:granted`]);
    const n = JSON.parse(sinkCalls[ai].body);
    assert.deepEqual([n.type, n.tenant, n.activation, n.subject, n.role, n.change], ['role.changed', T, 1, 'demo-alice', 'payment-approver', 'granted']);
    assert.equal(n.to, 'manager-of:demo-alice'); // fictional recipient, never a person
    assert.deepEqual([targetCalls[ti].method, targetCalls[ti].url], ['PUT', '/Users/demo-alice/Roles/payment-approver']);
    
  });
  it('activation 2: grant AND revoke computed from two REAL Dolt commits; a failing sink is retried by redelivery and ends with exactly one call per effect key', async () => {
    sinkFail = 2; // the first two sink answers are 503
    await sql("insert into assignments values ('demo-bob','payment-approver')");
    await sql("delete from assignments where identity_id='demo-alice' and role_id='payment-approver'");
    const b = await svc.activate(T, await new DoltService().head(), 'req-eff-0002');
    assert.deepEqual([b.state, b.seq], ['applied', 2]);
    await pump(() => sinkCalls.length >= 5 && targetCalls.length >= 5);
    const want = [`${T}:2:notify:demo-alice:payment-approver:revoked`, `${T}:2:notify:demo-bob:payment-approver:granted`];
    assert.deepEqual(sinkCalls.filter((c) => c.key.startsWith(`${T}:2:`)).map((c) => c.key).sort(), want);
    assert.deepEqual(targetCalls.filter((c) => c.key.startsWith(`${T}:2:`)).map((c) => `${c.method} ${c.url}`).sort(), ['DELETE /Users/demo-alice/Roles/payment-approver', 'PUT /Users/demo-bob/Roles/payment-approver']);
    assert.equal(new Set(sinkCalls.map((c) => c.key)).size, sinkCalls.length); // no duplicate effect key reached the sink
    assert.equal((await pool.query("select count(*)::int n from effects where state <> 'done'")).rows[0].n, 0); // every effect ended done after the retries
    assert.equal((await pool.query("select count(*)::int n from effects where tenant=$1", [T])).rows[0].n, 10); // (3+2 changes) x (notify, provision)
  });
  it('the startup catch-up replays the journal without repeating any effect (idempotent per effect key)', async () => {
    const before = [sinkCalls.length, targetCalls.length];
    // A fresh EffectsService (an API restart) replays every applied activation of the journal: per-effect keys make it a no-op.
    const eff2 = new EffectsService(new DoltService(), undefined, bus.ref);
    await eff2.onModuleInit();
    await sleep(500);
    assert.deepEqual([sinkCalls.length, targetCalls.length], before);
    await eff2.onModuleDestroy();
  });
  it('negative: a non-loopback target URL is refused before any request (nothing leaves the machine)', async () => {
    const { assertLoopback } = await import('./effects/loopback.js');
    assert.throws(() => assertLoopback('http://example.org:80'), /not a loopback host/);
    assert.throws(() => assertLoopback('https://127.0.0.1:1'), /http on loopback/);
  });
});
