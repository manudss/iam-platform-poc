/**
 * oidc-provider plugin: the platform acts as an OpenID Provider for the applications registered in
 * `app-connector`. All protocol logic lives in this folder; the core only mounts the engine and feeds
 * it dependencies (application registry, directory, secret store, event bus) through `createOidcEngine(deps)`.
 *
 * The protocol itself is the embedded library node-oidc-provider (MIT, OpenID certified): discovery,
 * authorize (code + PKCE S256 required), token, userinfo, JWKS, refresh, end-session. This engine wires it:
 *  - clients come from the LIVE application registry (Dolt main), so a change reaches applications only after Apply;
 *  - the user signs in with the existing authentication chain (the console), the library only asks "who is the user" through an interaction;
 *  - access is closed by default: the user needs one of the application's allowed roles, then explicitly allows the sharing on a consent screen;
 *  - client secrets and the signing key are read from the secret store, never from Dolt.
 *
 * deps = {
 *   liveApps(tenant)          -> application registry entries (live branch)
 *   pluginActive(tenant, id)  -> boolean, plugin activation on the live branch
 *   directoryUser(tenant, id) -> { id, display_name, email, department, roles } | undefined
 *   secretGet(ref)            -> secret fields record | undefined
 *   emit(type, tenant, payload) -> durable audit event
 *   env                       -> process.env-like ({ IAM_SSO_BASE_URL?, IAM_SSO_COOKIE_KEY? })
 *   warn(message)             -> log a warning
 * }
 */
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomBytes } from 'node:crypto';

// No top-level await: the loader and the core adapter sync-load this module with createRequire.
const require = createRequire(new URL('./package.json', import.meta.url));
const oidcProviderPkg = require('oidc-provider');
// The package is a transpiled ESM build: require() returns the module object, the Provider class is its default.
const Provider = oidcProviderPkg.default ?? oidcProviderPkg.Provider ?? oidcProviderPkg;
const { BadRequestException, NotFoundException } = require('@nestjs/common');

export const OIDC_PLUGIN = 'oidc-provider';
/** Claims this provider can send. An application's `attribute_mapping` picks among them (any other name is ignored). */
export const SUPPORTED_CLAIMS = ['sub', 'email', 'email_verified', 'name', 'preferred_username', 'department', 'roles', 'groups'];
/** Profile keys an application may read a claim from. */
export const PROFILE_KEYS = ['id', 'email', 'display_name', 'department', 'roles'];
const SCOPES = ['openid', 'profile', 'email', 'roles', 'offline_access'];

/** The claims an application receives: its `attribute_mapping` (claim -> profile key) applied to the live user. Unknown names are dropped. */
export function claimsFor(app, u) {
  const out = {};
  const from = { id: u.id, email: u.email, display_name: u.display_name, department: u.department, roles: u.roles };
  for (const [claim, key] of Object.entries(app.attribute_mapping)) {
    if (!SUPPORTED_CLAIMS.includes(claim) || !(key in from)) continue;
    const v = from[key]; if (v === '' || v === undefined) continue;
    out[claim] = v;
    if (claim === 'email') out.email_verified = false; // the directory does not verify addresses: never claim it
  }
  return out;
}
/** May this user open this application? Closed by default: the application must be enabled and the user must hold one allowed role. */
export function mayOpen(app, u) {
  return !!u && app.enabled && app.allowed_roles.some((r) => u.roles.includes(r));
}

/** In-memory storage for everything except clients (sessions, codes, tokens, grants, interactions): runtime state, not Dolt data. Lost on restart (demo). */
class MemoryAdapter {
  static store = new Map();
  static key(model, id) { return `${model}:${id}`; }
  constructor(model) { this.model = model; }
  k(id) { return MemoryAdapter.key(this.model, id); }
  async upsert(id, payload, expiresIn) {
    const s = MemoryAdapter.store; s.set(this.k(id), { payload, exp: expiresIn ? Date.now() + expiresIn * 1000 : undefined });
    if (payload.grantId) { const g = MemoryAdapter.key('Grant:link', payload.grantId); const l = s.get(g) ?? { payload: { ids: [] } }; l.payload.ids.push(this.k(id)); s.set(g, l); }
    if (payload.uid) s.set(MemoryAdapter.key('Session:uid', payload.uid), { payload: { id }, exp: s.get(this.k(id))?.exp });
    if (payload.userCode) s.set(MemoryAdapter.key('DeviceCode:uc', payload.userCode), { payload: { id } });
  }
  async find(id) { const e = MemoryAdapter.store.get(this.k(id)); if (!e) return undefined; if (e.exp && e.exp < Date.now()) { MemoryAdapter.store.delete(this.k(id)); return undefined; } return e.payload; }
  async findByUid(uid) { const l = MemoryAdapter.store.get(MemoryAdapter.key('Session:uid', uid)); return l ? this.find(l.payload.id) : undefined; }
  async findByUserCode(c) { const l = MemoryAdapter.store.get(MemoryAdapter.key('DeviceCode:uc', c)); return l ? this.find(l.payload.id) : undefined; }
  async consume(id) { const e = MemoryAdapter.store.get(this.k(id)); if (e) e.payload.consumed = Math.floor(Date.now() / 1000); }
  async destroy(id) { MemoryAdapter.store.delete(this.k(id)); }
  async revokeByGrantId(grantId) { const s = MemoryAdapter.store, l = s.get(MemoryAdapter.key('Grant:link', grantId)); for (const k of l?.payload.ids ?? []) s.delete(k); s.delete(MemoryAdapter.key('Grant:link', grantId)); }
}

