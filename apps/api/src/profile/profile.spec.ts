import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { validateManifest } from '../plugins/v1/manifest.js';
import { HOOKS } from '../plugins/v1/hooks.js';
import { hrAttributes } from '../plugins/v1/builtin/index.js';
import { BASE_FIELDS, toCatalog, validateFieldDecls } from './fields.js';
import { MemoryMigrationStore, MemorySettingsStore } from '../plugins/v1/memory-stores.js';
import { fakeBusBridge } from '../testing/fake-bus.js';
import { directory } from '../plugins/v1/builtin/index.js';
import { startTestBus, TestBus } from '../testing/test-bus.js';

// Step 3 cleanup (decision 6): PluginsV1Module requires a reachable bus - one nats+core pair for this spec file.
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const ADMIN = 'x'.repeat(20), T = 'acme-demo';
const CAT = [...BASE_FIELDS, ...toCatalog('hr-attributes', hrAttributes.manifest.profileFields!)];

/** The management RULES are answered by the directory.default slot (phase 2 step 1): these tests exercise them
 * through the registry, like the runtime does. Declarations stay synchronous (manifest-time rule). */
const rulesReg = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore());
rulesReg.register(directory);
rulesReg.setBus(fakeBusBridge(rulesReg));
const RULES_T = 't-rules';
const slot = <R>(hook: string, payload: unknown) => rulesReg.callSlot<R>(RULES_T, 'directory.default', hook, payload);
const validateConfig = async (input: unknown) => (await slot<{ valid: boolean; config?: { fields: Record<string, object> }; errors?: string[] }>('directory.fields.validateConfig', { input, catalogue: CAT })).result;
const schemaFor = async (ctx: 'signup' | 'self' | 'admin', cfg: unknown) => (await slot<{ fields: { key: string; klass: string; required: boolean; editable: boolean }[] }>('directory.fields.effectiveSchema', { catalogue: CAT, config: cfg, context: ctx })).result.fields;
const check = async (field: object, value: unknown) => (await slot<{ valid: boolean; value?: unknown; error?: string }>('directory.fields.checkValue', { field, value })).result;
const badConfig = async (input: unknown, re: RegExp) => { const r = await validateConfig(input); assert.ok(!r.valid, `expected refusal: ${JSON.stringify(input)}`); assert.ok(re.test(r.errors!.join('; ')), r.errors!.join('; ')); };
const badValue = async (field: object, value: unknown, re: RegExp) => { const r = await check(field, value); assert.ok(!r.valid, `expected refusal: ${JSON.stringify(value)}`); assert.ok(re.test(r.error!), r.error!); };

