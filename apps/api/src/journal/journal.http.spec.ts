import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { AuthGuard } from '../auth/auth.guard.js';

const ADMIN = 'x'.repeat(20); const GATE = 'gate-token-1234';
describe('journal API (read only, behind the plugin)', () => {
  let app: INestApplication; const prev = process.env.IAM_API_ADMIN_TOKEN;
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = ADMIN; process.env.IAM_AUTH_GATE_TOKEN = GATE;
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
  const hook = (t: string, who: string) => s().post('/internal/auth/authenticate').set('x-gate-token', GATE).send({ tenant: t, subject: who, password: 'S3cretPW!xyz' });
  it('records only while enabled: A recorded, B (made while disabled) absent after re-enable; recordingSince = first recorded call; no secret stored', async () => {
    const T = 'jt3'; const list = async () => (await s().get(`/tenants/${T}/journal/entries`).set(adm).expect(200)).body;
    await s().post(`/tenants/${T}/plugins/hooks-journal/install`).set(adm).send({}).expect(201);
    await s().post(`/tenants/${T}/plugins/hooks-journal/enable`).set(adm).send({}).expect(201);
    const empty = await list(); assert.equal(empty.entries.length, 0); assert.equal(empty.recordingSince, null);
    await hook(T, 'user-A');
    const a = await list(); assert.equal(a.entries.length, 1); assert.equal(a.recordingSince, a.entries[0].at);
    assert.deepEqual(a.entries[0].candidates, ['auth-password']); assert.deepEqual(a.entries[0].answered, ['auth-password']);
    assert.ok(!JSON.stringify(a).includes('S3cretPW'));
    await s().post(`/tenants/${T}/plugins/hooks-journal/disable`).set(adm).send({}).expect(201);
    await hook(T, 'user-B');
    await s().post(`/tenants/${T}/plugins/hooks-journal/enable`).set(adm).send({}).expect(201);
    const after = await list(); const subjects = after.entries.map((e: any) => e.payload.subject);
    assert.deepEqual(subjects, ['user-A'], 'the call made while disabled must not be in the journal');
    await hook(T, 'user-C');
    assert.deepEqual((await list()).entries.map((e: any) => e.payload.subject).sort(), ['user-A', 'user-C']);
  });
});
