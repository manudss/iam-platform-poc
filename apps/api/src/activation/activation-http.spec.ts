import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';
import { INestApplication, UnauthorizedException } from '@nestjs/common';
import request from 'supertest';
import { ActivationController } from './activation.controller.js';
import { ActivationReadService } from './activation-read.service.js';
import { ActivationService } from './activation.service.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { DoltService } from '../dolt/dolt.service.js';
import { SecretsService } from '../integrations/secrets.service.js';

// Isolated HTTP boundary. Auth verification itself is covered by auth suites; this fixture injects a verified principal.
describe('activation audit HTTP boundaries', () => {
  let app: INestApplication;
  const prior = { ...process.env };
  const TOKEN = 'fictional-admin-capability-123';
  before(async () => {
    delete process.env.IAM_PG_URL; delete process.env.IAM_CORE_URL; delete process.env.IAM_SCREEN_ACCESS; delete process.env.IAM_WORKSPACE_MODE;
    process.env.IAM_API_ADMIN_TOKEN = TOKEN; process.env.IAM_API_ADMIN_SUBJECTS = 'alice';
    const dolt = { head: async () => 'aaaaaaaa' } as DoltService;
    const journal = new ActivationService({ get: async () => undefined } as unknown as SecretsService, dolt);
    const module = await Test.createTestingModule({ controllers: [ActivationController], providers: [
      { provide: ActivationService, useValue: journal }, { provide: DoltService, useValue: dolt },
      { provide: ActivationReadService, useValue: { status: async () => ({ status: 'disabled', core: null }) } }
    ] }).overrideGuard(AuthGuard).useValue({ canActivate(ctx: any) {
      const req = ctx.switchToHttp().getRequest(); const sub = req.headers['x-fixture-principal'];
      if (!sub) throw new UnauthorizedException(); req.user = { sub }; return true;
    } }).compile();
    app = module.createNestApplication(); await app.init();
  });
  after(async () => {
    await app?.close();
    for (const key of ['IAM_PG_URL','IAM_CORE_URL','IAM_SCREEN_ACCESS','IAM_WORKSPACE_MODE','IAM_API_ADMIN_TOKEN','IAM_API_ADMIN_SUBJECTS']) {
      if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
    }
  });
  const path = '/tenants/fixture/activations';
  it('requires authentication and admin capability for new detailed reads', async () => {
    for (const suffix of ['/journal','/status']) {
      await request(app.getHttpServer()).get(path+suffix).expect(401);
      await request(app.getHttpServer()).get(path+suffix).set('x-fixture-principal','alice').expect(403);
      await request(app.getHttpServer()).get(path+suffix).set('x-fixture-principal','bob').set('x-api-admin-token',TOKEN).expect(403);
      await request(app.getHttpServer()).get(path+suffix).set('x-fixture-principal','alice').set('x-api-admin-token',TOKEN).expect(200);
    }
  });
  it('ignores forged actor/date in the body and preserves only server attribution', async () => {
    const out = await request(app.getHttpServer()).post(path).set('x-fixture-principal','alice').set('x-api-admin-token',TOKEN)
      .send({ commit:'aaaaaaaa', requestId:'audit-http-0001', actor:{kind:'user',id:'mallory'}, recordedAt:'1990-01-01' }).expect(201);
    assert.deepEqual(out.body.actor,{kind:'user',id:'alice'}); assert.notEqual(out.body.recordedAt,'1990-01-01');
    const detailed = await request(app.getHttpServer()).get(path+'/journal').set('x-fixture-principal','alice').set('x-api-admin-token',TOKEN).expect(200);
    assert.equal(detailed.body[0].actor.id,'alice');
    const legacy = await request(app.getHttpServer()).get(path).set('x-fixture-principal','bob').expect(200);
    assert.deepEqual(legacy.body,[{seq:1,commit:'aaaaaaaa'}]);
  });
});
