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
import { DEFAULT_SESSION, parseSession, sessionClaims, validateSession } from './session-config.js';
import { startTestBus, TestBus } from '../testing/test-bus.js';

// Step 3 cleanup (decision 6): PluginsV1Module requires a reachable bus - one nats+core pair for this spec file.
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const ADMIN = 'x'.repeat(20), GATE = 'gate-token-1234', T = 'acme-demo', PW = 'demo-only-not-a-secret';

describe('session settings: validation', () => {
  it('defaults are a coherent configuration', () => {
    assert.deepEqual(validateSession({}), DEFAULT_SESSION);
    assert.ok(DEFAULT_SESSION.warnSeconds < DEFAULT_SESSION.ttlSeconds && DEFAULT_SESSION.ttlSeconds <= DEFAULT_SESSION.maxSeconds);
  });
  it('refuses out of range, non integer, inconsistent and unknown values', () => {
    assert.throws(() => validateSession({ ttlSeconds: 59 }), /ttlSeconds/);
    assert.throws(() => validateSession({ ttlSeconds: 86_401 }), /ttlSeconds/);
    assert.throws(() => validateSession({ ttlSeconds: 90.5 }), /ttlSeconds/);
    assert.throws(() => validateSession({ ttlSeconds: '600' }), /ttlSeconds/);
    assert.throws(() => validateSession({ warnSeconds: 5 }), /warnSeconds/);
    assert.throws(() => validateSession({ ttlSeconds: 120, warnSeconds: 120 }), /shorter than ttlSeconds/);
    assert.throws(() => validateSession({ ttlSeconds: 600, maxSeconds: 300 }), /cannot be shorter/);
    assert.throws(() => validateSession({ allowExtend: 'yes' }), /true or false/);
    assert.throws(() => validateSession({ evil: 1 }), /unknown/);
    assert.throws(() => validateSession(null), /object/);
    assert.throws(() => validateSession([]), /object/);
  });
  it('a long token raises the default absolute limit instead of failing', () => {
    assert.equal(validateSession({ ttlSeconds: 86_400 }).maxSeconds, 86_400);
  });
  it('stored garbage never breaks sign-in: it reads as the defaults', () => {
    assert.deepEqual(parseSession(undefined), DEFAULT_SESSION);
    assert.deepEqual(parseSession({}), DEFAULT_SESSION);
    assert.deepEqual(parseSession({ ttlSeconds: -5 }), DEFAULT_SESSION);
    assert.deepEqual(parseSession({ ttlSeconds: 600, warnSeconds: 30, maxSeconds: 1200, allowExtend: true }), { ttlSeconds: 600, warnSeconds: 30, maxSeconds: 1200, allowExtend: true });
  });
  it('without renewal the absolute limit equals the token length', () => {
    assert.deepEqual(sessionClaims({ ttlSeconds: 600, warnSeconds: 30, maxSeconds: 9000, allowExtend: false }), { session_ttl: 600, session_warn: 30, session_max: 600 });
    assert.deepEqual(sessionClaims(DEFAULT_SESSION), { session_ttl: 1800, session_warn: 120, session_max: 28800 });
  });
});

