/**
 * Sign in with Facebook (docs/sso-federation.md). Facebook Login is OAuth2, NOT OIDC: no id_token, so the check is
 * state + the code exchange + debug_token proving the user token was issued for THIS app (the plugin judges the
 * raw debug_token answer; the API-side client fetches it). PURE handler. Without an app id the method runs in
 * SIMULATED mode (fictional identities, marked DEMO).
 */
const SIMULATED = [
  { sub: 'sim-facebook-ada', label: 'Ada Lovelace (fiction)', email: 'ada.lovelace@example.invalid' },
  { sub: 'sim-facebook-grace', label: 'Grace Hopper (fiction)', email: 'grace.hopper@example.invalid' },
];
const configured = (c) => typeof c?.clientId === 'string' && c.clientId.trim().length > 0;
const version = (c) => { const v = String(c?.apiVersion ?? 'v19.0').trim(); return /^v\d+\.\d+$/.test(v) ? v : 'v19.0'; };

/** Settings live ON THE PLUGIN (settingsScope 'plugin', docs/sso-federation.md rule 5): one provider project
 * per environment, the client secret in the plugin secret store. The instance config is a legacy fallback only. */
const conf = (p, c) => ({ ...(p?.config ?? {}), ...(c?.settings ?? {}) });
export default {
  'auth.verification': (p, c) => configured(conf(p, c))
    ? { real: true, note: 'Sign-in is delegated to Facebook (OAuth2 + debug_token app check; Facebook Login is not OIDC).' }
    : { real: false, note: 'SIMULATED: no Meta app id configured. Demonstration only - proves nothing.' },
  'auth.prepare': () => ({ prompt: { title: 'Sign in with Facebook', fields: [{ name: 'external', label: 'Continue with Facebook', type: 'link' }] }, state: {} }),
  'auth.external.start': (p, c) => {
    if (!configured(conf(p, c))) return { ok: true, mode: 'simulated', title: 'Facebook (simulated)', identities: SIMULATED };
    const v = version(conf(p, c));
    return {
      ok: true, mode: 'oauth2-userinfo', pkce: false,
      authorizeEndpoint: `https://www.facebook.com/${v}/dialog/oauth`,
      tokenEndpoint: `https://graph.facebook.com/${v}/oauth/access_token`,
      userinfoEndpoint: `https://graph.facebook.com/${v}/me?fields=id,name,email`,
      tokenInfoEndpoint: `https://graph.facebook.com/${v}/debug_token?input_token={token}&access_token={appToken}`,
      profileMap: { sub: 'id', email: 'email', name: 'name' },
      clientId: conf(p, c).clientId.trim(), scopes: ['email', 'public_profile'],
    };
  },
  'auth.external.verify': (p, c) => {
    if (!p.external?.sub) return { ok: false, reason: 'no-subject' };
    // Real mode: the token inspection must prove the user token is valid AND issued for this app (fail closed).
    if (configured(conf(p, c))) {
      const d = p.external.tokenInfo?.data;
      if (!d || d.is_valid !== true || String(d.app_id) !== String(conf(p, c).clientId).trim()) return { ok: false, reason: 'token-not-ours' };
    }
    if (p.intent !== 'link' && !p.linkedSubject) return { ok: false, reason: 'not-linked', message: 'No account is linked to this Facebook sign-in.' };
    return { ok: true };
  },
};
