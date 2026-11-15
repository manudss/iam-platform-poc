/**
 * Password sign-in with an advanced, fully configurable policy (replacement of the base password method).
 * Pure handlers (bus contract, step 2): the candidate password, the user info and the salted hash history travel
 * IN THE PAYLOAD, the rules come from the tenant settings. Storage (credential file, history) stays in the core:
 * this plugin only decides. The plain history never exists; hashes never enter Dolt or SQL.
 */
import { scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * A short built-in list of very common passwords, used when `blockCommon` is on. It is a floor, not a breach
 * corpus: a real deployment plugs a breached-password service or a larger list here (settings stay the contract).
 */
const COMMON = [
  'password', 'passw0rd', 'password1', '123456', '123456789', '12345678', '12345', '1234567', '1234567890',
  'qwerty', 'qwerty123', 'azerty', 'azerty123', 'abc123', '111111', '123123', 'letmein', 'iloveyou', 'admin',
  'welcome', 'monkey', 'dragon', 'football', 'baseball', 'sunshine', 'master', 'shadow', 'superman', 'batman',
  'motdepasse', 'bonjour', 'soleil', 'marseille', 'chocolate', 'whatever', 'freedom', 'trustno1', 'starwars',
];

const CLASSES = [
  ['uppercase', (x) => /[A-Z]/.test(x)],
  ['lowercase', (x) => /[a-z]/.test(x)],
  ['digit', (x) => /[0-9]/.test(x)],
  ['symbol', (x) => /[^A-Za-z0-9]/.test(x)],
];

/** Fragments of the account the password must not contain (case-insensitive, 3 characters or more). */
function userTokens(info) {
  const out = [];
  if (!info) return out;
  const push = (v) => { const t = String(v ?? '').toLowerCase().trim(); if (t.length >= 3 && !out.includes(t)) out.push(t); };
  push(info.login);
  for (const w of String(info.displayName ?? '').split(/[\s._-]+/)) push(w);
  const email = String(info.email ?? '').toLowerCase();
  push(email);
  push(email.split('@')[0]);
  return out;
}

function policyErrors(candidate, s, p) {
  const errors = [];
  const pwd = String(candidate ?? '');
  const min = Number(s.minLength ?? 12), max = Number(s.maxLength ?? 128);
  if (pwd.length < min) errors.push(`at least ${min} characters`);
  if (pwd.length > max) errors.push(`at most ${max} characters`);
  const present = CLASSES.filter(([, f]) => f(pwd)).length;
  if (s.requireUpper && !/[A-Z]/.test(pwd)) errors.push('at least one uppercase letter');
  if (s.requireLower && !/[a-z]/.test(pwd)) errors.push('at least one lowercase letter');
  if (s.requireDigit && !/[0-9]/.test(pwd)) errors.push('at least one digit');
  if (s.requireSymbol && !/[^A-Za-z0-9]/.test(pwd)) errors.push('at least one symbol (not a letter or digit)');
  if (Number(s.minClasses) > 0 && present < Number(s.minClasses)) errors.push(`at least ${s.minClasses} of the 4 character classes (uppercase, lowercase, digit, symbol)`);
  const low = pwd.toLowerCase();
  if (s.forbidUserInfo !== false && userTokens(p.userInfo).some((t) => low.includes(t))) errors.push('it must not contain the login, the name or the e-mail address');
  if ((s.forbiddenWords ?? []).some((w) => { const t = String(w).toLowerCase().trim(); return t && low.includes(t); })) errors.push('it contains a forbidden word');
  if (s.blockCommon && COMMON.includes(low)) errors.push('it is one of the most common passwords');
  // Reuse: the payload history is salted scrypt hashes, newest first (entry 0 = the CURRENT password). The current
  // one is always refused; `historyCount` older ones too. The candidate is re-hashed with each stored salt and
  // compared in constant time; at most 25 entries, so this loop is bounded.
  const history = Array.isArray(p.history) ? p.history : [];
  const keep = 1 + Math.max(0, Math.min(24, Number(s.historyCount ?? 0)));
  for (const e of history.slice(0, keep)) {
    if (!e || typeof e.salt !== 'string' || typeof e.hash !== 'string' || !/^[0-9a-f]+$/.test(e.salt) || !/^[0-9a-f]{128}$/.test(e.hash)) continue;
    const ref = Buffer.from(e.hash, 'hex'), got = scryptSync(pwd, e.salt, 64);
    if (ref.length === got.length && timingSafeEqual(ref, got)) {
      errors.push(Number(s.historyCount) > 0 ? `it was already used: the current password and the ${s.historyCount} previous one(s) cannot be reused` : 'the current password cannot be reused');
      break;
    }
  }
  return errors;
}

const policyNote = (s) =>
  `Policy: ${Number(s.minLength ?? 12)} to ${Number(s.maxLength ?? 128)} characters` +
  (Number(s.minClasses) > 0 ? `, ${s.minClasses} character classes` : '') +
  (s.forbidUserInfo !== false ? ', no login/name/e-mail' : '') +
  (s.blockCommon ? ', common passwords refused' : '') +
  (Number(s.historyCount) > 0 ? `, no reuse of the last ${s.historyCount}` : '') +
  (Number(s.maxAgeDays) > 0 ? `, expires after ${s.maxAgeDays} day(s)` : '') + '.';

export default {
  // The prompt, the step check and the credential verification stay the base's (directory password hash; in
  // directory mode the core overrides the base check with the real credential store, and ctx.base carries it).
  'auth.prepare': (p, c) => c.base['auth.prepare'](p, c),
  'auth.verify': (p, c) => c.base['auth.verify'](p, c),
  'auth.verification': (p, c) => {
    const base = c.base['auth.verification'](p, c);
    return { ...base, note: `${base.note} ${policyNote(c.settings)}` };
  },
  // The policy decision, called by the core at every password creation or change (admin create, self-service
  // change, public sign-up). A refusal is data ({ ok: false, errors }), never a throw.
  'auth.password.validate': (p, c) => {
    const errors = policyErrors(p.candidate, c.settings, p);
    return errors.length ? { ok: false, errors } : { ok: true };
  },
  // Expiry (maxAgeDays): the core passes the change date of the current password when it knows it (passwords set
  // while the history is active). An expired password is refused like a wrong one; the audit keeps the reason.
  'auth.authenticate': async (p, c) => {
    const r = await c.base['auth.authenticate'](p, c);
    if (r.outcome !== 'allow') return r;
    const maxAge = Number(c.settings.maxAgeDays ?? 0);
    if (maxAge > 0 && typeof p.passwordChangedAt === 'number' && p.passwordChangedAt > 0 && (p.now ?? Date.now()) - p.passwordChangedAt > maxAge * 86_400_000) {
      return { outcome: 'deny', reason: 'password-expired' };
    }
    return r;
  },
};