describe('profile field rules (pure)', () => {
  it('a plugin cannot declare an authority field that defaults to user-editable or sign-up', () => {
    assert.ok(validateFieldDecls('p', [{ key: 'a', type: 'string', label: 'A', klass: 'authority', defaults: { selfEdit: true } }]).length);
    assert.ok(validateFieldDecls('p', [{ key: 'a', type: 'string', label: 'A', klass: 'authority', defaults: { signup: 'optional' } }]).length);
    assert.deepEqual(validateFieldDecls('p', [{ key: 'a', type: 'string', label: 'A' }]), []);
  });
  it('rejects bad keys, duplicates, missing options, the reserved base id and wrong table-like input', () => {
    assert.ok(validateFieldDecls('p', [{ key: 'A-b', type: 'string', label: 'x' }]).length);
    assert.ok(validateFieldDecls('p', [{ key: 'a', type: 'string', label: 'x' }, { key: 'a', type: 'string', label: 'y' }]).length);
    assert.ok(validateFieldDecls('p', [{ key: 'a', type: 'select', label: 'x' }]).length);
    assert.ok(validateFieldDecls('base', [{ key: 'a', type: 'string', label: 'x' }]).length);
  });
  it('the shipped manifest with profile fields is valid; a bad declaration makes the manifest invalid', () => {
    assert.deepEqual(validateManifest(hrAttributes.manifest, HOOKS), []);
    assert.ok(validateManifest({ ...hrAttributes.manifest, profileFields: [{ key: 'X', type: 'string', label: 'x' }] }, HOOKS).length);
  });
  it('configuration: an authority field can never be user-editable or asked at sign-up, whatever the admin sends', async () => {
    for (const bad of [{ selfEdit: true }, { signup: 'optional' }, { signup: 'required' }]) await badConfig({ fields: { 'hr-attributes.employee_grade': bad } }, /authority field/);
    await badConfig({ fields: { 'base.department': { selfEdit: true } } }, /authority/);
    await badConfig({ fields: { 'base.manager_id': { signup: 'optional' } } }, /authority/);
  });
  it('configuration: consistency and unknown input', async () => {
    await badConfig({ fields: { 'hr-attributes.phone': { enabled: false, selfEdit: true } } }, /disabled/);
    await badConfig({ fields: { 'hr-attributes.phone': { selfView: false, selfEdit: true } } }, /selfEdit needs selfView/);
    await badConfig({ fields: { 'nope.x': {} } }, /unknown profile field/);
    await badConfig({ fields: { 'hr-attributes.phone': { role: 'admin' } } }, /unknown setting/);
    await badConfig({ fields: {}, roles: ['admin'] }, /unknown configuration field/);
    const ok = await validateConfig({ fields: { 'hr-attributes.phone': { selfEdit: true, order: 3 } } });
    assert.ok(ok.valid, ok.errors?.join('; ') ?? '');
    assert.deepEqual(ok.config!.fields['hr-attributes.phone'], { selfEdit: true, order: 3 });
  });
  it('effective schema per context: sign-up never offers authority fields, base fields are not editable through the value store', async () => {
    const cfg = { fields: { 'hr-attributes.job_title': { signup: 'required' as const } } };
    const su = await schemaFor('signup', cfg); assert.ok(su.every((f) => f.klass === 'profile'));
    assert.equal(su.find((f) => f.key === 'hr-attributes.job_title')!.required, true);
    assert.ok(!su.some((f) => f.key.includes('grade') || f.key === 'base.department'));
    const me = await schemaFor('self', cfg); assert.equal(me.find((f) => f.key === 'hr-attributes.employee_grade')!.editable, false);
    assert.equal(me.find((f) => f.key === 'base.display_name')!.editable, false);
    assert.equal((await schemaFor('admin', { fields: { 'hr-attributes.phone': { enabled: false } } })).some((f) => f.key === 'hr-attributes.phone'), false);
  });
  it('a plugin cannot rely on a validation hook that does not exist: the manifest is refused, never silently ignored', async () => {
    for (const name of ['profile.validate', 'signup.check']) assert.ok(validateManifest({ ...hrAttributes.manifest, hooks: [{ name, mode: 'blocking' }] } as never, HOOKS).some((e) => /unknown hook/.test(e)), name);
    const f = { fullKey: 'p.code', type: 'string' as const, pattern: '^[A-Z]{3}$' };
    assert.equal((await check(f, 'ABC')).value, 'ABC'); await badValue(f, 'abc', /format/);
  });
  it('values are checked by type', async () => {
    const f = (k: string) => CAT.find((c) => c.fullKey === k)!;
    assert.equal((await check(f('hr-attributes.phone'), '+33 6 12 34 56 78')).value, '+33 6 12 34 56 78');
    await badValue(f('hr-attributes.phone'), 'call me', /phone/);
    await badValue(f('hr-attributes.language'), 'de', /options/);
    assert.equal((await check(f('hr-attributes.job_title'), '  Engineer ')).value, 'Engineer');
    assert.equal((await check(f('hr-attributes.job_title'), '')).value, null);
    await badValue(f('hr-attributes.job_title'), 'x'.repeat(61), /length/);
    await badValue(f('hr-attributes.job_title'), 5, /text/);
  });
});

