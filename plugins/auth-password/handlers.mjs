/** Demo credential store: fictional users only. */
const DEMO_USERS = { 'demo-user-1': 'demo-pass-1', 'demo-admin': 'demo-pass-admin', 'demo-alice': 'demo-only-not-a-secret', 'demo-bob': 'demo-only-not-a-secret' };

export default {
  'auth.authenticate': (p) =>
    DEMO_USERS[p.subject] !== undefined && DEMO_USERS[p.subject] === p.credential.password
      ? { outcome: 'allow', subject: p.subject, methods: ['pwd'] }
      : { outcome: 'deny', reason: 'bad-credentials' },
};
