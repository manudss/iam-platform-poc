import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Injectable, Logger, NotFoundException, OnModuleInit, Optional, Param, Post, Req, UseGuards } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import Provider from 'oidc-provider';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { Connection } from 'mysql2/promise';
import { AuthGuard, assertNotBranchTest } from '../auth/auth.guard.js';
import { ProfileService } from '../profile/profile.service.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { ApplicationBus } from '../events/application-bus.service.js';
import { SecretsService } from '../integrations/secrets.service.js';
import { AppConnector, AppConnectorService } from '../connectors/app-connector.js';

/**
 * OIDC provider (plugin `oidc-provider`, step 2 of the SSO plan): the platform acts as an OpenID Provider for the applications
 * registered in `app-connector`. The protocol itself is the embedded library node-oidc-provider (MIT, OpenID certified): discovery,
 * authorize (code + PKCE S256 required), token, userinfo, JWKS, refresh, end-session. This file only wires it:
 *  - clients come from the LIVE application registry (Dolt main), so a change reaches applications only after Apply;
 *  - the user signs in with the existing authentication chain (the console), the library only asks "who is the user" through an interaction;
 *  - access is closed by default: the user needs one of the application's allowed roles, then explicitly allows the sharing on a consent screen;
 *  - client secrets and the signing key are read from the secret store, never from Dolt.
 */
export const OIDC_PLUGIN = 'oidc-provider';
/** Claims this provider can send. An application's `attribute_mapping` picks among them (any other name is ignored). */
export const SUPPORTED_CLAIMS = ['sub', 'email', 'email_verified', 'name', 'preferred_username', 'department', 'roles', 'groups'] as const;
/** Profile keys an application may read a claim from. */
export const PROFILE_KEYS = ['id', 'email', 'display_name', 'department', 'roles'] as const;
const SCOPES = ['openid', 'profile', 'email', 'roles', 'offline_access'];

export interface DirectoryUser { id: string; display_name: string; email: string; department: string; roles: string[] }
/** Where the signed-in user's attributes and roles come from (live data: Dolt main). */
export interface SsoDirectory { user(tenant: string, id: string): Promise<DirectoryUser | undefined> }
export const SSO_DIRECTORY = 'SSO_DIRECTORY';
export class DoltSsoDirectory implements SsoDirectory {
  constructor(private readonly v: VersioningService) {}
  async user(_t: string, id: string) {
    return this.v.at('main', async (c: Connection) => {
      const [u] = await c.query('select id, display_name, email, department from identities where id=? and login_enabled=1', [id]);
      const r = (u as Record<string, string | null>[])[0]; if (!r) return undefined;
      const [a] = await c.query('select role_id from assignments where identity_id=? order by role_id', [id]);
      return { id: String(r.id), display_name: r.display_name ?? '', email: r.email ?? '', department: r.department ?? '', roles: (a as { role_id: string }[]).map((x) => x.role_id) };
    });
  }
}
export class MemorySsoDirectory implements SsoDirectory {
  constructor(public users: DirectoryUser[] = []) {}
  async user(_t: string, id: string) { return this.users.find((u) => u.id === id); }
}

/** The claims an application receives: its `attribute_mapping` (claim -> profile key) applied to the live user. Unknown names are dropped. */
export function claimsFor(app: Pick<AppConnector, 'attribute_mapping'>, u: DirectoryUser): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const from: Record<string, unknown> = { id: u.id, email: u.email, display_name: u.display_name, department: u.department, roles: u.roles };
  for (const [claim, key] of Object.entries(app.attribute_mapping)) {
    if (!(SUPPORTED_CLAIMS as readonly string[]).includes(claim) || !(key in from)) continue;
    const v = from[key]; if (v === '' || v === undefined) continue;
    out[claim] = v;
    if (claim === 'email') out.email_verified = false; // the directory does not verify addresses: never claim it
  }
  return out;
}
/** May this user open this application? Closed by default: the application must be enabled and the user must hold one allowed role. */
export function mayOpen(app: Pick<AppConnector, 'enabled' | 'allowed_roles'>, u: DirectoryUser | undefined): boolean {
  return !!u && app.enabled && app.allowed_roles.some((r) => u.roles.includes(r));
}

