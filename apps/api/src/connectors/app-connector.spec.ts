import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { ApplicationBus } from '../events/application-bus.service.js';
import { AppConnectorService, MemoryAppConnectorStore, build, checkUrl, parseSpMetadata, DEMO_APP_CONNECTORS } from './app-connector.js';
import { startTestBus, TestBus } from '../testing/test-bus.js';

// Step 3 cleanup (decision 6): PluginsV1Module requires a reachable bus - one nats+core pair for this spec file.
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const ADMIN = 'x'.repeat(20), T = 'acme-demo';
const oidc = { id: 'wiki', name: 'Wiki', protocol: 'oidc', redirect_uris: ['https://wiki.example.invalid/cb'] };
const saml = { id: 'pay', name: 'Payroll', protocol: 'saml', entity_id: 'https://pay.example.invalid/meta', acs_url: 'https://pay.example.invalid/acs' };

describe('app-connector validation', () => {
  it('accepts https and localhost http only, no wildcard, fragment or credentials', () => {
    assert.equal(checkUrl('https://a.example.invalid/cb', 'u'), 'https://a.example.invalid/cb');
    assert.equal(checkUrl('http://localhost:4300/cb', 'u'), 'http://localhost:4300/cb');
    for (const bad of ['http://a.example.invalid/cb', 'https://*.example.invalid/cb', 'https://a.example.invalid/cb#x', 'https://u:p@a.example.invalid/cb', 'javascript:alert(1)', 'not a url', 'ftp://a.example.invalid'])
      assert.throws(() => checkUrl(bad, 'u'), /./, bad);
  });
  it('requires the fields of each protocol and drops those of the other', () => {
    assert.throws(() => build('a', { name: 'A', protocol: 'oidc' }), /redirect_uris/);
    assert.throws(() => build('a', { name: 'A', protocol: 'saml', entity_id: 'x' }), /acs_url/);
    const a = build('a', { ...oidc, entity_id: 'ignored', acs_url: 'https://a.example.invalid/acs' }); assert.equal(a.entity_id, null); assert.equal(a.acs_url, null);
    const s = build('p', { ...saml, redirect_uris: ['https://a.example.invalid/cb'] }); assert.deepEqual(s.redirect_uris, []);
    assert.equal(a.enabled, false, 'new applications start disabled'); assert.deepEqual(a.allowed_roles, [], 'closed by default');
  });
  it('refuses secrets in the body and malformed references', () => {
    for (const k of ['secret', 'client_secret', 'private_key', 'password', 'token']) assert.throws(() => build('a', { ...oidc, [k]: 'x' }), /secret store/, k);
    assert.throws(() => build('a', { ...oidc, secret_ref: 'Has Spaces' }), /secret_ref/);
    assert.equal(build('a', { ...oidc, secret_ref: 'apps/wiki/client-secret' }).secret_ref, 'apps/wiki/client-secret');
  });
  it('the demo seed is valid and fictional', () => {
    for (const d of DEMO_APP_CONNECTORS) { assert.deepEqual(build(d.id, d as never), d); assert.ok(JSON.stringify(d).includes('example.invalid') || JSON.stringify(d).includes('localhost') || JSON.stringify(d).includes('apps.dss.name')); } // apps.dss.name: the owner's demo gallery domain, no real company
    assert.equal(DEMO_APP_CONNECTORS.length, 13);
    // SAML options: certificate PEM checked, signed requests need the certificate, NameID format enumerated, OIDC clears SAML-only fields
    const pem = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----';
    assert.equal(build('x', { name: 'x', protocol: 'saml', entity_id: 'e', acs_url: 'https://x.example.invalid/acs', sp_certificate: pem, want_signed_requests: true, nameid_format: 'persistent' }).sp_certificate, pem);
    assert.throws(() => build('x', { name: 'x', protocol: 'saml', entity_id: 'e', acs_url: 'https://x.example.invalid/acs', want_signed_requests: true }), /certificate is required/);
    assert.throws(() => build('x', { name: 'x', protocol: 'saml', entity_id: 'e', acs_url: 'https://x.example.invalid/acs', sp_certificate: 'not a pem' }), /PEM/);
    assert.throws(() => build('x', { name: 'x', protocol: 'saml', entity_id: 'e', acs_url: 'https://x.example.invalid/acs', nameid_format: 'transient' }), /nameid_format/);
    // OIDC options: known scopes only, openid is implied, offline_access needs refresh tokens, SAML clears them
    assert.deepEqual(build('x', { name: 'x', protocol: 'oidc', redirect_uris: ['https://x.example.invalid/cb'], scopes: ['profile', 'offline_access'], allow_refresh_tokens: true }).scopes, ['profile', 'offline_access']);
    assert.throws(() => build('x', { name: 'x', protocol: 'oidc', redirect_uris: ['https://x.example.invalid/cb'], scopes: ['openid'] }), /always granted/);
    assert.throws(() => build('x', { name: 'x', protocol: 'oidc', redirect_uris: ['https://x.example.invalid/cb'], scopes: ['admin'] }), /unknown scope/);
    assert.throws(() => build('x', { name: 'x', protocol: 'oidc', redirect_uris: ['https://x.example.invalid/cb'], scopes: ['offline_access'], allow_refresh_tokens: false }), /needs allow_refresh_tokens/);
    const samlCleared = build('x', { name: 'x', protocol: 'saml', entity_id: 'e', acs_url: 'https://x.example.invalid/acs', scopes: ['profile'], allow_refresh_tokens: true });
    assert.deepEqual([samlCleared.scopes, samlCleared.allow_refresh_tokens], [[], false]);
    // an OIDC application without the new fields keeps the compatible defaults
    const dflt = build('x', { name: 'x', protocol: 'oidc', redirect_uris: ['https://x.example.invalid/cb'] });
    assert.deepEqual([dflt.scopes, dflt.allow_refresh_tokens], [['profile', 'email', 'roles'], true]);
    const oidcCleared = build('x', { name: 'x', protocol: 'oidc', redirect_uris: ['https://x.example.invalid/cb'], sp_certificate: pem, want_signed_requests: true, nameid_format: 'persistent' });
    assert.deepEqual([oidcCleared.sp_certificate, oidcCleared.want_signed_requests, oidcCleared.nameid_format], [null, false, null]);
  });
});

