import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { AuthnService } from './flow.service.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { parseSecurity } from '../accounts/security-config.js';
import { startTestBus, TestBus } from '../testing/test-bus.js';

let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const ADMIN = 'x'.repeat(20), T = 'acme-demo';
const appBody = (id: string) => ({ id, name: id, description: '', protocol: 'oidc', redirect_uris: ['https://x.example/cb'], allowed_roles: [], scopes: ['profile'] });

describe('application level: server-side rules on the real routes', () => {
  let app: INestApplication, svc: AuthnService; const env = { a: process.env.IAM_API_ADMIN_TOKEN, f: process.env.IAM_AUTHN_FILE };
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = ADMIN; process.env.IAM_AUTHN_FILE = join(mkdtempSync(join(tmpdir(), 'al-')), 'e.json');
    const mod = await Test.createTestingModule({ imports: [PluginsV1Module] }).overrideGuard(AuthGuard).useValue({ canActivate: (ctx: any) => { ctx.switchToHttp().getRequest().user = { sub: 'test-admin' }; return true; } }).compile();
    app = mod.createNestApplication(); await app.init(); svc = app.get(AuthnService);
    const reg = app.get(PluginRegistry); await reg.install(T, 'app-connector', {}); await reg.enable(T, 'app-connector', {});
  });
  after(async () => { process.env.IAM_API_ADMIN_TOKEN = env.a; process.env.IAM_AUTHN_FILE = env.f; await app.close(); });
  const http = () => request(app.getHttpServer()); const adm = { 'x-api-admin-token': ADMIN };
  const setLevel = (id: string, level: unknown) => http().put(`/tenants/${T}/security/app-level/${id}`).set(adm).send({ level });
  const apps = async () => parseSecurity((await svc.workingSecurity(T)) as any).appLevels;
  const putRaw = async (appLevels: object) => { const cur = await svc.workingSecurity(T); const reg: any = await (svc as any).registry('work', true); const { storedSecurity } = await import('../accounts/security-config.js'); await reg.putCoreSettings(T, 'security', storedSecurity({ ...cur, appLevels } as any)); };

  it('a level above 0 needs an existing application; the level then lives in the one security setting', async () => {
    await setLevel('ghost', 5).expect(404);
    await http().post(`/tenants/${T}/app-connectors`).set(adm).send(appBody('finance')).expect(201);
    await setLevel('finance', 5).expect(200);
    assert.deepEqual((await apps()).finance, { minLevel: 5 });
  });
  it('PUT security never changes application levels, even with an old copy in the body', async () => {
    const cur = await svc.workingSecurity(T);
    await http().put(`/tenants/${T}/security`).set(adm).send({ config: { lockout: { enabled: true, maxFailures: 5, windowSeconds: 600, lockSeconds: 600, hold: false, exempt: [] }, adminMinLevel: 0, adminMaxAgeSeconds: 0, holdAfterVerification: false, appLevels: { finance: { minLevel: 1 }, stale: { minLevel: 9 } } } }).expect(200);
    const l = await apps(); assert.equal(l.finance.minLevel, 5); assert.equal('stale' in l, false); void cur;
  });
  it('level 0 then 5 resumes the stored age limit; deleting the application removes the whole entry; a new application with the same id inherits nothing', async () => {
    await putRaw({ finance: { minLevel: 5, maxAgeSeconds: 300 } });
    await setLevel('finance', 0).expect(200); assert.deepEqual((await apps()).finance, { minLevel: 0, maxAgeSeconds: 300 });
    await setLevel('finance', 5).expect(200); assert.deepEqual((await apps()).finance, { minLevel: 5, maxAgeSeconds: 300 });
    await http().delete(`/tenants/${T}/app-connectors/finance`).set(adm).expect(200);
    assert.equal('finance' in (await apps()), false);
    await putRaw({ finance: { minLevel: 7, maxAgeSeconds: 120 } });   // a residue under the id (as if left by an older version)
    await http().post(`/tenants/${T}/app-connectors`).set(adm).send(appBody('finance')).expect(201);
    assert.equal('finance' in (await apps()), false, 'creation clears what was left under the id');
  });
  it('a refused duplicate creation does not wipe the existing application\'s level', async () => {
    await setLevel('finance', 6).expect(200);
    await http().post(`/tenants/${T}/app-connectors`).set(adm).send(appBody('finance')).expect((r) => assert.ok(r.status >= 400));
    assert.equal((await apps()).finance.minLevel, 6);
  });
  it('two concurrent writes on different applications both land', async () => {
    await http().post(`/tenants/${T}/app-connectors`).set(adm).send(appBody('wiki')).expect(201);
    await Promise.all([setLevel('finance', 3), setLevel('wiki', 4)]);
    const l = await apps(); assert.equal(l.finance.minLevel, 3); assert.equal(l.wiki.minLevel, 4);
  });
  it('bad levels are refused with nothing written', async () => {
    for (const lv of [11, -1, 2.5, '5']) await setLevel('wiki', lv).expect(400);
    assert.equal((await apps()).wiki.minLevel, 4);
  });
});
