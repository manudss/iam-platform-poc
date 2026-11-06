import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { AuditService } from '../access/audit.service.js';
import { checkSimulationRequest, CorePolicySource, POLICY_SOURCE, PolicyStudioController, PolicyStudioService, usageByRule, type CoreCatalog, type SimulationResult } from './policy-studio.js';

const ADMIN = 'x'.repeat(20), T = 'acme-demo';
const rule = (id: string, effect: 'permit' | 'forbid', pillar: string) => ({ id, set: 'default', name: id, kind: 'policy' as const, effect, description: `${id} description`, pillar, summary: 'Permits any principal to do any action on any resource.', conditions: 0, annotations: { id }, text: `${effect}(principal, action, resource);` });
const CATALOG: CoreCatalog = { engine: { rules: 2, sets: 1, schema: true }, sets: [{ name: 'default', rules: 2 }], rules: [rule('sod-blocks-approve', 'forbid', 'sod'), rule('approve-needs-payment-approver', 'permit', 'human')] };

describe('usageByRule', () => {
  it('counts the decisions whose reasons name a rule, once per decision, ignoring other reasons', () => {
    const u = usageByRule([
      { reasons: ['sod-blocks-approve'], allow: false, at: '2026-11-05T10:00:00Z' },
      { reasons: ['approve-needs-payment-approver', 'approve-needs-payment-approver'], allow: true, at: '2026-11-05T11:00:00Z' },
      { reasons: ['sod-blocks-approve'], allow: false, at: '2026-11-05T12:00:00Z' },
      { reasons: ['no-active-version', 'core-unreachable'], allow: false },
    ], new Set(['sod-blocks-approve', 'approve-needs-payment-approver', 'unused']));
    assert.deepEqual(u, { 'sod-blocks-approve': { allow: 0, deny: 2, last_at: '2026-11-05T12:00:00Z' }, 'approve-needs-payment-approver': { allow: 1, deny: 0, last_at: '2026-11-05T11:00:00Z' } });
  });
});

describe('policy-studio API', () => {
  let app: INestApplication, reg: PluginRegistry, audit: AuditService; const env = { a: process.env.IAM_API_ADMIN_TOKEN, p: process.env.IAM_PG_URL };
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = ADMIN; delete process.env.IAM_PG_URL;
    const guard = { canActivate: (c: any) => { c.switchToHttp().getRequest().user = { sub: 'demo-alice' }; return true; } };
    audit = new AuditService();
    const mod = await Test.createTestingModule({ imports: [PluginsV1Module], controllers: [PolicyStudioController], providers: [PolicyStudioService, { provide: AuditService, useValue: audit }, { provide: POLICY_SOURCE, useValue: { catalog: async () => CATALOG, simulate: async () => SIM } }] })
      .overrideGuard(AuthGuard).useValue(guard).compile();
    app = mod.createNestApplication(); await app.init(); reg = app.get(PluginRegistry);
  });
  after(async () => { process.env.IAM_API_ADMIN_TOKEN = env.a; if (env.p) process.env.IAM_PG_URL = env.p; await app.close(); });
  const api = () => request(app.getHttpServer()), adm = { 'x-api-admin-token': ADMIN };

  it('does not exist while the plugin is off, and needs the administrator capability', async () => {
    assert.equal((await api().get(`/tenants/${T}/policies`).set(adm)).status, 404);
    await reg.install(T, 'policy-studio', {}); await reg.enable(T, 'policy-studio', {});
    assert.equal((await api().get(`/tenants/${T}/policies`)).status, 403);
    assert.equal((await api().get(`/tenants/${T}/policies`).set(adm)).status, 200);
  });
  it('lists the rules of the core with how often the audit named each one, for this tenant only', async () => {
    const base = { tenant: T, subject: 's', principal: 'User::"a"', action: 'Action::"approve"', resource: 'R::"1"', activation_seq: 1, commit: 'c', source: 'http' as const };
    await audit.record({ ...base, allow: false, reasons: ['sod-blocks-approve'] });
    await audit.record({ ...base, allow: true, reasons: ['approve-needs-payment-approver'] });
    await audit.record({ ...base, tenant: 'other', allow: false, reasons: ['sod-blocks-approve'] });
    const r = await api().get(`/tenants/${T}/policies`).set(adm);
    assert.deepEqual(r.body.rules.map((x: { id: string }) => x.id), ['sod-blocks-approve', 'approve-needs-payment-approver']);
    assert.equal(r.body.usage['sod-blocks-approve'].deny, 1);
    assert.equal(r.body.usage['approve-needs-payment-approver'].allow, 1);
    assert.equal(r.body.usage_window.decisions, 2);
    assert.equal(r.body.engine.rules, 2);
    assert.equal(r.body.engine.schema, true); // the schema-validation flag of the core is relayed as is
  });
  it('disabling the plugin hides the catalogue again', async () => {
    await reg.disable(T, 'policy-studio');
    assert.equal((await api().get(`/tenants/${T}/policies`).set(adm)).status, 404);
  });
});

