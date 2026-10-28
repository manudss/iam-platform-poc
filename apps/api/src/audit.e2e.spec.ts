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
    core = spawn(bin, [], { cwd: resolve(root, 'core'), env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18101', IAM_ISSUER: CORE, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar'), IAM_CORE_ADMIN_TOKEN: ADMIN }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${CORE}/health`)).ok) break; } catch { await sleep(100); } }
  };
  before(async () => {
    delete process.env.IAM_PG_URL; delete process.env.IAM_CORE_GRPC_ADDR;
    await start();
    Object.assign(process.env, { IAM_CORE_URL: CORE, IAM_ISSUER: CORE });
    app = await NestFactory.create(AppModule, { logger: false }); await app.listen(13101);
  });
  after(async () => { await app?.close(); core?.kill(); });
  const check = (token: string | undefined, body: object) => post(`${API}/access/check`, { action: 'Action::"approve"', resource: 'Request::"r1"', ...body }, token);
  const audit = async (token: string | undefined, tenant = 'acme-demo') => fetch(`${API}/tenants/${tenant}/audit`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  it('an allow and a deny are both recorded, with caller, tenant and (tenant mode) the activation version', async () => {
    const t = await login();
    assert.equal((await check(t, { principal: 'User::"demo-alice"', context: { roles: ['payment-approver'], sod_conflict: false } })).status, 201); // demo mode: allow
    assert.equal((await check(t, { principal: 'User::"demo-alice"', context: { roles: ['payment-approver'], sod_conflict: true } })).status, 201); // deny
    // tenant mode: activate a version in the core, then decide against it
    assert.equal((await post(`${CORE}/v1/activate`, { tenant: 'acme-demo', seq: 1, commit: 'abcdef12', snapshot: { assignments: [{ identity_id: 'demo-alice', role_id: 'payment-approver' }], sod_rules: [] } }, undefined, { 'x-core-admin-token': ADMIN })).status, 200);
    assert.equal(((await (await check(t, { tenant: 'acme-demo', principal: 'User::"demo-alice"', context: {} })).json()) as { allow: boolean }).allow, true);
    const r = await audit(t); assert.equal(r.status, 200);
    const { entries } = (await r.json()) as { entries: Entry[] };
    assert.deepEqual(entries.map((e) => e.allow), [true, false, true]); // newest first
    assert.ok(entries.every((e) => e.tenant === 'acme-demo' && e.subject === 'demo-alice' && e.source === 'http'));
    assert.deepEqual([entries[0].activation_seq, entries[0].commit], [1, 'abcdef12']);
    assert.equal(entries[2].activation_seq, null);
    assert.ok(!JSON.stringify(entries).includes('sod_conflict')); // context values are not stored
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
    const rr = await audit(await login()); assert.equal(rr.status, 200, await rr.clone().text()); const { entries } = (await rr.json()) as { entries: Entry[] };
    assert.equal(entries.length, before + 1);
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
    await a.record({ ...base, tenant: 't-a', allow: true, reasons: [], activation_seq: 3, commit: 'c0ffee00' });
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
