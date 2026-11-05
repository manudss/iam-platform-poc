import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as oc from 'openid-client';
import { EventsModule } from '../events/events.module.js';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { AppEvents } from '../events/app-events.service.js';
import { AppConnectorService } from '../connectors/app-connector.js';
import { SSO_DIRECTORY, MemorySsoDirectory, claimsFor, mayOpen, SUPPORTED_CLAIMS } from './oidc.js';

const T = 'acme-demo', PORT = 13581, BASE = `http://localhost:${PORT}`, ISS = `${BASE}/sso/${T}/oidc`, CB = 'http://localhost:4300/cb';
const alice = { id: 'demo-alice', display_name: 'Alice Martin', email: 'alice@example.invalid', department: 'Finance', roles: ['employee'] };
const bob = { id: 'demo-bob', display_name: 'Bob Durand', email: 'bob@example.invalid', department: 'Sales', roles: ['sales-rep'] };

describe('claims and access decision (pure)', () => {
  const app = { attribute_mapping: { sub: 'id', email: 'email', name: 'display_name', groups: 'roles', secret_thing: 'email', dept: 'department', preferred_username: 'nope' }, enabled: true, allowed_roles: ['employee'] };
  it('maps only supported claims from known profile keys, never claims a verified email', () => {
    const c = claimsFor(app, alice);
    assert.deepEqual(c, { sub: 'demo-alice', email: 'alice@example.invalid', email_verified: false, name: 'Alice Martin', groups: ['employee'] });
    for (const k of Object.keys(c)) assert.ok((SUPPORTED_CLAIMS as readonly string[]).includes(k));
  });
  it('is closed by default: disabled app, no role, empty allowed list or unknown user are refused', () => {
    assert.equal(mayOpen(app, alice), true);
    assert.equal(mayOpen(app, bob), false);
    assert.equal(mayOpen({ ...app, enabled: false }, alice), false);
    assert.equal(mayOpen({ ...app, allowed_roles: [] }, alice), false);
    assert.equal(mayOpen(app, undefined), false);
  });
});

