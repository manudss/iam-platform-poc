import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { BASE_FIELDS, toCatalog, validateFieldDecls } from './fields.js';
import { DoltProfileStore, FieldRoute } from './store.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { MemoryMigrationStore, MemorySettingsStore } from '../plugins/v1/memory-stores.js';
import { fakeBusBridge } from '../testing/fake-bus.js';
import { directory, hrAttributes } from '../plugins/v1/builtin/index.js';
import { startTestBus, TestBus } from '../testing/test-bus.js';

// Same module shape as profile.spec.ts: PluginsV1Module needs a reachable bus, one nats+core pair per spec file.
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const ADMIN = 'x'.repeat(20), T = 'acme-plug';
const CAT = [...BASE_FIELDS, ...toCatalog('hr-attributes', hrAttributes.manifest.profileFields!)];

/** The management rules answered by the directory.default slot, like the runtime calls them. */
const rulesReg = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore());
rulesReg.register(directory);
rulesReg.setBus(fakeBusBridge(rulesReg));
const RULES_T = 't-rules-pc';
const slot = <R>(hook: string, payload: unknown) => rulesReg.callSlot<R>(RULES_T, 'directory.default', hook, payload);
const validateConfig = async (input: unknown) => (await slot<{ valid: boolean; config?: { fields: Record<string, object> }; errors?: string[] }>('directory.fields.validateConfig', { input, catalogue: CAT })).result;
const schemaFor = async (ctx: 'signup' | 'self' | 'admin', cfg: unknown) => (await slot<{ fields: { key: string; section?: string; order: number }[] }>('directory.fields.effectiveSchema', { catalogue: CAT, config: cfg, context: ctx })).result.fields;
const check = async (field: object, value: unknown) => (await slot<{ valid: boolean; value?: unknown; error?: string }>('directory.fields.checkValue', { field, value })).result;
const badConfig = async (input: unknown, re: RegExp) => { const r = await validateConfig(input); assert.ok(!r.valid, `expected refusal: ${JSON.stringify(input)}`); assert.ok(re.test(r.errors!.join('; ')), r.errors!.join('; ')); };
const badValue = async (field: object, value: unknown, re: RegExp) => { const r = await check(field, value); assert.ok(!r.valid, `expected refusal: ${JSON.stringify(value)}`); assert.ok(re.test(r.error!), r.error!); };
const pngDataUrl = (bytes: number) => 'data:image/png;base64,' + Buffer.alloc(bytes, 7).toString('base64');