describe('app-connector plugin: registry of applications on the admin API', () => {
  let app: INestApplication, reg: PluginRegistry; const env = { a: process.env.IAM_API_ADMIN_TOKEN };
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = ADMIN;
    const guard = { canActivate: (c: any) => { const r = c.switchToHttp().getRequest(); r.user = { sub: String(r.headers['x-test-sub'] ?? 'demo-alice') }; return true; } };
    const mod = await Test.createTestingModule({ imports: [PluginsV1Module] }).overrideGuard(AuthGuard).useValue(guard).compile();
    app = mod.createNestApplication(); await app.init(); reg = app.get(PluginRegistry);
  });
  after(async () => { process.env.IAM_API_ADMIN_TOKEN = env.a; await app.close(); });
  const api = () => request(app.getHttpServer()), adm = { 'x-api-admin-token': ADMIN }, u = (p: string) => `/tenants/${T}/${p}`;
  const tick = () => new Promise((r) => setTimeout(r, 20));

  it('does not exist while the plugin is off, and needs the administrator capability', async () => {
    assert.equal((await api().get(u('app-connectors')).set(adm)).status, 404);
    await reg.install(T, 'app-connector', {}); await reg.enable(T, 'app-connector', {});
    assert.equal((await api().get(u('app-connectors'))).status, 403);
    assert.equal((await api().post(u('app-connectors')).send(oidc)).status, 403);
    assert.equal((await api().get(u('app-connectors')).set(adm)).status, 200);
  });
  it('registers OIDC and SAML applications with the rules, then reads them back', async () => {
    const mk = (b: object) => api().post(u('app-connectors')).set(adm).send(b);
    assert.equal((await mk(oidc)).status, 201);
    assert.equal((await mk(oidc)).status, 409);
    assert.equal((await mk({ ...oidc, id: 'Bad Id' })).status, 400);
    assert.equal((await mk({ ...oidc, id: 'x1', redirect_uris: ['http://evil.example.invalid/cb'] })).status, 400);
    assert.equal((await mk({ ...oidc, id: 'x2', client_secret: 'nope' })).status, 400);
    assert.equal((await mk(saml)).status, 201);
    const list = await api().get(u('app-connectors')).set(adm); assert.deepEqual(list.body.apps.map((a: { id: string }) => a.id), ['pay', 'wiki']);
    assert.equal((await api().get(u('app-connectors/pay')).set(adm)).body.protocol, 'saml');
    assert.equal((await api().get(u('app-connectors/ghost')).set(adm)).status, 404);
  });
  it('updates, enables, and refuses to delete an enabled application', async () => {
    const r = await api().patch(u('app-connectors/wiki')).set(adm).send({ enabled: true, allowed_roles: ['employee'], attribute_mapping: { sub: 'id', email: 'email' } });
    assert.equal(r.status, 200); assert.equal(r.body.enabled, true); assert.deepEqual(r.body.allowed_roles, ['employee']);
    assert.equal((await api().patch(u('app-connectors/wiki')).set(adm).send({ allowed_roles: ['Bad Role'] })).status, 400);
    assert.equal((await api().patch(u('app-connectors/wiki')).set(adm).send({ protocol: 'saml' })).status, 400, 'saml needs entity_id and acs_url');
    assert.equal((await api().patch(u('app-connectors/wiki')).set(adm).send({ attribute_mapping: { 'bad key!': 'id' } })).status, 400);
    assert.equal((await api().delete(u('app-connectors/wiki')).set(adm)).status, 409);
    await api().patch(u('app-connectors/wiki')).set(adm).send({ enabled: false });
    assert.equal((await api().delete(u('app-connectors/wiki')).set(adm)).status, 200);
    assert.equal((await api().delete(u('app-connectors/wiki')).set(adm)).status, 404);
  });
  it('disabling the plugin hides the registry again', async () => {
    await reg.disable(T, 'app-connector');
    assert.equal((await api().get(u('app-connectors')).set(adm)).status, 404);
  });
});