describe('session settings: admin API and sign-in claims', () => {
  let app: INestApplication; const env = { a: process.env.IAM_API_ADMIN_TOKEN, g: process.env.IAM_AUTH_GATE_TOKEN, f: process.env.IAM_AUTHN_FILE };
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = ADMIN; process.env.IAM_AUTH_GATE_TOKEN = GATE; process.env.IAM_AUTHN_FILE = join(mkdtempSync(join(tmpdir(), 'session-')), 'e.json');
    const mod = await Test.createTestingModule({ imports: [PluginsV1Module] }).overrideGuard(AuthGuard).useValue({ canActivate: () => true }).compile();
    app = mod.createNestApplication(); await app.init();
  });
  after(async () => { process.env.IAM_API_ADMIN_TOKEN = env.a; process.env.IAM_AUTH_GATE_TOKEN = env.g; process.env.IAM_AUTHN_FILE = env.f; await app.close(); });
  const http = () => request(app.getHttpServer());
  const adm = { 'x-api-admin-token': ADMIN };
  const gate = (b: object) => http().post('/internal/auth/authenticate').set('x-gate-token', GATE).send(b);

  it('reads the defaults, the limits and both live and working values', async () => {
    const r = (await http().get(`/tenants/${T}/session`).expect(200)).body;
    assert.deepEqual(r.working, DEFAULT_SESSION); assert.deepEqual(r.live, DEFAULT_SESSION); assert.deepEqual(r.defaults, DEFAULT_SESSION);
    assert.deepEqual(r.limits.ttlSeconds, [60, 86_400]);
  });
  it('a sign-in answer carries the configured session length (classic password path)', async () => {
    const r = (await gate({ tenant: T, subject: 'demo-alice', password: PW }).expect(200)).body;
    assert.equal(r.outcome, 'allow'); assert.deepEqual(r.claims, { session_ttl: 1800, session_warn: 120, session_max: 28800 });
  });
  it('saving needs the admin capability and a valid configuration; nothing is stored on a refusal', async () => {
    await http().put(`/tenants/${T}/session`).send({ config: { ttlSeconds: 900 } }).expect(403);
    await http().put(`/tenants/${T}/session`).set(adm).send({ config: { ttlSeconds: 20 } }).expect(400);
    await http().put(`/tenants/${T}/session`).set(adm).send({ config: { ttlSeconds: 900, warnSeconds: 900 } }).expect(400);
    await http().put(`/tenants/${T}/session`).set(adm).send({}).expect(400);
    assert.deepEqual((await http().get(`/tenants/${T}/session`).expect(200)).body.working, DEFAULT_SESSION);
  });
  it('a saved configuration changes the next sign-in only, on the password path and on a chain', async () => {
    const c = { ttlSeconds: 900, warnSeconds: 60, maxSeconds: 7200, allowExtend: true };
    assert.deepEqual((await http().put(`/tenants/${T}/session`).set(adm).send({ config: c }).expect(200)).body, { saved: true, config: c });
    assert.deepEqual((await http().get(`/tenants/${T}/session`).expect(200)).body.live, c);
    assert.deepEqual((await gate({ tenant: T, subject: 'demo-alice', password: PW }).expect(200)).body.claims, { session_ttl: 900, session_warn: 60, session_max: 7200 });
    const pw = { id: 'pw', type: 'password', name: 'pw', enabled: true, level: 3, config: {} };
    await http().put(`/tenants/${T}/auth`).set(adm).send({ config: { methods: [pw], chains: [{ id: 'one', name: 'One', steps: ['pw'], level: 3 }], defaultChain: 'one' } }).expect(200);
    let r = (await gate({ tenant: T, subject: 'demo-alice', chain: 'one' }).expect(200)).body;
    if (r.outcome === 'challenge') r = (await gate({ tenant: T, session: r.session, answers: { password: PW } }).expect(200)).body;
    assert.equal(r.outcome, 'allow'); assert.equal(r.claims.session_ttl, 900); assert.equal(r.claims.session_max, 7200); assert.equal(r.claims.auth_chain, 'one');
  });
  it('renewal switched off: the absolute limit is the token length, so the core has nothing to add', async () => {
    await http().put(`/tenants/${T}/session`).set(adm).send({ config: { ttlSeconds: 600, warnSeconds: 30, maxSeconds: 9000, allowExtend: false } }).expect(200);
    let r = (await gate({ tenant: T, subject: 'demo-alice', chain: 'one' }).expect(200)).body;
    if (r.outcome === 'challenge') r = (await gate({ tenant: T, session: r.session, answers: { password: PW } }).expect(200)).body;
    assert.equal(r.outcome, 'allow');
    assert.deepEqual([r.claims.session_ttl, r.claims.session_warn, r.claims.session_max], [600, 30, 600]);
  });
});