describe('profile plugins: declarations and configuration (pure)', () => {
  it('a declared storage lives in a table the plugin owns: plg_<pluginId>_*', () => {
    assert.ok(validateFieldDecls('hr-attributes', [{ key: 'x', type: 'string', label: 'X', storage: { table: 'profile_field_values', column: 'c' } }]).some((e) => /plg_hr_attributes_/.test(e)));
    assert.ok(validateFieldDecls('hr-attributes', [{ key: 'x', type: 'string', label: 'X', storage: { table: 'plg_other_x', column: 'c' } }]).some((e) => /plg_hr_attributes_/.test(e)));
    assert.ok(validateFieldDecls('hr-attributes', [{ key: 'x', type: 'string', label: 'X', storage: { table: 'plg_hr_attributes_v', column: 'Bad Col' } }]).some((e) => /column/.test(e)));
    assert.ok(validateFieldDecls('hr-attributes', [{ key: 'x', type: 'string', label: 'X', storage: { table: 'plg_hr_attributes_v', column: 'c', sqlType: 'int' } }]).some((e) => /sqlType/.test(e)));
    assert.deepEqual(validateFieldDecls('hr-attributes', [{ key: 'x', type: 'string', label: 'X', storage: { table: 'plg_hr_attributes_v', column: 'c', sqlType: 'mediumtext' } }]), []);
  });
  it('section and order declarations are shape-checked', () => {
    assert.ok(validateFieldDecls('p', [{ key: 'x', type: 'string', label: 'X', section: ' '.repeat(0) + 'x'.repeat(81) }]).some((e) => /section/.test(e)));
    assert.ok(validateFieldDecls('p', [{ key: 'x', type: 'string', label: 'X', order: 1000 }]).some((e) => /order/.test(e)));
    assert.ok(validateFieldDecls('p', [{ key: 'x', type: 'string', label: 'X', order: 1.5 }]).some((e) => /order/.test(e)));
    assert.deepEqual(validateFieldDecls('p', [{ key: 'x', type: 'string', label: 'X', section: 'HR', order: 0 }]), []);
  });
  it('the shipped hr-attributes manifest maps its values to its own table', () => {
    for (const f of toCatalog('hr-attributes', hrAttributes.manifest.profileFields!)) {
      assert.equal(f.storage, 'table', f.fullKey);
      assert.ok(f.table!.startsWith('plg_hr_attributes_'), `unexpected table ${f.table}`);
    }
  });
  it('adminView is a boolean setting; the matrix rejects anything else', async () => {
    const ok = await validateConfig({ fields: { 'hr-attributes.phone': { adminView: false } } });
    assert.ok(ok.valid, ok.errors?.join('; ') ?? '');
    await badConfig({ fields: { 'hr-attributes.phone': { adminView: 'no' } } }, /adminView: boolean/);
  });
  it('the directory core fields can be tuned but never disabled, and the display name always stays visible to an administrator', async () => {
    await badConfig({ fields: { 'base.display_name': { enabled: false, signup: 'off', selfEdit: false } } }, /never disabled/);
    await badConfig({ fields: { 'base.email': { enabled: false, signup: 'off', selfEdit: false } } }, /never disabled/);
    await badConfig({ fields: { 'base.display_name': { adminView: false } } }, /always stay visible to an administrator/);
    const ok = await validateConfig({ fields: { 'base.email': { adminView: false } } }); // e-mail MAY be hidden from administrators
    assert.ok(ok.valid, ok.errors?.join('; ') ?? '');
  });
  it('component overrides are shape-checked: key, surfaces, order, no unknown setting', async () => {
    const ok = await validateConfig({ fields: {}, components: { 'auth-totp:totp': { admin: 'readonly', order: 5 } } });
    assert.ok(ok.valid, ok.errors?.join('; ') ?? '');
    await badConfig({ fields: {}, components: { totp: { admin: 'readonly' } } }, /<plugin>:<component>/);
    await badConfig({ fields: {}, components: { 'auth-totp:totp': { admin: 'editor' } } }, /manage, readonly, hidden/);
    await badConfig({ fields: {}, components: { 'auth-totp:totp': { order: 1000 } } }, /order/);
    await badConfig({ fields: {}, components: { 'auth-totp:totp': { enabled: true } } }, /unknown setting/);
  });
  it('an image value is a png, jpeg or webp data URL of at most 256 KB decoded', async () => {
    const f = { fullKey: 'profile-picture.picture', type: 'image' };
    assert.equal((await check(f, pngDataUrl(64))).value, pngDataUrl(64));
    assert.equal((await check(f, '')).value, null);
    await badValue(f, 'https://example.test/x.png', /data URL/);
    await badValue(f, 'data:image/svg+xml;base64,PHN2Zy8+', /png, jpeg or webp/);
    await badValue(f, pngDataUrl(300 * 1024), /over 256 KB/);
  });
  it('the effective schema hides an adminView:false field from administrators only, and carries section and order', async () => {
    const cfg = { fields: { 'hr-attributes.phone': { adminView: false }, 'hr-attributes.job_title': { section: 'Job', order: 1 } } };
    const adm = await schemaFor('admin', cfg);
    assert.ok(!adm.some((f) => f.key === 'hr-attributes.phone'));
    const self = await schemaFor('self', cfg);
    assert.ok(self.some((f) => f.key === 'hr-attributes.phone'), 'still on the person\'s own page');
    const jt = adm.find((f) => f.key === 'hr-attributes.job_title')!;
    assert.equal(jt.section, 'Job'); assert.equal(jt.order, 1);
    assert.equal(adm[0].key, 'hr-attributes.job_title', 'order 1 sorts first');
  });
});

