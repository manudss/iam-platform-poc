import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { SettingField } from '../plugins/v1/manifest.js';
import type { EnrollmentStore } from './enroll-store.js';
import { totpVerify } from './totp.js';

export type Factor = 'knowledge' | 'possession' | 'inherence';
export interface KeypadKey { id: string; digit: string; letters: string }
export interface PromptField { name: string; label: string; type: 'password' | 'text' | 'digits' | 'keypad'; maxLength?: number; hint?: string;
  /** keypad only: buttons in display order (opaque ids, valid for this page only), digits entered so far, digits needed. */
  keys?: KeypadKey[]; entered?: number; length?: number }
export interface Prompt { title: string; message?: string; fields: PromptField[] }

/** Delivery channel of one-time codes. The POC ships only the demo outbox: nothing leaves the process. */
export interface MailAdapter { id: string; real: boolean; send(m: { tenant: string; to: string; subject: string; text: string; subjectUser: string }): Promise<void> }
export interface OutboxMessage { at: string; tenant: string; to: string; subject: string; text: string; user: string }
export class DemoOutbox implements MailAdapter {
  id = 'demo-outbox'; real = false;
  private msgs: OutboxMessage[] = [];
  async send(m: { tenant: string; to: string; subject: string; text: string; subjectUser: string }) {
    this.msgs.unshift({ at: new Date().toISOString(), tenant: m.tenant, to: m.to, subject: m.subject, text: m.text, user: m.subjectUser });
    this.msgs.length = Math.min(this.msgs.length, 50);
  }
  list(tenant: string) { return this.msgs.filter((x) => x.tenant === tenant); }
  clear(tenant: string) { this.msgs = this.msgs.filter((x) => x.tenant !== tenant); }
}

export interface MethodCtx {
  tenant: string; subject: string; instanceId: string; config: Record<string, any>;
  /** False when the account does not exist or cannot sign in: methods still behave the same way from the outside (no enumeration). */
  known: boolean;
  enroll: EnrollmentStore; mail: DemoOutbox;
  /** Password check through the platform's auth.password slot (so a lockout replacement keeps working). */
  passwordCheck(tenant: string, subject: string, password: string): Promise<boolean>;
  now(): number;
}
export interface AuthMethodType {
  id: string; name: string; description: string;
  /** Category of factor the method DECLARES. It is a classification, not a measurement of strength or independence. */
  factor: Factor; amr: string;
  maturity: 'implemented' | 'catalogue';
  suggestedLevel: number;
  settings: SettingField[];
  provisioning: 'directory' | 'admin-demo' | 'none';
  inlineWithUsername(config: Record<string, any>): boolean;
  /** `real` = the check proves what the factor category says. A demo delivery channel proves nothing, so it is not real. */
  verification(config: Record<string, any>): { real: boolean; note: string };
  prepare?(ctx: MethodCtx): Promise<{ prompt: Prompt; state: Record<string, any> }>;
  verify?(ctx: MethodCtx, state: Record<string, any>, answers: Record<string, string>): Promise<boolean>;
  /** Interactive methods (keypad): one call per button press. `done:false` shows the next prompt and keeps the step open; `done:true` ends it with a verdict. */
  interact?(ctx: MethodCtx, state: Record<string, any>, answers: Record<string, string>): Promise<{ done: false; prompt: Prompt; state: Record<string, any> } | { done: true; ok: boolean }>;
}

const eq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export const password: AuthMethodType = {
  id: 'password', name: 'Password', description: 'Checks the directory password through the platform password slot (a lockout replacement plugin still applies).',
  factor: 'knowledge', amr: 'pwd', maturity: 'implemented', suggestedLevel: 3, settings: [], provisioning: 'directory',
  inlineWithUsername: () => true,
  verification: () => ({ real: true, note: 'Verified against the directory password hash.' }),
  async prepare() { return { prompt: { title: 'Password', fields: [{ name: 'password', label: 'Password', type: 'password' }] }, state: {} }; },
  async verify(ctx, _s, a) { return typeof a.password === 'string' && a.password.length > 0 && a.password.length <= 256 && (await ctx.passwordCheck(ctx.tenant, ctx.subject, a.password)) && ctx.known; },
};

