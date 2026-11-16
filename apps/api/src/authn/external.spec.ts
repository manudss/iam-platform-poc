import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { AuthnService } from './flow.service.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { startTestBus, TestBus } from '../testing/test-bus.js';

/**
 * Federated sign-in (docs/sso-federation.md): the full chain round-trip through the gate in SIMULATED mode
 * (no provider account exists to test against), plus the explicit-link rules and the authorize-params resume.
 * The REAL OIDC and OAuth2 exchange paths are covered against a loopback fake provider in federation.spec.ts.
 */
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const ADMIN = 'x'.repeat(20), GATE = 'gate-token-1234', T = 'acme-demo';

describe('external provider sign-in (federation)', () => {
  let app: INestApplication, svc: AuthnService;
  const env = { a: process.env.IAM_API_ADMIN_TOKEN, g: process.env.IAM_AUTH_GATE_TOKEN, f: process.env.IAM_AUTHN_FILE };
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = ADMIN; process.env.IAM_AUTH_GATE_TOKEN = GATE; process.env.IAM_AUTHN_FILE = join(mkdtempSync(join(tmpdir(), 'authn-ext-')), 'e.json');
    const guard = { canActivate: (c: any) => { const r = c.switchToHttp().getRequest(); r.user = { sub: String(r.headers['x-test-sub'] ?? 'demo-alice') }; return true; } };
    const mod = await Test.createTestingModule({ imports: [PluginsV1Module] }).overrideGuard(AuthGuard).useValue(guard).compile();
    app = mod.createNestApplication(); await app.init(); svc = app.get(AuthnService);
    const reg = app.get(PluginRegistry);
    for (const id of ['auth-sso-google', 'auth-sso-github']) { await reg.install(T, id, {}); await reg.enable(T, id, { hooks: ['auth.external.start', 'auth.external.verify'], uiComponents: true }); }
    const put = (c: unknown) => request(app.getHttpServer()).put(`/tenants/${T}/auth`).set('x-api-admin-token', ADMIN).send({ config: c }).expect(200);
    await put({
      methods: [
        { id: 'pw', type: 'password', name: 'Password', enabled: true, level: 3, config: {} },
        { id: 'goog', type: 'sso-google', name: 'Google', enabled: true, level: 6, config: {} },
      ],
      chains: [{ id: 'social', name: 'Password then Google', steps: ['pw', 'goog'], level: 7 }, { id: 'social-only', name: 'Google only', steps: ['goog'], level: 6 }],
      defaultChain: 'social',
    });
  });
  after(async () => { process.env.IAM_API_ADMIN_TOKEN = env.a; process.env.IAM_AUTH_GATE_TOKEN = env.g; process.env.IAM_AUTHN_FILE = env.f; await app.close(); });
  const http = () => request(app.getHttpServer());
  const adm = { 'x-api-admin-token': ADMIN };
  const gate = (b: object) => http().post('/internal/auth/authenticate').set('x-gate-token', GATE).send(b);
  const authorize = { response_type: 'code', client_id: 'demo-web', redirect_uri: 'http://localhost:4200/callback', state: 'st ate', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' };

  it('catalogue: the five provider types exist, factor other, and the federation placeholder is gone', async () => {
    const types = svc.catalogue().map((t) => t.id);
    for (const id of ['sso-google', 'sso-microsoft', 'sso-facebook', 'sso-github', 'sso-oidc']) assert.ok(types.includes(id), id);
    assert.ok(!types.includes('federation'));
    const g = svc.catalogue().find((t) => t.id === 'sso-google')!;
    assert.equal(g.factor, 'other'); assert.equal(g.simulatedByDefault, true);   // no client id: honest simulation
  });

  it('full chain round-trip in SIMULATED mode: link step, DEMO identities, explicit link, resume', async () => {
    // step 1: password
    let r = (await gate({ tenant: T, subject: 'demo-alice', password: 'demo-only-not-a-secret', chain: 'social' })).body;
    assert.equal(r.outcome, 'challenge');
    assert.equal(r.step.methodId, 'goog');
    assert.deepEqual(r.step.fields, [{ name: 'external', label: 'Continue with Google', type: 'link' }]);
    // leg 1: start the round-trip (the core passes the authorize params it captured)
    const start = (await gate({ tenant: T, session: r.session, externalStart: true, authorize })).body;
    assert.equal(start.outcome, 'external-sim');
    assert.ok(start.title.includes('simulated') && typeof start.state === 'string' && start.state.length >= 20);
    assert.ok(start.identities.some((i: any) => i.sub === 'sim-google-ada'));
    // leg 2a: a provider subject nobody linked is refused, and a wrong state is refused
    assert.equal((await gate({ tenant: T, session: r.session, externalCallback: { state: 'wrong', sim: 'sim-google-ada' } })).body.outcome, 'deny');
    const unlinked = (await gate({ tenant: T, session: r.session, externalCallback: { state: start.state, sim: 'sim-google-grace' } })).body;
    assert.equal(unlinked.outcome, 'deny'); assert.match(unlinked.message, /No account is linked/);
    // the administrator explicitly links the fictional Google subject to demo-alice
    const link = await http().post(`/tenants/${T}/auth/enrollments/demo-alice/goog`).set(adm).send({ externalSub: 'sim-google-ada', externalEmail: 'ada.lovelace@example.invalid' }).expect(201);
    assert.deepEqual(link.body.linked, { sub: 'sim-google-ada' });
    // leg 2b: the linked fictional identity completes the chain; resume carries the authorize params back
    const done = (await gate({ tenant: T, session: r.session, externalCallback: { state: start.state, sim: 'sim-google-ada' } })).body;
    assert.equal(done.outcome, 'allow'); assert.equal(done.subject, 'demo-alice');
    assert.deepEqual(done.resume, authorize);
    // password is the only REAL step (Google is simulated): amr ['pwd'], and a federated step never counts toward MFA
    assert.deepEqual(done.claims.amr, ['pwd']);
    assert.equal(done.claims.auth_mfa, false);
    assert.deepEqual(done.claims.auth_simulated, ['goog']);
  });

  it('a social-only chain starts without a username and resolves the account at the callback', async () => {
    // the classic "Sign in with Google" button: entry on a chain opening with a federation step creates a
    // subject-less session and returns the link field for the first page (no username form ever renders)
    const e = (await http().post('/internal/auth/entry').set('x-gate-token', GATE).send({ tenant: T, chain: 'social-only' })).body;
    assert.equal(e.mode, 'chain');
    assert.equal(e.noSubject, true);
    assert.ok(typeof e.session === 'string' && e.session.length >= 20);
    assert.equal(e.title, 'Sign in with Google');
    assert.deepEqual(e.fields, [{ name: 'external', label: 'Continue with Google', type: 'link' }]);
    // a subject-less authenticate POST stays refused (400 bad-request): the entry session is the only way in
    const bare = await gate({ tenant: T, chain: 'social-only' });
    assert.equal(bare.status, 400); assert.equal(bare.body.code, 'bad-request');
    // the round-trip on that session: simulated provider, explicit link, subject resolved at the callback
    const start = (await gate({ tenant: T, session: e.session, externalStart: true, authorize })).body;
    assert.equal(start.outcome, 'external-sim');
    // one provider subject = one account: sim-google-ada is already linked to demo-alice (test 2), refusing
    // a second link keeps the reverse lookup unambiguous (409, no overwrite)
    const clash = await http().post(`/tenants/${T}/auth/enrollments/demo-carol/goog`).set(adm).send({ externalSub: 'sim-google-ada' });
    assert.equal(clash.status, 409);
    await http().post(`/tenants/${T}/auth/enrollments/demo-carol/goog`).set(adm).send({ externalSub: 'sim-google-grace' }).expect(201);
    const done = (await gate({ tenant: T, externalCallback: { state: start.state, sim: 'sim-google-grace' } })).body;
    assert.equal(done.outcome, 'allow');
    assert.equal(done.subject, 'demo-carol');   // nobody typed a username: the link resolved the account
    await http().delete(`/tenants/${T}/auth/enrollments/demo-carol/goog`).set(adm).expect(200);   // leave the store clean for the confusion test
    assert.equal(done.claims.auth_mfa, false);  // a federated step alone never counts as MFA
    assert.deepEqual(done.claims.auth_simulated, ['goog']);
    assert.deepEqual(done.resume, authorize);
  });

  it('the callback resolves the session from the provider state alone (fixed provider URL)', async () => {
    let r = (await gate({ tenant: T, subject: 'demo-alice', password: 'demo-only-not-a-secret', chain: 'social' })).body;
    const start = (await gate({ tenant: T, session: r.session, externalStart: true, authorize })).body;
    // no session id: exactly what a real provider callback looks like on the fixed registered URL
    const done = (await gate({ tenant: T, externalCallback: { state: start.state, sim: 'sim-google-ada' } })).body;
    assert.equal(done.outcome, 'allow'); assert.equal(done.subject, 'demo-alice');
  });

  it('self-service linking: a signed-in member links a provider identity to their own account', async () => {
    const as = (sub: string) => ({ 'x-test-sub': sub });
    // leg 1: the member starts the round-trip; the simulated provider answers its fictional identities
    const start = (await http().post(`/tenants/${T}/auth/me/external-links/goog`).set(as('demo-dave')).send({})).body;
    assert.equal(start.mode, 'simulated');
    assert.ok(start.identities.some((i: any) => i.sub === 'sim-google-grace') && typeof start.state === 'string');
    // a bad returnTo is refused at validation; a loopback console URL is accepted
    assert.equal((await http().post(`/tenants/${T}/auth/me/external-links/goog`).set(as('demo-dave')).send({ returnTo: 'http://evil.example/x' })).status, 400);
    // leg 2: the fictional identity is recorded on the MEMBER's account (never by e-mail matching)
    const done = (await http().post(`/tenants/${T}/auth/me/external-links/goog/complete`).set(as('demo-dave')).send({ state: start.state, sim: 'sim-google-grace' })).body;
    assert.equal(done.linked, true); assert.equal(done.simulated, true);
    const st = (await http().get(`/tenants/${T}/auth/me/enrollments`).set(as('demo-dave'))).body;
    assert.equal(st.enrollments.goog.external.sub, 'sim-google-grace');
    // the link now signs demo-dave in on the social-only chain (the two halves of the feature meet)
    const e = (await http().post('/internal/auth/entry').set('x-gate-token', GATE).send({ tenant: T, chain: 'social-only' })).body;
    const s2 = (await gate({ tenant: T, session: e.session, externalStart: true, authorize })).body;
    const signed = (await gate({ tenant: T, externalCallback: { state: s2.state, sim: 'sim-google-grace' } })).body;
    assert.equal(signed.outcome, 'allow'); assert.equal(signed.subject, 'demo-dave');
    // one-use state, unknown state, wrong member, wrong instance: all refused
    assert.equal((await http().post(`/tenants/${T}/auth/me/external-links/goog/complete`).set(as('demo-dave')).send({ state: start.state, sim: 'sim-google-grace' })).status, 404);
    assert.equal((await http().post(`/tenants/${T}/auth/me/external-links/goog/complete`).set(as('demo-dave')).send({ state: 'forged', sim: 'sim-google-grace' })).status, 404);
    // a provider identity already linked elsewhere cannot be taken over (409-shaped refusal)
    const other = (await http().post(`/tenants/${T}/auth/me/external-links/goog`).set(as('demo-erin')).send({})).body;
    const clash = await http().post(`/tenants/${T}/auth/me/external-links/goog/complete`).set(as('demo-erin')).send({ state: other.state, sim: 'sim-google-ada' });
    assert.equal(clash.status, 403); assert.match(clash.body.message, /already linked/);
    // a password instance is not a federation method
    assert.equal((await http().post(`/tenants/${T}/auth/me/external-links/pw`).set(as('demo-dave')).send({})).status, 400);
    assert.equal((await http().post(`/tenants/${T}/auth/me/external-links/nope`).set(as('demo-dave')).send({})).status, 404);
    await http().delete(`/tenants/${T}/auth/enrollments/demo-dave/goog`).set(adm).expect(200);
  });

  it('an external start on a non-federation step is refused', async () => {
    const r = (await gate({ tenant: T, subject: 'demo-alice', password: 'demo-only-not-a-secret', chain: 'social' })).body;
    assert.equal(r.outcome, 'challenge');
    // fresh session sitting at the password step: externalStart must not apply
    const fresh = (await http().post('/internal/auth/entry').set('x-gate-token', GATE).send({ tenant: T, chain: 'social' })).body;
    assert.equal(fresh.mode, 'chain');
    const s0 = (await gate({ tenant: T, subject: 'demo-alice', chain: 'social' })).body;
    assert.equal(s0.outcome, 'challenge');
    assert.equal((await gate({ tenant: T, session: s0.session, externalStart: true, authorize })).body.outcome, 'deny');
    // a link to another account cannot sign demo-alice in (no account confusion)
    await http().post(`/tenants/${T}/auth/enrollments/demo-bob/goog`).set(adm).send({ externalSub: 'sim-google-grace' }).expect(201);
    const start = (await gate({ tenant: T, session: r.session, externalStart: true, authorize })).body;
    const confused = (await gate({ tenant: T, session: r.session, externalCallback: { state: start.state, sim: 'sim-google-grace' } })).body;
    assert.equal(confused.outcome, 'deny');   // sim-google-grace is linked to demo-bob, not demo-alice
  });
});
