import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { AuthnService } from './flow.service.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { analyzeChain, validateConfig, parseStored, SEED_CONFIG, isEmptyConfig } from './config.js';
import { totpAt, base32Decode, hotp, base32Encode } from './totp.js';
import { startTestBus, TestBus } from '../testing/test-bus.js';

// Step 3 cleanup (decision 6): PluginsV1Module requires a reachable bus - one nats+core pair for this spec file.
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const ADMIN = 'x'.repeat(20), GATE = 'gate-token-1234', T = 'acme-demo', PW = 'demo-only-not-a-secret';
const m = (id: string, type: string, level: number, config: Record<string, unknown> = {}) => ({ id, type, name: id, enabled: true, level, config });
const cfg = (methods: any[], chains: any[], def: string | null = null) => ({ methods, chains, defaultChain: def });

type Gate = (b: any) => Promise<{ body: any }>;
/** Presses the keypad like the browser does: finds the button that carries each digit on the CURRENT page and posts its opaque id. */
async function pressPin(gate: Gate, T: string, c: any, pin: string, submit = true) {
  let r = c;
  for (const d of pin) {
    assert.equal(r.step.fields[0].type, 'keypad');
    const id = r.step.fields[0].keys.find((k: any) => k.digit === d).id;
    r = (await gate({ tenant: T, session: r.session, answers: { key: id } })).body; assert.equal(r.outcome, 'challenge');
  }
  return submit ? (await gate({ tenant: T, session: r.session, answers: { action: 'submit' } })).body : r;
}

