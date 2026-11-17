/**
 * Sign in with Microsoft (docs/sso-federation.md). PURE handler; the API-side federation client executes the
 * round-trip. The tenant MUST be the directory GUID: Entra token issuers are tenant-specific, so 'common' or
 * 'organizations' cannot be validated and keep the method in SIMULATED mode (fictional identities, marked DEMO).
 */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIMULATED = [
  { sub: 'sim-microsoft-ada', label: 'Ada Lovelace (fiction)', email: 'ada.lovelace@example.invalid' },
  { sub: 'sim-microsoft-grace', label: 'Grace Hopper (fiction)', email: 'grace.hopper@example.invalid' },
];
const configured = (c) => typeof c?.clientId === 'string' && c.clientId.trim().length > 0 && GUID.test(String(c?.tenant ?? ''));

/** Settings live ON THE PLUGIN (settingsScope 'plugin', docs/sso-federation.md rule 5): one provider project
 * per environment, the client secret in the plugin secret store. The instance config is a legacy fallback only. */
const conf = (p, c) => ({ ...(p?.config ?? {}), ...(c?.settings ?? {}) });
export default {
  'auth.verification': (p, c) => configured(conf(p, c))
    ? { real: true, note: 'Sign-in is delegated to Microsoft Entra (OIDC: issuer pinned to the tenant, audience, signature, expiry and nonce are checked).' }
    : { real: false, note: 'SIMULATED: no client id / tenant GUID configured. Demonstration only - proves nothing.' },
  'auth.prepare': () => ({ prompt: { title: 'Sign in with Microsoft', fields: [{ name: 'external', label: 'Continue with Microsoft', type: 'link' }] }, state: {} }),
  'auth.external.start': (p, c) => {
    if (!configured(conf(p, c))) return { ok: true, mode: 'simulated', title: 'Microsoft (simulated)', identities: SIMULATED };
    const t = String(conf(p, c).tenant).trim();
    return {
      ok: true, mode: 'oidc',
      issuer: `https://login.microsoftonline.com/${t}/v2.0`,
      authorizeEndpoint: `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`,
      tokenEndpoint: `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,
      jwksUri: `https://login.microsoftonline.com/${t}/discovery/v2.0/keys`,
      clientId: conf(p, c).clientId.trim(), scopes: ['openid', 'email', 'profile'], pkce: true,
    };
  },
  'auth.external.verify': (p, c) => {
    if (!p.external?.sub) return { ok: false, reason: 'no-subject' };
    const t = String(conf(p, c)?.tenant ?? '').trim();
    if (GUID.test(t) && p.external.claims && p.external.claims.tid && p.external.claims.tid !== t) return { ok: false, reason: 'tenant' };
    if (p.intent !== 'link' && !p.linkedSubject) return { ok: false, reason: 'not-linked', message: 'No account is linked to this Microsoft sign-in.' };
    return { ok: true };
  },
};
