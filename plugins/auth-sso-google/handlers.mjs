/**
 * Sign in with Google (docs/sso-federation.md). PURE handler: the provider metadata travels as DATA in the
 * auth.external.start answer; the API-side federation client executes the round-trip (PKCE S256, state, nonce,
 * issuer/audience/JWKS validation via openid-client). This handler only DECIDES from the resolved profile and
 * the EXPLICIT link. Without a client id the method runs in SIMULATED mode (fictional identities, marked DEMO).
 */
const SIMULATED = [
  { sub: 'sim-google-ada', label: 'Ada Lovelace (fiction)', email: 'ada.lovelace@example.invalid' },
  { sub: 'sim-google-grace', label: 'Grace Hopper (fiction)', email: 'grace.hopper@example.invalid' },
];
const configured = (c) => typeof c?.clientId === 'string' && c.clientId.trim().length > 0;

/** Settings live ON THE PLUGIN (settingsScope 'plugin', docs/sso-federation.md rule 5): one provider project
 * per environment, the client secret in the plugin secret store. The instance config is a legacy fallback only. */
const conf = (p, c) => ({ ...(p?.config ?? {}), ...(c?.settings ?? {}) });
export default {
  'auth.verification': (p, c) => configured(conf(p, c))
    ? { real: true, note: 'Sign-in is delegated to Google (OIDC: issuer, audience, signature, expiry and nonce are checked).' }
    : { real: false, note: 'SIMULATED: no Google client id configured. Demonstration only - proves nothing.' },
  'auth.prepare': () => ({ prompt: { title: 'Sign in with Google', fields: [{ name: 'external', label: 'Continue with Google', type: 'link' }] }, state: {} }),
  'auth.external.start': (p, c) => {
    if (!configured(conf(p, c))) return { ok: true, mode: 'simulated', title: 'Google (simulated)', identities: SIMULATED };
    const hd = String(conf(p, c).hostedDomain ?? '').trim();
    return {
      ok: true, mode: 'oidc',
      issuer: 'https://accounts.google.com',
      authorizeEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
      clientId: conf(p, c).clientId.trim(), scopes: ['openid', 'email', 'profile'], pkce: true,
      ...(hd && /^[a-z0-9.-]{1,100}$/i.test(hd) ? { extraAuthorizeParams: { hd } } : {}),
    };
  },
  'auth.external.verify': (p, c) => {
    if (!p.external?.sub) return { ok: false, reason: 'no-subject' };
    const hd = String(conf(p, c)?.hostedDomain ?? '').trim();
    if (hd && p.external.claims?.hd !== hd) return { ok: false, reason: 'hosted-domain', message: 'This Google account is not in the accepted domain.' };
    if (p.intent !== 'link' && !p.linkedSubject) return { ok: false, reason: 'not-linked', message: 'No account is linked to this Google sign-in.' };
    return { ok: true };
  },
};
