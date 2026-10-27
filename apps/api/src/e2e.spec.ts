// End-to-end: real Rust core binary (Cedar + IdP prototype) + real NestJS API over HTTP.
// Skipped with a clear message if the core binary has not been built (cd core && cargo build -p iam-core).
// Local fictional demo mode only: demo accounts, in-memory keys.
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const root = resolve(process.cwd(), '../..');
const bin = resolve(root, 'core/target/debug/iam-core');
const CORE = 'http://127.0.0.1:18081';
const SHORT = 'http://127.0.0.1:18082'; // second core: 1s tokens, other keys, other issuer
const API = 'http://127.0.0.1:13000';
const REDIRECT = 'http://localhost:4200/callback';
const DEMO_PASSWORD = 'demo-only-not-a-secret'; // fictional, local demo only

const post = (url: string, body: object, token?: string) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

async function login(core: string, user = 'demo-alice'): Promise<string> {
  const verifier = randomBytes(40).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const a = await post(`${core}/authorize`, { client_id: 'demo-web', redirect_uri: REDIRECT, code_challenge: challenge, username: user, password: DEMO_PASSWORD });
  const { code } = (await a.json()) as { code: string };
  const t = await post(`${core}/token`, { code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: 'demo-web' });
  return ((await t.json()) as { id_token: string }).id_token;
}

async function waitUp(url: string) {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${url}/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('e2e core + api', { skip: !existsSync(bin) && 'core binary not built' }, () => {
  let core: ChildProcess;
  let short: ChildProcess;
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  const spawnCore = (addr: string, extra: Record<string, string>) =>
    spawn(bin, [], { env: { ...process.env, IAM_CORE_ADDR: addr, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar'), ...extra }, stdio: 'ignore' });

  before(async () => {
    core = spawnCore('127.0.0.1:18081', { IAM_ISSUER: CORE });
    short = spawnCore('127.0.0.1:18082', { IAM_ISSUER: SHORT, IAM_TOKEN_TTL_SECS: '1' });
    await waitUp(CORE); await waitUp(SHORT);
    process.env.IAM_CORE_URL = CORE;
    process.env.IAM_ISSUER = CORE;
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(13000);
  });
  after(async () => { await app?.close(); core?.kill(); short?.kill(); });

  const check = (token: string | undefined, context: object, principal = 'User::"alice"') =>
    post(`${API}/access/check`, { principal, action: 'Action::"approve"', resource: 'Request::"r1"', context }, token);

  it('IdP prototype: wrong password gets 401, wrong verifier burns the code', async () => {
    const challenge = createHash('sha256').update('v'.repeat(50)).digest('base64url');
    const bad = await post(`${CORE}/authorize`, { client_id: 'demo-web', redirect_uri: REDIRECT, code_challenge: challenge, username: 'demo-alice', password: 'wrong' });
    assert.equal(bad.status, 401);
    const { code } = (await (await post(`${CORE}/authorize`, { client_id: 'demo-web', redirect_uri: REDIRECT, code_challenge: challenge, username: 'demo-alice', password: DEMO_PASSWORD })).json()) as { code: string };
    assert.equal((await post(`${CORE}/token`, { code, code_verifier: 'x'.repeat(50), redirect_uri: REDIRECT, client_id: 'demo-web' })).status, 400);
  });

  it('valid token: manager approves without SoD conflict', async () => {
    const r = await check(await login(CORE), { sod_conflict: false });
    assert.equal(r.status, 201);
    assert.equal(((await r.json()) as { allow: boolean }).allow, true);
  });
  it('valid token: SoD conflict is forbidden', async () =>
    assert.equal(((await (await check(await login(CORE), { sod_conflict: true })).json()) as { allow: boolean }).allow, false));
  it('valid token: unknown principal is denied', async () =>
    assert.equal(((await (await check(await login(CORE), { sod_conflict: false }, 'User::"mallory"')).json()) as { allow: boolean }).allow, false));

  it('no token -> 401 on every business endpoint', async () => {
    assert.equal((await check(undefined, { sod_conflict: false })).status, 401);
    assert.equal((await fetch(`${API}/tenants/acme-demo/activations`)).status, 401);
    assert.equal((await post(`${API}/tenants/acme-demo/activations`, { commit: 'aaaaaaaa' })).status, 401);
  });
  it('garbage and alg=none tokens -> 401', async () => {
    assert.equal((await check('not-a-jwt', {})).status, 401);
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"iss":"x"}').toString('base64url')}.`;
    assert.equal((await check(none, {})).status, 401);
  });
  it('tampered token (payload changed) -> 401', async () => {
    const [h, , s] = (await login(CORE)).split('.');
    const p = Buffer.from(JSON.stringify({ iss: CORE, aud: 'demo-web', sub: 'demo-bob', tenant: 'acme-demo', exp: 9999999999 })).toString('base64url');
    assert.equal((await check(`${h}.${p}.${s}`, {})).status, 401);
  });
  it('expired token -> 401 (same issuer and keys, only the lifetime differs)', async () => {
    // Point the API at the 1s-TTL core for this test only; a fresh token must pass, the same token 2s later must not.
    const prev = { url: process.env.IAM_CORE_URL, iss: process.env.IAM_ISSUER };
    process.env.IAM_CORE_URL = SHORT; process.env.IAM_ISSUER = SHORT;
    try {
      const t = await login(SHORT);
      assert.equal((await check(t, { sod_conflict: false })).status, 201);
      await new Promise((r) => setTimeout(r, 2200));
      assert.equal((await check(t, { sod_conflict: false })).status, 401);
    } finally { process.env.IAM_CORE_URL = prev.url; process.env.IAM_ISSUER = prev.iss; }
  });
  it('token from another issuer (other keys) -> 401', async () => assert.equal((await check(await login(SHORT), {})).status, 401));
  it('wrong tenant -> 403, right tenant -> 201, journal works with a valid token', async () => {
    const t = await login(CORE);
    assert.equal((await post(`${API}/tenants/other-tenant/activations`, { commit: 'aaaaaaaa' }, t)).status, 403);
    const a = await post(`${API}/tenants/acme-demo/activations`, { commit: 'aaaaaaaa' }, t);
    assert.equal(a.status, 201);
    assert.equal(((await a.json()) as { seq: number }).seq, 1);
    assert.equal((await post(`${API}/tenants/acme-demo/activations`, { commit: 'zz' }, t)).status, 400);
  });

  it('denies (fail closed) when the core goes away', async () => {
    const t = await login(CORE);
    core.kill(); await new Promise((r) => setTimeout(r, 300));
    const r = await check(t, { sod_conflict: false });
    assert.equal(r.status, 502);
    assert.equal(((await r.json()) as { allow: boolean }).allow, false);
  });
});
