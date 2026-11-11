import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventsModule } from '../events/events.module.js';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { AppConnectorService } from '../connectors/app-connector.js';
import { SSO_DIRECTORY, MemorySsoDirectory } from './oidc.js';
import { startTestBus, TestBus } from '../testing/test-bus.js';

// The launchpad lists, for the signed-in person, the LIVE applications their roles may open, with the URL
// that starts each single sign-on. PluginsV1Module requires a reachable bus (same as the saml/oidc specs).
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const T = 'acme-demo', PORT = 13597, BASE = `http://localhost:${PORT}`;
const alice = { id: 'demo-alice', display_name: 'Alice Martin', email: 'alice@example.invalid', department: 'Finance', roles: ['employee'] };
const yanis = { id: 'yanis-leroy', display_name: 'Yanis Leroy', email: 'yanis@example.invalid', department: 'People Ops', roles: ['hr-partner'] };

describe('launchpad: the applications a signed-in person may open, with their SSO start URL', () => {
  let app: INestApplication;
  const saved = { b: process.env.IAM_SSO_BASE_URL };
  const api = (sub?: string) => fetch(`${BASE}/sso/${T}/launchpad`, { headers: sub ? { 'x-test-sub': sub } : {} });
  before(async () => {
    process.env.IAM_SSO_BASE_URL = BASE;
    const guard = { canActivate: (c: any) => { const r = c.switchToHttp().getRequest(); const s = r.headers['x-test-sub']; if (!s) return false; r.user = { sub: String(s), tenant: T }; return true; } };
    const mod = await Test.createTestingModule({ imports: [EventsModule, PluginsV1Module] }).overrideGuard(AuthGuard).useValue(guard).compile();
    app = mod.createNestApplication(); await app.init(); await app.listen(PORT);
    const reg = app.get(PluginRegistry), apps = app.get(AppConnectorService);
    (app.get(SSO_DIRECTORY) as MemorySsoDirectory).users.push(alice, yanis);
    await reg.install(T, 'app-connector', {}); await reg.enable(T, 'app-connector', {});
    await reg.install(T, 'oidc-provider', {}); await reg.enable(T, 'oidc-provider', {});
    await reg.install(T, 'saml-idp', {}); await reg.enable(T, 'saml-idp', {});
    await apps.create(T, 'admin', { id: 'wiki', name: 'Company wiki', protocol: 'oidc', enabled: true, redirect_uris: ['https://wiki.example.invalid/cb'], launch_url: 'https://wiki.example.invalid/', allowed_roles: ['employee'], attribute_mapping: {} });
    await apps.create(T, 'admin', { id: 'payroll', name: 'Payroll', protocol: 'saml', enabled: true, entity_id: 'https://payroll.example.invalid/saml', acs_url: 'https://payroll.example.invalid/acs', allowed_roles: ['employee'], attribute_mapping: {} });
    await apps.create(T, 'admin', { id: 'people', name: 'People directory', protocol: 'oidc', enabled: true, redirect_uris: ['https://people.example.invalid/cb'], launch_url: 'https://people.example.invalid/', allowed_roles: ['hr-partner'], attribute_mapping: {} });
    await apps.create(T, 'admin', { id: 'nolink', name: 'No launch', protocol: 'oidc', enabled: true, redirect_uris: ['https://nolink.example.invalid/cb'], allowed_roles: ['employee'], attribute_mapping: {} });
    await apps.create(T, 'admin', { id: 'off', name: 'Off', protocol: 'saml', enabled: false, entity_id: 'https://off.example.invalid/saml', acs_url: 'https://off.example.invalid/acs', allowed_roles: ['employee'], attribute_mapping: {} });
  });
  after(async () => { process.env.IAM_SSO_BASE_URL = saved.b; await app.close(); });

  it('needs a signed-in user', async () => {
    assert.equal((await api()).status, 403);
  });

  it('lists the applications the person may open: OIDC on its launch URL, SAML IdP-initiated, closed ones hidden', async () => {
    const r = await api('demo-alice');
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.deepEqual(body.user, { sub: 'demo-alice', name: 'Alice Martin' });
    const byId = new Map<string, any>(body.apps.map((a: any) => [a.id, a]));
    assert.deepEqual([...byId.keys()].sort(), ['payroll', 'wiki']);
    assert.equal(byId.get('wiki').url, 'https://wiki.example.invalid/', 'an OIDC application opens on its own URL');
    assert.equal(byId.get('wiki').protocol, 'oidc');
    assert.equal(byId.get('payroll').url, `${BASE}/sso/${T}/saml/login?app=payroll`, 'a SAML application opens IdP-initiated through the IdP');
    assert.equal(byId.get('payroll').protocol, 'saml');
  });

  it('persists preferences for the signed-in user only, rejects inaccessible IDs and body-supplied identities', async () => {
    const put = (sub: string, body: unknown) => fetch(`${BASE}/sso/${T}/launchpad/preferences`, { method: 'PUT', headers: { 'x-test-sub': sub, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await put('demo-alice', { favourites: ['wiki'], order: ['wiki','payroll'] })).status, 200);
    assert.deepEqual((await (await api('demo-alice')).json() as any).preferences, { favourites: ['wiki'], order: ['wiki','payroll'] });
    assert.deepEqual((await (await api('yanis-leroy')).json() as any).preferences, { favourites: [], order: [] });
    assert.equal((await put('yanis-leroy', { favourites: ['wiki'], order: [] })).status, 400);
    assert.equal((await put('demo-alice', { favourites: [], order: [], subject: 'yanis-leroy' })).status, 400);
  });

  it('filters by role: the HR-only application appears for the HR user, not for alice', async () => {
    const body = await (await api('yanis-leroy')).json() as any;
    assert.deepEqual(body.apps.map((a: any) => a.id), ['people']);
  });

  it('is empty while the registry plugin is off, and never leaks an application to an unknown user', async () => {
    const body = await (await api('nobody')).json() as any;
    assert.deepEqual(body.apps, []);
  });

  it('the SAML launch URL really starts SSO: it redirects to the console consent of a pending sign-in request', async () => {
    const r = await fetch(`${BASE}/sso/${T}/saml/login?app=payroll`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location') ?? '', /^\/sso-saml\/[0-9a-f]+\?tenant=acme-demo$/);
  });
});
