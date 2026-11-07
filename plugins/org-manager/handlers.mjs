export default {
  'profile.enrich': (p, c) => ({ ...p.profile, [c.settings.claimName]: 'root' }),
  'identity.changed': (p) => ({ queued: p.effectKey }),
  'http:GET /ping': (p, c) => ({ pong: true, tenant: c.tenant, maxDepth: c.settings.maxDepth }),
};