/** A fake MySQL connection with just enough behaviour for the DoltProfileStore routing tests (in-memory tables). */
function fakeConnection() {
  const tables = new Map<string, { key: (p: unknown[]) => string; rows: Map<string, Record<string, unknown>> }>();
  const mk = (name: string, key: (p: unknown[]) => string) => { if (!tables.has(name)) tables.set(name, { key, rows: new Map() }); return tables.get(name)!; };
  const rowKey = (t: string, s: string) => `${t}|${s}`;
  const conn = {
    tables,
    async query(sql: string, params: unknown[] = []): Promise<[unknown[], unknown]> {
      let m: RegExpMatchArray | null;
      if (sql.startsWith('create table if not exists profile_field_values')) { mk('profile_field_values', (p) => rowKey(String(p[0]), String(p[1])) + '|' + String(p[2])); return [[], {}]; }
      if ((m = sql.match(/^select count\(\*\) n from information_schema\.tables/))) return [[{ n: tables.has(String(params[0])) ? 1 : 0 }], {}];
      if (sql.startsWith('select field_key, value from profile_field_values where tenant=? and subject=?')) {
        const t = tables.get('profile_field_values'); const out: Record<string, unknown>[] = [];
        for (const [k, r] of t?.rows ?? []) if (k.startsWith(rowKey(String(params[0]), String(params[1])) + '|')) out.push({ field_key: r.field_key, value: r.value });
        return [out, {}];
      }
      if (sql.startsWith('insert into profile_field_values')) { const t = mk('profile_field_values', (p) => rowKey(String(p[0]), String(p[1])) + '|' + String(p[2])); t.rows.set(t.key(params), { tenant: params[0], subject: params[1], field_key: params[2], value: JSON.parse(String(params[3])) }); return [[], {}]; }
      if (sql.startsWith('delete from profile_field_values')) { const t = tables.get('profile_field_values'); t?.rows.delete(rowKey(String(params[0]), String(params[1])) + '|' + String(params[2])); return [[], {}]; }
      if (sql.startsWith('select subject, field_key, value from profile_field_values')) {
        const keys = params.slice(1).map(String); const t = tables.get('profile_field_values'); const out: Record<string, unknown>[] = [];
        for (const [k, r] of t?.rows ?? []) if (k.startsWith(String(params[0]) + '|') && keys.includes(String(r.field_key))) out.push({ subject: r.subject, field_key: r.field_key, value: r.value });
        return [out, {}];
      }
      if (sql.startsWith('select count(*) n from profile_field_values')) {
        const t = tables.get('profile_field_values'); let n = 0;
        for (const [k] of t?.rows ?? []) if (k.startsWith(String(params[0]) + '|') && String(k.split('|')[2]).startsWith(String(params[1]).replace(/%$/, ''))) n++;
        return [[{ n }], {}];
      }
      if ((m = sql.match(/^insert into `(\w+)` \(tenant, subject, (.+)\) values/))) {
        const name = m[1]; if (!tables.has(name)) throw new Error(`Table '${name}' doesn't exist`);
        const cols = m[2].split(',').map((c) => c.trim().replace(/`/g, ''));
        const t = tables.get(name)!; const k = rowKey(String(params[0]), String(params[1]));
        const row = { ...(t.rows.get(k) ?? { tenant: params[0], subject: params[1] }) };
        cols.forEach((c, i) => { row[c] = params[2 + i]; });
        t.rows.set(k, row); return [[], {}];
      }
      if ((m = sql.match(/^select (.+) from `(\w+)` where tenant=\? and subject=\?/))) {
        const cols = m[1].split(',').map((c) => c.trim().replace(/`/g, '')); const t = tables.get(m[2]);
        const row = t?.rows.get(rowKey(String(params[0]), String(params[1])));
        if (!row) return [[], {}];
        return [[Object.fromEntries(cols.map((c) => [c, row[c] ?? null]))], {}];
      }
      if ((m = sql.match(/^select count\(\*\) n from `(\w+)` where tenant=\? and \((.+)\)/))) {
        const t = tables.get(m[1]); const cols = [...m[2].matchAll(/`(\w+)` is not null/g)].map((x) => x[1]); let n = 0;
        for (const [, r] of t?.rows ?? []) if (r.tenant === params[0] && cols.some((c) => r[c] !== null && r[c] !== undefined)) n++;
        return [[{ n }], {}];
      }
      if (sql.startsWith('select table_name from dolt_status')) return [[], {}]; // nothing to commit in the fake
      throw new Error('fake connection: unexpected SQL: ' + sql);
    },
  };
  mk('profile_field_values', (p) => rowKey(String(p[0]), String(p[1])) + '|' + String(p[2]));
  return conn;
}