/** In-memory storage for everything except clients (sessions, codes, tokens, grants, interactions): runtime state, not Dolt data. Lost on restart (demo). */
class MemoryAdapter {
  static store = new Map<string, { payload: Record<string, any>; exp?: number }>();
  static key(model: string, id: string) { return `${model}:${id}`; }
  constructor(private readonly model: string) {}
  private k(id: string) { return MemoryAdapter.key(this.model, id); }
  async upsert(id: string, payload: Record<string, any>, expiresIn: number) {
    const s = MemoryAdapter.store; s.set(this.k(id), { payload, exp: expiresIn ? Date.now() + expiresIn * 1000 : undefined });
    if (payload.grantId) { const g = MemoryAdapter.key('Grant:link', payload.grantId); const l = s.get(g) ?? { payload: { ids: [] } }; l.payload.ids.push(this.k(id)); s.set(g, l); }
    if (payload.uid) s.set(MemoryAdapter.key('Session:uid', payload.uid), { payload: { id }, exp: s.get(this.k(id))?.exp });
    if (payload.userCode) s.set(MemoryAdapter.key('DeviceCode:uc', payload.userCode), { payload: { id } });
  }
  async find(id: string) { const e = MemoryAdapter.store.get(this.k(id)); if (!e) return undefined; if (e.exp && e.exp < Date.now()) { MemoryAdapter.store.delete(this.k(id)); return undefined; } return e.payload; }
  async findByUid(uid: string) { const l = MemoryAdapter.store.get(MemoryAdapter.key('Session:uid', uid)); return l ? this.find(l.payload.id) : undefined; }
  async findByUserCode(c: string) { const l = MemoryAdapter.store.get(MemoryAdapter.key('DeviceCode:uc', c)); return l ? this.find(l.payload.id) : undefined; }
  async consume(id: string) { const e = MemoryAdapter.store.get(this.k(id)); if (e) e.payload.consumed = Math.floor(Date.now() / 1000); }
  async destroy(id: string) { MemoryAdapter.store.delete(this.k(id)); }
  async revokeByGrantId(grantId: string) { const s = MemoryAdapter.store, l = s.get(MemoryAdapter.key('Grant:link', grantId)); for (const k of l?.payload.ids ?? []) s.delete(k); s.delete(MemoryAdapter.key('Grant:link', grantId)); }
}

type ProviderT = any;
interface TenantProvider { provider: ProviderT; callback: (req: unknown, res: unknown) => void; issuer: string }

@Injectable()
export class OidcProviderService implements OnModuleInit {
  private readonly log = new Logger('oidc-provider');
  private providers = new Map<string, TenantProvider>();
  private signing = new Map<string, Record<string, unknown>>();
  private cookieKeys = (process.env.IAM_SSO_COOKIE_KEY ?? '').length >= 16 ? [process.env.IAM_SSO_COOKIE_KEY!] : [randomBytes(32).toString('base64url')];
  constructor(
    private readonly apps: AppConnectorService, private readonly profile: ProfileService,
    @Inject(SSO_DIRECTORY) private readonly dir: SsoDirectory, private readonly secrets: SecretsService,
    @Optional() private readonly events?: ApplicationBus, @Optional() private readonly host?: HttpAdapterHost,
  ) {}

  /** Mounts /sso/:tenant/oidc/* on the HTTP server (before the Nest routes). */
  onModuleInit() {
    const app = this.host?.httpAdapter?.getInstance?.(); if (!app?.use) return;
    app.use('/sso/:tenant/oidc', (req: any, res: any, next: (e?: unknown) => void) => {
      this.forTenant(req.params.tenant, req).then((p) => { if (!p) { res.statusCode = 404; res.setHeader('content-type', 'application/json'); res.end('{"error":"not_found","message":"the oidc-provider plugin is not enabled"}'); return; } // The library builds its endpoint URLs from the path it is served under: tell it the PUBLIC path (the edge strips a prefix such as /api).
        req.originalUrl = new URL(p.issuer).pathname.replace(/\/$/, '') + req.url; p.callback(req, res); }, next);
    });
  }

