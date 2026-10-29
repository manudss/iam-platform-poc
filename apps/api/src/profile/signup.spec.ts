import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { UsersService } from '../users/users.service.js';
import { AuthnService } from '../authn/flow.service.js';
import { SignupService } from './signup.service.js';
import { SIGNUP_ALLOWED } from './profile.service.js';

const ADMIN = 'x'.repeat(20), T = 'acme-demo';
const good = { id: 'new-nora', display_name: 'Nora Test', email: 'nora@example.invalid', password: 'a-fictional-password-1', values: { 'hr-attributes.job_title': 'Tester' } };

describe('public sign-up: closed by default, request only, never grants access', () => {
  let app: INestApplication; const saved: any[] = []; const env = { a: process.env.IAM_API_ADMIN_TOKEN };
  const usersStub = { list: async () => [{ id: 'demo-alice', email: 'alice@example.invalid' }], save: async (...a: any[]) => { saved.push(a); return { id: a[0] }; } };
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = ADMIN;
    const guard = { canActivate: (c: any) => { const r = c.switchToHttp().getRequest(); r.user = { sub: String(r.headers['x-test-sub'] ?? 'new-nora') }; return true; } };
    const mod = await Test.createTestingModule({ imports: [PluginsV1Module] }).overrideGuard(AuthGuard).useValue(guard).overrideProvider(UsersService).useValue(usersStub).overrideProvider(SIGNUP_ALLOWED).useValue(() => true).compile();
    app = mod.createNestApplication(); await app.init();
    const reg = app.get(PluginRegistry); await reg.install(T, 'hr-attributes', {}); await reg.enable(T, 'hr-attributes', {});
  });
  after(async () => { process.env.IAM_API_ADMIN_TOKEN = env.a; await app.close(); });
  const api = () => request(app.getHttpServer()), adm = { 'x-api-admin-token': ADMIN }, u = (p: string) => `/tenants/${T}/${p}`;
  const reset = () => (app.get(SignupService) as any).hits.clear();
  const su = (b: unknown) => { reset(); return api().post(u('signup')).send(b as object); };

  it('is closed by default: no form, no request accepted', async () => {
    assert.equal((await api().get(u('signup/schema'))).status, 404);
    assert.equal((await api().post(u('signup')).send(good)).status, 404);
  });
  it('only an administrator can open it, and a signed-in user cannot', async () => {
    const cfg = { config: { fields: { 'hr-attributes.job_title': { signup: 'required' } }, signup: { open: true } } };
    assert.equal((await api().put(u('profile-fields')).send(cfg)).status, 403);
    assert.equal((await api().put(u('profile-fields')).set(adm).send({ config: { fields: {}, signup: { open: 'yes' } } })).status, 400);
    assert.equal((await api().put(u('profile-fields')).set(adm).send(cfg)).status, 200);
    const s = await api().get(u('signup/schema')); assert.equal(s.status, 200);
    assert.ok(s.body.fields.some((f: any) => f.key === 'hr-attributes.job_title' && f.required)); assert.ok(!s.body.fields.some((f: any) => /grade|department|manager/.test(f.key)));
  });
  it('refuses anything that is not the plain form: roles, department, manager, authority fields, missing required fields', async () => {
    for (const extra of [{ roles: ['admin'] }, { role: 'payment-approver' }, { department: 'finance' }, { manager_id: 'demo-alice' }, { login_enabled: true }, { admin: true }, { subject: 'demo-alice' }]) assert.equal((await su({ ...good, ...extra })).status, 400, JSON.stringify(extra));
    assert.equal((await su({ ...good, values: { 'hr-attributes.employee_grade': 'G9', 'hr-attributes.job_title': 'x' } })).status, 400);
    assert.equal((await su({ ...good, values: { 'base.department': 'finance', 'hr-attributes.job_title': 'x' } })).status, 400);
    assert.equal((await su({ ...good, values: {} })).status, 400);
    assert.equal((await su({ ...good, password: 'short' })).status, 400);
    assert.equal((await api().get(u('signup/requests')).set(adm)).body.requests.length, 0);
  });
  it('answers neutrally: a taken id, a taken e-mail and a duplicate look like success and create nothing', async () => {
    const out = (app.get(AuthnService) as any).outbox; const n0 = out.list(T).length;
    const a = await su(good), b = await su(good);
    const c = await su({ ...good, id: 'demo-alice' }), d = await su({ ...good, id: 'other-id', email: 'ALICE@example.invalid' });
    assert.deepEqual([b.body, c.body, d.body], [a.body, a.body, a.body]);
    assert.equal(out.list(T).length, n0 + 1, 'exactly one confirmation message');
    const l = (await api().get(u('signup/requests')).set(adm)).body.requests; assert.equal(l.length, 1);
    assert.ok(!JSON.stringify(l).match(/password|hash|salt|token/i), 'no secret in the admin list');
  });
  it('the request list and the decisions need the administrator capability', async () => {
    assert.equal((await api().get(u('signup/requests'))).status, 403);
    assert.equal((await api().post(u('signup/requests/new-nora/approve'))).status, 403);
    assert.equal((await api().delete(u('signup/requests/new-nora'))).status, 403);
  });
  it('an unconfirmed request cannot be approved; a wrong code changes nothing; the right code does not create an account by itself', async () => {
    assert.equal((await api().post(u('signup/requests/new-nora/approve')).set(adm)).status, 409);
    await api().post(u('signup/confirm')).send({ token: 'wrong' });
    assert.equal((await api().get(u('signup/requests')).set(adm)).body.requests[0].confirmed, false);
    const msg = (app.get(AuthnService) as any).outbox.list(T)[0]; const token = /code: (\S+)/.exec(msg.text)![1];
    await api().post(u('signup/confirm')).send({ token });
    assert.equal((await api().get(u('signup/requests')).set(adm)).body.requests[0].confirmed, true);
    assert.equal(saved.length, 0, 'no account before approval');
  });
  it('approval creates a plain account: no role, department, manager, and the password is only a hash', async () => {
    const r = await api().post(u('signup/requests/new-nora/approve')).set(adm); assert.equal(r.status, 201);
    assert.equal(saved.length, 1); const [id, body, create, pre] = saved[0];
    assert.equal(id, 'new-nora'); assert.equal(create, true);
    assert.deepEqual(Object.keys(body).sort(), ['display_name', 'email', 'id', 'login_enabled']);
    assert.ok(pre.salt && pre.hash && !JSON.stringify(saved).includes(good.password));
    assert.equal((await api().get(u('signup/requests')).set(adm)).body.requests.length, 0);
    assert.equal((await api().post(u('signup/requests/new-nora/approve')).set(adm)).status, 404);
  });
  it('a freshly signed-up person with a valid token still cannot change configuration, other profiles, authority fields or open requests', async () => {
    const me = { 'x-test-sub': 'new-nora' };
    assert.equal((await api().put(u('profile-fields')).set(me).send({ config: { fields: {} } })).status, 403);
    assert.equal((await api().patch(u('users/demo-alice/profile')).set(me).send({ values: { 'hr-attributes.job_title': 'x' } })).status, 403);
    assert.equal((await api().patch(u('me/profile')).set(me).send({ values: { 'hr-attributes.employee_grade': 'G9' } })).status, 403);
    assert.equal((await api().get(u('signup/requests')).set(me)).status, 403);
  });
  it('rate limit: the sixth request in an hour from one address is refused; closing the switch closes the door again', async () => {
    reset(); let last = 0;
    for (let i = 0; i < 6; i++) last = (await api().post(u('signup')).send({ ...good, id: `rl-${i}`, email: `rl${i}@example.invalid` })).status;
    assert.equal(last, 429);
    await api().put(u('profile-fields')).set(adm).send({ config: { fields: {} } }); reset();
    assert.equal((await api().post(u('signup')).send({ ...good, id: 'late-one' })).status, 404);
  });
});

describe('sign-up outside the hosted workspace mode: refused by the API, whatever the setting', () => {
  let app: INestApplication; const env = { a: process.env.IAM_API_ADMIN_TOKEN };
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = ADMIN;
    const guard = { canActivate: (c: any) => { c.switchToHttp().getRequest().user = { sub: 'new-nora' }; return true; } };
    const mod = await Test.createTestingModule({ imports: [PluginsV1Module] }).overrideGuard(AuthGuard).useValue(guard).compile();
    app = mod.createNestApplication(); await app.init();
  });
  after(async () => { process.env.IAM_API_ADMIN_TOKEN = env.a; await app.close(); });
  it('opening is refused, the form and the endpoint stay closed', async () => {
    const api = () => request(app.getHttpServer());
    const r = await api().put(`/tenants/${T}/profile-fields`).set({ 'x-api-admin-token': ADMIN }).send({ config: { fields: {}, signup: { open: true } } });
    assert.equal(r.status, 400); assert.match(JSON.stringify(r.body), /workspace mode/);
    assert.equal((await api().get(`/tenants/${T}/signup/schema`)).status, 404);
    assert.equal((await api().post(`/tenants/${T}/signup`).send(good)).status, 404);
  });
});