describe('profile plugins: value store routing (DoltProfileStore)', () => {
  const ROUTES: FieldRoute[] = [
    { fullKey: 'hr-attributes.job_title', type: 'string', table: 'plg_hr_attributes_values', column: 'job_title' },
    { fullKey: 'hr-attributes.on_site', type: 'boolean', table: 'plg_hr_attributes_values', column: 'on_site' },
  ];
  const store = (conn: ReturnType<typeof fakeConnection>, routes: FieldRoute[]) => {
    const v = { at: async (_r: string, fn: (c: unknown) => Promise<unknown>) => fn(conn), lock: async (fn: () => Promise<unknown>) => fn(), writeOn: async (_b: string, fn: (c: unknown) => Promise<unknown>) => fn(conn) } as unknown as VersioningService;
    const s = new DoltProfileStore(v, () => 'work');
    s.setCatalogue(async () => routes);
    return s;
  };
  it('a storage-mapped field writes to the plugin table (booleans as 0/1); everything else keeps the generic row store', async () => {
    const conn = fakeConnection(); conn.tables.set('plg_hr_attributes_values', { key: (p) => `${p[0]}|${p[1]}`, rows: new Map() });
    const s = store(conn, ROUTES);
    await s.put('acme', 'demo-alice', { 'hr-attributes.job_title': 'Engineer', 'hr-attributes.on_site': true, 'legacy.note': 'x' }, 'live', 'alice');
    const row = conn.tables.get('plg_hr_attributes_values')!.rows.get('acme|demo-alice')!;
    assert.equal(row.job_title, 'Engineer'); assert.equal(row.on_site, 1);
    const legacy = [...conn.tables.get('profile_field_values')!.rows.keys()];
    assert.deepEqual(legacy, ['acme|demo-alice|legacy.note']);
    const got = await s.get('acme', 'demo-alice', 'live');
    assert.equal(got['hr-attributes.job_title'], 'Engineer');
    assert.equal(got['hr-attributes.on_site'], true, '0/1 reads back as a boolean');
    assert.equal(got['legacy.note'], 'x');
  });
  it('writing a routed field before the plugin table exists fails loudly, never silently drops the value', async () => {
    const conn = fakeConnection();
    const s = store(conn, ROUTES);
    await assert.rejects(s.put('acme', 'demo-alice', { 'hr-attributes.job_title': 'Engineer' }, 'live', 'alice'), /plg_hr_attributes_values is missing/);
  });
  it('adopt moves legacy generic rows into the plugin tables and removes them from the generic store', async () => {
    const conn = fakeConnection(); conn.tables.set('plg_hr_attributes_values', { key: (p) => `${p[0]}|${p[1]}`, rows: new Map() });
    const legacy = store(conn, []); // a catalogue without storage yet: values land in the generic row store
    await legacy.put('acme', 'demo-alice', { 'hr-attributes.job_title': 'Engineer' }, 'live', 'alice');
    await legacy.put('acme', 'demo-bob', { 'hr-attributes.job_title': 'Chef' }, 'live', 'alice');
    const s = store(conn, ROUTES);
    assert.equal(conn.tables.get('profile_field_values')!.rows.size, 2);
    const moved = await s.adopt('acme', ROUTES);
    assert.equal(moved, 2);
    assert.equal(conn.tables.get('profile_field_values')!.rows.size, 0);
    assert.equal(conn.tables.get('plg_hr_attributes_values')!.rows.get('acme|demo-bob')!.job_title, 'Chef');
    assert.equal(await s.adopt('acme', ROUTES), 0, 'idempotent');
  });
  it('countForPlugin counts legacy rows and filled plugin-table rows (the uninstall confirmation number)', async () => {
    const conn = fakeConnection(); conn.tables.set('plg_hr_attributes_values', { key: (p) => `${p[0]}|${p[1]}`, rows: new Map() });
    const s = store(conn, ROUTES);
    await s.put('acme', 'demo-alice', { 'hr-attributes.job_title': 'Engineer', 'legacy.other': 'y' }, 'live', 'alice');
    await s.put('acme', 'demo-bob', { 'hr-attributes.job_title': 'Chef' }, 'live', 'alice');
    assert.equal(await s.countForPlugin('acme', 'hr-attributes.', [], 'live'), 0, 'nothing under the prefix: values are in the plugin table now');
    assert.equal(await s.countForPlugin('acme', 'hr-attributes.', ROUTES, 'live'), 2, 'two filled rows of the plugin table');
  });
});

