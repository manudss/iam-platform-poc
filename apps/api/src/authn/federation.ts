import { createHash, randomBytes } from 'node:crypto';

/**
 * The API-side federation client (docs/sso-federation.md). The provider plugins are PURE handlers: they return
 * their provider's metadata as data (auth.external.start) and decide ok/deny from the resolved profile
 * (auth.external.verify). Everything that touches the network lives HERE, once, with one set of caps and checks:
 * PKCE S256, state, nonce, issuer/audience/signature validation through openid-client for OIDC providers,
 * and a plain token exchange + userinfo read for OAuth2-only providers.
 */

export interface ExternalIdentity { sub: string; label: string; email?: string }
/** The validated shape of an auth.external.start answer (plugin output crossing the bus is never trusted blindly). */
export interface ExternalStart {
  ok: boolean; reason?: string;
  mode?: 'oidc' | 'oauth2-userinfo' | 'simulated';
  authorizeEndpoint?: string; tokenEndpoint?: string; userinfoEndpoint?: string; jwksUri?: string; issuer?: string;
  clientId?: string; scopes?: string[]; pkce?: boolean;
  /** Extra authorize-query entries (e.g. Google's hd or Microsoft's response_mode): [A-Za-z0-9_-] keys, short values. */
  extraAuthorizeParams?: Record<string, string>;
  /** Extra headers on the userinfo read (e.g. GitHub's Accept). */
  userinfoHeaders?: Record<string, string>;
  /** A second read listing e-mail records when the profile itself carries none (GitHub /user/emails). */
  emailsEndpoint?: string;
  /** A token-inspection URL template with {token} and {appToken} placeholders (Facebook debug_token). */
  tokenInfoEndpoint?: string;
  /** How to read the profile JSON: which keys hold the subject, e-mail, e-mail-verified flag and display name. */
  profileMap?: { sub: string; email?: string; emailVerified?: string; name?: string };
  title?: string; identities?: ExternalIdentity[]; // simulated mode
}
/** The resolved identity handed to auth.external.verify. `claims`/`tokenInfo` are capped raw provider data for the plugin's own checks. */
export interface ExternalProfile { sub: string; email?: string; emailVerified?: boolean; name?: string; claims?: Record<string, unknown>; tokenInfo?: Record<string, unknown> }

const MAX_JSON = 64 * 1024, TIMEOUT_MS = 5000;
const urlOk = (u: unknown): u is string => {
  if (typeof u !== 'string' || !u.length || u.length > 2048) return false;
  try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname)); } catch { return false; }
};
const strOk = (s: unknown, max: number): s is string => typeof s === 'string' && s.length > 0 && s.length <= max;

/** Validates a plugin's auth.external.start answer into a safe-to-use shape. Throws on a malformed answer (technical failure, fail closed). */
export function checkStart(r: unknown): ExternalStart {
  const s = r as ExternalStart;
  if (!s || typeof s !== 'object' || typeof s.ok !== 'boolean') throw new Error('bad auth.external.start answer');
  if (!s.ok) return { ok: false, reason: strOk(s.reason, 120) ? s.reason : 'refused' };
  if (s.mode === 'simulated') {
    const ids = (Array.isArray(s.identities) ? s.identities : []).filter((i) => i && strOk(i.sub, 128) && strOk(i.label, 60) && (i.email === undefined || strOk(i.email, 120))).slice(0, 8);
    if (!ids.length) throw new Error('bad auth.external.start answer: simulated mode without identities');
    return { ok: true, mode: 'simulated', title: strOk(s.title, 60) ? s.title : 'Simulated provider', identities: ids };
  }
  if (s.mode !== 'oidc' && s.mode !== 'oauth2-userinfo') throw new Error('bad auth.external.start answer: unknown mode');
  if (!urlOk(s.authorizeEndpoint) || !urlOk(s.tokenEndpoint) || !strOk(s.clientId, 200)) throw new Error('bad auth.external.start answer: endpoints');
  if (s.mode === 'oidc' && (!strOk(s.issuer, 200) || !urlOk(s.jwksUri))) throw new Error('bad auth.external.start answer: oidc metadata');
  if (s.mode === 'oauth2-userinfo' && (!urlOk(s.userinfoEndpoint) || !s.profileMap || !strOk(s.profileMap.sub, 40))) throw new Error('bad auth.external.start answer: userinfo metadata');
  const scopes = (Array.isArray(s.scopes) ? s.scopes : []).filter((x) => strOk(x, 40)).slice(0, 10);
  const extra = Object.fromEntries(Object.entries(s.extraAuthorizeParams ?? {}).filter(([k, v]) => /^[A-Za-z0-9_-]{1,32}$/.test(k) && typeof v === 'string' && v.length <= 120).slice(0, 8));
  const headers = Object.fromEntries(Object.entries(s.userinfoHeaders ?? {}).filter(([k, v]) => /^[A-Za-z-]{1,40}$/.test(k) && typeof v === 'string' && v.length <= 200).slice(0, 6));
  return {
    ok: true, mode: s.mode, authorizeEndpoint: s.authorizeEndpoint, tokenEndpoint: s.tokenEndpoint,
    ...(s.userinfoEndpoint && urlOk(s.userinfoEndpoint) ? { userinfoEndpoint: s.userinfoEndpoint } : {}),
    ...(s.mode === 'oidc' ? { jwksUri: s.jwksUri, issuer: s.issuer } : {}),
    clientId: s.clientId, scopes, pkce: s.pkce !== false, ...(Object.keys(extra).length ? { extraAuthorizeParams: extra } : {}),
    ...(Object.keys(headers).length ? { userinfoHeaders: headers } : {}),
    ...(urlOk(s.emailsEndpoint) ? { emailsEndpoint: s.emailsEndpoint } : {}),
    ...(strOk(s.tokenInfoEndpoint, 2048) ? { tokenInfoEndpoint: s.tokenInfoEndpoint } : {}),
    ...(s.mode === 'oauth2-userinfo' ? { profileMap: { sub: s.profileMap!.sub, ...(strOk(s.profileMap!.email, 40) ? { email: s.profileMap!.email } : {}), ...(strOk(s.profileMap!.emailVerified, 40) ? { emailVerified: s.profileMap!.emailVerified } : {}), ...(strOk(s.profileMap!.name, 40) ? { name: s.profileMap!.name } : {}) } } : {}),
  };
}

