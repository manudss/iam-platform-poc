// Activation protocol against REAL Dolt + the REAL Rust core (no mocks): apply a Dolt commit to the core, idempotence,
// retry after the core was down, reconcile after a core restart, SoD computed by the core from the activated data.
// Skipped if the dolt or core binary is missing. Journal is the in-memory fallback here (PostgreSQL durability is tested in pg.e2e.spec.ts).
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'mysql2/promise';
import { ActivationService } from './activation/activation.service.js';
import { DoltService } from './dolt/dolt.service.js';

const root = resolve(process.cwd(), '../..');
const coreBin = resolve(root, 'core/target/debug/iam-core');
const which = spawnSync('sh', ['-c', 'command -v dolt']).stdout.toString().trim();
const doltBin = process.env.DOLT_BIN ?? (which || '/tmp/dolt-linux-amd64/bin/dolt');
const have = existsSync(coreBin) && existsSync(doltBin);
const CORE = 'http://127.0.0.1:18092', ADMIN = 'local-demo-admin-token'; // local fictional value

describe('activation protocol: real Dolt + real Rust core', { skip: !have && 'dolt or core binary missing' }, () => {
  let dolt: ChildProcess, core: ChildProcess | undefined, dir: string, svc: ActivationService;
  const T = 'acme-demo';

  const startCore = async () => {
    core = spawn(coreBin, [], { cwd: resolve(root, 'core'), env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18092', IAM_ISSUER: CORE, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar'), IAM_CORE_ADMIN_TOKEN: ADMIN }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${CORE}/health`)).ok) return; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 100)); }
    throw new Error('core did not start');
  };
  const stopCore = async () => { core?.kill(); core = undefined; await new Promise((r) => setTimeout(r, 300)); };
  const sql = async (q: string) => {
    const c = await createConnection({ host: '127.0.0.1', port: 13317, user: 'root', database: 'iam' });
    try { await c.query(q); await c.query("call dolt_commit('-Am', 'test change')"); } finally { await c.end(); }
  };
  const decide = async (id: string, withLies = false) => (await (await fetch(`${CORE}/v1/decide`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenant: T, principal: `User::"${id}"`, action: 'Action::"approve"', resource: 'Request::"r1"', context: withLies ? { roles: ['payment-approver'], sod_conflict: false } : {} }),
  })).json()) as { allow: boolean; reasons: string[]; version?: { seq: number; commit: string } };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-act-'));
    const home = join(dir, 'home'), data = join(dir, 'data'); mkdirSync(home); mkdirSync(data);
    const env = { ...process.env, HOME: home };
    for (const [k, v] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(doltBin, ['config', '--global', '--add', k, v], { env });
    assert.equal(spawnSync(doltBin, ['sql'], { cwd: data, env, input: readFileSync(resolve(root, 'data/demo/01-schema.sql')) }).status, 0);
    dolt = spawn(doltBin, ['sql-server', '--host', '127.0.0.1', '--port', '13317', '--data-dir', data], { cwd: data, env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { if (spawnSync(doltBin, ['--host', '127.0.0.1', '--port', '13317', '--no-tls', '-u', 'root', 'sql', '-q', 'select 1'], { env }).status === 0) break; await new Promise((r) => setTimeout(r, 150)); }
    await startCore();
    Object.assign(process.env, { IAM_CORE_URL: CORE, IAM_CORE_ADMIN_TOKEN: ADMIN, DOLT_PORT: '13317', DOLT_DATABASE: 'iam' });
    delete process.env.IAM_PG_URL;
    svc = new ActivationService(undefined, new DoltService());
  });
  after(async () => { await stopCore(); dolt?.kill(); await new Promise((r) => setTimeout(r, 800)); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

  it('before any activation the core denies tenant requests (fail closed)', async () => {
    const d = await decide('demo-alice');
    assert.equal(d.allow, false); assert.deepEqual(d.reasons, ['no-active-version']);
  });
  it('activating a Dolt commit really applies it in the core; roles claimed by the caller are ignored', async () => {
    const head = await new DoltService().head();
    const a = await svc.activate(T, head, 'req-first-0001');
    assert.equal(a.state, 'applied'); assert.equal(a.seq, 1);
    const v = (await (await fetch(`${CORE}/v1/version?tenant=${T}`)).json()) as { seq: number; commit: string };
    assert.deepEqual(v, { tenant: T, seq: 1, commit: head });
    assert.equal((await decide('demo-alice', true)).allow, false); // alice has no role in the active data, lying context is overwritten
    assert.equal((await decide('demo-bob')).allow, false);
  });
  it('is idempotent per REQUEST id: retry of the same request has no new effect; a request for another commit is refused', async () => {
    const head = await new DoltService().head();
    const again = await svc.activate(T, head, 'req-first-0001');
    assert.equal(again.seq, 1); assert.equal(again.state, 'applied');
    assert.equal((await svc.list(T)).length, 1);
    await assert.rejects(svc.activate(T, 'ffffffff', 'req-first-0001'), /another commit/);
  });
  it('an explicit new request for the same commit is a NEW activation (no global dedupe by commit hash)', async () => {
    const head = await new DoltService().head();
    assert.equal((await svc.activate(T, head)).seq, 2);
    assert.equal((await svc.activate(T, head)).seq, 3);
    assert.equal((await svc.list(T)).length, 3);
  });
  it('a new data version changes decisions; SoD is computed by the core from the activated data', async () => {
    await sql("insert into assignments values ('demo-alice','payment-approver')");
    const a = await svc.activate(T, await new DoltService().head());
    assert.equal(a.seq, 4); assert.equal(a.state, 'applied');
    const d = await decide('demo-alice');
    assert.equal(d.allow, true); assert.equal(d.version?.seq, 4);
    await sql("insert into assignments values ('demo-bob','payment-approver')"); // bob now creator + approver => SoD
    assert.equal((await svc.activate(T, await new DoltService().head())).state, 'applied');
    assert.equal((await decide('demo-bob')).allow, false);
    assert.equal((await decide('demo-alice')).allow, true);
  });
  it('the activated commit is tagged act-<tenant>-<seq> in Dolt', async () => {
    const c = await createConnection({ host: '127.0.0.1', port: 13317, user: 'root', database: 'iam' });
    try {
      const [r] = await c.query('select tag_name from dolt_tags order by 1');
      assert.deepEqual((r as { tag_name: string }[]).map((x) => x.tag_name), ['act-acme-demo-1', 'act-acme-demo-2', 'act-acme-demo-3', 'act-acme-demo-4', 'act-acme-demo-5']);
    } finally { await c.end(); }
  });
  it('core down: activation is journaled as failed (no false success); retry of the same commit succeeds with the same seq', async () => {
    await stopCore();
    await sql("delete from assignments where identity_id='demo-bob' and role_id='payment-approver'");
    const head = await new DoltService().head();
    const failed = await svc.activate(T, head, 'req-retry-0001');
    assert.equal(failed.state, 'failed'); assert.equal(failed.seq, 6); assert.ok(failed.error);
    assert.equal((await svc.current(T))?.state, 'failed');
    await startCore(); // fresh core: lost its in-memory state
    const retried = await svc.activate(T, head, 'req-retry-0001');
    assert.equal(retried.state, 'applied'); assert.equal(retried.seq, 6); // same request: same activation, not a new one
    assert.equal((await svc.list(T)).length, 6);
  });
  it('reconcile re-applies the latest activation after a core restart, and does nothing when in sync', async () => {
    assert.equal((await svc.reconcile(T)).action, 'none');
    await stopCore(); await startCore(); // core lost its state
    assert.equal((await decide('demo-alice')).reasons[0], 'no-active-version');
    const r = await svc.reconcile(T);
    assert.equal(r.action, 'reapplied');
    assert.equal((await decide('demo-alice')).allow, true);
    assert.equal((await svc.reconcile(T)).action, 'none');
  });
  it('the core refuses /v1/activate without the admin token and refuses a stale seq', async () => {
    const body = JSON.stringify({ tenant: T, seq: 1, commit: 'abc', snapshot: { assignments: [], sod_rules: [] } });
    const h = { 'content-type': 'application/json' };
    assert.equal((await fetch(`${CORE}/v1/activate`, { method: 'POST', headers: h, body })).status, 401);
    assert.equal((await fetch(`${CORE}/v1/activate`, { method: 'POST', headers: { ...h, 'x-core-admin-token': ADMIN }, body })).status, 409);
  });
  it('policy-studio step 4: the snapshot carries the Dolt rules; a broken rule refuses the activation', async () => {
    // The seed loaded the six demo rules as rows: the tenant engine is built from them, the boot file is only the fallback.
    const cat = await (await fetch(`${CORE}/v1/policies?tenant=${T}`, { headers: { 'x-core-admin-token': ADMIN } })).json() as { engine: { source: string; rules: number } };
    assert.deepEqual(cat.engine, { source: 'tenant', rules: 20, sets: 1, schema: true });
    // A new rule row in Dolt decides once its commit is activated: carol may approve, and the audit name is the rule id.
    await sql(`insert into policy_rules values ('default','carol-approves','@id("carol-approves")\\npermit(principal == User::"carol", action == Action::"approve", resource);')`);
    const a = await svc.activate(T, await new DoltService().head());
    assert.equal(a.state, 'applied');
    const d = await decide('carol');
    assert.equal(d.allow, true); assert.deepEqual(d.reasons, ['carol-approves']);
    // A BROKEN rule row refuses the activation (journaled failed, core said why): the previous version keeps deciding.
    await sql("insert into policy_rules values ('default','broken','this is not cedar')");
    const f = await svc.activate(T, await new DoltService().head());
    assert.equal(f.state, 'failed'); assert.match(f.error ?? '', /policy rules refused/);
    assert.equal((await decide('carol')).allow, true);
  });
  it('policy-studio step 4d: a proposed rule is validated pre-commit, then merged and activated end to end', async () => {
    await sql("delete from policy_rules where id='broken'"); // clean up the poisoned row the previous test left on main
    const dolt = new DoltService();
    const branches = async () => { const c = await createConnection({ host: '127.0.0.1', port: 13317, user: 'root', database: 'iam' }); try { const [r] = await c.query('select name from dolt_branches'); return (r as { name: string }[]).map((x) => x.name); } finally { await c.end(); } };
    const validate = async (cand: unknown) => {
      const res = await fetch(`${CORE}/v1/policies/validate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-core-admin-token': ADMIN }, body: JSON.stringify(cand) });
      if (!res.ok) throw new Error(`core refused the candidate: HTTP ${res.status} ${await res.text()}`);
    };
    // A candidate the core refuses: no commit, no branch left behind.
    const before = await branches();
    await assert.rejects(dolt.proposePolicyChange({ kind: 'upsert-rule', set: 'default', id: 'nope', cedar: 'permit(' }, validate), /core refused the candidate/);
    assert.deepEqual(await branches(), before);
    // A valid rule: committed on its branch, merged, activated - and it decides.
    const { branch } = await dolt.proposePolicyChange({ kind: 'upsert-rule', set: 'default', id: 'dave-approves', cedar: '@id("dave-approves")\npermit(principal == User::"dave", action == Action::"approve", resource);' }, validate);
    const merged = await dolt.merge(branch);
    const a = await svc.activate(T, merged.commit);
    assert.equal(a.state, 'applied');
    const d = await decide('dave');
    assert.equal(d.allow, true); assert.deepEqual(d.reasons, ['dave-approves']);
  });
  it('branch:merge with the REAL core: manager may merge profile/ into main only; branch-merger any kind; nobody else', async () => {
    await sql("insert into assignments values ('mgr-x','manager'),('merger-y','branch-merger'),('main-z','main-merger')");
    const a = await svc.activate(T, await new DoltService().head());
    assert.equal(a.state, 'applied');
    const merge = async (id: string, source?: string, kind?: string, target = 'main') => (await (await fetch(`${CORE}/v1/decide`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenant: T, principal: `User::"${id}"`, action: 'Action::"branch:merge"', resource: `Branch::"${target}"`, context: source ? { source, source_kind: kind } : {} }),
    })).json()) as { allow: boolean; reasons: string[] };
    const p = await merge('mgr-x', 'profile/pend-dan', 'profile');
    assert.equal(p.allow, true); assert.deepEqual(p.reasons, ['main-profile-merger']);
    assert.equal((await merge('mgr-x', 'feature/x', 'feature')).allow, false, 'a manager may not merge a feature/ branch');
    assert.equal((await merge('mgr-x', 'personal/mgr-x', 'personal')).allow, false);
    assert.equal((await merge('mgr-x', 'profile/pend-dan', 'profile', 'release')).allow, false, 'the manager rule is scoped to main');
    assert.equal((await merge('mgr-x')).allow, false, 'no source given: the manager rule does not apply');
    assert.equal((await merge('merger-y', 'feature/x', 'feature')).allow, true);
    assert.equal((await merge('nobody', 'profile/x', 'profile')).allow, false);
    const mm = await merge('main-z', 'feature/x', 'feature');
    assert.equal(mm.allow, true); assert.deepEqual(mm.reasons, ['merge-into-main-needs-main-merger']);
    assert.equal((await merge('main-z', 'feature/x', 'feature', 'release')).allow, false, 'main-merger is a right on main only');
  });
  it('screen access and people scopes with the REAL core: roles open screens, managers and organisation admins reach only their people', async () => {
    await sql("insert into assignments values ('alice-sa','iam-admin'),('lucie-sa','manager'),('noemie-sa','main-merger'),('noah-sa','org-admin'),('bob-sa','payment-creator')");
    const a = await svc.activate(T, await new DoltService().head());
    assert.equal(a.state, 'applied');
    const ask = async (body: object) => (await (await fetch(`${CORE}/v1/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenant: T, ...body }) })).json()) as { allow: boolean; reasons: string[]; errors: string[] };
    const screen = async (id: string, screenId: string) => (await ask({ principal: `User::"${id}"`, action: 'Action::"screen:open"', resource: `Screen::"${screenId}"`, context: {} })).allow;
    const ent = (id: string, parents: [string, string][] = []) => ({ uid: { type: 'User', id }, attrs: {}, parents: parents.map(([type, pid]) => ({ type, id: pid })) });
    const org = (id: string, parent?: string) => ({ uid: { type: 'Org', id }, attrs: {}, parents: parent ? [{ type: 'Org', id: parent }] : [] });
    // lucie-sa -> yanis-sa -> lea-sa (manager chain); camille-sa is somewhere else; ines-sa is in the security organisation below it
    const world = [ent('lucie-sa'), ent('yanis-sa', [['User', 'lucie-sa']]), ent('lea-sa', [['User', 'yanis-sa']]), ent('camille-sa'), ent('noah-sa'), ent('ines-sa', [['Org', 'security']]), ent('cam-fin', [['Org', 'finance']]), org('it'), org('security', 'it'), org('finance')];
    const person = async (action: string, id: string, target: string, role?: string, orgs?: string[]) => (await ask({ principal: `User::"${id}"`, action: `Action::"${action}"`, resource: `User::"${target}"`, context: { ...(role ? { role } : {}), ...(orgs ? { admin_orgs: orgs.map((o) => ({ __entity: { type: 'Org', id: o } })) } : {}) }, entities: world })).allow;
    // screens
    for (const sc of ['roles', 'policies', 'activation', 'dolt-sql', 'dolt-data', 'users', 'dashboard', 'branch-manage']) assert.equal(await screen('alice-sa', sc), true, `super admin opens ${sc}`);
    for (const sc of ['users', 'profile-reviews', 'assignments', 'my-profile']) assert.equal(await screen('lucie-sa', sc), true, `manager opens ${sc}`);
    for (const sc of ['roles', 'policies', 'activation', 'dashboard', 'dolt-sql', 'dolt-data', 'dolt-pulls', 'plugins', 'branch-manage']) assert.equal(await screen('lucie-sa', sc), false, `manager does not open ${sc}`);
    for (const sc of ['dolt-pulls', 'dolt-compare', 'dolt-history', 'dolt-branches', 'branch-manage', 'my-profile']) assert.equal(await screen('noemie-sa', sc), true, `main-merger opens ${sc}`);
    for (const sc of ['dolt-data', 'dolt-edit', 'dolt-sql', 'users', 'roles', 'policies', 'activation', 'dashboard', 'plugins']) assert.equal(await screen('noemie-sa', sc), false, `main-merger does not open ${sc}`);
    for (const sc of ['users', 'profile-reviews', 'assignments', 'my-profile']) assert.equal(await screen('noah-sa', sc), true, `org admin opens ${sc}`);
    for (const sc of ['roles', 'policies', 'activation', 'dolt-sql', 'dolt-pulls', 'dashboard', 'branch-manage']) assert.equal(await screen('noah-sa', sc), false, `org admin does not open ${sc}`);
    assert.equal(await screen('bob-sa', 'my-profile'), true); assert.equal(await screen('bob-sa', 'users'), false); assert.equal(await screen('bob-sa', 'dolt-pulls'), false);
    // nobody but the super admin is a super admin: no other demo role reaches any config screen or any person
    for (const id of ['lucie-sa', 'noemie-sa', 'noah-sa']) for (const sc of ['roles', 'policies', 'activation', 'plugins', 'dolt-sql']) assert.equal(await screen(id, sc), false, `${id} is not a super admin (${sc})`);
    // manager chain scope
    assert.equal(await person('user:manage', 'lucie-sa', 'yanis-sa'), true); assert.equal(await person('user:read', 'lucie-sa', 'lea-sa'), true, 'a report of a report');
    assert.equal(await person('user:manage', 'lucie-sa', 'camille-sa'), false); assert.equal(await person('user:read', 'lucie-sa', 'lucie-sa'), false, 'not herself');
    assert.equal(await person('user:read', 'noemie-sa', 'yanis-sa'), false); assert.equal(await person('user:read', 'alice-sa', 'camille-sa'), true);
    // organisation scope (the caller administers the it organisation; security is below it)
    assert.equal(await person('user:manage', 'noah-sa', 'ines-sa', undefined, ['it']), true, 'a member of a sub-organisation');
    assert.equal(await person('user:manage', 'noah-sa', 'cam-fin', undefined, ['it']), false); assert.equal(await person('user:manage', 'noah-sa', 'noah-sa', undefined, ['it']), false);
    assert.equal(await person('user:manage', 'noah-sa', 'ines-sa'), false, 'no organisation sent: nothing in scope');
    // assignments: allow list, scope, no escalation
    assert.equal(await person('assignment:change', 'lucie-sa', 'lea-sa', 'payment-creator'), true); assert.equal(await person('assignment:change', 'lucie-sa', 'lea-sa', 'accountant'), true);
    for (const r of ['iam-admin', 'main-merger', 'branch-merger', 'manager', 'org-admin', 'payment-approver', 'mcp-operator']) assert.equal(await person('assignment:change', 'lucie-sa', 'lea-sa', r), false, `a manager cannot assign ${r}`);
    assert.equal(await person('assignment:change', 'lucie-sa', 'camille-sa', 'accountant'), false, 'outside the scope'); assert.equal(await person('assignment:change', 'lucie-sa', 'lucie-sa', 'accountant'), false, 'not herself');
    assert.equal(await person('assignment:change', 'noah-sa', 'ines-sa', 'accountant', ['it']), true); assert.equal(await person('assignment:change', 'noah-sa', 'ines-sa', 'iam-admin', ['it']), false);
    assert.equal(await person('assignment:change', 'alice-sa', 'lea-sa', 'iam-admin'), true, 'the super admin may grant authority roles');
  });
});