describe('profile plugins API: components, grants and the uninstall contract', () => {
  let app: INestApplication; const env = { a: process.env.IAM_API_ADMIN_TOKEN };
  before(async () => {
    process.env.IAM_API_ADMIN_TOKEN = ADMIN;
    const guard = { canActivate: (c: any) => { const r = c.switchToHttp().getRequest(); r.user = { sub: String(r.headers['x-test-sub'] ?? 'demo-alice') }; return true; } };
    const mod = await Test.createTestingModule({ imports: [PluginsV1Module] }).overrideGuard(AuthGuard).useValue(guard).compile();
    app = mod.createNestApplication(); await app.init();
  });
  after(async () => { process.env.IAM_API_ADMIN_TOKEN = env.a; await app.close(); });
  const api = () => request(app.getHttpServer());
  const adm = { 'x-api-admin-token': ADMIN };

  it('a plugin shipping profile components takes the uiComponents grant to enable', async () => {
    assert.equal((await api().post(`/tenants/${T}/plugins/auth-totp/install`).set(adm).send({ grants: {} })).status, 201);
    const noGrant = await api().post(`/tenants/${T}/plugins/auth-totp/enable`).set(adm).send({ grants: {} });
    assert.equal(noGrant.status, 403); assert.match(JSON.stringify(noGrant.body), /component screens were not granted/);
    assert.equal((await api().post(`/tenants/${T}/plugins/auth-totp/enable`).set(adm).send({ grants: { uiComponents: true } })).status, 201);
  });
  it('the components endpoint serves the self surface to anyone signed in, the admin surface to administrators only', async () => {
    assert.equal((await api().get(`/tenants/${T}/profile-components?surface=top`)).status, 400);
    const self = await api().get(`/tenants/${T}/profile-components?surface=self`);
    assert.equal(self.status, 200);
    const totp = self.body.components.find((c: any) => c.key === 'auth-totp:totp');
    assert.ok(totp, 'auth-totp contributes its component'); assert.equal((totp as any).mode, 'manage'); assert.equal((totp as any).component, 'screens/profile.mjs');
    assert.equal((await api().get(`/tenants/${T}/profile-components?surface=admin`)).status, 403, 'the admin surface needs the capability');
    const admR = await api().get(`/tenants/${T}/profile-components?surface=admin`).set(adm);
    assert.equal(admR.status, 200); assert.ok(admR.body.components.some((c: any) => c.key === 'auth-totp:totp'));
  });
  it('the administrator tunes surfaces per component; the inventory shows defaults against effective values', async () => {
    const bad = await api().put(`/tenants/${T}/profile-fields`).set(adm).send({ config: { fields: {}, components: { 'auth-totp:totp': { admin: 'editor' } } } });
    assert.equal(bad.status, 400);
    const ok = await api().put(`/tenants/${T}/profile-fields`).set(adm).send({ config: { fields: {}, components: { 'auth-totp:totp': { admin: 'readonly', order: 5 } } } });
    assert.equal(ok.status, 200);
    const admR = await api().get(`/tenants/${T}/profile-components?surface=admin&ref=work`).set(adm);
    const totp = admR.body.components.find((c: any) => c.key === 'auth-totp:totp');
    assert.equal(totp.mode, 'readonly'); assert.equal(totp.order, 5);
    const selfR = await api().get(`/tenants/${T}/profile-components?surface=self`);
    assert.equal(selfR.body.components.find((c: any) => c.key === 'auth-totp:totp').mode, 'manage', 'the self surface keeps the manifest default');
    assert.equal((await api().get(`/tenants/${T}/profile-components-inventory`)).status, 403);
    const inv = await api().get(`/tenants/${T}/profile-components-inventory`).set(adm);
    const itotp = inv.body.components.find((c: any) => c.key === 'auth-totp:totp');
    assert.deepEqual(itotp.defaults, { self: 'manage', admin: 'manage' });
    assert.deepEqual(itotp.effective, { self: 'manage', admin: 'readonly' });
  });
  it('hidden on a surface removes the component there only', async () => {
    await api().put(`/tenants/${T}/profile-fields`).set(adm).send({ config: { fields: {}, components: { 'auth-totp:totp': { admin: 'hidden' } } } });
    const admR = await api().get(`/tenants/${T}/profile-components?surface=admin&ref=work`).set(adm);
    assert.ok(!admR.body.components.some((c: any) => c.key === 'auth-totp:totp'));
    const selfR = await api().get(`/tenants/${T}/profile-components?surface=self`);
    assert.ok(selfR.body.components.some((c: any) => c.key === 'auth-totp:totp'), 'self untouched');
  });
  it('the picture plugin end to end: install adopts nothing, the person sets a picture, the count follows it', async () => {
    assert.equal((await api().post(`/tenants/${T}/plugins/profile-picture/install`).set(adm).send({ grants: { install: true } })).status, 201);
    assert.equal((await api().post(`/tenants/${T}/plugins/profile-picture/enable`).set(adm).send({ grants: { uiComponents: true } })).status, 201);
    const me = { 'x-test-sub': 'demo-bob' };
    const before = await api().get(`/tenants/${T}/plugins/profile-picture/profile-values`).set(adm);
    assert.equal(before.body.values, 0);
    const pic = pngDataUrl(32);
    const r = await api().patch(`/tenants/${T}/me/profile`).set(me).send({ values: { 'profile-picture.picture': pic } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const g = await api().get(`/tenants/${T}/me/profile`).set(me);
    assert.equal(g.body.values['profile-picture.picture'], pic);
    const after = await api().get(`/tenants/${T}/plugins/profile-picture/profile-values`).set(adm);
    assert.equal(after.body.values, 1);
  });
  it('the picture is the person\'s: an administrator sees it but cannot change it (adminEdit false by default)', async () => {
    const r = await api().patch(`/tenants/${T}/users/demo-bob/profile`).set(adm).send({ values: { 'profile-picture.picture': pngDataUrl(16) } });
    assert.equal(r.status, 403, JSON.stringify(r.body));
  });
  it('uninstall takes the plugin\'s profile configuration with it and reports the purge', async () => {
    assert.equal((await api().post(`/tenants/${T}/plugins/hr-attributes/install`).set(adm).send({ grants: { install: true } })).status, 201);
    assert.equal((await api().post(`/tenants/${T}/plugins/hr-attributes/enable`).set(adm).send({ grants: {} })).status, 201, 'no UI grant: hr-attributes ships no components');
    const put = await api().put(`/tenants/${T}/profile-fields`).set(adm).send({ config: { fields: { 'hr-attributes.job_title': { selfEdit: true, section: 'Job' }, 'base.email': { adminView: false } }, components: { 'hr-attributes:extra': { self: 'hidden' } } } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal((await api().post(`/tenants/${T}/plugins/hr-attributes/disable`).set(adm)).status, 201);
    const un = await api().post(`/tenants/${T}/plugins/hr-attributes/uninstall`).set(adm);
    assert.equal(un.status, 201, JSON.stringify(un.body));
    assert.equal(un.body.profileConfig.purged, 'hr-attributes');
    assert.equal(un.body.profileConfig.fields, 1, 'one field setting purged');
    const f = await api().get(`/tenants/${T}/profile-fields`).set(adm);
    assert.ok(!Object.keys(f.body.working.config.fields).some((k) => k.startsWith('hr-attributes.')), 'field settings gone');
    assert.ok(!Object.keys(f.body.working.config.components ?? {}).some((k) => k.startsWith('hr-attributes:')), 'component overrides gone');
    assert.equal(f.body.working.config.fields['base.email'].adminView, false, 'the settings of what stays installed are untouched');
  });
});
