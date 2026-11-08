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
};
