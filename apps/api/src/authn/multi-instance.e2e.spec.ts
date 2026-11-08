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
import { totpAt, base32Decode, hotp } from './totp.js';
import { startTestBus, TestBus } from '../testing/test-bus.js';

/** Step 6 acceptance: several INSTANCES of the same method plugin run side by side, each with its own
 *  configuration and per-user enrollment. Two PIN instances with different lengths, two TOTP instances
 *  with independent secrets; chains combine instances freely (the same instance twice is refused by
 *  config validation, covered in authn.spec). */
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const ADMIN = 'y'.repeat(20), GATE = 'gate-token-5678', T = 'acme-demo';
const m = (id: string, type: string, level: number, config: Record<string, unknown> = {}) => ({ id, type, name: id, enabled: true, level, config });
const cfg = (methods: unknown[], chains: unknown[], def: string | null = null) => ({ methods, chains, defaultChain: def });

type Gate = (b: any) => Promise<{ body: any }>;
async function pressPin(gate: Gate, c: any, pin: string) {
  let r = c;
  for (const d of pin) {
    assert.equal(r.step.fields[0].type, 'keypad');
    const id = r.step.fields[0].keys.find((k: any) => k.digit === d).id;
    r = (await gate({ tenant: T, session: r.session, answers: { key: id } })).body;
  }
  return (await gate({ tenant: T, session: r.session, answers: { action: 'submit' } })).body;
}

