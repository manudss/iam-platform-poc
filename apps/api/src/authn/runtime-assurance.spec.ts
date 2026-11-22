import 'reflect-metadata';
import '../plugins/v1/plugins-v1.module.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AuthnService } from './flow.service.js';
import { type AuthnConfig, analyzeChain } from './config.js';
import { DEFAULT_SESSION } from './session-config.js';
import { DEFAULT_SECURITY } from '../accounts/security-config.js';
import { defaultPluginsDir } from '../plugins/v1/loader.js';
import { checkAssurance } from './step-up.js';

// Real orchestrator and shipped mail handler, local dependency fixtures. No network, token or user data.
const mail = (await import(pathToFileURL(join(defaultPluginsDir(), 'auth-email-otp/handlers.mjs')).href)).default;
const method = (id: string, type: string, level: number, config = {}) => ({ id, type, name: id, enabled: true, level, config });
const config = (methods: AuthnConfig['methods'], steps: string[], level = 6): AuthnConfig => ({ methods, chains: [{ id: 'chain', name: 'Chain', enabled: true, steps, level }], defaultChain: 'chain' });
function harness(cfg: AuthnConfig) {
  const state = { capable: false, preparedCapable: false, code: '', sent: 0, outbox: 0, active: true, email: 'fixture@example.invalid' as string | undefined };
  const reg = {
    resolve: (_t: string, slot: string) => ({ manifest: { id: slot, authMethod: {} } }),
    isActive: () => state.active,
    callSlot: async (_t: string, slot: string, hook: string, payload: any) => {
      if (slot === 'notify.default') return { result: { real: state.capable } };
      if (hook === 'auth.verification') return { result: slot === 'auth.email-otp' ? mail[hook](payload) : { real: true, note: 'fixture provider verdict' } };
      if (slot === 'auth.email-otp') { const result = mail[hook](payload); state.code = result.mail?.data.code ?? result.notify?.data.code ?? state.code; return { result }; }
      if (hook === 'auth.prepare') return { result: { prompt: { title: 'Fixture', fields: [] }, state: {} } };
      if (hook === 'auth.verify') return { result: { ok: payload.answers?.password === 'fixture-accepted' } };
      throw new Error('Unexpected fixture hook');
    },
    emit: async () => { state.sent++; },
  };
  const svc: any = new AuthnService(reg as never);
  svc.now = () => 1_800_000_000_000; svc.audit = () => {};
  svc.signinConfig = async () => cfg; svc.signinRegistry = async () => reg;
  svc.signinSession = async () => DEFAULT_SESSION; svc.signinSecurity = async () => DEFAULT_SECURITY;
  svc.blocks.list = async () => []; svc.enroll.status = async () => ({ pin: { pin: { length: 6 } } });
  svc.profileEmail = async () => state.email;
  svc.outbox.send = async () => { state.outbox++; };
  svc.methodPayload = async (_r: unknown, s: any, st: any, stored: unknown, answers: unknown) => ({ tenant: s.tenant, subject: s.subject, known: true, instanceId: st.id, config: st.config, state: stored, answers, now: svc.now(), profileEmail: state.email, enrollment: {}, notifyCapability: { real: state.preparedCapable } });
  return { svc: svc as AuthnService, privateSvc: svc, state };
}
async function passwordThenMail(h: ReturnType<typeof harness>, beforeMail?: () => void) {
  let r: any = await h.svc.authenticate({ tenant: 'fixture', subject: 'fixture-user', chain: 'chain' });
  beforeMail?.();
  r = await h.svc.authenticate({ tenant: 'fixture', session: r.session, answers: { password: 'fixture-accepted' } });
  const prompt = r.step.message;
  r = await h.svc.authenticate({ tenant: 'fixture', session: r.session, answers: { code: h.state.code } });
  return { result: r, prompt };
}
const mailConfig = () => config([method('pw', 'password', 3), method('mail', 'email-otp', 6, { delivery: 'smtp' })], ['pw', 'mail']);

