import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { AppEvents } from '../events/app-events.service.js';
import { AppConnectorService, MemoryAppConnectorStore, build, checkUrl, DEMO_APP_CONNECTORS } from './app-connector.js';

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
    for (const d of DEMO_APP_CONNECTORS) { assert.deepEqual(build(d.id, d as never), d); assert.ok(JSON.stringify(d).includes('example.invalid') || JSON.stringify(d).includes('localhost')); }
    assert.equal(DEMO_APP_CONNECTORS.length, 3);
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
    const events = new AppEvents(), seen: { type: string; payload: Record<string, string> }[] = []; events.on((e) => { seen.push(e); });
    const svc = new AppConnectorService({ pluginActive: async () => true } as never, new MemoryAppConnectorStore(), events);
    await svc.create(T, 'demo-alice', oidc);
    await assert.rejects(svc.create(T, 'demo-alice', oidc), /already exists/);
    await svc.update(T, 'demo-alice', 'wiki', { description: 'x' });
    await svc.remove(T, 'demo-alice', 'wiki');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen.map((e) => `${e.type}:${e.payload.app}:${e.payload.protocol}:${e.payload.actor}`), ['app.registered:wiki:oidc:demo-alice', 'app.updated:wiki:oidc:demo-alice', 'app.removed:wiki:oidc:demo-alice']);
  });
});
