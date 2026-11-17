/**
 * Sign in with GitHub (docs/sso-federation.md). GitHub's OAuth flow has no OIDC id_token: the check is state +
 * PKCE (S256, supported by GitHub for OAuth apps) + the code exchange + the userinfo read over TLS. The profile's
 * `id` is the stable subject; when it carries no e-mail, the primary verified one is read from /user/emails
 * (API side). PURE handler. Without a client id the method runs in SIMULATED mode (fictional identities, DEMO).
 */
const SIMULATED = [
  { sub: 'sim-github-ada', label: 'Ada Lovelace (fiction)', email: 'ada.lovelace@example.invalid' },
  { sub: 'sim-github-grace', label: 'Grace Hopper (fiction)', email: 'grace.hopper@example.invalid' },
];
const configured = (c) => typeof c?.clientId === 'string' && c.clientId.trim().length > 0;

/** Settings live ON THE PLUGIN (settingsScope 'plugin', docs/sso-federation.md rule 5): one provider project
 * per environment, the client secret in the plugin secret store. The instance config is a legacy fallback only. */
const conf = (p, c) => ({ ...(p?.config ?? {}), ...(c?.settings ?? {}) });
export default {
  'auth.verification': (p, c) => configured(conf(p, c))
    ? { real: true, note: 'Sign-in is delegated to GitHub (OAuth2 with PKCE S256 + state; no OIDC id_token exists).' }
    : { real: false, note: 'SIMULATED: no GitHub client id configured. Demonstration only - proves nothing.' },
  'auth.prepare': () => ({ prompt: { title: 'Sign in with GitHub', fields: [{ name: 'external', label: 'Continue with GitHub', type: 'link' }] }, state: {} }),
  'auth.external.start': (p, c) => {
    if (!configured(conf(p, c))) return { ok: true, mode: 'simulated', title: 'GitHub (simulated)', identities: SIMULATED };
    return {
      ok: true, mode: 'oauth2-userinfo', pkce: true,
      authorizeEndpoint: 'https://github.com/login/oauth/authorize',
      tokenEndpoint: 'https://github.com/login/oauth/access_token',
      userinfoEndpoint: 'https://api.github.com/user',
      userinfoHeaders: { accept: 'application/vnd.github+json' },
      emailsEndpoint: 'https://api.github.com/user/emails',
      profileMap: { sub: 'id', email: 'email', name: 'name' },
      clientId: conf(p, c).clientId.trim(), scopes: ['read:user', 'user:email'],
    };
  },
  'auth.external.verify': (p, c) => {
    if (!p.external?.sub) return { ok: false, reason: 'no-subject' };
    if (p.intent !== 'link' && !p.linkedSubject) return { ok: false, reason: 'not-linked', message: 'No account is linked to this GitHub sign-in.' };
    return { ok: true };
  },
};