describe('several instances of the same method plugin (step 6 acceptance)', () => {
  let app: INestApplication, svc: AuthnService; const env = { a: process.env.IAM_API_ADMIN_TOKEN, g: process.env.IAM_AUTH_GATE_TOKEN, f: process.env.IAM_AUTHN_FILE };
  let clock = 1_800_000_000_000;
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = ADMIN; process.env.IAM_AUTH_GATE_TOKEN = GATE; process.env.IAM_AUTHN_FILE = join(mkdtempSync(join(tmpdir(), 'authn-multi-')), 'e.json');
    const mod = await Test.createTestingModule({ imports: [PluginsV1Module] }).overrideGuard(AuthGuard).useValue({ canActivate: () => true }).compile();
    app = mod.createNestApplication(); await app.init(); svc = app.get(AuthnService); svc.now = () => clock;
    const reg = app.get(PluginRegistry);
    for (const id of ['auth-totp', 'auth-digit-code']) { await reg.install(T, id, {}); await reg.enable(T, id, { uiComponents: true }); }
  });
  after(async () => { process.env.IAM_API_ADMIN_TOKEN = env.a; process.env.IAM_AUTH_GATE_TOKEN = env.g; process.env.IAM_AUTHN_FILE = env.f; await app.close(); });
  const http = () => request(app.getHttpServer());
  const adm = { 'x-api-admin-token': ADMIN };
  const put = (c: unknown) => http().put(`/tenants/${T}/auth`).set(adm).send({ config: c });
  const gate = (b: object) => http().post('/internal/auth/authenticate').set('x-gate-token', GATE).send(b);
  const provision = async (user: string, inst: string, body: object = {}) => (await http().post(`/tenants/${T}/auth/enrollments/${user}/${inst}`).set(adm).send(body).expect(201)).body;
  const secrets: Record<string, string> = {};
  const code = (inst: string, step = 0) => hotp(base32Decode(secrets[inst]), Math.floor(clock / 1000 / 30) + step, 6);

  it('two PIN instances with different lengths: each enrolls its own length and a chain runs both in order', async () => {
    await put(cfg(
      [m('pin4', 'digit-code', 3, { length: 4 }), m('pin6', 'digit-code', 4, { length: 6 })],
      [{ id: 'two-pins', name: 'PIN 4 then PIN 6', steps: ['pin4', 'pin6'], level: 5 }],
      'two-pins',
    )).expect(200);
    // each instance enforces ITS configured length
    await provision('demo-alice', 'pin4', { pin: '4829' });
    await http().post(`/tenants/${T}/auth/enrollments/demo-alice/pin4`).set(adm).send({ pin: '482915' }).expect(400);
    await provision('demo-alice', 'pin6', { pin: '730146' });
    await http().post(`/tenants/${T}/auth/enrollments/demo-alice/pin6`).set(adm).send({ pin: '7301' }).expect(400);
    const status = (await http().get(`/tenants/${T}/auth/enrollments/demo-alice`).set(adm)).body.enrollments;
    assert.equal(status.pin4.pin?.length, 4); assert.equal(status.pin6.pin?.length, 6, 'each instance reports its own enrollment');
    // sign in through the chain: 4 key presses, then 6
    let r = (await gate({ tenant: T, subject: 'demo-alice' }).expect(200)).body;
    assert.equal(r.outcome, 'challenge'); assert.equal(r.step.total, 2);
    // a wrong PIN at the FIRST step is a deny (no session lives on), same rule as a wrong password
    const wrong = await pressPin(gate, r, '0000');
    assert.equal(wrong.outcome, 'deny');
    // fresh sign-in: the right PIN for instance pin4 opens step 2
    r = (await gate({ tenant: T, subject: 'demo-alice' }).expect(200)).body;
    r = await pressPin(gate, r, '4829');
    assert.equal(r.outcome, 'challenge'); assert.equal(r.step.index, 1);
    // pin4's PIN does not answer pin6's step (a full-length wrong PIN). The keypad keeps its entered
    // digits after a wrong submit (the browser offers delete), so the clean run signs in fresh.
    const cross = await pressPin(gate, r, '000000');
    assert.equal(cross.outcome, 'challenge'); assert.match(cross.error ?? '', /attempt/);
    // the right PINs, in a fresh session, run the whole chain
    let clean = (await gate({ tenant: T, subject: 'demo-alice' }).expect(200)).body;
    clean = await pressPin(gate, clean, '4829');
    const done = await pressPin(gate, clean, '730146');
    assert.equal(done.outcome, 'allow');
    assert.deepEqual(done.claims.amr, ['pin']); assert.equal(done.claims.auth_mfa, false, 'two PINs are one knowledge factor, honestly reported');
    assert.equal(done.claims.auth_level, 5);
  });

  it('two TOTP instances with independent secrets: a code only answers the step of its own instance', async () => {
    await put(cfg(
      [m('totp-a', 'totp', 7, { issuer: 'Acme A' }), m('totp-b', 'totp', 7, { issuer: 'Acme B' })],
      [{ id: 'two-totp', name: 'Two authenticators', steps: ['totp-a', 'totp-b'], level: 8 }],
      'two-totp',
    )).expect(200);
    const a = await provision('demo-alice', 'totp-a'); secrets['totp-a'] = a.shownOnce.secret;
    const b = await provision('demo-alice', 'totp-b'); secrets['totp-b'] = b.shownOnce.secret;
    assert.notEqual(secrets['totp-a'], secrets['totp-b']);
    assert.match(a.shownOnce.otpauthUri, /issuer=Acme(%20| )A/); assert.match(b.shownOnce.otpauthUri, /issuer=Acme(%20| )B/);
    let r = (await gate({ tenant: T, subject: 'demo-alice' }).expect(200)).body;
    assert.equal(r.outcome, 'challenge'); assert.equal(r.step.total, 2);
    // instance B's code does not answer instance A's step: a wrong FIRST factor is a deny, no session lives on
    const cross = (await gate({ tenant: T, session: r.session, answers: { code: code('totp-b') } }).expect(200)).body;
    assert.equal(cross.outcome, 'deny');
    // fresh sign-in: instance A's code opens step 2
    r = (await gate({ tenant: T, subject: 'demo-alice' }).expect(200)).body;
    const step2 = (await gate({ tenant: T, session: r.session, answers: { code: code('totp-a') } }).expect(200)).body;
    assert.equal(step2.outcome, 'challenge'); assert.equal(step2.step.index, 1);
    // replay of A's code at step B refused; B's code finishes
    assert.equal((await gate({ tenant: T, session: step2.session, answers: { code: code('totp-a') } })).body.outcome, 'challenge');
    const ok = (await gate({ tenant: T, session: step2.session, answers: { code: code('totp-b') } }).expect(200)).body;
    assert.equal(ok.outcome, 'allow');
    assert.deepEqual(ok.claims.amr, ['otp']); assert.equal(ok.claims.auth_mfa, false, 'same factor twice is not multi-factor');
    assert.equal(ok.claims.auth_level, 8);
  });

  it('config validation still applies per instance: unknown settings and out-of-range length are refused', async () => {
    const tooLong = cfg([m('pin9', 'digit-code', 3, { length: 9 })], []);
    const r1 = await put(tooLong); assert.equal(r1.status, 400);
    const unknown = cfg([m('pin-x', 'digit-code', 3, { bogus: 1 })], []);
    const r2 = await put(unknown); assert.equal(r2.status, 400);
  });
});
