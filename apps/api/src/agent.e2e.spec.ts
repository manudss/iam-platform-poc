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
import { startTestBus, TestBus } from './testing/test-bus.js';

// Step 3 cleanup (decision 6): AppModule requires a reachable bus - one nats+core pair for this spec file.
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const root = resolve(process.cwd(), '../..');
const bin = resolve(root, 'core/target/debug/iam-core');
const ADMIN = 'local-demo-admin-token';
const CORE = 'http://127.0.0.1:18104', API = 'http://127.0.0.1:13104', REDIRECT = 'http://localhost:4200/callback';
const PW = 'demo-only-not-a-secret'; // fictional local demo password
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (url: string, body: object, h: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
async function login(user = 'demo-alice'): Promise<string> {
  const v = randomBytes(40).toString('base64url'), ch = createHash('sha256').update(v).digest('base64url');
  const { code } = (await (await post(`${CORE}/authorize`, { client_id: 'demo-web', redirect_uri: REDIRECT, code_challenge: ch, username: user, password: PW })).json()) as { code: string };
  return ((await (await post(`${CORE}/token`, { code, code_verifier: v, redirect_uri: REDIRECT, client_id: 'demo-web' })).json()) as { id_token: string }).id_token;
}
type Entry = { source: string; allow: boolean; reasons: string[]; note: string; subject: string; principal: string };

describe('bounded agent call demo (real core + API; tools are SIMULATED)', { skip: !existsSync(bin) && 'core binary not built' }, () => {
  let core: ChildProcess, app: Awaited<ReturnType<typeof NestFactory.create>>;
  before(async () => {
    delete process.env.IAM_PG_URL; delete process.env.IAM_CORE_GRPC_ADDR;
    core = spawn(bin, [], { cwd: resolve(root, 'core'), env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18104', IAM_CORE_NATS_URL: `127.0.0.1:${testBus!.natsPort}`, IAM_CORE_NATS_PASSWORD: 'core-dev', IAM_ISSUER: CORE, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar'), IAM_CORE_ADMIN_TOKEN: ADMIN }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${CORE}/health`)).ok) break; } catch { await sleep(100); } }
    // server-side data: alice is an approver; bob holds creator+approver (separation-of-duties conflict). Attributes come from here, never from callers.
    assert.equal((await post(`${CORE}/v1/activate`, { tenant: 'acme-demo', seq: 1, commit: 'abcdef12', snapshot: { assignments: [{ identity_id: 'demo-alice', role_id: 'payment-approver' }, { identity_id: 'demo-bob', role_id: 'payment-creator' }, { identity_id: 'demo-bob', role_id: 'payment-approver' }], sod_rules: [{ role_a: 'payment-creator', role_b: 'payment-approver' }] } }, { 'x-core-admin-token': ADMIN })).status, 200);
    Object.assign(process.env, { IAM_CORE_URL: CORE, IAM_ISSUER: CORE, IAM_CORE_ADMIN_TOKEN: ADMIN });
    app = await NestFactory.create(AppModule, { logger: false }); await app.listen(13104);
  });
  after(async () => { await app?.close(); core?.kill(); });
  const AL = 'User::"demo-alice"';
  const delegate = (token: string | undefined, body: object) => fetch(`${API}/agent/delegations`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const call = (secret: string | undefined, tool: unknown) => fetch(`${API}/agent/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-agent-delegation': secret } : {}) }, body: JSON.stringify({ tool }) });
  const audit = async (t: string) => ((await (await fetch(`${API}/tenants/acme-demo/audit`, { headers: { authorization: `Bearer ${t}` } })).json()) as { entries: Entry[] }).entries;
  // The trail is fed asynchronously over the bus (access.decided) for decisions the core answered, and bus
  // delivery can also land AFTER a later locally-written denial: poll for the expected row instead of
  // assuming it is the newest entry right after the call (racy on slow CI).
  const auditWait = async (t: string, match: (e: Entry) => boolean): Promise<Entry> => {
    for (let i = 0; i < 200; i++) { const hit = (await audit(t)).find(match); if (hit) return hit; await sleep(25); }
    throw new Error('expected audit entry never arrived within 5s');
  };
  const mk = async (t: string, body: object = {}) => (await (await delegate(t, { agent_id: 'demo-agent', tools: ['approve-payment'], ...body })).json()) as { delegation: string; expires_at: string };

  it('allowlisted tool: tenant-mode Cedar decision as the TOKEN subject, simulated result, audited as source=agent', async () => {
    const t = await login();
    const r = await delegate(t, { agent_id: 'demo-agent-1', tools: ['approve-payment'] }); assert.equal(r.status, 201);
    const d = (await r.json()) as { delegation: string };
    const ok = await call(d.delegation, 'approve-payment'); assert.equal(ok.status, 201);
    const body = (await ok.json()) as { allow: boolean; simulated: boolean; calls_left: number };
    assert.deepEqual([body.allow, body.simulated, body.calls_left], [true, true, 4]);
    const e = (await audit(t))[0];
    assert.deepEqual([e.source, e.allow, e.subject, e.principal], ['agent', true, 'demo-alice', AL]);
    assert.match(e.note, /agent=demo-agent-1 tool=approve-payment/);
  });
  it('policy still applies from server data: bob (creator+approver in the active version) is denied by SoD; no ambient read right in tenant mode', async () => {
    const tb = await login('demo-bob');
    assert.equal((await call((await mk(tb)).delegation, 'approve-payment')).status, 403);
    // bob's denial was answered by the core: its row rides the bus, wait for it instead of reading position 0
    const e = await auditWait(tb, (x) => x.source === 'agent' && x.principal === 'User::"demo-bob"');
    assert.deepEqual([e.source, e.allow, e.principal], ['agent', false, 'User::"demo-bob"']);
    const ta = await login();
    assert.equal((await call((await mk(ta, { tools: ['read-report'] })).delegation, 'read-report')).status, 403); // no read permit in tenant mode
  });
  it('negative: impersonation and forged attributes. Another principal, roles, sod_conflict, context or tenant_mode in the body never grant or change anything', async () => {
    const tb = await login('demo-bob'), ta = await login();
    assert.equal((await delegate(tb, { agent_id: 'x', principal: AL, tools: ['approve-payment'] })).status, 403); // bob cannot delegate as alice
    assert.equal((await delegate(tb, { agent_id: 'x', tools: ['approve-payment'], context: { roles: ['payment-approver'], sod_conflict: false } })).status, 400);
    assert.equal((await delegate(tb, { agent_id: 'x', tools: ['approve-payment'], tenant_mode: false })).status, 400);
    // a delegation made by bob stays bob, whatever alice's rights are
    const d = await mk(tb, { principal: 'User::"demo-bob"' });
    assert.equal((await call(d.delegation, 'approve-payment')).status, 403);
    // /access/check: another principal or tenant is 403, forged roles are dropped (bob stays denied by SoD, mallory-like unknown subject has no data)
    const chk = (t: string, b: object) => post(`${API}/access/check`, { action: 'Action::"approve"', resource: 'Request::"r1"', ...b }, { authorization: `Bearer ${t}` });
    assert.equal((await chk(tb, { principal: AL })).status, 403);
    assert.equal((await chk(tb, { tenant: 'other-tenant' })).status, 403);
    const forged = await chk(tb, { context: { roles: ['payment-approver'], sod_conflict: false, tenant_mode: false } });
    assert.equal(((await forged.json()) as { allow: boolean }).allow, false);
    const own = await chk(ta, { context: { sod_conflict: true, roles: [] } }); // alice with hostile "attributes": server data wins, still allowed
    assert.equal(((await own.json()) as { allow: boolean }).allow, true);
    // simulation: valid token is not enough, the admin capability is required, and it can never run a tool
    const sim = (h: Record<string, string>) => post(`${API}/access/simulate`, { principal: 'User::"alice"', action: 'Action::"approve"', resource: 'Request::"r1"', context: {} }, { authorization: `Bearer ${ta}`, ...h });
    const prev = process.env.IAM_API_ADMIN_TOKEN;
    try {
      delete process.env.IAM_API_ADMIN_TOKEN; assert.equal((await sim({ 'x-api-admin-token': 'anything-anything-1' })).status, 403); // disabled
      process.env.IAM_API_ADMIN_TOKEN = 'simulation-admin-token-1';
      assert.equal((await sim({})).status, 403);
      assert.equal((await sim({ 'x-api-admin-token': 'wrong-admin-token-xxxx' })).status, 403);
      assert.equal((await sim({ 'x-api-admin-token': 'simulation-admin-token-1' })).status, 201);
      for (let i = 0; i < 100 && (await audit(ta))[0]?.source !== 'simulate'; i++) await sleep(30);
      assert.equal(((await audit(ta))[0]).source, 'simulate');
      assert.equal((await fetch(`${API}/agent/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-admin-token': 'simulation-admin-token-1' }, body: JSON.stringify({ tool: 'approve-payment' }) })).status, 401);
    } finally { if (prev === undefined) delete process.env.IAM_API_ADMIN_TOKEN; else process.env.IAM_API_ADMIN_TOKEN = prev; }
  });
  it('negative: tool outside the allowlist, unknown tool, no delegation, wrong delegation: refused; the first two are audited', async () => {
    const t = await login();
    const d = await mk(t, { tools: ['read-report'] });
    assert.equal((await call(d.delegation, 'approve-payment')).status, 403);
    assert.deepEqual([(await audit(t))[0].allow, (await audit(t))[0].reasons], [false, ['tool-not-in-allowlist']]);
    assert.equal((await call(d.delegation, 'delete-everything')).status, 403);
    assert.equal((await call(d.delegation, { $ne: 1 })).status, 403);
    assert.equal((await call(undefined, 'read-report')).status, 401);
    assert.equal((await call('not-a-real-delegation', 'read-report')).status, 401);
    assert.equal((await call(t, 'read-report')).status, 401); // a user JWT is not a delegation secret
  });
  it('negative: creating a delegation needs a valid user token and known tools; the agent cannot re-delegate', async () => {
    assert.equal((await delegate(undefined, { agent_id: 'a', tools: ['read-report'] })).status, 401);
    const t = await login();
    assert.equal((await delegate(t, { agent_id: 'a', tools: ['read-report', 'wire-money'] })).status, 400);
    assert.equal((await delegate(t, { agent_id: 'a', tools: [] })).status, 400);
    const d = await mk(t, { tools: ['read-report'] });
    assert.equal((await delegate(d.delegation, { agent_id: 'b', tools: ['read-report'] })).status, 401);
  });
  it('negative: call budget and TTL are enforced (TTL clamped, expired delegation is 401)', async () => {
    const t = await login();
    const r = await mk(t, { max_calls: 2, ttl_seconds: 99999 });
    assert.ok(new Date(r.expires_at).getTime() - Date.now() <= 601_000);
    assert.equal((await call(r.delegation, 'approve-payment')).status, 201);
    assert.equal((await call(r.delegation, 'approve-payment')).status, 201);
    assert.equal((await call(r.delegation, 'approve-payment')).status, 403);
    // the budget denial is written locally at once, but the two allowed calls' rows can arrive from the bus
    // after it: match the entry instead of assuming the newest position
    const budget = await auditWait(t, (x) => x.reasons.includes('call-budget-exhausted'));
    assert.deepEqual([budget.allow, budget.reasons], [false, ['call-budget-exhausted']]);
    const s = await mk(t, { ttl_seconds: 1 }); await sleep(1300);
    assert.equal((await call(s.delegation, 'approve-payment')).status, 401);
  });
  it('core down: the agent call is denied (502) and the denial is audited as source=agent', async () => {
    const t = await login(); const d = await mk(t);
    core.kill(); await sleep(400);
    assert.equal((await call(d.delegation, 'approve-payment')).status, 502);
    const e = (await audit(t))[0];
    assert.deepEqual([e.source, e.allow, e.reasons], ['agent', false, ['core-unreachable']]);
  });
});
