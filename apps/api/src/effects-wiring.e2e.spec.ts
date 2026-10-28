// WIRING of the opt-in EffectsService (IAM_EFFECTS=1), no stub: real Dolt data -> real DoltService export/snapshotAt -> ActivationService (real PostgreSQL journal+outbox)
// -> REAL Rust core -> outbox relay -> REAL NATS JetStream -> EffectsService (Nest lifecycle, env-driven) -> notification sink + provisioning target started by this test on loopback.
// Nothing leaves the machine. Skipped if any of the dolt, postgres, nats binaries or the core binary is missing.
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'mysql2/promise';
import { connect } from 'nats';
import pg from 'pg';
import { ActivationService } from './activation/activation.service.js';
import { NatsService } from './integrations/nats.service.js';
import { EffectsService } from './effects/effects.service.js';
import { createServer, Server } from 'node:http';
import { DoltService } from './dolt/dolt.service.js';

const root = resolve(process.cwd(), '../..');
const coreBin = resolve(root, 'core/target/debug/iam-core');
const doltBin = process.env.DOLT_BIN, natsBin = process.env.NATS_SERVER_BIN, pgBin = process.env.PG_BIN;
const have = !!doltBin && existsSync(doltBin) && !!natsBin && existsSync(natsBin) && !!pgBin && existsSync(join(pgBin, 'postgres')) && existsSync(coreBin);
const CORE = 'http://127.0.0.1:18096', ADMIN = 'local-demo-admin-token', T = 'acme-demo'; // local fictional value
const DP = 13329, PGP = 15445, NP = 14235, SINK = 18161, TARGET = 18162;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('EffectsService wiring: real Dolt export + PostgreSQL + core + NATS -> local sink and provisioning target', { skip: !have && 'a required binary is missing' }, () => {
  let dolt: ChildProcess, pgp: ChildProcess, nats: ChildProcess, core: ChildProcess, dir: string, svc: ActivationService, ns: NatsService, eff: EffectsService, sink: Server, target: Server, pool: pg.Pool;
  type Call = { method: string; url: string; key: string; body: string };
  const sinkCalls: Call[] = [], targetCalls: Call[] = []; let sinkFail = 0;
  const listen = (port: number, calls: Call[], fail?: () => boolean) => new Promise<Server>((ok) => { const sv = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { if (fail?.()) { res.statusCode = 503; return res.end(); } const key = String(req.headers['idempotency-key'] ?? ''); if (!calls.some((c) => c.key === key)) calls.push({ method: req.method!, url: req.url!, key, body: b }); res.statusCode = 204; res.end(); }); }); sv.listen(port, '127.0.0.1', () => ok(sv)); });
  const pump = async (until: () => boolean) => { for (let i = 0; i < 150 && !until(); i++) { await svc.relay(); await sleep(100); } };
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
    nats = spawn(natsBin!, ['-js', '-a', '127.0.0.1', '-p', String(NP), '-sd', join(dir, 'nats')], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) { try { (await connect({ servers: `127.0.0.1:${NP}` })).close(); break; } catch { await sleep(100); } }
    core = spawn(coreBin, [], { cwd: resolve(root, 'core'), env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18096', IAM_ISSUER: CORE, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar'), IAM_CORE_ADMIN_TOKEN: ADMIN }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${CORE}/health`)).ok) break; } catch { await sleep(100); } }
    Object.assign(process.env, { IAM_CORE_URL: CORE, IAM_CORE_ADMIN_TOKEN: ADMIN, DOLT_PORT: String(DP), DOLT_DATABASE: 'iam', IAM_NATS_URL: `127.0.0.1:${NP}` });
    ns = new NatsService(); svc = new ActivationService(undefined, ns, new DoltService());
    sink = await listen(SINK, sinkCalls, () => (sinkFail > 0 ? (sinkFail--, true) : false)); target = await listen(TARGET, targetCalls);
    Object.assign(process.env, { IAM_EFFECTS: '1', IAM_NOTIFY_SINK_URL: `http://127.0.0.1:${SINK}`, IAM_PROVISION_TARGET_URL: `http://127.0.0.1:${TARGET}` });
    eff = new EffectsService(new DoltService()); await eff.onModuleInit(); // the real Nest lifecycle hook, driven only by the environment
  });
  after(async () => {
    await eff?.onModuleDestroy(); sink?.close(); target?.close(); delete process.env.IAM_EFFECTS; await svc?.onModuleDestroy(); await ns?.onModuleDestroy(); await pool?.end();
    delete process.env.IAM_PG_URL; delete process.env.IAM_NATS_URL;
    core?.kill(); nats?.kill(); pgp?.kill(); dolt?.kill(); await sleep(800);
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  it('activation 1 (real Dolt data): the sink gets the notification and the target gets the grant, once, with idempotency keys', async () => {
    await sql("insert into assignments values ('demo-alice','payment-approver')");
    const a = await svc.activate(T, await new DoltService().head(), 'req-eff-0001');
    assert.deepEqual([a.state, a.seq], ['applied', 1]);
    await pump(() => sinkCalls.length >= 2 && targetCalls.length >= 2);
    assert.equal(sinkCalls.length, 2); assert.equal(targetCalls.length, 2); // the seeded demo data already holds bob/payment-creator, plus the new alice grant
    const ai = sinkCalls.findIndex((c) => c.key.includes('demo-alice')), ti = targetCalls.findIndex((c) => c.url.includes('demo-alice'));
    assert.deepEqual(sinkCalls.map((c) => c.key).sort(), [`${T}:1:notify:demo-alice:payment-approver:granted`, `${T}:1:notify:demo-bob:payment-creator:granted`]);
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
    await pump(() => sinkCalls.length >= 4 && targetCalls.length >= 4);
    const want = [`${T}:2:notify:demo-alice:payment-approver:revoked`, `${T}:2:notify:demo-bob:payment-approver:granted`];
    assert.deepEqual(sinkCalls.filter((c) => c.key.startsWith(`${T}:2:`)).map((c) => c.key).sort(), want);
    assert.deepEqual(targetCalls.filter((c) => c.key.startsWith(`${T}:2:`)).map((c) => `${c.method} ${c.url}`).sort(), ['DELETE /Users/demo-alice/Roles/payment-approver', 'PUT /Users/demo-bob/Roles/payment-approver']);
    assert.equal(new Set(sinkCalls.map((c) => c.key)).size, sinkCalls.length); // no duplicate effect key reached the sink
    assert.equal((await pool.query("select count(*)::int n from effects where state <> 'done'")).rows[0].n, 0); // every effect ended done after the retries
    assert.equal((await pool.query("select count(*)::int n from effects where tenant=$1", [T])).rows[0].n, 8); // (2+2 changes) x (notify, provision)
  });
  it('replaying the same activation events does not repeat any effect (idempotent per tenant+seq)', async () => {
    const before = [sinkCalls.length, targetCalls.length];
    await pool.query('update outbox set sent_at = null'); // the relay publishes both events AGAIN
    for (let i = 0; i < 20; i++) { await svc.relay(); await sleep(100); } await sleep(500);
    assert.equal((await pool.query('select count(*)::int n from outbox where sent_at is not null')).rows[0].n, 2); // they really were re-sent
    assert.deepEqual([sinkCalls.length, targetCalls.length], before);
  });
  it('negative: a non-loopback target URL is refused before any request (nothing leaves the machine)', async () => {
    const { assertLoopback } = await import('./effects/loopback.js');
    assert.throws(() => assertLoopback('http://example.org:80'), /not a loopback host/);
    assert.throws(() => assertLoopback('https://127.0.0.1:1'), /http on loopback/);
  });
});