export const emailOtp: AuthMethodType = {
  id: 'email-otp', name: 'One-time code by e-mail', description: 'Sends a short code to the user\'s e-mail address and asks for it. In this POC the e-mail goes to a DEMO OUTBOX visible to administrators: no real e-mail is sent, so it proves nothing about possession of a mailbox.',
  factor: 'possession', amr: 'otp', maturity: 'implemented', suggestedLevel: 4,
  settings: [
    { key: 'codeLength', type: 'number', label: 'Code length', default: 6, min: 4, max: 8, group: 'Code' },
    { key: 'ttlSeconds', type: 'number', label: 'Code lifetime (seconds)', default: 300, min: 60, max: 900, group: 'Code' },
    { key: 'delivery', type: 'select', label: 'Delivery', default: 'demo-outbox', options: [{ value: 'demo-outbox', label: 'Demo outbox (simulated, no e-mail sent)' }], help: 'A real mail adapter (SMTP) is not implemented in this POC.', group: 'Delivery' },
  ],
  provisioning: 'admin-demo',
  inlineWithUsername: () => false,
  verification: (c) => (c.delivery ?? 'demo-outbox') === 'demo-outbox'
    ? { real: false, note: 'SIMULATED: the code is written to a demo outbox that administrators can read, so it does not prove possession of a mailbox.' }
    : { real: true, note: 'Code delivered by a real mail adapter.' },
  async prepare(ctx) {
    const len = Number(ctx.config.codeLength ?? 6), ttl = Number(ctx.config.ttlSeconds ?? 300);
    const code = String(randomInt(0, 10 ** len)).padStart(len, '0');
    const to = ctx.known ? (await ctx.enroll.email(ctx.tenant, ctx.subject, ctx.instanceId)) ?? `${ctx.subject}@mail.example.invalid` : '';
    if (ctx.known) await ctx.mail.send({ tenant: ctx.tenant, to, subject: 'Your sign-in code', text: `Your sign-in code is ${code}. It expires in ${Math.round(ttl / 60)} minute(s).`, subjectUser: ctx.subject });
    return { prompt: { title: 'Check your e-mail', message: (ctx.config.delivery ?? 'demo-outbox') === 'demo-outbox' ? 'DEMO ONLY: no e-mail is sent. In this prototype the code is written to a demo outbox that an administrator can read.' : 'If the account exists, a code was sent to its e-mail address.', fields: [{ name: 'code', label: 'Code', type: 'digits', maxLength: len, hint: `${len} digits` }] },
      state: { hash: sha(`${ctx.instanceId}:${code}`), exp: ctx.now() + ttl * 1000, used: false } };
  },
  async verify(ctx, st, a) {
    if (!ctx.known || st.used || ctx.now() > st.exp || typeof a.code !== 'string') return false;
    const ok = eq(sha(`${ctx.instanceId}:${a.code.trim()}`), st.hash); if (ok) st.used = true; return ok;
  },
};

const PHONE_LETTERS: Record<string, string> = { '0': '', '1': '', '2': 'ABC', '3': 'DEF', '4': 'GHI', '5': 'JKL', '6': 'MNO', '7': 'PQRS', '8': 'TUV', '9': 'WXYZ' };
/** A new random order and new opaque button ids on every page: an id only means something on the page that carried it. */
function keypadPrompt(ctx: MethodCtx, entered: string[], map: Record<string, string>, error?: string): { prompt: Prompt; map: Record<string, string> } {
  const digits = '0123456789'.split('');
  for (let i = digits.length - 1; i > 0; i--) { const j = randomInt(0, i + 1); [digits[i], digits[j]] = [digits[j], digits[i]]; }
  const len = Number(ctx.config.length ?? 6), fresh: Record<string, string> = {};
  const keys: KeypadKey[] = digits.map((d) => { const id = randomBytes(9).toString('base64url'); fresh[id] = d; return { id, digit: d, letters: PHONE_LETTERS[d] }; });
  void map;
  return { map: fresh, prompt: { title: 'PIN', message: error ?? `Enter your ${len}-digit PIN with the on-screen buttons. Their order changes every time.`, fields: [{ name: 'key', label: 'PIN', type: 'keypad', keys, entered: entered.length, length: len }] } };
}