/** Builds the per-tenant provider engine. One instance per process (the core adapter holds it). */
export function createOidcEngine(deps) {
  const env = deps.env ?? process.env;
  const warn = deps.warn ?? (() => {});
  const providers = new Map();
  const signing = new Map();
  const cookieKeys = (env.IAM_SSO_COOKIE_KEY ?? '').length >= 16 ? [env.IAM_SSO_COOKIE_KEY] : [randomBytes(32).toString('base64url')];

  /** Public base URL. IAM_SSO_BASE_URL pins it (recommended); otherwise it is taken from the request, behind the edge's forwarded headers. */
  function base(req) {
    const pinned = env.IAM_SSO_BASE_URL; if (pinned) return pinned.replace(/\/+$/, '');
    const proto = String(req?.headers?.['x-forwarded-proto'] ?? req?.protocol ?? 'http').split(',')[0].trim(), host = String(req?.headers?.['x-forwarded-host'] ?? req?.headers?.host ?? 'localhost').split(',')[0].trim();
    return `${proto}://${host}`;
  }
  async function active(t) { return (await deps.pluginActive(t, OIDC_PLUGIN)) && (await deps.pluginActive(t, 'app-connector')); }
  async function forTenant(t, req) {
    if (!/^[a-z0-9-]{1,32}$/.test(t) || !(await active(t))) return undefined;
    const issuer = `${base(req)}/sso/${t}/oidc`; const k = `${t}|${issuer}`;
    let p = providers.get(k); if (!p) { p = await build(t, issuer); providers.set(k, p); }
    return p;
  }
  /** Signing key: from the secret store (`sso/<tenant>/oidc-signing-key`, field `jwk`) so it survives restarts; else generated for this process (demo). */
  async function signingKey(t) {
    let jwk = signing.get(t); if (jwk) return jwk;
    try { const s = await deps.secretGet(`sso/${t}/oidc-signing-key`); if (s?.jwk) jwk = JSON.parse(s.jwk); } catch (e) { warn(`signing key not read from the secret store: ${e.message}`); }
    if (!jwk) { const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }); jwk = { ...privateKey.export({ format: 'jwk' }), alg: 'ES256', use: 'sig', kid: `${t}-${randomBytes(6).toString('hex')}` }; }
    signing.set(t, jwk); return jwk;
  }
  async function clientFor(t, id) {
    const a = (await deps.liveApps(t)).find((x) => x.id === id && x.protocol === 'oidc' && x.enabled); if (!a) return undefined;
    let secret;
    if (a.secret_ref) { try { const s = await deps.secretGet(a.secret_ref); secret = s?.client_secret ?? s?.value; } catch (e) { warn(`secret of ${a.id} unreadable: ${e.message}`); } }
    return {
      client_id: a.id, client_name: a.name, redirect_uris: a.redirect_uris, response_types: ['code'], grant_types: ['authorization_code', ...(a.allow_refresh_tokens === false ? [] : ['refresh_token'])],
      // the scopes this application may ask for: a request beyond the list is refused with invalid_scope
      scope: ['openid', ...(Array.isArray(a.scopes) ? a.scopes : ['profile', 'email', 'roles'])].join(' '),
      // without a readable secret the application is a public client: it must use PKCE (always required here anyway)
      token_endpoint_auth_method: secret ? 'client_secret_basic' : 'none', ...(secret ? { client_secret: secret } : {}), application_type: 'web',
    };
  }
  async function build(t, issuer) {
    const adapter = class { constructor(name) { return name === 'Client' ? { find: (id) => clientFor(t, id), upsert: async () => undefined, destroy: async () => undefined, consume: async () => undefined } : new MemoryAdapter(name); } };
    const provider = new Provider(issuer, {
      adapter,
      jwks: { keys: [await signingKey(t)] },
      cookies: { keys: cookieKeys },
      scopes: SCOPES,
      claims: { openid: ['sub'], email: ['email', 'email_verified'], profile: ['name', 'preferred_username', 'department'], roles: ['roles', 'groups'] },
      responseTypes: ['code'],
      pkce: { required: () => true },
      clientDefaults: { id_token_signed_response_alg: 'ES256' },
      features: { devInteractions: { enabled: false }, revocation: { enabled: true }, rpInitiatedLogout: { enabled: true } },
      ttl: { AccessToken: 600, AuthorizationCode: 60, IdToken: 600, RefreshToken: 14 * 24 * 3600, Interaction: 600, Session: 8 * 3600, Grant: 14 * 24 * 3600 },
      interactions: { url: (_ctx, i) => `/sso-interaction/${i.uid}?tenant=${encodeURIComponent(t)}` },
      issueRefreshToken: async (_ctx, client, code) => client.grantTypeAllowed('refresh_token') && code.scopes.has('offline_access'),
      findAccount: async (ctx, sub) => {
        const u = await deps.directoryUser(t, sub); if (!u) return undefined;
        const app = (await deps.liveApps(t)).find((x) => x.id === ctx?.oidc?.client?.clientId);
        return { accountId: sub, claims: async () => ({ sub, ...(app ? claimsFor(app, u) : {}) }) };
      },
      renderError: async (ctx, out) => { ctx.type = 'application/json'; ctx.body = { error: out.error, error_description: out.error_description }; },
    });
    provider.proxy = true;
    for (const [ev, type] of [['grant.success', 'sso.token.issued'], ['authorization.error', 'sso.login.failed'], ['server_error', 'sso.login.failed']])
      provider.on(ev, (ctx, err) => deps.emit(type, t, { app: String(ctx?.oidc?.client?.clientId ?? ''), subject: String(ctx?.oidc?.session?.accountId ?? ''), ...(type === 'sso.login.failed' ? { reason: String(err?.error ?? err?.message ?? 'error').slice(0, 80) } : { scope: String(ctx?.oidc?.entities?.AccessToken?.scope ?? '') }) }));
    return { provider, callback: provider.callback(), issuer };
  }

  /** Express middleware to mount at /sso/:tenant/oidc (before the Nest routes). */
  function middleware(req, res, next) {
    forTenant(req.params.tenant, req).then((p) => {
      if (!p) { res.statusCode = 404; res.setHeader('content-type', 'application/json'); res.end('{"error":"not_found","message":"the oidc-provider plugin is not enabled"}'); return; }
      // The library builds its endpoint URLs from the path it is served under: tell it the PUBLIC path (the edge strips a prefix such as /api).
      req.originalUrl = new URL(p.issuer).pathname.replace(/\/$/, '') + req.url;
      p.callback(req, res);
    }, next);
  }

  async function interaction(t, uid, req) {
    const p = await forTenant(t, req); if (!p) throw new NotFoundException('the oidc-provider plugin is not enabled');
    const i = await p.provider.Interaction.find(uid); if (!i) throw new NotFoundException('unknown or expired sign-in request');
    const app = (await deps.liveApps(t)).find((x) => x.id === i.params.client_id); if (!app) throw new NotFoundException('unknown application');
    return { p, i, app };
  }
  /** The scopes an application may receive: openid plus its configured list; an unconfigured (older) application keeps the profile scopes. */
  const appScopes = (a) => new Set(['openid', ...(Array.isArray(a.scopes) ? a.scopes : ['profile', 'email', 'roles'])]);
  /** What the console shows after the user signed in: which application asks for what, and whether the user may open it. */
  async function details(t, uid, sub, req) {
    const { i, app } = await interaction(t, uid, req); const u = await deps.directoryUser(t, sub);
    const scopes = String(i.params.scope ?? '').split(' ').filter((s) => SCOPES.includes(s) && appScopes(app).has(s));
    return { app: { id: app.id, name: app.name, description: app.description }, scopes, user: { sub, name: u?.display_name || sub }, allowed: mayOpen(app, u) };
  }
  /** The signed-in user answers. Returns where the browser must go next (the library resumes the authorization request there). */
  async function complete(t, uid, sub, decision, req) {
    if (decision !== 'allow' && decision !== 'deny') throw new BadRequestException("decision: 'allow' or 'deny'");
    const { p, i, app } = await interaction(t, uid, req); const u = await deps.directoryUser(t, sub);
    const deny = async (error, reason) => { i.result = { error, error_description: reason }; await i.save(i.exp - Math.floor(Date.now() / 1000)); deps.emit('sso.login.denied', t, { app: app.id, subject: sub, reason }); return { redirectTo: i.returnTo }; };
    if (!mayOpen(app, u)) return deny('access_denied', 'not-allowed');
    if (decision === 'deny') return deny('access_denied', 'user-declined');
    const grant = new p.provider.Grant({ accountId: sub, clientId: app.id });
    grant.addOIDCScope(String(i.params.scope ?? 'openid').split(' ').filter((s) => SCOPES.includes(s) && appScopes(app).has(s)).join(' ') || 'openid');
    const grantId = await grant.save();
    i.result = { login: { accountId: sub, remember: false }, consent: { grantId } };
    await i.save(i.exp - Math.floor(Date.now() / 1000));
    deps.emit('sso.login.succeeded', t, { app: app.id, subject: sub });
    return { redirectTo: i.returnTo };
  }

  return { middleware, details, complete, forTenant };
}

// No bus hooks: the plugin serves HTTP through the engine the core adapter mounts.
export default {};