describe('app-connector events', () => {
  it('emits app.registered, app.updated and app.removed only after a successful write', async () => {
    const events = new ApplicationBus(), seen: { type: string; payload: Record<string, string> }[] = []; events.attachBus((e) => { seen.push(e); }, () => {});
    const svc = new AppConnectorService({ pluginActive: async () => true } as never, new MemoryAppConnectorStore(), { resolve: () => ({ manifest: { id: 'app-connector' } }) } as never, undefined, events);
    await svc.create(T, 'demo-alice', oidc);
    await assert.rejects(svc.create(T, 'demo-alice', oidc), /already exists/);
    await svc.update(T, 'demo-alice', 'wiki', { description: 'x' });
    await svc.remove(T, 'demo-alice', 'wiki');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen.map((e) => `${e.type}:${e.payload.app}:${e.payload.protocol}:${e.payload.actor}`), ['app.registered:wiki:oidc:demo-alice', 'app.updated:wiki:oidc:demo-alice', 'app.removed:wiki:oidc:demo-alice']);
  });
});

describe('parseSpMetadata: SP metadata import for the admin form', () => {
  it('reads entity id, POST ACS and the signing certificate (PEM-wrapped)', () => {
    const xml = '<md:EntityDescriptor entityID="https://sp.example.invalid/saml"><md:SPSSODescriptor><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>  MIIB\n  CERT </ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://sp.example.invalid/acs" index="0"/></md:SPSSODescriptor></md:EntityDescriptor>';
    assert.deepEqual(parseSpMetadata(xml), { entity_id: 'https://sp.example.invalid/saml', acs_url: 'https://sp.example.invalid/acs', sp_certificate: '-----BEGIN CERTIFICATE-----\nMIIBCERT\n-----END CERTIFICATE-----' });
  });
  it('refuses a document without entity id or ACS, and a non-SAML document', () => {
    assert.throws(() => parseSpMetadata('<EntityDescriptor >'), /missing/);
    assert.throws(() => parseSpMetadata('hello'), /EntityDescriptor/);
  });
});
