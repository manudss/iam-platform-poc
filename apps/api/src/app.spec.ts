import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './app.module.js';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AuthGuard } from './auth/auth.guard.js';
import { startTestBus, TestBus } from './testing/test-bus.js';

// Step 3 cleanup (decision 6): AppModule requires a reachable bus - one nats+core pair for this spec file.
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

describe('api', () => {
  let app: INestApplication;
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = 'local-demo-simulation-token';
    const m = await Test.createTestingModule({ imports: [AppModule] })
      // Unit-level only: activation logic without auth. Auth is covered end-to-end in e2e.spec.ts.
      .overrideGuard(AuthGuard).useValue({ canActivate: () => true }).compile();
    app = m.createNestApplication();
    await app.init();
  });
  after(() => app.close());

  it('health', async () => {
    const r = await request(app.getHttpServer()).get('/health').expect(200);
    assert.equal(r.body.status, 'ok');
  });

  it('reactivating an older commit is a new activation', async () => {
    const post = (c: string) => request(app.getHttpServer()).post('/tenants/t1/activations').set('x-api-admin-token', 'local-demo-simulation-token').send({ commit: c });
    assert.equal((await post('aaaaaaaa')).body.seq, 1);
    assert.equal((await post('bbbbbbbb')).body.seq, 2);
    assert.equal((await post('aaaaaaaa')).body.seq, 3);
  });

  it('rejects an invalid commit', async () => {
    await request(app.getHttpServer()).post('/tenants/t1/activations').set('x-api-admin-token', 'local-demo-simulation-token').send({ commit: 'x' }).expect(400);
  });

});