describe('runtime assurance issuance', () => {
  it('non-delivering SMTP produces demo challenge, capped claims and no admin access at either configured threshold', async () => {
    const h = harness(mailConfig());
    const options = await h.svc.options('fixture');
    const { result, prompt } = await passwordThenMail(h);
    assert.match(prompt, /DEMO ONLY/); assert.equal(h.state.outbox, 1); assert.equal(h.state.sent, 0);
    assert.equal(options.chains[0].effectiveLevel, 3);
    assert.equal(result.outcome, 'allow'); assert.equal(result.claims.auth_level, 3);
    assert.deepEqual(result.claims.auth_simulated, ['mail']); assert.equal(result.claims.auth_mfa, false);
    assert.deepEqual(result.claims.amr, ['pwd']);
    for (const minLevel of [5, 6]) assert.equal(checkAssurance({ level: result.claims.auth_level, authTime: 0 }, { minLevel }, 0).ok, false);
  });
  it('real transport and completed code preserve the declared level and real factors', async () => {
    const h = harness(mailConfig()); h.state.capable = h.state.preparedCapable = true;
    const { result, prompt } = await passwordThenMail(h);
    assert.doesNotMatch(prompt, /DEMO ONLY/); assert.equal(h.state.sent, 1); assert.equal(h.state.outbox, 0);
    assert.equal(result.outcome, 'allow'); assert.equal(result.claims.auth_level, 6); assert.equal(result.claims.auth_level_declared, 6);
    assert.deepEqual(result.claims.auth_simulated, []); assert.equal(result.claims.auth_mfa, true);
  });
  it('a notifier that degrades after the snapshot cannot upgrade the prepared demo code', async () => {
    const h = harness(mailConfig()); h.state.capable = true;
    const { result } = await passwordThenMail(h);
    assert.equal(result.claims.auth_level, 3); assert.deepEqual(result.claims.auth_simulated, ['mail']);
  });
  it('plugin-scoped Google uses registry verification at entry and completed evidence at issuance', async () => {
    const cfg = config([method('google', 'sso-google', 7)], ['google'], 7);
    const h = harness(cfg);
    assert.equal(analyzeChain(cfg, cfg.chains[0]).effectiveLevel, 1, 'old static inference is deliberately different');
    const entry: any = await h.svc.entry('fixture', 'chain');
    const s = h.privateSvc.sessions.get(entry.session);
    assert.equal(s.chain.level, 7, 'entry uses serving plugin verdict despite empty instance config');
    s.done = [{ id: 'google', type: 'sso-google', real: true }];
    s.chain.level = 1; // stale/static field must not be the authority for issuance
    const allowed = await h.privateSvc.finish(s);
    assert.equal(allowed.claims.auth_level, 7); assert.deepEqual(allowed.claims.auth_simulated, []);
    assert.equal(allowed.claims.auth_mfa, false);
  });
  it('a completed simulated external step cannot inherit a real snapshot level', async () => {
    const h = harness(config([method('google', 'sso-google', 7)], ['google'], 7));
    const entry: any = await h.svc.entry('fixture', 'chain');
    const s = h.privateSvc.sessions.get(entry.session); s.done = [{ id: 'google', type: 'sso-google', real: false }];
    const allowed = await h.privateSvc.finish(s);
    assert.equal(allowed.claims.auth_level, 1); assert.deepEqual(allowed.claims.auth_simulated, ['google']);
  });
  it('missing, partial, duplicate or mismatched completion evidence never issues a level', async () => {
    for (const done of [[], [{ id: 'wrong', type: 'sso-google', real: true }], [{ id: 'google', type: 'password', real: true }], [{ id: 'google', type: 'sso-google', real: true }, { id: 'google', type: 'sso-google', real: true }]]) {
      const h = harness(config([method('google', 'sso-google', 7)], ['google'], 7));
      const entry: any = await h.svc.entry('fixture', 'chain');
      const s = h.privateSvc.sessions.get(entry.session); s.done = done;
      assert.equal((await h.privateSvc.finish(s)).outcome, 'deny');
    }
  });
});
describe('step-up uses current sign-in availability', () => {
  it('offers email-otp and digit-code on their actual instance enrollment, never disabled chains', async () => {
    const cfg = mailConfig(); cfg.methods.push(method('pin', 'digit-code', 3));
    cfg.chains.push({ id: 'pin-chain', name: 'Pin', enabled: true, steps: ['mail', 'pin'], level: 7 }, { id: 'off', name: 'Off', enabled: false, steps: ['mail'], level: 8 });
    const h = harness(cfg); h.state.capable = true;
    assert.deepEqual((await h.svc.stepUpOptions('fixture', 'fixture-user', 5)).map((c) => c.id), ['chain', 'pin-chain']);
    h.privateSvc.enroll.status = async () => ({});
    assert.deepEqual((await h.svc.stepUpOptions('fixture', 'fixture-user', 5)).map((c) => c.id), ['chain']);
    h.state.capable = false;
    assert.deepEqual(await h.svc.stepUpOptions('fixture', 'fixture-user', 5), []);
  });
  it('missing email and disabled providers are not offered', async () => {
    const h = harness(mailConfig()); h.state.capable = true; h.state.email = undefined;
    assert.deepEqual(await h.svc.stepUpOptions('fixture', 'fixture-user', 5), []);
    h.state.email = 'fixture@example.invalid'; h.state.active = false;
    assert.deepEqual(await h.svc.stepUpOptions('fixture', 'fixture-user', 5), []);
  });
});
