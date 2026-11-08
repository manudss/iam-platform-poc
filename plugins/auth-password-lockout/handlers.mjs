/** Same checks as the base, plus a lockout after repeated failures. The base handler comes in as ctx.base
 * (the `extends` contract); each installation gets a fresh failures map. */
export default function createHandlers() {
  const failures = new Map();
  return {
    // The lockout changes the credential CHECK only: the prompt and the proof stay the base's.
    'auth.prepare': (p, c) => c.base['auth.prepare'](p, c),
    'auth.verify': (p, c) => c.base['auth.verify'](p, c),
    'auth.verification': (p, c) => c.base['auth.verification'](p, c),
    'auth.authenticate': async (p, c) => {
      const n = failures.get(p.subject) ?? 0;
      if (n >= c.settings.maxFailures) return { outcome: 'deny', reason: 'locked' };
      const ok = await c.base['auth.authenticate'](p, c);
      if (ok.outcome === 'deny') failures.set(p.subject, n + 1); else failures.delete(p.subject);
      return ok;
    },
  };
}
