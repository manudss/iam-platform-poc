import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { PluginRegistry } from '../plugins/v1/registry.js';

const ADMIN = 'x'.repeat(20), T = 'acme-demo';
describe('organizations plugin: CRUD and assignments by an administrator, read-only on the profile', () => {
  let app: INestApplication, reg: PluginRegistry; const env = { a: process.env.IAM_API_ADMIN_TOKEN };
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = ADMIN;
    const guard = { canActivate: (c: any) => { const r = c.switchToHttp().getRequest(); r.user = { sub: String(r.headers['x-test-sub'] ?? 'demo-alice') }; return true; } };
    const mod = await Test.createTestingModule({ imports: [PluginsV1Module] }).overrideGuard(AuthGuard).useValue(guard).compile();
    app = mod.createNestApplication(); await app.init(); reg = app.get(PluginRegistry);
  });
  after(async () => { process.env.IAM_API_ADMIN_TOKEN = env.a; await app.close(); });
  const api = () => request(app.getHttpServer()), adm = { 'x-api-admin-token': ADMIN }, u = (p: string) => `/tenants/${T}/${p}`;

  it('does not exist while the plugin is off, and needs the administrator capability', async () => {
    assert.equal((await api().get(u('organizations')).set(adm)).status, 404);
    await reg.install(T, 'organizations', {}); await reg.enable(T, 'organizations', {});
    assert.equal((await api().get(u('organizations'))).status, 403);
    assert.equal((await api().post(u('organizations')).send({ id: 'x', name: 'X' })).status, 403);
    assert.equal((await api().get(u('organizations')).set(adm)).status, 200);
  });
  it('creates, renames, nests and deletes with the rules (ids, parents, cycles, children, members)', async () => {
    const mk = (b: object) => api().post(u('organizations')).set(adm).send(b);
    assert.equal((await mk({ id: 'acme', name: 'Acme' })).status, 201);
    assert.equal((await mk({ id: 'acme', name: 'Again' })).status, 409);
    assert.equal((await mk({ id: 'Bad Id', name: 'x' })).status, 400);
    assert.equal((await mk({ id: 'fin', name: 'Finance', parent_id: 'nope' })).status, 400);
    assert.equal((await mk({ id: 'fin', name: 'Finance', parent_id: 'acme' })).status, 201);
    assert.equal((await api().patch(u('organizations/acme')).set(adm).send({ parent_id: 'fin' })).status, 400, 'cycle');
    assert.equal((await api().patch(u('organizations/fin')).set(adm).send({ name: 'Finance team' })).status, 200);
    assert.equal((await api().delete(u('organizations/acme')).set(adm)).status, 409, 'has children');
  });
  it('assigns people to organizations; the person sees them read-only and cannot change them', async () => {
    const r = await api().put(u('organizations/memberships/demo-alice')).set(adm).send({ orgIds: ['fin'] }); assert.equal(r.status, 200);
    assert.equal((await api().put(u('organizations/memberships/demo-alice')).send({ orgIds: ['acme'] })).status, 403, 'no admin capability');
    assert.equal((await api().put(u('organizations/memberships/demo-alice')).set(adm).send({ orgIds: ['ghost'] })).status, 400);
    const me = await api().get(u('me/profile')).set({ 'x-test-sub': 'demo-alice' }); assert.equal(me.status, 200);
    assert.deepEqual(me.body.sections.organizations, [{ id: 'fin', name: 'Finance team' }]); assert.equal(me.body.sections.readOnly, true);
    for (const body of [{ values: { organizations: ['acme'] } }, { values: { 'organizations.member': 'acme' } }, { organizations: ['acme'] }, { values: { roles: ['admin'] } }])
      assert.ok([400, 403].includes((await api().patch(u('me/profile')).set({ 'x-test-sub': 'demo-alice' }).send(body)).status), JSON.stringify(body));
    const again = await api().get(u('me/profile')).set({ 'x-test-sub': 'demo-alice' }); assert.deepEqual(again.body.sections.organizations, [{ id: 'fin', name: 'Finance team' }]);
    assert.equal((await api().get(u('me/profile')).set({ 'x-test-sub': 'demo-bob' })).body.sections.organizations.length, 0);
  });
  it('an organization with members cannot be deleted; a free one can; disabling the plugin hides the section', async () => {
    assert.equal((await api().delete(u('organizations/fin')).set(adm)).status, 409);
    await api().put(u('organizations/memberships/demo-alice')).set(adm).send({ orgIds: [] });
    assert.equal((await api().delete(u('organizations/fin')).set(adm)).status, 200);
    await reg.disable(T, 'organizations');
    const me = await api().get(u('me/profile')).set({ 'x-test-sub': 'demo-alice' }); assert.equal(me.body.sections.organizations, undefined);
  });
});