describe('OIDC provider: a local relying party signs in (code + PKCE) through the embedded node-oidc-provider', () => {
  let app: INestApplication, reg: PluginRegistry, apps: AppConnectorService, events: { type: string; payload: Record<string, string> }[] = [];
  const saved = { b: process.env.IAM_SSO_BASE_URL };
  before(async () => {
    process.env.IAM_SSO_BASE_URL = BASE;
    // The console's sign-in is the normal chain; here the guard just names the caller from a header.
    const guard = { canActivate: (c: any) => { const r = c.switchToHttp().getRequest(); const s = r.headers['x-test-sub']; if (!s) return false; r.user = { sub: String(s), tenant: T }; return true; } };
    const mod = await Test.createTestingModule({ imports: [EventsModule, PluginsV1Module] }).overrideGuard(AuthGuard).useValue(guard).compile();
    app = mod.createNestApplication(); await app.init(); await app.listen(PORT);
    reg = app.get(PluginRegistry); apps = app.get(AppConnectorService);
    (app.get(SSO_DIRECTORY) as MemorySsoDirectory).users.push(alice, bob);
    app.get(AppEvents).on((e) => { events.push({ type: e.type, payload: e.payload }); });
    await reg.install(T, 'app-connector', {}); await reg.enable(T, 'app-connector', {});
    await apps.create(T, 'admin', { id: 'wiki', name: 'Company wiki', protocol: 'oidc', redirect_uris: [CB], enabled: true, allowed_roles: ['employee'], attribute_mapping: { sub: 'id', email: 'email', name: 'display_name', groups: 'roles' } });
    await apps.update(T, 'admin', 'wiki', { enabled: true, allowed_roles: ['employee'] });
    await apps.create(T, 'admin', { id: 'off', name: 'Off', protocol: 'oidc', redirect_uris: [CB] });
  });
  after(async () => { process.env.IAM_SSO_BASE_URL = saved.b; await app.close(); });

  const jar = new Map<string, string>();
  const keep = (r: Response) => { for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const get = async (url: string) => { const r = await fetch(url, { redirect: 'manual', headers: { cookie: cookie() } }); keep(r); return r; };
  const pkce = async () => { const v = oc.randomPKCECodeVerifier(); return { v, c: await oc.calculatePKCECodeChallenge(v) }; };
  const cfg = async () => oc.discovery(new URL(ISS), 'wiki', undefined, oc.None(), { execute: [oc.allowInsecureRequests] });

  /** Starts an authorization request and returns the interaction uid the console would receive. */
  async function start(config: oc.Configuration, challenge: string, scope = 'openid email profile roles', state = 'st1', extra: Record<string, string> = {}) {
    jar.clear();
    const url = oc.buildAuthorizationUrl(config, { redirect_uri: CB, scope, state, code_challenge: challenge, code_challenge_method: 'S256', ...extra });
    let r = await get(url.href); let guard = 0;
    while (r.status >= 300 && r.status < 400 && guard++ < 5) { const loc = new URL(r.headers.get('location')!, ISS); if (loc.pathname.startsWith('/sso-interaction/')) return { uid: loc.pathname.split('/').pop()!, tenant: loc.searchParams.get('tenant') }; if (loc.href.startsWith(CB)) return { cb: loc }; r = await get(loc.href); }
    return { status: r.status, body: await r.text() };
  }
  const api = (path: string, sub?: string, body?: object) => fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { ...(sub ? { 'x-test-sub': sub } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  async function finish(redirectTo: string) { let r = await get(redirectTo); let g = 0; while (r.status >= 300 && r.status < 400 && g++ < 5) { const loc = new URL(r.headers.get('location')!, ISS); if (loc.href.startsWith(CB)) return loc; r = await get(loc.href); } throw new Error(`no callback, last status ${r.status}`); }

  it('is a 404 while the oidc-provider plugin is off, then publishes discovery and the keys', async () => {
    assert.equal((await fetch(`${ISS}/.well-known/openid-configuration`)).status, 404);
    await reg.install(T, 'oidc-provider', {}); await reg.enable(T, 'oidc-provider', {});
    const d = await (await fetch(`${ISS}/.well-known/openid-configuration`)).json() as any;
    assert.equal(d.issuer, ISS); assert.deepEqual(d.code_challenge_methods_supported, ['S256']); assert.deepEqual(d.response_types_supported, ['code']);
    assert.ok(d.scopes_supported.includes('roles')); assert.equal(d.userinfo_endpoint, `${ISS}/me`);
    const k = await (await fetch(`${ISS}/jwks`)).json() as any; assert.equal(k.keys.length, 1); assert.equal(k.keys[0].d, undefined, 'the private part is never published');
  });

  it('signs a user in end to end: consent, code exchange, ID token, userinfo, mapped claims only', async () => {
    const config = await cfg(), { v, c } = await pkce();
    const s = await start(config, c) as { uid: string; tenant: string };
    assert.equal(s.tenant, T);
    assert.equal((await api(`/sso/${T}/interaction/${s.uid}`)).status, 403, 'the console API needs a signed-in user');
    const det = await (await api(`/sso/${T}/interaction/${s.uid}`, 'demo-alice')).json() as any;
    assert.deepEqual(det, { app: { id: 'wiki', name: 'Company wiki', description: '' }, scopes: ['openid', 'email', 'profile', 'roles'], user: { sub: 'demo-alice', name: 'Alice Martin' }, allowed: true });
    const done = await (await api(`/sso/${T}/interaction/${s.uid}/complete`, 'demo-alice', { decision: 'allow' })).json() as any;
    const cb = await finish(done.redirectTo);
    assert.equal(cb.searchParams.get('state'), 'st1');
    const tokens = await oc.authorizationCodeGrant(config, cb, { pkceCodeVerifier: v, expectedState: 'st1' });
    const claims = tokens.claims()!;
    assert.equal(claims.sub, 'demo-alice'); assert.equal(claims.iss, ISS); assert.equal(claims.aud, 'wiki');
    const info = await oc.fetchUserInfo(config, tokens.access_token, claims.sub) as any;
    assert.deepEqual(info, { sub: 'demo-alice', email: 'alice@example.invalid', email_verified: false, name: 'Alice Martin', groups: ['employee'] });
    assert.equal((info as any).department, undefined, 'a claim the application did not map is not sent');
    assert.equal(tokens.refresh_token, undefined, 'no refresh token without offline_access');
    // the authorization code is single use
    await assert.rejects(oc.authorizationCodeGrant(config, cb, { pkceCodeVerifier: v, expectedState: 'st1' }));
    assert.ok(events.some((e) => e.type === 'sso.login.succeeded' && e.payload.app === 'wiki' && e.payload.subject === 'demo-alice'));
    assert.ok(events.some((e) => e.type === 'sso.token.issued'));
  });

  it('issues and rotates a refresh token with offline_access', async () => {
    const config = await cfg(), { v, c } = await pkce();
    const s = await start(config, c, 'openid offline_access', 'st2', { prompt: 'consent' }) as { uid: string };
    const done = await (await api(`/sso/${T}/interaction/${s.uid}/complete`, 'demo-alice', { decision: 'allow' })).json() as any;
    const t1 = await oc.authorizationCodeGrant(config, await finish(done.redirectTo), { pkceCodeVerifier: v, expectedState: 'st2' });
    assert.ok(t1.refresh_token);
    const t2 = await oc.refreshTokenGrant(config, t1.refresh_token!);
    assert.ok(t2.access_token && t2.access_token !== t1.access_token);
  });

  it('refuses a user without an allowed role (access_denied) and records it', async () => {
    const config = await cfg(), { c } = await pkce();
    const s = await start(config, c, 'openid', 'st3') as { uid: string };
    assert.equal(((await (await api(`/sso/${T}/interaction/${s.uid}`, 'demo-bob')).json()) as any).allowed, false);
    const done = await (await api(`/sso/${T}/interaction/${s.uid}/complete`, 'demo-bob', { decision: 'allow' })).json() as any;
    const cb = await finish(done.redirectTo);
    assert.equal(cb.searchParams.get('error'), 'access_denied'); assert.equal(cb.searchParams.get('code'), null);
    assert.ok(events.some((e) => e.type === 'sso.login.denied' && e.payload.subject === 'demo-bob' && e.payload.reason === 'not-allowed'));
  });

  it('honours a user who declines at the consent screen', async () => {
    const config = await cfg(), { c } = await pkce();
    const s = await start(config, c, 'openid', 'st4') as { uid: string };
    const done = await (await api(`/sso/${T}/interaction/${s.uid}/complete`, 'demo-alice', { decision: 'deny' })).json() as any;
    assert.equal((await finish(done.redirectTo)).searchParams.get('error'), 'access_denied');
    assert.equal((await api(`/sso/${T}/interaction/${s.uid}/complete`, 'demo-alice', { decision: 'maybe' })).status, 400);
  });

  it('negative tests: no PKCE, wrong redirect_uri, disabled or unknown application, unknown sign-in request', async () => {
    const config = await cfg(); jar.clear();
    const noPkce = oc.buildAuthorizationUrl(config, { redirect_uri: CB, scope: 'openid', state: 'x' });
    let r = await get(noPkce.href); assert.equal(r.status, 303); assert.equal(new URL(r.headers.get('location')!).searchParams.get('error'), 'invalid_request', 'PKCE is required');
    const { c } = await pkce();
    const bad = oc.buildAuthorizationUrl(config, { redirect_uri: 'http://localhost:4300/other', scope: 'openid', state: 'x', code_challenge: c, code_challenge_method: 'S256' });
    r = await get(bad.href); assert.ok(r.status >= 400 && r.status < 500, `wrong redirect_uri must not redirect (got ${r.status})`);
    const plain = oc.buildAuthorizationUrl(config, { redirect_uri: CB, scope: 'openid', state: 'x', code_challenge: c, code_challenge_method: 'plain' });
    r = await get(plain.href); assert.notEqual(r.status, 200); assert.equal(r.headers.get('location')?.includes('code='), false);
    const off = await oc.discovery(new URL(ISS), 'off', undefined, oc.None(), { execute: [oc.allowInsecureRequests] });
    r = await get(oc.buildAuthorizationUrl(off, { redirect_uri: CB, scope: 'openid', state: 'x', code_challenge: c, code_challenge_method: 'S256' }).href); assert.ok(r.status >= 400, `disabled application: ${r.status}`);
    r = await get(oc.buildAuthorizationUrl(await oc.discovery(new URL(ISS), 'nobody', undefined, oc.None(), { execute: [oc.allowInsecureRequests] }), { redirect_uri: CB, scope: 'openid', state: 'x', code_challenge: c, code_challenge_method: 'S256' }).href); assert.ok(r.status >= 400);
    assert.equal((await api(`/sso/${T}/interaction/does-not-exist`, 'demo-alice')).status, 404);
  });

  it('a wrong PKCE verifier cannot redeem the code', async () => {
    const config = await cfg(), { c } = await pkce();
    const s = await start(config, c, 'openid', 'st5') as { uid: string };
    const done = await (await api(`/sso/${T}/interaction/${s.uid}/complete`, 'demo-alice', { decision: 'allow' })).json() as any;
    const cb = await finish(done.redirectTo);
    await assert.rejects(oc.authorizationCodeGrant(config, cb, { pkceCodeVerifier: oc.randomPKCECodeVerifier(), expectedState: 'st5' }));
  });

  it('closes again when the plugin is switched off', async () => {
    await reg.disable(T, 'oidc-provider');
    assert.equal((await fetch(`${ISS}/.well-known/openid-configuration`)).status, 404);
  });
});