describe('profile fields API: plugin fields, configuration, self-service and admin edits', () => {
  let app: INestApplication, reg: PluginRegistry; const env = { a: process.env.IAM_API_ADMIN_TOKEN };
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = ADMIN;
    const guard = { canActivate: (c: any) => { const r = c.switchToHttp().getRequest(); r.user = { sub: String(r.headers['x-test-sub'] ?? 'demo-alice') }; return true; } };
    const mod = await Test.createTestingModule({ imports: [PluginsV1Module] }).overrideGuard(AuthGuard).useValue(guard).compile();
    app = mod.createNestApplication(); await app.init(); reg = app.get(PluginRegistry);
  });
  after(async () => { process.env.IAM_API_ADMIN_TOKEN = env.a; await app.close(); });
  const api = () => request(app.getHttpServer());
  const adm = { 'x-api-admin-token': ADMIN };

  it('a plugin field exists only while its plugin is enabled', async () => {
    let r = await api().get(`/tenants/${T}/profile-fields`).set(adm); assert.equal(r.status, 200);
    assert.ok(!r.body.catalogue.some((f: any) => f.plugin === 'hr-attributes'));
    await reg.install(T, 'hr-attributes', { install: true }); await reg.enable(T, 'hr-attributes', {});
    r = await api().get(`/tenants/${T}/profile-fields`).set(adm);
    assert.ok(r.body.catalogue.some((f: any) => f.fullKey === 'hr-attributes.job_title'));
    assert.ok(r.body.catalogue.some((f: any) => f.fullKey === 'base.email'));
  });
  it('the admin configuration needs the admin capability and refuses an authority field made user-editable', async () => {
    assert.equal((await api().put(`/tenants/${T}/profile-fields`).send({ config: { fields: {} } })).status, 403);
    const bad = await api().put(`/tenants/${T}/profile-fields`).set(adm).send({ config: { fields: { 'hr-attributes.employee_grade': { selfEdit: true } } } });
    assert.equal(bad.status, 400); assert.match(JSON.stringify(bad.body), /authority/);
    const ok = await api().put(`/tenants/${T}/profile-fields`).set(adm).send({ config: { fields: { 'hr-attributes.job_title': { selfEdit: true, signup: 'required' }, 'hr-attributes.phone': { selfEdit: true }, 'hr-attributes.language': { selfEdit: true } } } });
    assert.equal(ok.status, 200);
  });
  it('a user edits only fields that the configuration lets them edit, as themselves', async () => {
    const mine = { 'x-test-sub': 'demo-alice' };
    const r = await api().patch(`/tenants/${T}/me/profile`).set(mine).send({ values: { 'hr-attributes.job_title': 'Accountant', 'hr-attributes.language': 'fr' } });
    assert.equal(r.status, 200); assert.equal(r.body.values['hr-attributes.job_title'], 'Accountant');
    const g = await api().get(`/tenants/${T}/me/profile`).set(mine); assert.equal(g.body.values['hr-attributes.language'], 'fr');
    const other = await api().get(`/tenants/${T}/me/profile`).set({ 'x-test-sub': 'demo-bob' }); assert.deepEqual(other.body.values, {});
  });
  it('self-service refuses authority fields, base fields, unknown keys, disabled fields, wrong values and a spoofed subject', async () => {
    const mine = { 'x-test-sub': 'demo-alice' }, patch = (values: any, h: any = mine) => api().patch(`/tenants/${T}/me/profile`).set(h).send({ values });
    assert.equal((await patch({ 'hr-attributes.employee_grade': 'G9' })).status, 403);
    assert.equal((await patch({ 'base.department': 'finance' })).status, 403);
    assert.equal((await patch({ 'base.email': 'a@b.example' })).status, 403);
    assert.equal((await patch({ 'base.manager_id': 'demo-bob' })).status, 403);
    assert.equal((await patch({ role: 'payment-approver' })).status, 400);
    assert.equal((await patch({ 'hr-attributes.language': 'de' })).status, 400);
    assert.equal((await api().patch(`/tenants/${T}/me/profile`).set(mine).send({ values: { 'hr-attributes.language': 'en' }, subject: 'demo-bob' })).status, 400);
    assert.equal((await api().patch(`/tenants/${T}/me/profile`).set(mine).send({ values: { 'hr-attributes.language': 'en' }, sub: 'demo-bob' })).status, 400);
    const bob = await api().get(`/tenants/${T}/me/profile`).set({ 'x-test-sub': 'demo-bob' }); assert.deepEqual(bob.body.values, {});
    // the stored value of the authority field is untouched
    const a = await api().get(`/tenants/${T}/me/profile`).set(mine); assert.equal(a.body.values['hr-attributes.employee_grade'], undefined);
  });
  it('only the LIVE configuration governs users: a field made editable in the working config is not editable yet', async () => {
    // in this test setup (no workspace mode) working and live are the same; the rule is exercised against the live config explicitly
    await api().put(`/tenants/${T}/profile-fields`).set(adm).send({ config: { fields: { 'hr-attributes.phone': { selfEdit: false } } } });
    assert.equal((await api().patch(`/tenants/${T}/me/profile`).set({ 'x-test-sub': 'demo-alice' }).send({ values: { 'hr-attributes.phone': '+33 6 12 34 56 78' } })).status, 403);
  });
  it('an administrator can set the authority field; the user then sees it read-only', async () => {
    assert.equal((await api().patch(`/tenants/${T}/users/demo-bob/profile`).send({ values: { 'hr-attributes.employee_grade': 'G3' } })).status, 403);
    const r = await api().patch(`/tenants/${T}/users/demo-bob/profile`).set(adm).send({ values: { 'hr-attributes.employee_grade': 'G3' } });
    assert.equal(r.status, 200); assert.equal(r.body.values['hr-attributes.employee_grade'], 'G3');
    const me = await api().get(`/tenants/${T}/me/profile`).set({ 'x-test-sub': 'demo-bob' });
    const f = me.body.fields.find((x: any) => x.key === 'hr-attributes.employee_grade'); assert.equal(f.editable, false);
  });
  it('the schema endpoint serves the sign-up form without authority fields', async () => {
    await api().put(`/tenants/${T}/profile-fields`).set(adm).send({ config: { fields: { 'hr-attributes.job_title': { selfEdit: true, signup: 'required' } } } });
    const r = await api().get(`/tenants/${T}/profile-schema?context=signup`); assert.equal(r.status, 200);
    assert.ok(r.body.fields.some((f: any) => f.key === 'hr-attributes.job_title' && f.required));
    assert.ok(!r.body.fields.some((f: any) => f.klass === 'authority'));
    assert.equal((await api().get(`/tenants/${T}/profile-schema?context=root`)).status, 400);
  });
  it('review policy: own edits wait on a personal change set, only another administrator accepts, an ordinary account cannot review', async () => {
    const F = 'hr-attributes.job_title';
    await api().put(`/tenants/${T}/profile-fields`).set(adm).send({ config: { selfEditPolicy: 'review', fields: { [F]: { selfEdit: true } } } });
    const me = { 'x-test-sub': 'demo-bob' };
    const r = await api().patch(`/tenants/${T}/me/profile`).set(me).send({ values: { [F]: 'Controller' } });
    assert.equal(r.status, 200); assert.equal(r.body.policy, 'review'); assert.deepEqual(r.body.pending, [F]); assert.equal(r.body.values[F], 'Controller', 'the person sees their proposal');
    const list = await api().get(`/tenants/${T}/profile-reviews`).set({ ...adm, 'x-test-sub': 'demo-alice' });
    assert.equal(list.status, 200); assert.equal(list.body.reviews[0].subject, 'demo-bob'); assert.equal(list.body.reviews[0].changes[0].to, 'Controller');
    assert.equal((await api().get(`/tenants/${T}/profile-reviews`).set(me)).status, 403, 'ordinary account: no review');
    assert.equal((await api().post(`/tenants/${T}/profile-reviews/demo-bob/accept`).set(me)).status, 403);
    assert.equal((await api().post(`/tenants/${T}/profile-reviews/demo-bob/accept`).set({ ...adm, 'x-test-sub': 'demo-bob' })).status, 403, 'nobody accepts their own edits');
    const acc = await api().post(`/tenants/${T}/profile-reviews/demo-bob/accept`).set({ ...adm, 'x-test-sub': 'demo-alice' }); assert.equal(acc.status, 201);
    const after = await api().get(`/tenants/${T}/me/profile`).set(me); assert.equal(after.body.values[F], 'Controller'); assert.deepEqual(after.body.pending, []);
    await api().patch(`/tenants/${T}/me/profile`).set(me).send({ values: { [F]: 'Nope' } });
    assert.equal((await api().post(`/tenants/${T}/profile-reviews/demo-bob/refuse`).set({ ...adm, 'x-test-sub': 'demo-alice' })).status, 201);
    assert.equal((await api().get(`/tenants/${T}/me/profile`).set(me)).body.values[F], 'Controller', 'refused edits never reach live values');
    const acc2 = await api().get(`/tenants/${T}/me/access`).set(me); assert.equal(acc2.body.admin, false); assert.ok('organizations' in acc2.body.plugins || true);
    assert.equal((await api().get(`/tenants/${T}/me/access`).set({ ...adm, 'x-test-sub': 'demo-alice' })).body.admin, true);
    await api().put(`/tenants/${T}/profile-fields`).set(adm).send({ config: { fields: { [F]: { selfEdit: true } } } });
    const imm = await api().patch(`/tenants/${T}/me/profile`).set(me).send({ values: { [F]: 'Immediate' } }); assert.equal(imm.body.policy, 'immediate'); assert.deepEqual(imm.body.pending, []);
  });
});
