/**
 * Sign in with a generic OpenID Connect provider (docs/sso-federation.md): the "and others" entry point for
 * providers without a dedicated plugin. All endpoints are administrator settings; the API-side federation client
 * executes the round-trip (PKCE S256, state, nonce, issuer/audience/JWKS validation via openid-client). PURE
 * handler. Incompletely configured = SIMULATED mode (fictional identities, marked DEMO).
 */
const SIMULATED = [
  { sub: 'sim-oidc-ada', label: 'Ada Lovelace (fiction)', email: 'ada.lovelace@example.invalid' },
  { sub: 'sim-oidc-grace', label: 'Grace Hopper (fiction)', email: 'grace.hopper@example.invalid' },
];
const https = (u) => typeof u === 'string' && u.startsWith('https://') && u.length <= 2048;
const configured = (c) => https(c?.issuer) && https(c?.authorizeEndpoint) && https(c?.tokenEndpoint) && https(c?.jwksUri) && typeof c?.clientId === 'string' && c.clientId.trim().length > 0;
const name = (c) => { const n = String(c?.providerName ?? 'SSO').trim(); return n && n.length <= 40 ? n : 'SSO'; };

export default {
  'auth.verification': (p) => configured(p.config)
    ? { real: true, note: `Sign-in is delegated to ${name(p.config)} (OIDC: issuer, audience, signature, expiry and nonce are checked).` }
    : { real: false, note: 'SIMULATED: provider endpoints or client id not configured. Demonstration only - proves nothing.' },
  'auth.prepare': (p) => ({ prompt: { title: `Sign in with ${name(p.config)}`, fields: [{ name: 'external', label: `Continue with ${name(p.config)}`, type: 'link' }] }, state: {} }),
  'auth.external.start': (p) => {
    if (!configured(p.config)) return { ok: true, mode: 'simulated', title: `${name(p.config)} (simulated)`, identities: SIMULATED };
    const scopes = String(p.config.scopes ?? 'openid email profile').split(/\s+/).filter((s) => /^[a-z0-9:_-]{1,40}$/i.test(s)).slice(0, 10);
    if (!scopes.includes('openid')) scopes.unshift('openid');
    return {
      ok: true, mode: 'oidc',
      issuer: p.config.issuer, authorizeEndpoint: p.config.authorizeEndpoint, tokenEndpoint: p.config.tokenEndpoint, jwksUri: p.config.jwksUri,
      clientId: p.config.clientId.trim(), scopes, pkce: true,
    };
  },
  'auth.external.verify': (p) => {
    if (!p.external?.sub) return { ok: false, reason: 'no-subject' };
    if (!p.linkedSubject) return { ok: false, reason: 'not-linked', message: `No account is linked to this ${name(p.config)} sign-in.` };
    return { ok: true };
  },
};
