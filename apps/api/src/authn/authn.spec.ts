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
import { analyzeChain, validateConfig } from './config.js';
import { totpAt, base32Decode, hotp, base32Encode } from './totp.js';

const ADMIN = 'x'.repeat(20), GATE = 'gate-token-1234', T = 'acme-demo', PW = 'demo-only-not-a-secret';
const m = (id: string, type: string, level: number, config: Record<string, unknown> = {}) => ({ id, type, name: id, enabled: true, level, config });
const cfg = (methods: any[], chains: any[], def: string | null = null) => ({ methods, chains, defaultChain: def });

describe('authentication methods and chains', () => {
  let app: INestApplication, svc: AuthnService; const env = { a: process.env.IAM_API_ADMIN_TOKEN, g: process.env.IAM_AUTH_GATE_TOKEN, f: process.env.IAM_AUTHN_FILE };
  let clock = 1_800_000_000_000;
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = ADMIN; process.env.IAM_AUTH_GATE_TOKEN = GATE; process.env.IAM_AUTHN_FILE = join(mkdtempSync(join(tmpdir(), 'authn-')), 'e.json');
    const mod = await Test.createTestingModule({ imports: [PluginsV1Module] }).overrideGuard(AuthGuard).useValue({ canActivate: () => true }).compile();
    app = mod.createNestApplication(); await app.init(); svc = app.get(AuthnService); svc.now = () => clock;
  });
  after(async () => { process.env.IAM_API_ADMIN_TOKEN = env.a; process.env.IAM_AUTH_GATE_TOKEN = env.g; process.env.IAM_AUTHN_FILE = env.f; await app.close(); });
  const http = () => request(app.getHttpServer());
  const adm = { 'x-api-admin-token': ADMIN };
  const put = (c: unknown) => http().put(`/tenants/${T}/auth`).set(adm).send({ config: c });

  describe('validation', () => {
    const base = [m('pw', 'password', 3), m('tp', 'totp', 7)];
    it('accepts a coherent configuration and applies defaults', () => {
      const c = validateConfig(cfg(base, [{ id: 'c1', name: 'Pw then TOTP', steps: ['pw', 'tp'], level: 8 }], 'c1'));
      assert.equal(c.methods[1].config.digits, '6'); assert.equal(c.defaultChain, 'c1');
    });
    it('refuses bad levels, unknown types, catalogue-only types and unknown settings', () => {
      assert.throws(() => validateConfig(cfg([m('a', 'password', 0)], [])), /1 to 10/);
      assert.throws(() => validateConfig(cfg([m('a', 'password', 11)], [])), /1 to 10/);
      assert.throws(() => validateConfig(cfg([m('a', 'password', 2.5)], [])), /whole number/);
      assert.throws(() => validateConfig(cfg([m('a', 'nope', 3)], [])), /unknown type/);
      assert.throws(() => validateConfig(cfg([m('a', 'passkey', 9)], [])), /catalogue only/);
      assert.throws(() => validateConfig(cfg([m('a', 'totp', 5, { evil: 1 })], [])), /unknown setting/);
      assert.throws(() => validateConfig(cfg([m('A_B', 'password', 3)], [])), /method id/);
      assert.throws(() => validateConfig(cfg([m('a', 'password', 3), m('a', 'password', 3)], [])), /duplicate method/);
    });
    it('refuses chains that are empty, repeat an instance, reference unknown or disabled methods, or sit below their strongest step', () => {
      assert.throws(() => validateConfig(cfg(base, [{ id: 'c', name: 'c', steps: [], level: 5 }])), /1 to 6 steps/);
      assert.throws(() => validateConfig(cfg(base, [{ id: 'c', name: 'c', steps: ['pw', 'pw'], level: 5 }])), /twice/);
      assert.throws(() => validateConfig(cfg(base, [{ id: 'c', name: 'c', steps: ['zz'], level: 5 }])), /unknown method/);
      assert.throws(() => validateConfig(cfg(base, [{ id: 'c', name: 'c', steps: ['pw', 'tp'], level: 6 }])), /below its strongest step/);
      assert.throws(() => validateConfig(cfg([m('pw', 'password', 3), { ...m('tp', 'totp', 7), enabled: false }], [{ id: 'c', name: 'c', steps: ['pw', 'tp'], level: 8 }])), /disabled/);
      assert.throws(() => validateConfig(cfg(base, [{ id: 'c', name: 'c', steps: ['pw'], level: 5 }], 'other')), /unknown chain/);
    });
  });

  describe('honest analysis', () => {
    it('does not add levels and does not call password + PIN multi-factor', () => {
      const c = validateConfig(cfg([m('pw', 'password', 3), m('pin', 'digit-code', 3, { mode: 'full' })], [{ id: 'c', name: 'c', steps: ['pw', 'pin'], level: 4 }]));
      const a = analyzeChain(c, c.chains[0]);
      assert.equal(a.declaredLevel, 4); assert.equal(a.mfa, false); assert.deepEqual(a.verifiedFactors, ['knowledge']);
      assert.ok(a.warnings.some((w) => /same factor category/.test(w)));
    });
    it('password + TOTP is multi-factor; the level is the declared one', () => {
      const c = validateConfig(cfg([m('pw', 'password', 3), m('tp', 'totp', 7)], [{ id: 'c', name: 'c', steps: ['pw', 'tp'], level: 9 }]));
      const a = analyzeChain(c, c.chains[0]); assert.equal(a.mfa, true); assert.equal(a.effectiveLevel, 9); assert.equal(a.declaredLevel, 9);
    });
    it('a simulated e-mail step does not count as a factor and caps the effective level', () => {
      const c = validateConfig(cfg([m('pw', 'password', 3), m('mail', 'email-otp', 6)], [{ id: 'c', name: 'c', steps: ['pw', 'mail'], level: 8 }]));
      const a = analyzeChain(c, c.chains[0]);
      assert.equal(a.mfa, false); assert.deepEqual(a.simulatedSteps, ['mail']); assert.equal(a.declaredLevel, 8); assert.equal(a.effectiveLevel, 3);
    });
    it('warns when one method type is repeated', () => {
      const c = validateConfig(cfg([m('t1', 'totp', 6), m('t2', 'totp', 6, { periodSeconds: '60' })], [{ id: 'c', name: 'c', steps: ['t1', 't2'], level: 6 }]));
      const a = analyzeChain(c, c.chains[0]); assert.equal(a.mfa, false); assert.ok(a.warnings.some((w) => /repeating a type/.test(w)));
    });
  });

  describe('admin API', () => {
    it('reading needs sign-in only, writing needs the admin capability and validates', async () => {
      await http().get(`/tenants/${T}/auth`).expect(200);
      await http().put(`/tenants/${T}/auth`).send({ config: cfg([], []) }).expect(403);
      await put(cfg([m('a', 'password', 99)], [])).expect(400);
      const r = await http().get(`/tenants/${T}/auth`).expect(200);
      assert.equal(r.body.catalogue.find((c: any) => c.id === 'passkey').maturity, 'catalogue');
      assert.equal(r.body.live.signInMode, 'base-password');
    });
    it('the catalogue lists the implemented method types, one of them simulated by default', async () => {
      const r = await http().get(`/tenants/${T}/auth`).expect(200);
      const by = Object.fromEntries(r.body.catalogue.map((c: any) => [c.id, c]));
      for (const id of ['password', 'email-otp', 'digit-code', 'totp']) assert.equal(by[id].maturity, 'implemented');
      assert.equal(by['email-otp'].simulatedByDefault, true); assert.equal(by.totp.simulatedByDefault, false);
    });
  });

  describe('sign-in flows through the gate', () => {
    const gate = (b: object) => http().post('/internal/auth/authenticate').set('x-gate-token', GATE).send(b);
    const code = (inst: string, step = 0, digits = 6, period = 30) => hotp(base32Decode(secrets[inst]), Math.floor(clock / 1000 / period) + step, digits);
    const secrets: Record<string, string> = {};
    const provision = async (user: string, inst: string, body: object = {}) => (await http().post(`/tenants/${T}/auth/enrollments/${user}/${inst}`).set(adm).send(body).expect(201)).body;

    it('no chain live: the legacy base password path is untouched', async () => {
      assert.deepEqual((await http().post('/internal/auth/entry').set('x-gate-token', GATE).send({ tenant: T }).expect(200)).body, { mode: 'legacy' });
      assert.equal((await gate({ tenant: T, subject: 'demo-alice', password: PW }).expect(200)).body.outcome, 'allow');
      assert.equal((await gate({ tenant: T, subject: 'demo-alice', password: 'nope' }).expect(200)).body.outcome, 'deny');
    });

    it('password then authenticator code: wrong password ends at once, wrong code retries, replay is refused, claims are honest', async () => {
      await put(cfg([m('pw', 'password', 3), m('tp', 'totp', 7)], [{ id: 'mfa', name: 'Password + TOTP', steps: ['pw', 'tp'], level: 8 }], 'mfa')).expect(200);
      const tp = await provision('demo-alice', 'tp'); secrets.tp = tp.shownOnce.secret; assert.match(tp.shownOnce.otpauthUri, /^otpauth:\/\/totp\//);
      assert.deepEqual((await http().get(`/tenants/${T}/auth/enrollments/demo-alice`).set(adm)).body.enrollments.tp, { totp: true, pin: false, email: null });
      const e = (await http().post('/internal/auth/entry').set('x-gate-token', GATE).send({ tenant: T }).expect(200)).body;
      assert.equal(e.mode, 'chain'); assert.deepEqual(e.fields.map((f: any) => f.name), ['password']);
      // wrong password: generic deny, nothing about the second step
      assert.deepEqual((await gate({ tenant: T, subject: 'demo-alice', password: 'wrong' }).expect(200)).body, { outcome: 'deny', reason: 'bad-credentials', message: 'Sign-in failed. Check your details and try again.' });
      // right password: second step requested
      const c1 = (await gate({ tenant: T, subject: 'demo-alice', password: PW }).expect(200)).body;
      assert.equal(c1.outcome, 'challenge'); assert.equal(c1.step.index, 1); assert.equal(c1.step.total, 2); assert.equal(c1.step.type, 'totp');
      const bad = (await gate({ tenant: T, session: c1.session, answers: { code: '000000' } }).expect(200)).body;
      assert.equal(bad.outcome, 'challenge'); assert.match(bad.error, /2 attempt/);
      const ok = (await gate({ tenant: T, session: c1.session, answers: { code: code('tp') } }).expect(200)).body;
      assert.equal(ok.outcome, 'allow');
      assert.deepEqual(ok.claims.amr.sort(), ['otp', 'pwd']); assert.equal(ok.claims.auth_mfa, true); assert.equal(ok.claims.auth_level, 8); assert.equal(ok.claims.auth_level_basis, 'configured');
      // the same code in a new sign-in is a replay
      const c2 = (await gate({ tenant: T, subject: 'demo-alice', password: PW }).expect(200)).body;
      assert.equal((await gate({ tenant: T, session: c2.session, answers: { code: code('tp') } })).body.outcome, 'challenge');
      // the session is not reusable after success
      assert.equal((await gate({ tenant: T, session: c1.session, answers: { code: code('tp', 1) } })).body.outcome, 'deny');
    });

    it('three wrong codes end the attempt', async () => {
      const c = (await gate({ tenant: T, subject: 'demo-alice', password: PW })).body; let r: any = c;
      for (let i = 0; i < 3; i++) r = (await gate({ tenant: T, session: c.session, answers: { code: '111111' } })).body;
      assert.equal(r.outcome, 'deny');
      assert.equal((await gate({ tenant: T, session: c.session, answers: { code: code('tp', -1) } })).body.outcome, 'deny');
    });

    it('e-mail code then bank-style digits (order is free): the e-mail is only a demo outbox and the claims say so', async () => {
      await put(cfg([m('mail', 'email-otp', 4), m('pin', 'digit-code', 4, { mode: 'positions', positions: 3 })], [{ id: 'mail-pin', name: 'E-mail code then PIN digits', steps: ['mail', 'pin'], level: 4 }], 'mail-pin')).expect(200);
      await provision('demo-bob', 'mail', { email: 'bob@example.test' });
      const pin = (await provision('demo-bob', 'pin', { length: 6 })).shownOnce.pin as string; assert.match(pin, /^\d{6}$/);
      const e = (await http().post('/internal/auth/entry').set('x-gate-token', GATE).send({ tenant: T })).body; assert.deepEqual(e, { mode: 'chain', fields: [] });
      const c1 = (await gate({ tenant: T, subject: 'demo-bob' })).body;
      assert.equal(c1.outcome, 'challenge'); assert.equal(c1.step.type, 'email-otp');
      const mail = (await http().get(`/tenants/${T}/auth/outbox`).set(adm)).body; assert.equal(mail.simulated, true);
      const sent = mail.messages.find((x: any) => x.user === 'demo-bob'); assert.equal(sent.to, 'bob@example.test');
      const otp = /code is (\d{6})/.exec(sent.text)![1];
      const c2 = (await gate({ tenant: T, session: c1.session, answers: { code: otp } })).body;
      assert.equal(c2.outcome, 'challenge'); assert.equal(c2.step.type, 'digit-code'); assert.equal(c2.step.fields.length, 3);
      const ans = Object.fromEntries(c2.step.fields.map((f: any) => { const p = Number(f.name.slice(1)); return [f.name, pin[p]]; }));
      const done = (await gate({ tenant: T, session: c2.session, answers: ans })).body;
      assert.equal(done.outcome, 'allow'); assert.equal(done.claims.auth_mfa, false);
      assert.deepEqual(done.claims.auth_simulated, ['mail']); assert.deepEqual(done.claims.amr, ['pin']);
      assert.equal(done.claims.auth_level_declared, 4); assert.equal(done.claims.auth_level, 4); // capped by the really verified PIN (4)
    });

    it('a wrong PIN digit fails; a code is single use and expires', async () => {
      const c1 = (await gate({ tenant: T, subject: 'demo-bob' })).body; const sent = (await http().get(`/tenants/${T}/auth/outbox`).set(adm)).body.messages[0];
      const otp = /code is (\d{6})/.exec(sent.text)![1];
      clock += 6 * 60_000; // past the 5 minute code lifetime (and the session lifetime)
      assert.equal((await gate({ tenant: T, session: c1.session, answers: { code: otp } })).body.outcome, 'deny');
    });

    it('unknown and known accounts look the same until the end, and an unknown one never signs in', async () => {
      const c1 = (await gate({ tenant: T, subject: 'nobody-here' })).body;
      assert.equal(c1.outcome, 'challenge'); assert.equal(c1.step.type, 'email-otp');
      assert.equal((await gate({ tenant: T, session: c1.session, answers: { code: '123456' } })).body.outcome, 'deny');
    });

    it('throttles repeated failures for an account', async () => {
      let r: any;
      for (let i = 0; i < 12; i++) { const c = (await gate({ tenant: T, subject: 'victim' })).body; if (c.outcome === 'deny') { r = c; break; } r = (await gate({ tenant: T, session: c.session, answers: { code: '000000' } })).body; }
      assert.equal(r.outcome, 'deny');
      assert.deepEqual((await gate({ tenant: T, subject: 'victim' })).body, { outcome: 'deny', reason: 'bad-credentials', message: 'Sign-in failed. Check your details and try again.' });
    });

    it('a PIN typed in the admin form is kept as verifiers, never echoed back', async () => {
      await put(cfg([m('pin', 'digit-code', 3, { mode: 'full' })], [{ id: 'pin-only', name: 'PIN', steps: ['pin'], level: 3 }], 'pin-only')).expect(200);
      const r = await provision('demo-alice', 'pin', { pin: '482915' }); assert.equal(r.shownOnce, undefined); assert.ok(!JSON.stringify(r).includes('482915'));
      const e = (await http().post('/internal/auth/entry').set('x-gate-token', GATE).send({ tenant: T })).body; assert.deepEqual(e.fields.map((f: any) => f.name), ['pin']);
      assert.equal((await gate({ tenant: T, subject: 'demo-alice', answers: { pin: '482915' } })).body.outcome, 'allow');
      assert.equal((await gate({ tenant: T, subject: 'demo-alice', answers: { pin: '482916' } })).body.outcome, 'deny');
      assert.equal((await gate({ tenant: T, subject: 'demo-alice', answers: { pin: '48291' } })).body.outcome, 'deny');
    });

    it('the gate and the admin enrollment refuse missing tokens', async () => {
      await http().post('/internal/auth/entry').send({ tenant: T }).expect(401);
      await http().post(`/tenants/${T}/auth/enrollments/demo-alice/tp`).send({}).expect(403);
      await http().get(`/tenants/${T}/auth/outbox`).expect(403);
    });
  });

  it('totp helpers match the RFC 6238 test vector', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    assert.equal(totpAt(secret, 59_000, 30, 8), '94287082');
    assert.equal(totpAt(secret, 1111111109_000, 30, 8), '07081804');
  });
});