export const digitCode: AuthMethodType = {
  id: 'digit-code', name: 'PIN on a shuffled keypad', description: 'A numeric PIN enrolled for the user, entered with on-screen buttons whose order changes on every page. A button carries only an opaque id valid for that page; the server maps it back to the digit, so the PIN digits are never sent as text. This hides the digits from simple form logging, it is NOT encryption: HTTPS is still required. A PIN is a knowledge factor: with a password it is NOT two different factors.',
  factor: 'knowledge', amr: 'pin', maturity: 'implemented', suggestedLevel: 3,
  settings: [
    { key: 'length', type: 'number', label: 'PIN length (digits)', default: 6, min: 4, max: 8, group: 'PIN', help: 'Enrolled PINs must have this length.' },
  ],
  provisioning: 'admin-demo',
  inlineWithUsername: () => false,
  verification: () => ({ real: true, note: 'Verified against a salted scrypt hash of the whole enrolled PIN (knowledge factor). Keypad ids are single page and bound to the sign-in session.' }),
  async prepare(ctx) { const k = keypadPrompt(ctx, [], {}); return { prompt: k.prompt, state: { entered: [] as string[], map: k.map, presses: 0 } }; },
  async verify() { return false; },
  async interact(ctx, st, a) {
    const len = Number(ctx.config.length ?? 6), entered: string[] = [...(st.entered as string[])];
    if (++st.presses > 40) return { done: true, ok: false };
    if (typeof a.key === 'string') {
      const d = (st.map as Record<string, string>)[a.key];
      if (d === undefined) return { done: true, ok: false };            // an id that this page never carried: a replayed or forged button
      if (entered.length < len) entered.push(d);
    } else if (a.action === 'delete') { entered.pop(); }
    else if (a.action === 'submit') {
      if (entered.length !== len) return { done: true, ok: false };
      return { done: true, ok: ctx.known && (await ctx.enroll.verifyPinFull(ctx.tenant, ctx.subject, ctx.instanceId, entered.join(''))) };
    } else return { done: true, ok: false };
    const k = keypadPrompt(ctx, entered, st.map);
    return { done: false, prompt: k.prompt, state: { entered, map: k.map, presses: st.presses } };
  },
};

export const totp: AuthMethodType = {
  id: 'totp', name: 'Authenticator app code (TOTP)', description: 'Time-based one-time code (RFC 6238, HMAC-SHA-1) from an authenticator app. The secret is enrolled per user and never stored in Dolt.',
  factor: 'possession', amr: 'otp', maturity: 'implemented', suggestedLevel: 7,
  settings: [
    { key: 'digits', type: 'select', label: 'Digits', default: '6', options: [{ value: '6', label: '6' }, { value: '8', label: '8' }], group: 'Code' },
    { key: 'periodSeconds', type: 'select', label: 'Period (seconds)', default: '30', options: [{ value: '30', label: '30' }, { value: '60', label: '60' }], group: 'Code' },
    { key: 'window', type: 'number', label: 'Accepted steps either side (clock drift)', default: 1, min: 0, max: 2, group: 'Code' },
    { key: 'issuer', type: 'string', label: 'Issuer shown in the app', default: 'IAM POC', group: 'Enrollment' },
  ],
  provisioning: 'admin-demo',
  inlineWithUsername: () => true,
  verification: () => ({ real: true, note: 'Verified against a per-user enrolled secret (demo: provisioned by an administrator and shown once; a real product enrolls from the user\'s own session).' }),
  async prepare(ctx) { const d = Number(ctx.config.digits ?? 6); return { prompt: { title: 'Authenticator code', fields: [{ name: 'code', label: 'Code from your app', type: 'digits', maxLength: d, hint: `${d} digits` }] }, state: {} }; },
  async verify(ctx, _s, a) {
    if (!ctx.known || typeof a.code !== 'string') return false;
    const rec = await ctx.enroll.totp(ctx.tenant, ctx.subject, ctx.instanceId); if (!rec) return false;
    const step = totpVerify(rec.secret, a.code.trim(), ctx.now(), Number(ctx.config.periodSeconds ?? 30), Number(ctx.config.digits ?? 6), Number(ctx.config.window ?? 1));
    return step !== null && (await ctx.enroll.consumeTotpStep(ctx.tenant, ctx.subject, ctx.instanceId, step));
  },
};

/** Ideas shown in the catalogue so the list reads as a roadmap. They cannot be created: nothing is implemented for them. */
const planned = (id: string, name: string, description: string, factor: Factor, level: number, amr: string): AuthMethodType => ({
  id, name, description, factor, amr, maturity: 'catalogue', suggestedLevel: level, settings: [], provisioning: 'none',
  inlineWithUsername: () => false, verification: () => ({ real: false, note: 'Not implemented.' }),
});
export const CATALOGUE: AuthMethodType[] = [
  password, emailOtp, digitCode, totp,
  planned('passkey', 'Passkey (WebAuthn)', 'Phishing-resistant public-key credential bound to a device. Needs a browser ceremony and a relying-party configuration: not built.', 'possession', 9, 'hwk'),
  planned('recovery-code', 'Recovery codes', 'One-time printed codes for account recovery. Not built.', 'knowledge', 5, 'otp'),
  planned('federation', 'External identity provider (OIDC/SAML)', 'Delegate sign-in to another IdP and map its claims. Not built.', 'other' as Factor, 6, 'fed'),
];
export const methodType = (id: string) => CATALOGUE.find((m) => m.id === id);
