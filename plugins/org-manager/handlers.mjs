export default {
  'profile.enrich': (p, c) => ({ ...p.profile, [c.settings.claimName]: 'root' }),
  'identity.changed': (p) => ({ queued: p.effectKey }),
};