  /** Public base URL. IAM_SSO_BASE_URL pins it (recommended); otherwise it is taken from the request, behind the edge's forwarded headers. */
  private base(req?: any): string {
    const pinned = process.env.IAM_SSO_BASE_URL; if (pinned) return pinned.replace(/\/+$/, '');
    const proto = String(req?.headers?.['x-forwarded-proto'] ?? req?.protocol ?? 'http').split(',')[0].trim(), host = String(req?.headers?.['x-forwarded-host'] ?? req?.headers?.host ?? 'localhost').split(',')[0].trim();
    return `${proto}://${host}`;
  }
  async active(t: string) { return (await this.profile.pluginActive(t, OIDC_PLUGIN, 'live')) && (await this.profile.pluginActive(t, 'app-connector', 'live')); }
  async forTenant(t: string, req?: unknown): Promise<TenantProvider | undefined> {
    if (!/^[a-z0-9-]{1,32}$/.test(t) || !(await this.active(t))) return undefined;
    const issuer = `${this.base(req)}/sso/${t}/oidc`; const k = `${t}|${issuer}`;
    let p = this.providers.get(k); if (!p) { p = await this.build(t, issuer); this.providers.set(k, p); }
    return p;
  }
  /** Signing key: from the secret store (`sso/<tenant>/oidc-signing-key`, field `jwk`) so it survives restarts; else generated for this process (demo). */
  private async signingKey(t: string) {
    let jwk = this.signing.get(t); if (jwk) return jwk;
    try { const s = await this.secrets.get(`sso/${t}/oidc-signing-key`); if (s?.jwk) jwk = JSON.parse(s.jwk); } catch (e) { this.log.warn(`signing key not read from the secret store: ${(e as Error).message}`); }
    if (!jwk) { const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' }); jwk = { ...privateKey.export({ format: 'jwk' }), alg: 'ES256', use: 'sig', kid: `${t}-${randomBytes(6).toString('hex')}` }; }
    this.signing.set(t, jwk); return jwk;
  }
  private async clientFor(t: string, id: string) {
    const a = (await this.apps.liveApps(t)).find((x) => x.id === id && x.protocol === 'oidc' && x.enabled); if (!a) return undefined;
    let secret: string | undefined;
    if (a.secret_ref) { try { const s = await this.secrets.get(a.secret_ref); secret = s?.client_secret ?? s?.value; } catch (e) { this.log.warn(`secret of ${a.id} unreadable: ${(e as Error).message}`); } }
    return {
      client_id: a.id, client_name: a.name, redirect_uris: a.redirect_uris, response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'],
      // without a readable secret the application is a public client: it must use PKCE (always required here anyway)
      token_endpoint_auth_method: secret ? 'client_secret_basic' : 'none', ...(secret ? { client_secret: secret } : {}), application_type: 'web',
    };
  }
  private async build(t: string, issuer: string): Promise<TenantProvider> {
    const self = this;
    const adapter = class { constructor(public name: string) { return name === 'Client' ? { find: (id: string) => self.clientFor(t, id), upsert: async () => undefined, destroy: async () => undefined, consume: async () => undefined } as any : new MemoryAdapter(name); } };
    const provider: ProviderT = new (Provider as any)(issuer, {
      adapter: adapter as any,
      jwks: { keys: [await this.signingKey(t)] },
      cookies: { keys: this.cookieKeys },
      scopes: SCOPES,
      claims: { openid: ['sub'], email: ['email', 'email_verified'], profile: ['name', 'preferred_username', 'department'], roles: ['roles', 'groups'] },
      responseTypes: ['code'],
      pkce: { required: () => true },
      clientDefaults: { id_token_signed_response_alg: 'ES256' },
      features: { devInteractions: { enabled: false }, revocation: { enabled: true }, rpInitiatedLogout: { enabled: true } },
      ttl: { AccessToken: 600, AuthorizationCode: 60, IdToken: 600, RefreshToken: 14 * 24 * 3600, Interaction: 600, Session: 8 * 3600, Grant: 14 * 24 * 3600 },
      interactions: { url: (_ctx: unknown, i: { uid: string }) => `/sso-interaction/${i.uid}?tenant=${encodeURIComponent(t)}` },
      issueRefreshToken: async (_ctx: unknown, client: any, code: any) => client.grantTypeAllowed('refresh_token') && code.scopes.has('offline_access'),
      findAccount: async (ctx: any, sub: string) => {
        const u = await self.dir.user(t, sub); if (!u) return undefined;
        const app = (await self.apps.liveApps(t)).find((x) => x.id === ctx?.oidc?.client?.clientId);
        return { accountId: sub, claims: async () => ({ sub, ...(app ? claimsFor(app, u) : {}) }) };
      },
      renderError: async (ctx: any, out: Record<string, string>) => { ctx.type = 'application/json'; ctx.body = { error: out.error, error_description: out.error_description }; },
    });
    provider.proxy = true;
    for (const [ev, type] of [['grant.success', 'sso.token.issued'], ['authorization.error', 'sso.login.failed'], ['server_error', 'sso.login.failed']] as const)
      provider.on(ev, (ctx: any, err: Error) => this.emit(type, t, { app: String(ctx?.oidc?.client?.clientId ?? ''), subject: String(ctx?.oidc?.session?.accountId ?? ''), ...(type === 'sso.login.failed' ? { reason: String((err as any)?.error ?? err?.message ?? 'error').slice(0, 80) } : { scope: String(ctx?.oidc?.entities?.AccessToken?.scope ?? '') }) }));
    return { provider, callback: provider.callback(), issuer };
  }
  emit(type: string, tenant: string, payload: Record<string, string>) { this.events?.emit({ type, tenant, branch: 'main', at: new Date().toISOString(), payload }); }

  private async interaction(t: string, uid: string, req: unknown) {
    const p = await this.forTenant(t, req); if (!p) throw new NotFoundException('the oidc-provider plugin is not enabled');
    const i = await p.provider.Interaction.find(uid); if (!i) throw new NotFoundException('unknown or expired sign-in request');
    const app = (await this.apps.liveApps(t)).find((x) => x.id === i.params.client_id); if (!app) throw new NotFoundException('unknown application');
    return { p, i, app };
  }
  /** What the console shows after the user signed in: which application asks for what, and whether the user may open it. */
  async details(t: string, uid: string, sub: string, req: unknown) {
    const { i, app } = await this.interaction(t, uid, req); const u = await this.dir.user(t, sub);
    const scopes = String(i.params.scope ?? '').split(' ').filter((s) => SCOPES.includes(s));
    return { app: { id: app.id, name: app.name, description: app.description }, scopes, user: { sub, name: u?.display_name || sub }, allowed: mayOpen(app, u) };
  }
  /** The signed-in user answers. Returns where the browser must go next (the library resumes the authorization request there). */
  async complete(t: string, uid: string, sub: string, decision: unknown, req: unknown): Promise<{ redirectTo: string }> {
    if (decision !== 'allow' && decision !== 'deny') throw new BadRequestException("decision: 'allow' or 'deny'");
    const { p, i, app } = await this.interaction(t, uid, req); const u = await this.dir.user(t, sub);
    const deny = async (error: string, reason: string) => { i.result = { error, error_description: reason }; await i.save(i.exp - Math.floor(Date.now() / 1000)); this.emit('sso.login.denied', t, { app: app.id, subject: sub, reason }); return { redirectTo: i.returnTo as string }; };
    if (!mayOpen(app, u)) return deny('access_denied', 'not-allowed');
    if (decision === 'deny') return deny('access_denied', 'user-declined');
    const grant = new p.provider.Grant({ accountId: sub, clientId: app.id });
    grant.addOIDCScope(String(i.params.scope ?? 'openid').split(' ').filter((s) => SCOPES.includes(s)).join(' ') || 'openid');
    const grantId = await grant.save();
    i.result = { login: { accountId: sub, remember: false }, consent: { grantId } };
    await i.save(i.exp - Math.floor(Date.now() / 1000));
    this.emit('sso.login.succeeded', t, { app: app.id, subject: sub });
    return { redirectTo: i.returnTo as string };
  }
}

/** Console-facing API of the sign-in request (the user is signed in to the console with the normal chain; the bearer token proves who). */
@UseGuards(AuthGuard)
@Controller('sso/:tenant/interaction')
export class SsoInteractionController {
  constructor(private readonly o: OidcProviderService) {}
  @Get(':uid') details(@Param('tenant') t: string, @Param('uid') uid: string, @Req() r: { user: { sub: string; branch?: string } }) { assertNotBranchTest(r); return this.o.details(t, uid, r.user.sub, r); }
  @Post(':uid/complete') complete(@Param('tenant') t: string, @Param('uid') uid: string, @Body() b: { decision?: unknown }, @Req() r: { user: { sub: string; branch?: string } }) { assertNotBranchTest(r); return this.o.complete(t, uid, r.user.sub, b?.decision, r); }
}