export const mint = () => randomBytes(24).toString('base64url');
export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/** The provider authorize URL. state/nonce/challenge were minted by the flow and live server-side in the session. */
export function buildAuthorizeUrl(s: ExternalStart, callbackUrl: string, p: { state: string; nonce: string; challenge: string }): string {
  if (!urlOk(s.authorizeEndpoint)) throw new Error('bad authorize endpoint');
  const q = new URLSearchParams({ response_type: 'code', client_id: s.clientId!, redirect_uri: callbackUrl, state: p.state });
  if (s.scopes?.length) q.set('scope', s.scopes.join(' '));
  if (s.mode === 'oidc') q.set('nonce', p.nonce);
  if (s.pkce !== false) { q.set('code_challenge', p.challenge); q.set('code_challenge_method', 'S256'); }
  for (const [k, v] of Object.entries(s.extraAuthorizeParams ?? {})) q.set(k, v);
  return `${s.authorizeEndpoint}?${q.toString()}`;
}

/** The configured public callback URL of the core (registered at the provider). '' when unset: real modes then fail closed. */
export function callbackUrl(): string {
  const u = (process.env.IAM_EXTERNAL_CALLBACK_URL ?? '').trim();
  return urlOk(u) ? u : '';
}

async function readJson(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (text.length > MAX_JSON) throw new Error(`${what}: answer too large`);
  try { const j = JSON.parse(text); if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, unknown>; } catch { /* falls through */ }
  throw new Error(`${what}: bad answer`);
}

