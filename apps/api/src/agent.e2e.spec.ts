// Bounded agent call demo: real Rust core + real NestJS API. Delegated allowlist, same Cedar decision, audit source 'agent'.
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
const CORE = 'http://127.0.0.1:18102', API = 'http://127.0.0.1:13102', REDIRECT = 'http://localhost:4200/callback';
const PW = 'demo-only-not-a-secret'; // fictional local demo password
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (url: string, body: object, h: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
async function login(user = 'demo-alice'): Promise<string> {
  const v = randomBytes(40).toString('base64url'), ch = createHash('sha256').update(v).digest('base64url');
  const { code } = (await (await post(`${CORE}/authorize`, { client_id: 'demo-web', redirect_uri: REDIRECT, code_challenge: ch, username: user, password: PW })).json()) as { code: string };
  return ((await (await post(`${CORE}/token`, { code, code_verifier: v, redirect_uri: REDIRECT, client_id: 'demo-web' })).json()) as { id_token: string }).id_token;
}
type Entry = { source: string; allow: boolean; reasons: string[]; note: string; subject: string; principal: string };

describe('bounded agent call demo (real core + API)', { skip: !existsSync(bin) && 'core binary not built' }, () => {
  let core: ChildProcess, app: Awaited<ReturnType<typeof NestFactory.create>>;
  before(async () => {
    delete process.env.IAM_PG_URL; delete process.env.IAM_CORE_GRPC_ADDR;
    core = spawn(bin, [], { cwd: resolve(root, 'core'), env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18102', IAM_ISSUER: CORE, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar') }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${CORE}/health`)).ok) break; } catch { await sleep(100); } }
    Object.assign(process.env, { IAM_CORE_URL: CORE, IAM_ISSUER: CORE });
    app = await NestFactory.create(AppModule, { logger: false }); await app.listen(13102);
  });
  after(async () => { await app?.close(); core?.kill(); });
  const delegate = (token: string | undefined, body: object) => fetch(`${API}/agent/delegations`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const call = (secret: string | undefined, tool: unknown) => fetch(`${API}/agent/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-agent-delegation': secret } : {}) }, body: JSON.stringify({ tool }) });
  const audit = async (t: string) => ((await (await fetch(`${API}/tenants/acme-demo/audit`, { headers: { authorization: `Bearer ${t}` } })).json()) as { entries: Entry[] }).entries;

  it('allowlisted tool: same Cedar decision as the user, simulated result, audited as source=agent', async () => {
    const t = await login();
    const r = await delegate(t, { agent_id: 'demo-agent-1', principal: 'User::"demo-alice"', tools: ['approve-payment'], context: { roles: ['payment-approver'], sod_conflict: false } });
    assert.equal(r.status, 201); const d = (await r.json()) as { delegation: string; expires_at: string };
    const ok = await call(d.delegation, 'approve-payment'); assert.equal(ok.status, 201);
    const body = (await ok.json()) as { allow: boolean; simulated: boolean; calls_left: number };
    assert.deepEqual([body.allow, body.simulated, body.calls_left], [true, true, 4]);
    const e = (await audit(t))[0];
    assert.deepEqual([e.source, e.allow, e.subject, e.principal], ['agent', true, 'demo-alice', 'User::"demo-alice"']);
    assert.match(e.note, /agent=demo-agent-1 tool=approve-payment/);
  });
  it('the policy still applies: a separation-of-duties conflict denies the agent exactly as it would deny the user', async () => {
    const t = await login();
    const d = (await (await delegate(t, { agent_id: 'demo-agent-2', principal: 'User::"demo-alice"', tools: ['approve-payment'], context: { roles: ['payment-approver'], sod_conflict: true } })).json()) as { delegation: string };
    assert.equal((await call(d.delegation, 'approve-payment')).status, 403);
    const e = (await audit(t))[0]; assert.deepEqual([e.source, e.allow], ['agent', false]);
  });
  it('negative: tool outside the allowlist, unknown tool, no delegation, wrong delegation: refused; the first two are audited', async () => {
    const t = await login();
    const d = (await (await delegate(t, { agent_id: 'demo-agent-3', principal: 'User::"demo-alice"', tools: ['read-report'], context: {} })).json()) as { delegation: string };
    assert.equal((await call(d.delegation, 'approve-payment')).status, 403);
    assert.deepEqual([(await audit(t))[0].allow, (await audit(t))[0].reasons], [false, ['tool-not-in-allowlist']]);
    assert.equal((await call(d.delegation, 'delete-everything')).status, 403);
    assert.equal((await call(d.delegation, { $ne: 1 })).status, 403);
    assert.equal((await call(undefined, 'read-report')).status, 401);
    assert.equal((await call('not-a-real-delegation', 'read-report')).status, 401);
    assert.equal((await call(t, 'read-report')).status, 401); // a user JWT is not a delegation secret
  });
  it('negative: creating a delegation needs a valid user token, a known tool list, and the agent cannot re-delegate', async () => {
    assert.equal((await delegate(undefined, { agent_id: 'a', principal: 'p', tools: ['read-report'] })).status, 401);
    const t = await login();
    assert.equal((await delegate(t, { agent_id: 'a', principal: 'User::"demo-alice"', tools: ['read-report', 'wire-money'] })).status, 400);
    assert.equal((await delegate(t, { agent_id: 'a', principal: 'User::"demo-alice"', tools: [] })).status, 400);
    const d = (await (await delegate(t, { agent_id: 'a', principal: 'User::"demo-alice"', tools: ['read-report'] })).json()) as { delegation: string };
    assert.equal((await delegate(d.delegation, { agent_id: 'b', principal: 'User::"demo-alice"', tools: ['read-report'] })).status, 401);
  });
  it('negative: the call budget is enforced and ttl/calls are clamped', async () => {
    const t = await login();
    const r = (await (await delegate(t, { agent_id: 'demo-agent-4', principal: 'User::"bob"', tools: ['read-report'], context: {}, max_calls: 2, ttl_seconds: 99999 })).json()) as { delegation: string; expires_at: string };
    assert.ok(new Date(r.expires_at).getTime() - Date.now() <= 601_000);
    assert.equal((await call(r.delegation, 'read-report')).status, 201);
    assert.equal((await call(r.delegation, 'read-report')).status, 201);
    assert.equal((await call(r.delegation, 'read-report')).status, 403);
    assert.deepEqual([(await audit(t))[0].reasons], [['call-budget-exhausted']]);
  });
});
