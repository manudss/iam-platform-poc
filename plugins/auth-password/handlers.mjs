/** Demo credential store: fictional users only. */
const DEMO_USERS = { 'demo-user-1': 'demo-pass-1', 'demo-admin': 'demo-pass-admin', 'demo-alice': 'demo-only-not-a-secret', 'demo-bob': 'demo-only-not-a-secret' };

export default {
  // Sign-in method behaviour (decision 1: the chains/levels stay in the core, the method lives here).
  'auth.prepare': () => ({ prompt: { title: 'Password', fields: [{ name: 'password', label: 'Password', type: 'password' }] }, state: {} }),
  // Bus-safe contract (step 2): the credential check is the auth.password slot's own auth.authenticate hook; the
  // core runs it FIRST (lockout and any replacement included) and hands the outcome in the payload.
  'auth.verify': (p) => ({ ok: typeof p.answers?.password === 'string' && p.answers.password.length > 0 && p.answers.password.length <= 256 && p.passwordOutcome === 'allow' && !!p.known }),
  'auth.verification': () => ({ real: true, note: 'Verified against the directory password hash.' }),
  'auth.authenticate': (p) =>
    DEMO_USERS[p.subject] !== undefined && DEMO_USERS[p.subject] === p.credential.password
      ? { outcome: 'allow', subject: p.subject, methods: ['pwd'] }
      : { outcome: 'deny', reason: 'bad-credentials' },
  // Password policy of the base method: the historical rule - the minLength setting (default 12) and the hard
  // 128-character cap the core stores enforce. A replacement (auth-password-policy) takes over with richer rules.
  'auth.password.validate': (p, c) => {
    const pwd = typeof p.candidate === 'string' ? p.candidate : '';
    const min = Number(c.settings.minLength ?? 12);
    return pwd.length >= min && pwd.length <= 128 ? { ok: true } : { ok: false, errors: [`password: ${min} to 128 characters`] };
  },
};