/** OIDC code exchange + full ID-token validation (issuer, audience, expiry, signature via JWKS, nonce) through openid-client. */
export async function exchangeOidc(s: ExternalStart, clientSecret: string, cbUrl: string, cb: Record<string, string>, pending: { state: string; nonce: string; verifier?: string }): Promise<ExternalProfile> {
  const client = await import('openid-client');
  const cfg = new client.Configuration(
    { issuer: s.issuer!, authorization_endpoint: s.authorizeEndpoint!, token_endpoint: s.tokenEndpoint!, jwks_uri: s.jwksUri! } as import('openid-client').ServerMetadata,
    s.clientId!, clientSecret || undefined);
  const tokenUrl = new URL(s.tokenEndpoint!);
  if (tokenUrl.protocol === 'http:') client.allowInsecureRequests(cfg);   // local fake provider in dev/e2e only
  // v6 validates id_token CLAIMS in every grant but verifies the SIGNATURE only when asked (the spec treats a
  // back-channel id_token as TLS-authenticated). We always ask: a provider key rotation or a poisoned cache must
  // never be enough to mint an identity here.
  client.enableNonRepudiationChecks(cfg);
  const current = new URL(cbUrl);
  for (const k of ['code', 'state', 'iss']) if (cb[k]) current.searchParams.set(k, cb[k]);
  const tokens = await client.authorizationCodeGrant(cfg, current, {
    ...(pending.verifier && s.pkce !== false ? { pkceCodeVerifier: pending.verifier } : {}),
    expectedNonce: pending.nonce, expectedState: pending.state, idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims || !strOk(claims.sub, 255)) throw new Error('oidc: no usable id_token');
  const email = typeof claims.email === 'string' && claims.email.length <= 120 ? claims.email : undefined;
  return { sub: String(claims.sub), ...(email ? { email, emailVerified: claims.email_verified === true } : {}), ...(typeof claims.name === 'string' && claims.name.length <= 120 ? { name: claims.name } : {}), claims: claims as Record<string, unknown> };
}

/** OAuth2-only providers (GitHub, Facebook): code -> access token -> userinfo (+ optional e-mails and token inspection reads). */
export async function exchangeUserinfo(s: ExternalStart, clientSecret: string, cbUrl: string, cb: Record<string, string>, pending: { state: string; verifier?: string }): Promise<ExternalProfile> {
  if (!strOk(cb.code, 2048)) throw new Error('oauth2: no code');
  const form = new URLSearchParams({ grant_type: 'authorization_code', code: cb.code, redirect_uri: cbUrl, client_id: s.clientId! });
  if (clientSecret) form.set('client_secret', clientSecret);
  if (pending.verifier && s.pkce !== false) form.set('code_verifier', pending.verifier);
  const tokRes = await fetch(s.tokenEndpoint!, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!tokRes.ok) throw new Error(`oauth2: token endpoint answered ${tokRes.status}`);
  const tok = await readJson(tokRes, 'oauth2 token');
  const access = tok.access_token;
  if (typeof access !== 'string' || !access.length || access.length > 4096) throw new Error('oauth2: no access token');
  const infoRes = await fetch(s.userinfoEndpoint!, { headers: { authorization: `Bearer ${access}`, accept: 'application/json', ...(s.userinfoHeaders ?? {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!infoRes.ok) throw new Error(`oauth2: userinfo answered ${infoRes.status}`);
  const raw = await readJson(infoRes, 'oauth2 userinfo');
  const map = s.profileMap!;
  const sub = raw[map.sub];
  if ((typeof sub !== 'string' && typeof sub !== 'number') || !String(sub).length || String(sub).length > 255) throw new Error('oauth2: no subject in profile');
  let email = map.email && typeof raw[map.email] === 'string' && String(raw[map.email]).length <= 120 ? String(raw[map.email]) : undefined;
  let emailVerified = map.emailVerified ? raw[map.emailVerified] === true : undefined;
  // A provider whose profile carries no e-mail can list e-mail records separately (GitHub /user/emails): pick the primary verified one.
  if (!email && urlOk(s.emailsEndpoint)) {
    const emRes = await fetch(s.emailsEndpoint!, { headers: { authorization: `Bearer ${access}`, accept: 'application/json', ...(s.userinfoHeaders ?? {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (emRes.ok) {
      const text = await emRes.text();
      if (text.length <= MAX_JSON) {
        try {
          const list = JSON.parse(text);
          if (Array.isArray(list)) {
            const pick = list.find((e) => e && typeof e === 'object' && (e as { primary?: boolean }).primary && (e as { verified?: boolean }).verified && typeof (e as { email?: unknown }).email === 'string') ?? list.find((e) => e && typeof e === 'object' && (e as { verified?: boolean }).verified && typeof (e as { email?: unknown }).email === 'string');
            if (pick && String((pick as { email: string }).email).length <= 120) { email = String((pick as { email: string }).email); emailVerified = true; }
          }
        } catch { /* no e-mail then */ }
      }
    }
  }
  // Optional token inspection (Facebook debug_token): raw answer for the PLUGIN to judge (it stays pure).
  let tokenInfo: Record<string, unknown> | undefined;
  if (typeof s.tokenInfoEndpoint === 'string') {
    const appToken = clientSecret ? `${s.clientId}|${clientSecret}` : '';
    const url = s.tokenInfoEndpoint.replace('{token}', encodeURIComponent(access)).replace('{appToken}', encodeURIComponent(appToken));
    if (urlOk(url)) {
      const tiRes = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (tiRes.ok) tokenInfo = await readJson(tiRes, 'token info');
    }
  }
  const name = map.name && typeof raw[map.name] === 'string' && String(raw[map.name]).length <= 120 ? String(raw[map.name]) : undefined;
  return { sub: String(sub), ...(email ? { email, ...(emailVerified !== undefined ? { emailVerified } : {}) } : {}), ...(name ? { name } : {}), ...(tokenInfo ? { tokenInfo } : {}) };
}
