import { BusHostRef } from '../plugins/v1/bus-host.js';
import { startTestBus, TestBus } from '../testing/test-bus.js';
// Profile values in a REAL Dolt server: a user's own edit goes to main, an administrator's edit stays on the working branch until the merge,
// and a main edit made after the branch was cut merges without conflict. Skipped without DOLT_BIN (or dolt on PATH).
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VersioningService } from '../versioning/versioning.service.js';
import { DoltProfileStore } from './store.js';
import { DoltOrgStore } from './orgs.js';
import { DoltAppConnectorStore } from '../connectors/app-connector.js';
import { RolesService } from './roles.js';
import { DemoDataService } from './demo-data.service.js';
import { UsersService } from '../users/users.service.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { SHIPPED_PLUGIN_IDS } from '../plugins/v1/builtin/index.js';

let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const root = resolve(process.cwd(), '../..');
const which = spawnSync('sh', ['-c', 'command -v dolt']).stdout.toString().trim();
const doltBin = process.env.DOLT_BIN ?? which;
const have = !!doltBin && existsSync(doltBin);
const T = 'acme-demo';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('profile values in real Dolt', { skip: !have && 'dolt binary missing' }, () => {
  let dolt: ChildProcess, dir: string;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-prof-'));
    const home = join(dir, 'home'), data = join(dir, 'data'); mkdirSync(home); mkdirSync(data);
    const env = { ...process.env, HOME: home };
    for (const [k, v] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(doltBin, ['config', '--global', '--add', k, v], { env });
    assert.equal(spawnSync(doltBin, ['sql'], { cwd: data, env, input: readFileSync(resolve(root, 'data/demo/01-schema.sql')) }).status, 0);
    dolt = spawn(doltBin, ['sql-server', '--host', '127.0.0.1', '--port', '13312', '--data-dir', data], { cwd: data, env, stdio: 'ignore' });
    Object.assign(process.env, { DOLT_PORT: '13312', DOLT_DATABASE: 'iam' });
    for (let i = 0; i < 100; i++) { if (spawnSync(doltBin, ['--host', '127.0.0.1', '--port', '13312', '--no-tls', '-u', 'root', 'sql', '-q', 'select 1'], { env }).status === 0) break; await sleep(150); }
  });
  after(async () => { dolt?.kill(); await sleep(800); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

  it('live edits commit to main; admin edits stay on the branch until merged; a main edit after the branch was cut does not conflict', async () => {
    const v = new VersioningService(); const branch = 'work-profile';
    const store = new DoltProfileStore(v, () => branch);
    assert.deepEqual(await store.get(T, 'demo-alice', 'live'), {}, 'no table yet: empty, not an error');
    await store.put(T, 'demo-alice', { 'hr-attributes.job_title': 'Accountant' }, 'live', 'demo-alice');
    await v.lock(() => v.at('main', async (c) => { await c.query("call dolt_branch(?)", [branch]); }));
    await store.put(T, 'demo-bob', { 'hr-attributes.employee_grade': 'G3' }, 'work', 'admin');
    assert.deepEqual(await store.get(T, 'demo-bob', 'live'), {}, 'main untouched by the admin edit');
    assert.deepEqual(await store.get(T, 'demo-bob', 'work'), { 'hr-attributes.employee_grade': 'G3' });
    assert.deepEqual(await store.get(T, 'demo-alice', 'work'), { 'hr-attributes.job_title': 'Accountant' }, 'the branch was cut after the live edit');
    await store.put(T, 'demo-alice', { 'hr-attributes.language': 'fr' }, 'live', 'demo-alice'); // main moves after the cut
    await store.put(T, 'demo-alice', { 'hr-attributes.phone': '+33 6 12 34 56 78' }, 'work', 'admin');
    const r = await v.mergeInto(branch, 'main', 'Apply work-profile', 'demo-alice');
    assert.equal(r.mergeable, true, JSON.stringify(r));
    assert.deepEqual(await store.get(T, 'demo-bob', 'live'), { 'hr-attributes.employee_grade': 'G3' });
    assert.deepEqual(await store.get(T, 'demo-alice', 'live'), { 'hr-attributes.job_title': 'Accountant', 'hr-attributes.language': 'fr', 'hr-attributes.phone': '+33 6 12 34 56 78' });
    await store.put(T, 'demo-alice', { 'hr-attributes.phone': null }, 'live', 'demo-alice');
    assert.equal('hr-attributes.phone' in (await store.get(T, 'demo-alice', 'live')), false);
  });

  it('review policy: a personal branch holds the proposal, main is untouched until accepted, a refusal deletes it, the branch is reused', async () => {
    const v = new VersioningService(); const store = new DoltProfileStore(v, () => 'main');
    const F = 'hr-attributes.job_title';
    await store.put(T, 'pend-dan', { [F]: 'Old' }, 'live', 'pend-dan');
    await store.putPending(T, 'pend-dan', { [F]: 'New', 'hr-attributes.language': 'fr' }, 'pend-dan');
    await store.putPending(T, 'pend-dan', { 'hr-attributes.language': 'en' }, 'pend-dan'); // same branch reused
    assert.deepEqual(await store.get(T, 'pend-dan', 'live'), { [F]: 'Old' }, 'main untouched');
    assert.deepEqual(await store.pending(T, 'pend-dan'), { [F]: 'New', 'hr-attributes.language': 'en' });
    assert.ok((await store.listPending(T)).some((p) => p.subject === 'pend-dan' && p.base === 'main'));
    assert.equal((await v.branches()).branches.filter((b) => b.name === 'profile/pend-dan').length, 1);
    await store.resolvePending(T, 'pend-dan', true, 'validator');
    assert.deepEqual(await store.get(T, 'pend-dan', 'live'), { [F]: 'New', 'hr-attributes.language': 'en' });
    assert.deepEqual(await store.pending(T, 'pend-dan'), {}); assert.ok(!(await store.listPending(T)).some((p) => p.subject === 'pend-dan'));
    await store.putPending(T, 'pend-dan', { [F]: 'Bad' }, 'pend-dan'); await store.resolvePending(T, 'pend-dan', false, 'validator');
    assert.equal((await store.get(T, 'pend-dan', 'live'))[F], 'New'); assert.deepEqual(await store.pending(T, 'pend-dan'), {});
    await store.putPending(T, 'Odd.User@x', { [F]: 'x' }, 'Odd.User@x'); assert.ok((await store.listPending(T)).some((p) => p.subject === 'Odd.User@x' && p.base === 'main'), 'subject encoding round-trips');
    await store.resolvePending(T, 'Odd.User@x', false, 'validator');
  });

  it('a pending change set against another base branch merges back into that branch, never main', async () => {
    const v = new VersioningService(); const store = new DoltProfileStore(v, () => 'main');
    const F = 'hr-attributes.job_title';
    await v.createBranch('preprod-x', 'main');
    await store.putPending(T, 'pend-eve', { [F]: 'Pre' }, 'pend-eve', 'preprod-x');
    assert.ok((await store.listPending(T)).some((p) => p.subject === 'pend-eve' && p.base === 'preprod-x'));
    assert.deepEqual(await store.pending(T, 'pend-eve', 'preprod-x'), { [F]: 'Pre' });
    assert.deepEqual(await store.pending(T, 'pend-eve'), {}, 'main scope untouched');
    await store.resolvePending(T, 'pend-eve', true, 'validator', 'preprod-x');
    await v.at('preprod-x', async (c) => {
      const [rows] = await c.query('select field_key from profile_field_values where tenant=? and subject=?', [T, 'pend-eve']);
      assert.ok((rows as { field_key: string }[]).some((r) => r.field_key === F), 'value landed on the base branch');
    });
    assert.deepEqual(await store.get(T, 'pend-eve', 'live'), {}, 'main untouched by a branch-scoped acceptance');
    await v.deleteBranch('preprod-x', async () => false);
  });

  it('same field, same person: self edit on main after the admin edit on the branch is an explicit conflict, never a silent loss', async () => {
    const v = new VersioningService(); const branch = 'work-conflict';
    const store = new DoltProfileStore(v, () => branch);
    await v.lock(() => v.at('main', async (c) => { await c.query('call dolt_branch(?)', [branch]); }));
    await store.put(T, 'demo-carol', { 'hr-attributes.job_title': 'Admin says Lead' }, 'work', 'admin');
    await store.put(T, 'demo-carol', { 'hr-attributes.job_title': 'Carol says Manager' }, 'live', 'demo-carol');
    const r = await v.mergeInto(branch, 'main', 'Apply conflict', 'demo-carol');
    assert.equal(r.mergeable, false);
    assert.ok(r.conflicts > 0 && r.reasons.some((x: string) => /conflict/.test(x)), JSON.stringify(r));
    assert.deepEqual(await store.get(T, 'demo-carol', 'live'), { 'hr-attributes.job_title': 'Carol says Manager' }, 'main keeps the user value');
    assert.deepEqual(await store.get(T, 'demo-carol', 'work'), { 'hr-attributes.job_title': 'Admin says Lead' }, 'the branch keeps the admin value');
  });

  it('organizations and memberships: written on the branch, absent from main until the merge, then live', async () => {
    const v = new VersioningService(); const branch = 'work-orgs';
    await v.lock(() => v.at('main', async (c) => { await c.query('call dolt_branch(?)', [branch]); }));
    const st = new DoltOrgStore(v, () => branch);
    await st.write(T, 'admin', (x) => { x.orgs.push({ id: 'acme', name: 'Acme', parent_id: null }, { id: 'fin', name: 'Finance', parent_id: 'acme' }); x.members.push({ subject: 'demo-alice', org_id: 'fin' }); });
    assert.deepEqual((await st.list(T, 'live')), { orgs: [], members: [] });
    assert.equal((await st.list(T, 'work')).orgs.length, 2);
    const r = await v.mergeInto(branch, 'main', 'Apply work-orgs', 'admin'); assert.equal(r.mergeable, true, JSON.stringify(r));
    const live = await st.list(T, 'live'); assert.equal(live.orgs.length, 2); assert.deepEqual(live.members, [{ subject: 'demo-alice', org_id: 'fin' }]);
    await st.write(T, 'admin', (x) => { x.members = []; x.orgs = x.orgs.filter((o) => o.id !== 'fin'); });
    assert.equal((await st.list(T, 'work')).orgs.length, 1);
  });

  it('application connectors: written on the branch, absent from main until the merge, then live; config round-trips', async () => {
    const v = new VersioningService(); const branch = 'work-apps';
    await v.lock(() => v.at('main', async (c) => { await c.query('call dolt_branch(?)', [branch]); }));
    const st = new DoltAppConnectorStore(v, () => branch);
    const app = { id: 'wiki', name: 'Wiki', description: 'd', protocol: 'oidc' as const, enabled: true, redirect_uris: ['https://wiki.example.invalid/cb'], entity_id: null, acs_url: null, attribute_mapping: { sub: 'id' }, allowed_roles: ['employee'], secret_ref: 'apps/wiki/client-secret' };
    await st.write(T, 'admin', (x) => { x.apps.push(app); });
    assert.deepEqual(await st.list(T, 'live'), { apps: [] });
    assert.deepEqual((await st.list(T, 'work')).apps, [app]);
    const r = await v.mergeInto(branch, 'main', 'Apply work-apps', 'admin'); assert.equal(r.mergeable, true, JSON.stringify(r));
    assert.deepEqual((await st.list(T, 'live')).apps, [app]);
    await st.write(T, 'admin', (x) => { x.apps[0].enabled = false; x.apps[0].allowed_roles = []; });
    assert.equal((await st.list(T, 'work')).apps[0].enabled, false); assert.equal((await st.list(T, 'live')).apps[0].enabled, true);
  });

  it('claims safety: a user edit touches only profile_field_values; identities, roles and assignments are byte-identical', async () => {
    const v = new VersioningService(); const st = new DoltProfileStore(v, () => 'main');
    const snap = () => v.at('main', async (c) => { const out: Record<string, unknown> = {}; for (const t of ['identities', 'roles', 'assignments']) { const [r] = await c.query(`select * from ${t} order by 1,2`); out[t] = r; } return JSON.stringify(out); });
    const before = await snap();
    await st.put(T, 'demo-alice', { 'hr-attributes.job_title': 'Chief', 'hr-attributes.employee_grade': 'G99' }, 'live', 'demo-alice');
    assert.equal(await snap(), before);
    const tables = await v.at('main', async (c) => { const [r] = await c.query("select to_table_name t from dolt_diff_summary('HEAD~1','HEAD')"); return (r as { t: string }[]).map((x) => x.t); });
    assert.deepEqual(tables, ['profile_field_values']);
  });

  it('roles: definitions and SoD rules are edited on the branch, guarded, and Apply still enforces SoD', async () => {
    const v = new VersioningService(); const branch = 'work-roles'; process.env.IAM_WORKSPACE_MODE = '1';
    try {
      await v.lock(() => v.at('main', async (c) => { await c.query('call dolt_branch(?)', [branch]); }));
      const { branchContext } = await import('../workspace/context.js');
      const rs = new RolesService(v); const inBranch = <T>(fn: () => Promise<T>) => branchContext.run({ branch }, fn);
      const before = await v.at('main', async (c) => (await c.query('select * from roles order by id'))[0]);
      let l = await inBranch(() => rs.create('admin', { id: 'auditor', label: 'Auditor' })); assert.ok(l.roles.some((r) => r.id === 'auditor'));
      await assert.rejects(inBranch(() => rs.create('admin', { id: 'auditor', label: 'x' })), /already exists/);
      await assert.rejects(inBranch(() => rs.create('admin', { id: 'Bad Id', label: 'x' })), /id:/);
      await assert.rejects(inBranch(() => rs.update('admin', 'auditor', { id: 'other' })), /cannot change/);
      await inBranch(() => rs.update('admin', 'auditor', { label: 'Internal auditor', is_sensitive: true }));
      const first = l.roles.find((r) => r.id !== 'auditor')!.id;
      await inBranch(() => rs.addRule('admin', { role_a: 'auditor', role_b: first }));
      await assert.rejects(inBranch(() => rs.remove('admin', 'auditor')), /separation-of-duties/);
      await assert.rejects(inBranch(() => rs.removeRule('admin', 'auditor', first, undefined)), /confirm/);
      assert.deepEqual(await v.at('main', async (c) => (await c.query('select * from roles order by id'))[0]), before, 'main untouched until Apply');
      await inBranch(() => rs.removeRule('admin', 'auditor', first, true));
      l = await inBranch(() => rs.remove('admin', 'auditor')); assert.ok(!l.roles.some((r) => r.id === 'auditor'));
    } finally { delete process.env.IAM_WORKSPACE_MODE; }
  });

  it('P1: a branch registry registers the same shipped set as the main registry (catalogue partagé)', async () => {
    const busRef = new BusHostRef();
    process.env.IAM_WORKSPACE_MODE = '1';
    try {
      const v = new VersioningService(), users = new UsersService(v), br = new BranchRegistries(v, users, undefined, busRef);
      const reg = await br.get('main');
      // The two registration lists used to diverge silently: notify-resend, saml-idp, csv-connector,
      // scim-connector, mcp-gateway and directory were missing from every branch registry.
      for (const id of SHIPPED_PLUGIN_IDS) assert.ok(reg.impl(id), `branch registry registers ${id}`);
    } finally { await busRef.onModuleDestroy(); delete process.env.IAM_WORKSPACE_MODE; }
  });

  it('demo data seed: organizations and HR plugins enabled, people with profile values, sign-up open, idempotent', async () => {
    const busRef = new BusHostRef();
    const ST = 'seed-demo'; process.env.IAM_WORKSPACE_MODE = '1'; process.env.IAM_CREDENTIAL_FILE = join(dir, 'cred.json');
    try {
      const v = new VersioningService(), users = new UsersService(v), br = new BranchRegistries(v, users, undefined, busRef), store = new DoltProfileStore(v, () => 'main');
      const seed = new DemoDataService(v, users, br, store);
      assert.equal(await seed.seed(ST), true); assert.equal(await seed.seed(ST), false, 'second start does nothing');
      const reg = await br.get('main');
      assert.equal(reg.isActive(ST, 'organizations'), true); assert.equal(reg.isActive(ST, 'hr-attributes'), true);
      const list = await users.list('main'); assert.ok(list.length >= 10 && list.filter((u) => u.hasCredential && u.login_enabled).length >= 10);
      const orgs = await new DoltOrgStore(v, () => 'main').list(ST, 'live'); assert.ok(orgs.orgs.length >= 6 && orgs.members.length >= 10);
      const apps = (await new DoltAppConnectorStore(v, () => 'main').list(ST, 'live')).apps; assert.deepEqual(apps.map((a) => a.id), ['clientdesk', 'crm', 'expenseflow', 'learnup', 'payroll', 'peoplehub', 'sso-config-oidc', 'sso-config-saml', 'stockroom', 'ticketly', 'timesheet', 'travelops', 'wiki']); assert.equal(reg.isActive(ST, 'app-connector'), true);
      assert.equal((await store.get(ST, 'camille-martin', 'live'))['hr-attributes.job_title'], 'Chief accountant');
      const cfg = await reg.coreSettings(ST, 'core-profile-fields') as { signup?: { open: boolean } }; assert.equal(cfg.signup?.open, true);
    } finally { await busRef.onModuleDestroy(); delete process.env.IAM_WORKSPACE_MODE; delete process.env.IAM_CREDENTIAL_FILE; }
  });
});
