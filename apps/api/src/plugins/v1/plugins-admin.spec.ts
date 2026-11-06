import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PluginsV1Module } from './plugins-v1.module.js';
import { AuthGuard } from '../../auth/auth.guard.js';
import { startTestBus, TestBus } from '../../testing/test-bus.js';

// Step 3 cleanup (decision 6): PluginsV1Module requires a reachable bus - one nats+core pair for this spec file.
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const ADMIN = 'x'.repeat(20);
describe('plugin admin API', () => {
  let app: INestApplication; const prev = process.env.IAM_API_ADMIN_TOKEN;
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = ADMIN;
    const m = await Test.createTestingModule({ imports: [PluginsV1Module] }).overrideGuard(AuthGuard).useValue({ canActivate: () => true }).compile();
    app = m.createNestApplication(); await app.init();
  });
  after(async () => { process.env.IAM_API_ADMIN_TOKEN = prev; await app.close(); });
  const s = () => request(app.getHttpServer());
  const adm = { 'x-api-admin-token': ADMIN };

  it('lists base plugins as always on, replacements as off', async () => {
    const r = await s().get('/tenants/t1/plugins').expect(200);
    const by = Object.fromEntries(r.body.plugins.map((p: any) => [p.id, p]));
    assert.equal(by['auth-password'].enabled, true); assert.equal(by['auth-password'].base, true);
    assert.equal(by['auth-password-lockout'].enabled, false);
  });
  it('changes need the admin capability', async () => {
    await s().post('/tenants/t1/plugins/org-manager/install').send({ grants: { install: true } }).expect(403);
    await s().put('/tenants/t1/plugins/org-manager/settings').send({ values: {} }).expect(403);
  });
  it('install -> configure via form -> enable; settings are validated server side', async () => {
    await s().post('/tenants/t2/plugins/org-manager/install').set(adm).send({}).expect(403); // no install grant
    await s().post('/tenants/t2/plugins/org-manager/install').set(adm).send({ grants: { install: true } }).expect(201);
    await s().put('/tenants/t2/plugins/org-manager/settings').set(adm).send({ values: { maxDepth: 500 } }).expect(400);
    await s().put('/tenants/t2/plugins/org-manager/settings').set(adm).send({ values: { maxDepth: 4 } }).expect(200);
    const f = await s().get('/tenants/t2/plugins/org-manager/form').expect(200);
    assert.equal(f.body.groups[0].fields[0].value, 4);
    await s().post('/tenants/t2/plugins/org-manager/enable').set(adm).send({}).expect(201);
    const sc = await s().get('/tenants/t2/plugins/screens').expect(200);
    assert.equal(sc.body.screens.length, 2);
    // tenant isolation: t3 sees nothing enabled
    assert.equal((await s().get('/tenants/t3/plugins/screens')).body.screens.length, 0);
  });
  it('sensitive hooks are refused until granted; base plugin cannot be disabled; unknown is 404', async () => {
    await s().post('/tenants/t4/plugins/auth-password-lockout/install').set(adm).send({ grants: { install: true } }).expect(201);
    await s().put('/tenants/t4/plugins/auth-password-lockout/settings').set(adm).send({ values: {} }).expect(200);
    await s().post('/tenants/t4/plugins/auth-password-lockout/enable').set(adm).send({}).expect(403);
    await s().post('/tenants/t4/plugins/auth-password-lockout/enable').set(adm).send({ grants: { hooks: ['auth.authenticate'] } }).expect(201);
    await s().post('/tenants/t4/plugins/auth-password-lockout/disable').set(adm).expect(201);
    await s().post('/tenants/t4/plugins/auth-password/disable').set(adm).expect(409);
    await s().get('/tenants/t4/plugins/nope/form').expect(404);
  });
});
