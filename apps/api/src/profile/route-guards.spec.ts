// A valid token is not an administrator. Every mutating route and the directory/decision reads that a freshly signed-up (ordinary) account could reach
// are refused without the admin capability, whatever the tenant in the URL, in and out of workspace mode. Real HTTP calls through Nest.
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AppModule } from '../app.module.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { startTestBus, TestBus } from '../testing/test-bus.js';

// Step 3 cleanup (decision 6): AppModule requires a reachable bus - one nats+core pair for this spec file.
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const ADMIN = 'x'.repeat(20);
describe('ordinary valid token: no administration route answers', () => {
  let app: INestApplication; const env = { a: process.env.IAM_API_ADMIN_TOKEN };
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = ADMIN;
    const guard = { canActivate: (c: any) => { c.switchToHttp().getRequest().user = { sub: 'new-nora', tenant: 'acme-demo' }; return true; } };
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideGuard(AuthGuard).useValue(guard).compile();
    app = mod.createNestApplication(); await app.init();
  });
  after(async () => { process.env.IAM_API_ADMIN_TOKEN = env.a; await app.close(); });
  const routes: [string, string][] = [
    ['post', 'changes'], ['post', 'connectors/csv'], ['post', 'connectors/scim'], ['post', 'changes/x/merge'], 
    ['post', 'activations'], ['post', 'activations/reconcile'], ['post', 'activation-workflows'],
    ['post', 'users'], ['put', 'users/demo-alice'], ['get', 'users'], ['put', 'profile-fields'], ['get', 'profile-fields'], ['patch', 'users/demo-alice/profile'],
    ['post', 'workspace/assignment'], ['post', 'workspace/unassignment'], ['post', 'workspace/assignments'], ['post', 'workspace/apply'], ['put', 'auth'], ['post', 'plugins/hr-attributes/enable'], ['post', 'organizations'], ['get', 'roles'], ['post', 'roles'], ['patch', 'roles/x'], ['delete', 'roles/x'], ['post', 'roles/sod-rules'], ['post', 'roles/sod-rules/remove'], ['get', 'signup/requests'], ['post', 'signup/requests/x/approve'],
  ];
  for (const tenant of ['acme-demo', 'other-tenant'])
    it(`refuses ${routes.length} routes for tenant ${tenant} without the admin capability`, async () => {
      for (const [m, p] of routes) {
        const r = await (request(app.getHttpServer()) as any)[m](`/tenants/${tenant}/${p}`).send({});
        assert.ok([403, 404].includes(r.status), `${m} ${p} -> ${r.status}`);
        assert.notEqual(r.status, 200); assert.notEqual(r.status, 201);
      }
    });
});

// Hosted edge model: the capability header is attached to every call. A signed-up ordinary subject must still be refused; only the listed demo admin passes.
describe('edge attaches the capability to everyone: the subject decides', () => {
  let app: INestApplication; let sub = 'new-nora'; const env = { a: process.env.IAM_API_ADMIN_TOKEN, s: process.env.IAM_API_ADMIN_SUBJECTS };
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = ADMIN; process.env.IAM_API_ADMIN_SUBJECTS = 'demo-alice';
    const guard = { canActivate: (c: any) => { c.switchToHttp().getRequest().user = { sub, tenant: 'acme-demo' }; return true; } };
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideGuard(AuthGuard).useValue(guard).compile();
    app = mod.createNestApplication(); await app.init();
  });
  after(async () => { process.env.IAM_API_ADMIN_TOKEN = env.a; if (env.s === undefined) delete process.env.IAM_API_ADMIN_SUBJECTS; else process.env.IAM_API_ADMIN_SUBJECTS = env.s; await app.close(); });
  const routes: [string, string][] = [['post', 'changes'], ['post', 'connectors/csv'], ['post', 'users'], ['get', 'users'], ['get', 'profile-fields'], ['put', 'profile-fields'], ['post', 'workspace/apply'], ['put', 'auth'], ['post', 'plugins/hr-attributes/enable'], ['post', 'organizations'], ['get', 'roles'], ['post', 'roles'], ['post', 'activations']];
  it('ordinary subject with the edge header is refused on admin routes', async () => {
    sub = 'new-nora';
    for (const [m, p] of routes) { const r = await (request(app.getHttpServer()) as any)[m](`/tenants/acme-demo/${p}`).set('x-api-admin-token', ADMIN).send({}); assert.equal(r.status, 403, `${m} ${p} -> ${r.status}`); }
  });
  it('the listed demo administrator is not refused by the guard', async () => {
    sub = 'demo-alice';
    const r = await request(app.getHttpServer()).get('/tenants/acme-demo/users').set('x-api-admin-token', ADMIN);
    assert.notEqual(r.status, 403);
  });
});
