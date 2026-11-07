// Decision audit: real Rust core + real NestJS API (in-memory audit), plus the PostgreSQL table on a real PostgreSQL server (PG_BIN) for durability.
// Tests: every allow/deny/core-down is recorded with tenant + activation seq/commit; reading needs a valid token of the same tenant.
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { AuditService } from './access/audit.service.js';
import { startTestBus, TestBus } from './testing/test-bus.js';

// Step 3 cleanup (decision 6): AppModule requires a reachable bus - one nats+core pair for this spec file.
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const root = resolve(process.cwd(), '../..');
const bin = resolve(root, 'core/target/debug/iam-core');
const CORE = 'http://127.0.0.1:18101', API = 'http://127.0.0.1:13101', REDIRECT = 'http://localhost:4200/callback', ADMIN = 'local-demo-admin-token';
const PW = 'demo-only-not-a-secret'; // fictional local demo password
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (url: string, body: object, token?: string, h: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...h, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
async function login(user = 'demo-alice'): Promise<string> {
  const v = randomBytes(40).toString('base64url'), ch = createHash('sha256').update(v).digest('base64url');
  const { code } = (await (await post(`${CORE}/authorize`, { client_id: 'demo-web', redirect_uri: REDIRECT, code_challenge: ch, username: user, password: PW })).json()) as { code: string };
  return ((await (await post(`${CORE}/token`, { code, code_verifier: v, redirect_uri: REDIRECT, client_id: 'demo-web' })).json()) as { id_token: string }).id_token;
}
type Entry = { id: number; tenant: string; subject: string; principal: string; allow: boolean; reasons: string[]; activation_seq: number | null; commit: string | null; source: string };

describe('decision audit (real core + API)', { skip: !existsSync(bin) && 'core binary not built' }, () => {
  let core: ChildProcess, app: Awaited<ReturnType<typeof NestFactory.create>>;
  const start = async () => {
    core = spawn(bin, [], { cwd: resolve(root, 'core'), env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18101', IAM_CORE_NATS_URL: `127.0.0.1:${testBus!.natsPort}`, IAM_CORE_NATS_PASSWORD: 'core-dev', IAM_ISSUER: CORE, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar'), IAM_CORE_ADMIN_TOKEN: ADMIN }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${CORE}/health`)).ok) break; } catch { await sleep(100); } }
  };
  before(async () => {
    delete process.env.IAM_PG_URL; delete process.env.IAM_CORE_GRPC_ADDR;
    await start();
    Object.assign(process.env, { IAM_CORE_URL: CORE, IAM_ISSUER: CORE, IAM_CORE_ADMIN_TOKEN: ADMIN });
    app = await NestFactory.create(AppModule, { logger: false }); await app.listen(13101);
  });
  after(async () => { await app?.close(); core?.kill(); });
  const check = (token: string | undefined, body: object) => post(`${API}/access/check`, { action: 'Action::"approve"', resource: 'Request::"r1"', ...body }, token);
  const audit = async (token: string | undefined, tenant = 'acme-demo') => fetch(`${API}/tenants/${tenant}/audit`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  // Step 3: the trail is fed by the bus (at-least-once, asynchronous) - poll until the expected rows are there.
  const auditUntil = async (token: string | undefined, n: number): Promise<Entry[]> => {
    for (let i = 0; i < 100; i++) {
      const { entries } = (await (await audit(token)).json()) as { entries: Entry[] };
      if (entries.length >= n) return entries;
      await sleep(150);
    }
    throw new Error(`audit trail never reached ${n} rows`);
  };

  it('an allow and a deny are both recorded, with caller (token subject), tenant and the activation version from server data', async () => {
    const t = await login(), tb = await login('demo-bob');
    assert.equal((await post(`${CORE}/v1/activate`, { tenant: 'acme-demo', seq: 1, commit: 'abcdef12', snapshot: { assignments: [{ identity_id: 'demo-alice', role_id: 'payment-approver' }], sod_rules: [] } }, undefined, { 'x-core-admin-token': ADMIN })).status, 200);
    assert.equal(((await (await check(t, { principal: 'User::"demo-alice"', context: { roles: [], sod_conflict: true } })).json()) as { allow: boolean }).allow, true); // hostile context ignored: roles come from the active version
    assert.equal(((await (await check(tb, { tenant: 'acme-demo', context: { roles: ['payment-approver'] } })).json()) as { allow: boolean }).allow, false); // bob has no role in the data
    assert.equal(((await (await check(t, {})).json()) as { allow: boolean }).allow, true);
    const entries = await auditUntil(t, 3);
    assert.deepEqual(entries.map((e) => e.allow), [true, false, true]); // newest first
    assert.deepEqual(entries.map((e) => e.subject), ['demo-alice', 'demo-bob', 'demo-alice']);
    assert.ok(entries.every((e) => e.tenant === 'acme-demo' && e.source === 'http' && e.activation_seq === 1 && e.commit === 'abcdef12'));
    assert.ok(!JSON.stringify(entries).includes('sod_conflict')); // context values are not stored
  });
  it('negative: spoofing another principal is 403 and not decided', async () => {
    const t = await login('demo-bob');
    assert.equal((await check(t, { principal: 'User::"demo-alice"' })).status, 403);
  });
  it('negative: no token or garbage token cannot read the audit; another tenant is 403; a body for another tenant is 403 and not recorded', async () => {
    assert.equal((await audit(undefined)).status, 401);
    assert.equal((await audit('garbage.token.here')).status, 401);
    const t = await login();
    assert.equal((await audit(t, 'other-tenant')).status, 403);
    const before = ((await (await audit(t)).json()) as { entries: Entry[] }).entries.length;
    assert.equal((await check(t, { tenant: 'other-tenant', principal: 'User::"demo-alice"', context: {} })).status, 403);
    assert.equal(((await (await audit(t)).json()) as { entries: Entry[] }).entries.length, before);
    assert.equal((await check(undefined, { principal: 'User::"demo-alice"', context: {} })).status, 401); // unauthenticated decisions are refused, not audited
  });
  it('core down: the caller gets 502 (denied) and the denial is recorded', async () => {
    const t = await login(); const before = ((await (await audit(t)).json()) as { entries: Entry[] }).entries.length;
    core.kill(); await sleep(400);
    assert.equal((await check(t, { principal: 'User::"demo-alice"', context: {} })).status, 502);
    await start(); // the guard's cached key is still valid, token stays usable
    const entries = await auditUntil(await login(), before + 1);
    assert.deepEqual([entries[0].allow, entries[0].reasons], [false, ['core-unreachable']]);
  });
});

const pgBin = process.env.PG_BIN;
describe('decision audit on real PostgreSQL', { skip: !(pgBin && existsSync(join(pgBin, 'postgres'))) && 'PG_BIN missing' }, () => {
  let pgp: ChildProcess, dir: string;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-audit-'));
    assert.equal(spawnSync(join(pgBin!, 'initdb'), ['-D', join(dir, 'd'), '-U', 'poc', '--auth=trust', '-E', 'UTF8']).status, 0);
    pgp = spawn(join(pgBin!, 'postgres'), ['-D', join(dir, 'd'), '-p', '15441', '-k', dir, '-c', 'listen_addresses=127.0.0.1'], { stdio: 'ignore' });
    process.env.IAM_PG_URL = 'postgres://poc@127.0.0.1:15441/postgres';
    await sleep(2500);
  });
  after(() => { delete process.env.IAM_PG_URL; pgp?.kill(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  it('rows survive a service restart and are isolated per tenant', async () => {
    const a = new AuditService();
    const base = { subject: 'demo-alice', principal: 'User::"demo-alice"', action: 'Action::"approve"', resource: 'Request::"r1"', source: 'http' as const };
    await a.record({ ...base, event_id: 'replayed-event', tenant: 't-a', allow: true, reasons: [], activation_seq: 3, commit: 'c0ffee00' });
    await a.record({ ...base, event_id: 'replayed-event', tenant: 't-a', allow: true, reasons: [], activation_seq: 3, commit: 'c0ffee00' });
    await a.record({ ...base, tenant: 't-b', allow: false, reasons: ['sod'], activation_seq: null, commit: null });
    await a.onModuleDestroy();
    const b = new AuditService(); // "restart"
    const ra = await b.list('t-a'), rb = await b.list('t-b');
    assert.deepEqual([ra.length, ra[0].allow, ra[0].activation_seq, ra[0].commit], [1, true, 3, 'c0ffee00']);
    assert.deepEqual([rb.length, rb[0].allow, rb[0].reasons], [1, false, ['sod']]);
    assert.equal((await b.list('t-none')).length, 0);
    await b.onModuleDestroy();
  });
});