describe('authentication methods and chains', () => {
  let app: INestApplication, svc: AuthnService; const env = { a: process.env.IAM_API_ADMIN_TOKEN, g: process.env.IAM_AUTH_GATE_TOKEN, f: process.env.IAM_AUTHN_FILE };
  let clock = 1_800_000_000_000;
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = ADMIN; process.env.IAM_AUTH_GATE_TOKEN = GATE; process.env.IAM_AUTHN_FILE = join(mkdtempSync(join(tmpdir(), 'authn-')), 'e.json');
    const mod = await Test.createTestingModule({ imports: [PluginsV1Module] }).overrideGuard(AuthGuard).useValue({ canActivate: () => true }).compile();
    app = mod.createNestApplication(); await app.init(); svc = app.get(AuthnService); svc.now = () => clock;
    // Step 2: a method is usable only while its plugin is enabled on the slot (the shipped plugins register disabled).
    const reg = app.get(PluginRegistry);
    for (const id of ['auth-totp', 'auth-email-otp', 'auth-digit-code']) { await reg.install(T, id, {}); await reg.enable(T, id, {}); }
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
      const c = validateConfig(cfg([m('pw', 'password', 3), m('pin', 'digit-code', 3)], [{ id: 'c', name: 'c', steps: ['pw', 'pin'], level: 4 }]));
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
    it('a branch sign-in needs its valid ticket: without one the refusal is generic and nothing leaks', async () => {
      for (const b of [{ tenant: T, subject: 'demo-alice', password: PW, branch: 'feature-x' }, { tenant: T, subject: 'demo-alice', password: PW, branch: 'feature-x', ticket: 'forged-ticket-value' }, { tenant: T, subject: 'demo-alice', password: PW, branch: 'main', ticket: 'whatever-here' }]) {
        const r = (await gate(b).expect(200)).body;
        assert.equal(r.outcome, 'deny'); assert.equal(r.reason, 'branch-test');
        assert.ok(!JSON.stringify(r).includes('feature-x'), 'the refusal does not echo the branch');
      }
      const e = await http().post('/internal/auth/entry').set('x-gate-token', GATE).send({ tenant: T, branch: 'feature-x' }).expect(200);
      assert.equal(e.body.mode, 'error');
    });

    it('chains enabled live: the entry lists them (choice), a picked chain opens, a forged id never falls back to a laxer path', async () => {
      await put(cfg([m('pw', 'password', 3), m('tp', 'totp', 7)], [{ id: 'pw-only', name: 'Password only', steps: ['pw'], level: 3 }, { id: 'mfa', name: 'Password + TOTP', steps: ['pw', 'tp'], level: 8 }], 'mfa')).expect(200);
      const entry = (b: object) => http().post('/internal/auth/entry').set('x-gate-token', GATE).send({ tenant: T, ...b }).expect(200);
      const ch = (await entry({})).body; assert.equal(ch.mode, 'choice');
      assert.deepEqual(ch.chains.map((c: any) => [c.id, c.recommended]), [['pw-only', false], ['mfa', true]]);
      assert.equal((await http().get(`/tenants/${T}/signin/options`).expect(200)).body.mode, 'choice');
      assert.equal((await entry({ chain: 'pw-only' })).body.mode, 'chain');
      assert.equal((await entry({ chain: 'ghost' })).body.mode, 'choice', 'unknown id: the list again, not a sign-in');
      // a picked chain is the one that runs: password only allows after one step, and the claim says so
      const ok = (await gate({ tenant: T, chain: 'pw-only', subject: 'demo-alice', password: PW }).expect(200)).body; assert.equal(ok.outcome, 'allow'); assert.equal(ok.claims.auth_chain, 'pw-only');
      assert.equal((await gate({ tenant: T, chain: 'ghost', subject: 'demo-alice', password: PW }).expect(200)).body.outcome, 'deny');
      // no chain id: the recommended chain (JSON API path), never a silent downgrade
      assert.equal((await gate({ tenant: T, subject: 'demo-alice', password: PW }).expect(200)).body.outcome, 'challenge');
    });

    it('password then authenticator code: wrong password ends at once, wrong code retries, replay is refused, claims are honest', async () => {
      await put(cfg([m('pw', 'password', 3), m('tp', 'totp', 7)], [{ id: 'mfa', name: 'Password + TOTP', steps: ['pw', 'tp'], level: 8 }], 'mfa')).expect(200);
      const tp = await provision('demo-alice', 'tp'); secrets.tp = tp.shownOnce.secret; assert.match(tp.shownOnce.otpauthUri, /^otpauth:\/\/totp\//);
      assert.deepEqual((await http().get(`/tenants/${T}/auth/enrollments/demo-alice`).set(adm)).body.enrollments.tp, { totp: true, pin: false, email: null });
      const e = (await http().post('/internal/auth/entry').set('x-gate-token', GATE).send({ tenant: T, chain: 'mfa' }).expect(200)).body;
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

    it('e-mail code then PIN keypad (order is free): the e-mail is only a demo outbox and the claims say so', async () => {
      await put(cfg([m('mail', 'email-otp', 4), m('pin', 'digit-code', 4)], [{ id: 'mail-pin', name: 'E-mail code then PIN digits', steps: ['mail', 'pin'], level: 4 }], 'mail-pin')).expect(200);
      await provision('demo-bob', 'mail', { email: 'bob@example.test' });
      const pin = (await provision('demo-bob', 'pin', { length: 6 })).shownOnce.pin as string; assert.match(pin, /^\d{6}$/);
      const e = (await http().post('/internal/auth/entry').set('x-gate-token', GATE).send({ tenant: T, chain: 'mail-pin' })).body; assert.deepEqual(e, { mode: 'chain', chain: { id: 'mail-pin', name: 'E-mail code then PIN digits' }, fields: [] });
      const c1 = (await gate({ tenant: T, subject: 'demo-bob' })).body;
      assert.equal(c1.outcome, 'challenge'); assert.equal(c1.step.type, 'email-otp');
      const mail = (await http().get(`/tenants/${T}/auth/outbox`).set(adm)).body; assert.equal(mail.simulated, true);
      const sent = mail.messages.find((x: any) => x.user === 'demo-bob'); assert.equal(sent.to, 'bob@example.test');
      const otp = /code is (\d{6})/.exec(sent.text)![1];
      const c2 = (await gate({ tenant: T, session: c1.session, answers: { code: otp } })).body;
      assert.equal(c2.outcome, 'challenge'); assert.equal(c2.step.type, 'digit-code');
      assert.equal(c2.step.fields[0].type, 'keypad'); assert.equal(c2.step.fields[0].keys.length, 10);
      assert.ok(!JSON.stringify(c2).includes(pin), 'the PIN is nowhere in the page data');
      const done = await pressPin(gate, T, c2, pin);
      assert.equal(done.outcome, 'allow'); assert.equal(done.claims.auth_mfa, false);
      assert.deepEqual(done.claims.auth_simulated, ['mail']); assert.deepEqual(done.claims.amr, ['pin']);
      assert.equal(done.claims.auth_level_declared, 4); assert.equal(done.claims.auth_level, 4); // capped by the really verified PIN (4)
    });

    it('with a real notifier on the notify.default slot, the e-mail step is delivered by the slot and counts as a verified possession factor', async () => {
      // P1-E: the OTP send path is chosen by the SLOT. A fake notifier takes the slot, declares real delivery
      // through notify.capability and captures the notify.send emission (durable: poll for the delivery).
      const { PluginRegistry } = await import('../plugins/v1/registry.js');
      const { BusHostRef } = await import('../plugins/v1/bus-host.js');
      const reg = app.get(PluginRegistry);
      const sent: any[] = [];
      reg.register({ manifest: { apiVersion: 'plugin/v3', id: 'notify-fake', version: '1.0.0', name: 'Fake mailer', description: 'test notifier', publisher: 'iam-platform', kinds: ['notifier'], extends: 'notify-log', provides: ['notify.default'], hooks: [{ name: 'notify.send', mode: 'async' }, { name: 'notify.capability', mode: 'blocking' }], settings: [{ key: 'prefix', type: 'string', label: 'Prefix', default: 'fake' }], entrypoints: { handlers: 'handlers.mjs' }, security: { signed: true } } as any,
        handlers: { 'notify.send': (pl: any) => { sent.push(pl); return { delivered: true, real: true, id: 'fake-1' }; }, 'notify.capability': () => ({ real: true, note: 'fake real delivery' }) } as any });
      await reg.install(T, 'notify-fake', { install: true });
      await reg.enable(T, 'notify-fake', {});
      await app.get(BusHostRef).host!.sync(); // enabling only schedules the bus re-push; serve the fake now
      (svc as any).profileEmail = async (u: string) => (u === 'demo-bob' ? 'bob.profile@example.test' : undefined);
      try {
        await put(cfg([m('pw', 'password', 3), m('mail', 'email-otp', 4, { delivery: 'smtp' })], [{ id: 'pw-mail', name: 'Password then e-mail', steps: ['pw', 'mail'], level: 6 }], 'pw-mail')).expect(200);
        const c1 = (await gate({ tenant: T, subject: 'demo-bob', answers: { password: 'demo-only-not-a-secret' } })).body;
        assert.equal(c1.outcome, 'challenge'); assert.equal(c1.step.type, 'email-otp'); assert.doesNotMatch(c1.step.message, /DEMO ONLY/);
        for (let i = 0; i < 60 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
        assert.equal(sent.length, 1); assert.equal(sent[0].to, 'bob.profile@example.test'); assert.equal(sent[0].template, 'sign-in-code');
        const before = (await http().get(`/tenants/${T}/auth/outbox`).set(adm)).body.messages.length;
        const done = (await gate({ tenant: T, session: c1.session, answers: { code: sent[0].data.code } })).body;
        assert.equal(done.outcome, 'allow'); assert.deepEqual(done.claims.auth_simulated, []); assert.equal(done.claims.auth_mfa, true);
        assert.equal((await http().get(`/tenants/${T}/auth/outbox`).set(adm)).body.messages.length, before, 'nothing went to the demo outbox');
        // an unknown account gets the same page and no message
        const u = (await gate({ tenant: T, subject: 'nobody-at-all', answers: { password: 'x' } })).body; assert.ok(['challenge', 'deny'].includes(u.outcome));
        for (let i = 0; i < 20 && sent.length > 1; i++) await new Promise((r) => setTimeout(r, 100));
        assert.equal(sent.length, 1);
      } finally { await reg.disable(T, 'notify-fake'); delete (svc as any).profileEmail; }
    });

    it('a later step cannot be skipped or answered early, and a finished session cannot be reused', async () => {
      await put(cfg([m('mail', 'email-otp', 4), m('pin', 'digit-code', 4)], [{ id: 'mail-pin2', name: 'Mail then PIN', steps: ['mail', 'pin'], level: 4 }], 'mail-pin2'));
      await provision('demo-bob', 'mail', { email: 'bobb@example.test' });
      const pin = (await provision('demo-bob', 'pin', { length: 6 })).shownOnce.pin as string;
      const c1 = (await gate({ tenant: T, subject: 'demo-bob' })).body;
      assert.match(c1.step.message, /DEMO ONLY: no e-mail is sent/);
      const early = (await gate({ tenant: T, session: c1.session, answers: { key: 'nope', action: 'submit' } })).body; assert.notEqual(early.outcome, 'allow'); assert.equal(early.claims, undefined);
      const codeOf = async () => /code is (\d{6})/.exec((await http().get(`/tenants/${T}/auth/outbox`).set(adm)).body.messages.find((x: any) => x.user === 'demo-bob' && x.to === 'bobb@example.test').text)![1];
      // the first step failed above: that session is over, even with the right code
      assert.notEqual((await gate({ tenant: T, session: c1.session, answers: { code: await codeOf() } })).body.outcome, 'allow');
      const f1 = (await gate({ tenant: T, subject: 'demo-bob' })).body;
      const c2 = (await gate({ tenant: T, session: f1.session, answers: { code: await codeOf() } })).body; assert.equal(c2.outcome, 'challenge');
      assert.equal((await pressPin(gate, T, c2, pin)).outcome, 'allow');
      const again = (await gate({ tenant: T, session: c2.session, answers: { action: 'submit' } })).body; assert.notEqual(again.outcome, 'allow'); assert.equal(again.claims, undefined);
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

    it('shuffled keypad: order and ids change on every page, ids are single page, the PIN is hashed and never echoed', async () => {
      await put(cfg([m('pin', 'digit-code', 3)], [{ id: 'pin-only', name: 'PIN', steps: ['pin'], level: 3 }], 'pin-only')).expect(200);
      const r = await provision('demo-alice', 'pin', { pin: '482915' }); assert.equal(r.shownOnce, undefined); assert.ok(!JSON.stringify(r).includes('482915'));
      await http().post(`/tenants/${T}/auth/enrollments/demo-alice/pin`).set(adm).send({ pin: '4829' }).expect(400); // wrong length for this method
      assert.equal((await http().post('/internal/auth/entry').set('x-gate-token', GATE).send({ tenant: T, chain: 'pin-only' })).body.mode, 'chain');
      const stored = JSON.stringify(JSON.parse(readFileSync(process.env.IAM_AUTHN_FILE!, 'utf8'))); assert.ok(!stored.includes('482915') && !/"pos"|pepper/.test(stored), 'no clear PIN, no per-position verifiers');
      const c = (await gate({ tenant: T, subject: 'demo-alice' })).body, k1 = c.step.fields[0].keys;
      const p2 = (await gate({ tenant: T, session: c.session, answers: { key: k1.find((k: any) => k.digit === '4').id } })).body, k2 = p2.step.fields[0].keys;
      assert.notDeepEqual(k1.map((k: any) => k.id), k2.map((k: any) => k.id)); assert.equal(p2.step.fields[0].entered, 1);
      assert.equal(new Set([...k1, ...k2].map((k: any) => k.id)).size, 20, 'fresh opaque ids on every page');
      // an id from an earlier page is a replayed button: the attempt is refused
      assert.equal((await gate({ tenant: T, session: c.session, answers: { key: k1[0].id } })).body.outcome, 'deny');
      // right PIN, one press at a time, allowed; wrong PIN denied; too short denied
      assert.equal((await pressPin(gate, T, (await gate({ tenant: T, subject: 'demo-alice' })).body, '482915')).outcome, 'allow');
      assert.equal((await pressPin(gate, T, (await gate({ tenant: T, subject: 'demo-alice' })).body, '482916')).outcome, 'deny');
      assert.equal((await pressPin(gate, T, (await gate({ tenant: T, subject: 'demo-alice' })).body, '4829')).outcome, 'deny');
      // delete removes the last digit
      const q = (await gate({ tenant: T, subject: 'demo-alice' })).body; const q1 = await pressPin(gate, T, q, '48299', false);
      const q2 = (await gate({ tenant: T, session: q1.session, answers: { action: 'delete' } })).body; assert.equal(q2.step.fields[0].entered, 4);
      assert.equal((await pressPin(gate, T, q2, '15')).outcome, 'allow');
    });

    it('the gate and the admin enrollment refuse missing tokens', async () => {
      await http().post('/internal/auth/entry').send({ tenant: T }).expect(401);
      await http().post(`/tenants/${T}/auth/enrollments/demo-alice/tp`).send({}).expect(403);
      await http().get(`/tenants/${T}/auth/outbox`).expect(403);
    });
  });

  it('the core has NO mail adapter anymore: real OTP delivery only exists through the notify.default slot (P1-E)', async () => {
    // The old ResendMailAdapter/SmtpMailAdapter (authn/mail.ts) are deleted: one Resend path, the plugin's.
    assert.equal((await import('node:fs')).existsSync(new URL('../../src/authn/mail.ts', import.meta.url)), false, 'authn/mail.ts is gone');
    const { PluginRegistry } = await import('../plugins/v1/registry.js');
    const reg = app.get(PluginRegistry);
    // The base log transport occupies the slot and says explicitly it simulates (unavailability policy).
    const cap = await reg.callSlot<{ real: boolean; note?: string }>(T, 'notify.default', 'notify.capability', {});
    assert.equal(cap.servedBy, 'notify-log'); assert.equal(cap.result.real, false); assert.match(cap.result.note ?? '', /simulated/);
  });
  it('totp helpers match the RFC 6238 test vector', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    assert.equal(totpAt(secret, 59_000, 30, 8), '94287082');
    assert.equal(totpAt(secret, 1111111109_000, 30, 8), '07081804');
  });
});

describe('authn configuration is checked when staged, so Apply never receives a broken one', () => {
  const pw = { id: 'pw', type: 'password', name: 'Password', level: 3 };
  const rejects = (cfg: unknown, re: RegExp) => assert.throws(() => validateConfig(cfg), (e: any) => re.test(String(e.message)));
  it('refuses unknown steps, repeated steps, levels out of range, a chain weaker than its strongest step and catalogue-only types', () => {
    rejects({ methods: [pw], chains: [{ id: 'c', name: 'C', steps: ['nope'], level: 3 }] }, /unknown method/);
    rejects({ methods: [pw], chains: [{ id: 'c', name: 'C', steps: ['pw', 'pw'], level: 3 }] }, /twice/);
    rejects({ methods: [{ ...pw, level: 11 }], chains: [] }, /1 to 10/);
    rejects({ methods: [{ ...pw, level: 7 }], chains: [{ id: 'c', name: 'C', steps: ['pw'], level: 3 }] }, /below its strongest step/);
    rejects({ methods: [{ ...pw, type: 'passkey' }], chains: [] }, /catalogue only|unknown type/);
    rejects({ methods: [pw], chains: [], defaultChain: 'ghost' }, /unknown chain/);
    rejects({ methods: [pw], chains: [], extra: 1 }, /unknown configuration field/);
  });
  it('a damaged stored value falls back to an empty configuration instead of breaking sign-in', () => {
    assert.deepEqual(parseStored({ methods: 'garbage' } as any), { methods: [], chains: [], defaultChain: null });
    assert.deepEqual(parseStored(undefined), { methods: [], chains: [], defaultChain: null });
  });
});

describe('ready-to-try examples', () => {
  it('the seed is valid, executable only, selects no chain for sign-in, and an existing config is never replaced', () => {
    const cfg = validateConfig(SEED_CONFIG);
    assert.equal(cfg.defaultChain, null);
    assert.ok(cfg.methods.length >= 4 && cfg.chains.length >= 4);
    assert.ok(!cfg.methods.some((m) => ['passkey', 'recovery-codes', 'external-idp'].includes(m.type)));
    assert.equal(isEmptyConfig(SEED_CONFIG), false);
    assert.equal(isEmptyConfig({ methods: [], chains: [], defaultChain: null }), true);
    assert.equal(isEmptyConfig({ methods: [SEED_CONFIG.methods[0]], chains: [], defaultChain: null }), false);
  });
});

describe('opt-in persistent demo seed', () => {
  it('seeds an empty base once: stored examples, enrolled fictional demo-alice, no chain selected; never overwrites', async () => {
    const f = process.env.IAM_AUTHN_FILE; process.env.IAM_AUTHN_FILE = join(mkdtempSync(join(tmpdir(), 'authn-seed-')), 'e.json');
    const mod = await Test.createTestingModule({ imports: [PluginsV1Module] }).overrideGuard(AuthGuard).useValue({ canActivate: () => true }).compile();
    const app = mod.createNestApplication(); await app.init(); const svc = app.get(AuthnService);
    try {
      assert.equal((await svc.liveConfig('seedt')).methods.length, 0);
      assert.equal(await svc.seedDemo('seedt'), true);
      const c = await svc.liveConfig('seedt');
      assert.ok(c.methods.length > 0 && c.chains.length > 0); assert.equal(c.defaultChain, null);
      const st = await svc.enroll.status('seedt', 'demo-alice');
      assert.ok(st['authenticator-app']?.totp && st['pin-keypad']?.pin && st['e-mail-code']?.email);
      assert.equal(await svc.seedDemo('seedt'), false);
      await svc.saveConfig('other', { methods: [], chains: [], defaultChain: null });
      const own = validateConfig({ methods: [m('only', 'password', 3)], chains: [], defaultChain: null });
      await svc.saveConfig('mine', own);
      assert.equal(await svc.seedDemo('mine'), false);
      assert.deepEqual((await svc.liveConfig('mine')).methods.map((x: any) => x.id), ['only']);
    } finally { process.env.IAM_AUTHN_FILE = f; await app.close(); }
  });
});