const SIM: SimulationResult = { allow: false, reasons: ['sod-blocks-approve'], errors: [], matched_permits: [], matched_forbids: ['sod-blocks-approve'], errored_rules: [], templates: [], explanation: 'DENIED: the forbid sod-blocks-approve applies.' };

describe('checkSimulationRequest', () => {
  it('accepts a full request and trims the entity ids', () => {
    assert.deepEqual(checkSimulationRequest({ principal: ' User::"a" ', action: 'Action::"read"', resource: 'R::"1"', context: { roles: ['x'] } }),
      { principal: 'User::"a"', action: 'Action::"read"', resource: 'R::"1"', context: { roles: ['x'] }, entities: undefined });
  });
  it('refuses missing fields and a non-object context', () => {
    assert.throws(() => checkSimulationRequest({}), /principal, action and resource/);
    assert.throws(() => checkSimulationRequest({ principal: 'User::"a"', action: '', resource: 'R::"1"' }), /principal, action and resource/);
    assert.throws(() => checkSimulationRequest({ principal: 'User::"a"', action: 'Action::"read"', resource: 'R::"1"', context: 'roles' }), /context must be a JSON object/);
    assert.throws(() => checkSimulationRequest({ principal: 'User::"a"', action: 'Action::"read"', resource: 'R::"1"', entities: {} }), /entities must be a JSON array/);
  });
});

describe('policy-studio simulator API', () => {
  let app: INestApplication, reg: PluginRegistry; const env = { a: process.env.IAM_API_ADMIN_TOKEN, p: process.env.IAM_PG_URL };
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = ADMIN; delete process.env.IAM_PG_URL;
    const guard = { canActivate: (c: any) => { c.switchToHttp().getRequest().user = { sub: 'demo-alice' }; return true; } };
    const mod = await Test.createTestingModule({ imports: [PluginsV1Module], controllers: [PolicyStudioController], providers: [PolicyStudioService, { provide: AuditService, useValue: new AuditService() }, { provide: POLICY_SOURCE, useValue: { catalog: async () => CATALOG, simulate: async () => SIM } }] })
      .overrideGuard(AuthGuard).useValue(guard).compile();
    app = mod.createNestApplication(); await app.init(); reg = app.get(PluginRegistry);
  });
  after(async () => { process.env.IAM_API_ADMIN_TOKEN = env.a; if (env.p) process.env.IAM_PG_URL = env.p; await app.close(); });
  const api = () => request(app.getHttpServer()), adm = { 'x-api-admin-token': ADMIN };
  const body = { principal: 'User::"carol"', action: 'Action::"approve"', resource: 'Request::"r1"', context: { roles: ['viewer'], sod_conflict: true } };

  it('answers "why refused" for an administrator, only while the plugin is on', async () => {
    assert.equal((await api().post(`/tenants/${T}/policies/simulate`).set(adm).send(body)).status, 404);
    await reg.install(T, 'policy-studio', {}); await reg.enable(T, 'policy-studio', {});
    assert.equal((await api().post(`/tenants/${T}/policies/simulate`).send(body)).status, 403);
    const r = await api().post(`/tenants/${T}/policies/simulate`).set(adm).send(body);
    assert.equal(r.status, 200);
    assert.equal(r.body.allow, false);
    assert.deepEqual(r.body.matched_forbids, ['sod-blocks-approve']);
    assert.match(r.body.explanation, /sod-blocks-approve/);
    await reg.disable(T, 'policy-studio');
  });
  it('refuses a malformed simulation request with a 400, not a 500', async () => {
    await reg.enable(T, 'policy-studio', {});
    assert.equal((await api().post(`/tenants/${T}/policies/simulate`).set(adm).send({ principal: 'User::"a"' })).status, 400);
    await reg.disable(T, 'policy-studio');
  });
});

describe('CorePolicySource without a core', () => {
  it('answers 503 (never an empty list) when the core is not configured', async () => {
    const e = { u: process.env.IAM_CORE_URL, t: process.env.IAM_CORE_ADMIN_TOKEN }; delete process.env.IAM_CORE_URL; delete process.env.IAM_CORE_ADMIN_TOKEN;
    try {
      await assert.rejects(new CorePolicySource().catalog(), /IAM_CORE_URL/);
      await assert.rejects(new CorePolicySource().simulate({ principal: 'User::"a"', action: 'Action::"read"', resource: 'R::"1"' }), /IAM_CORE_URL/);
    } finally { if (e.u) process.env.IAM_CORE_URL = e.u; if (e.t) process.env.IAM_CORE_ADMIN_TOKEN = e.t; }
  });
});
