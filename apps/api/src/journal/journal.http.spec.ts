import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { AuthGuard } from '../auth/auth.guard.js';

const ADMIN = 'x'.repeat(20);
describe('journal API (read only, behind the plugin)', () => {
  let app: INestApplication; const prev = process.env.IAM_API_ADMIN_TOKEN;
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = ADMIN;
    const m = await Test.createTestingModule({ imports: [PluginsV1Module] }).overrideGuard(AuthGuard).useValue({ canActivate: () => true }).compile();
    app = m.createNestApplication(); await app.init();
  });
  after(async () => { process.env.IAM_API_ADMIN_TOKEN = prev; await app.close(); });
  const s = () => request(app.getHttpServer()); const adm = { 'x-api-admin-token': ADMIN };

  it('refuses when the plugin is off or the caller is not admin', async () => {
    await s().get('/tenants/jt1/journal/entries').set(adm).expect(403);
    await s().get('/tenants/jt1/journal/entries').expect(403);
  });
  it('once enabled: empty journal states honestly, validates input, has no write route', async () => {
    await s().post('/tenants/jt2/plugins/hooks-journal/install').set(adm).send({}).expect(201);
    await s().post('/tenants/jt2/plugins/hooks-journal/enable').set(adm).send({}).expect(201);
    const r = await s().get('/tenants/jt2/journal/entries').set(adm).expect(200);
    assert.deepEqual(r.body.entries, []);
    await s().get('/tenants/jt2/journal/entries?from=not-a-date').set(adm).expect(400);
    await s().post('/tenants/jt2/journal/entries').set(adm).send({}).expect(404);
    await s().get('/tenants/jt2/journal/summary').set(adm).expect(200);
  });
});
