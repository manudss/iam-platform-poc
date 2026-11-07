// Sign-in gate: real Rust core (sign-in endpoint) + real NestJS API + the plugin registry (auth.authenticate), and notify.send in the activation effects.
// Proves: allowed sign-in, wrong password = business denial that does NOT fault the plugin, lockout replacement, admin disable returns to base,
// gate unreachable = sign-in refused (fail closed, no fallback to the plain IdP check), and the activation effects reach the notify plugin.
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { PluginRegistry } from './plugins/v1/registry.js';
import { ActivationEffects } from './effects/activation-effects.js';
import { EffectStore } from './effects/effect-store.js';
import { startTestBus, TestBus } from './testing/test-bus.js';

// Step 3 cleanup (decision 6): AppModule requires a reachable bus - one nats+core pair for this spec file.
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const root = resolve(process.cwd(), '../..');
const bin = resolve(root, 'core/target/debug/iam-core');
const CORE = 'http://127.0.0.1:18201', REDIRECT = 'http://localhost:4200/callback', GATE_TOKEN = 'local-gate-token-demo', T = 'acme-demo';
const GOOD = 'demo-only-not-a-secret'; // fictional local demo password
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function signIn(user: string, password: string) {
  const v = randomBytes(40).toString('base64url'), ch = createHash('sha256').update(v).digest('base64url');
  const r = await fetch(`${CORE}/authorize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: 'demo-web', redirect_uri: REDIRECT, code_challenge: ch, username: user, password }) });
  return { status: r.status, body: (await r.json()) as { code?: string; error?: string } };
}

describe('sign-in gate (real core + API + plugins)', { skip: !existsSync(bin) && 'core binary not built' }, () => {
  let core: ChildProcess, app: Awaited<ReturnType<typeof NestFactory.create>>, reg: PluginRegistry;
  before(async () => {
    delete process.env.IAM_PG_URL; delete process.env.IAM_CORE_GRPC_ADDR;
    process.env.IAM_AUTH_GATE_TOKEN = GATE_TOKEN;
    app = await NestFactory.create(AppModule, { logger: false }); await app.listen(13201);
    reg = app.get(PluginRegistry);
    core = spawn(bin, [], { cwd: resolve(root, 'core'), env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18201', IAM_ISSUER: CORE, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar'), IAM_AUTH_GATE_ADDR: '127.0.0.1:13201', IAM_AUTH_GATE_TOKEN: GATE_TOKEN }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${CORE}/health`)).ok) break; } catch { await sleep(100); } }
  });
  after(async () => { await app?.close().catch(() => undefined); core?.kill(); delete process.env.IAM_AUTH_GATE_TOKEN; });

  it('the gate endpoint needs its shared token', async () => {
    const r = await fetch('http://127.0.0.1:13201/internal/auth/authenticate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenant: T, subject: 'demo-alice', password: GOOD }) });
    assert.equal(r.status, 401);
  });

  it('good password signs in through the base plugin; a wrong password is a business denial and the plugin stays healthy', async () => {
    assert.ok((await signIn('demo-alice', GOOD)).body.code);
    const bad = await signIn('demo-alice', 'wrong-password-1');
    assert.equal(bad.status, 401); assert.equal(bad.body.error, 'invalid_credentials');
    assert.ok((await signIn('demo-alice', GOOD)).body.code, 'one wrong password must not break sign-in for anyone');
    assert.equal((await reg.callSlot<any>(T, 'auth.password', 'auth.authenticate', { tenant: T, subject: 'demo-bob', credential: { password: GOOD } })).servedBy, 'auth-password');
  });

  it('lockout replacement: denial stays a denial, the counter is kept, admin disable returns to base explicitly', async () => {
    await reg.install(T, 'auth-password-lockout', { install: true });
    await reg.configure(T, 'auth-password-lockout', { maxFailures: 2 });
    await reg.enable(T, 'auth-password-lockout', { hooks: ['auth.authenticate'] });
    assert.equal((await signIn('demo-bob', 'nope-nope-1')).status, 401);
    assert.equal((await signIn('demo-bob', 'nope-nope-2')).status, 401);
    const locked = await signIn('demo-bob', GOOD);
    assert.equal(locked.status, 401, 'locked even with the right password'); assert.equal(locked.body.error, 'invalid_credentials');
    assert.ok((await signIn('demo-alice', GOOD)).body.code, 'another user is not affected (no plugin-wide fault)');
    await reg.disable(T, 'auth-password-lockout');
    assert.ok((await signIn('demo-bob', GOOD)).body.code, 'after the explicit admin disable the base config serves again');
  });

  it('notify.send: activation effects reach the notify plugin (idempotent per effect key)', async () => {
    const lines: unknown[] = [];
    const deps = { store: new EffectStore(), snapshotAt: async (c: string) => ({ assignments: c === 'c2' ? [{ identity_id: 'demo-alice', role_id: 'payment-approver' }] : [] }), previousCommit: async (_t: string, s: number) => (s > 1 ? 'c1' : undefined),
      pluginNotify: async (t: string, p: any) => { lines.push(...(await reg.emit(t, 'notify.send', p))); } };
    const fx = new ActivationEffects(deps);
    await fx.handle({ tenant: T, seq: 2, commit: 'c2' });
    await fx.handle({ tenant: T, seq: 2, commit: 'c2' }); // redelivery
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], { plugin: 'notify-log', result: { queued: true } }); // notify is asynchronous; consumer execution is covered by activation-bus.e2e
  });

  it('gate unreachable: sign-in is refused (fail closed), not served by the plain IdP check', async () => {
    await app.close();
    const r = await signIn('demo-alice', GOOD);
    assert.equal(r.status, 503); assert.equal(r.body.error, 'temporarily_unavailable'); assert.equal(r.body.code, undefined);
  });
});
