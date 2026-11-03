// End-to-end of workflow START TRIGGERS with a REAL Dolt SQL server (no Docker, no core): an application
// event (user created / department changed / account disabled) starts matching workflow runs by itself.
// Same fake-auth contract as workflows.e2e.spec.ts; skipped if the dolt binary is missing (DOLT_BIN).
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CanActivate, ExecutionContext, ForbiddenException, INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WorkflowsModule } from './workflows.module.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { VersioningModule } from '../versioning/versioning.module.js';
import { UsersModule } from '../users/users.module.js';
import { UsersService } from '../users/users.service.js';
import { EventsModule } from '../events/events.module.js';
import { AppEvents } from '../events/app-events.service.js';
import { SignupService } from '../profile/signup.service.js';
import { ProfileService } from '../profile/profile.service.js';
import { MemoryProfileStore } from '../profile/store.js';
import { OrgService, MemoryOrgStore } from '../profile/orgs.js';

const root = resolve(process.cwd(), '../..');
const which = spawnSync('sh', ['-c', 'command -v dolt']).stdout.toString().trim();
const doltBin = process.env.DOLT_BIN ?? (which || '/tmp/dolt-linux-amd64/bin/dolt');
const have = existsSync(doltBin);
const PORT = 13435, API = 'http://127.0.0.1:13436', ADMIN = 'test-admin-token-0123456789';
const T = 'acme-demo';

class FakeAuth implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const h = String(req.headers['authorization'] ?? '');
    if (!h.startsWith('Bearer ')) throw new UnauthorizedException('missing bearer token');
    const [tenant, sub] = h.slice(7).split(':');
    if (!tenant || !sub) throw new UnauthorizedException('malformed token');
    if (req.params?.tenant !== undefined && req.params.tenant !== tenant) throw new ForbiddenException('wrong tenant');
    req.user = { tenant, sub };
    return true;
  }
}

const call = async (method: string, path: string, body?: object) => {
  const r = await fetch(`${API}/tenants/${T}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${T}:demo-alice`, 'x-api-admin-token': ADMIN }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json: unknown; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json as never };
};
const ok = async (method: string, path: string, body?: object) => { const r = await call(method, path, body); assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
interface RunRow { id: string; definitionId: string; name: string; branch: string | null; status: string; startedBy: string }
const runsOf = async (def: string) => ((await ok('GET', `/workflow-runs?definition=${def}`)) as { runs: RunRow[] }).runs;
const waitForRun = async (def: string, count: number, timeoutMs = 30000): Promise<RunRow> => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const runs = await runsOf(def);
    if (runs.length >= count) {
      const last = runs[0];
      if (['completed', 'failed', 'canceled'].includes(last.status)) return last;
    }
    if (Date.now() > until) throw new Error(`definition ${def}: wanted ${count} finished run(s), got ${JSON.stringify((await runsOf(def)).map((r) => r.status))}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
let sqlEnv: NodeJS.ProcessEnv = process.env;
const sql = (q: string) => {
  const r = spawnSync(doltBin, ['--host', '127.0.0.1', '--port', String(PORT), '--no-tls', '-u', 'root', '--password', '', 'sql', '-q', q, '-r', 'csv'], { env: sqlEnv });
  assert.equal(r.status, 0, `sql failed: ${r.stderr}`);
  return r.stdout.toString();
};

describe('workflow start triggers + real Dolt', { skip: !have && 'dolt binary missing' }, () => {
  let dolt: ChildProcess, app: INestApplication, dir: string, home = '', users: UsersService, events: AppEvents;
  let joiner = '', mover = '', leaver = '';

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-wf-trig-'));
    const data = join(dir, 'data'); home = join(dir, 'home'); mkdirSync(home); mkdirSync(data);
    const env = { ...process.env, HOME: home }; sqlEnv = env;
    for (const [k, v] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(doltBin, ['config', '--global', '--add', k, v], { env });
    const seed = spawnSync(doltBin, ['sql'], { cwd: data, env, input: readFileSync(resolve(root, 'data/demo/01-schema.sql')) });
    assert.equal(seed.status, 0, 'seed failed: ' + seed.stderr);
    dolt = spawn(doltBin, ['sql-server', '--host', '127.0.0.1', '--port', String(PORT), '--data-dir', data], { cwd: data, env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      if (spawnSync(doltBin, ['--host', '127.0.0.1', '--port', String(PORT), '--no-tls', '-u', 'root', '--password', '', 'sql', '-q', 'select 1'], { env }).status === 0) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    Object.assign(process.env, { DOLT_PORT: String(PORT), DOLT_DATABASE: 'iam', IAM_API_ADMIN_TOKEN: ADMIN, IAM_CREDENTIAL_FILE: join(dir, 'creds.json') });
    delete process.env.IAM_WORKSPACE_MODE;
    const m = await Test.createTestingModule({ imports: [EventsModule, WorkflowsModule, VersioningModule, UsersModule] }).overrideGuard(AuthGuard).useValue(new FakeAuth()).compile();
    app = m.createNestApplication(); await app.init(); await app.listen(13436);
    users = m.get(UsersService); events = m.get(AppEvents);
    await ok('POST', '/plugins/workflows-iga/install', {});
    await ok('POST', '/plugins/workflows-iga/enable', {});
  });
  after(async () => { await app?.close(); dolt?.kill(); await new Promise((r) => setTimeout(r, 800)); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

  it('the event catalog is published for the editor', async () => {
    const c = (await ok('GET', '/workflows-events')) as { events: { type: string; payload: string[] }[] };
    const types = c.events.map((e) => e.type);
    for (const t of ['user.created', 'user.department-changed', 'user.disabled', 'signup.approved', 'signup.requested', 'profile.updated', 'profile.review-resolved', 'organization.member-added']) assert.ok(types.includes(t), `catalog missing ${t}`);
    assert.ok(c.events.find((e) => e.type === 'user.created')!.payload.includes('subject'));
  });

  it('trigger validation: unknown event, bad match key, placeholder without trigger, wrong placeholder key', async () => {
    const graph = { nodes: [{ id: 'a', type: 'wait', name: 'a', config: {} }], edges: [] };
    assert.equal((await call('POST', '/workflows', { name: 'x', graph, trigger: { event: 'user.deleted' } })).status, 400);
    assert.equal((await call('POST', '/workflows', { name: 'x', graph, trigger: { event: 'user.created', match: { role: 'x' } } })).status, 400);
    const withPlaceholder = { nodes: [{ id: 'a', type: 'assign-role', name: 'a', config: { identity: '{{event.subject}}', role: 'accountant' } }], edges: [] };
    assert.equal((await call('POST', '/workflows', { name: 'x', graph: withPlaceholder })).status, 400); // no trigger
    assert.equal((await call('POST', '/workflows', { name: 'x', graph: { nodes: [{ id: 'a', type: 'assign-role', name: 'a', config: { identity: '{{event.role}}', role: 'accountant' } }], edges: [] }, trigger: { event: 'user.created' } })).status, 400); // not a payload key
  });

  it('creating a user starts the joiner workflow: placeholders resolved, data on the run branch, main untouched', async () => {
    joiner = ((await ok('POST', '/workflows', { name: 'Joiner', description: '', trigger: { event: 'user.created' }, graph: { nodes: [
      { id: 'grant', type: 'assign-role', name: 'Grant accountant', config: { identity: '{{event.subject}}', role: 'accountant' } },
      { id: 'tell', type: 'notify', name: 'Inform', config: { recipient: 'manager', message: '{{event.displayName}} joined' } },
    ], edges: [{ from: 'grant', to: 'tell' }] } })) as { definition: { id: string } }).definition.id;
    await users.save('jane-doe', { id: 'jane-doe', display_name: 'Jane Doe', department: 'it', password: 'x'.repeat(12) }, true, undefined, T);
    const run = await waitForRun(joiner, 1);
    assert.equal(run.status, 'completed', JSON.stringify(run));
    assert.equal(run.startedBy, 'event:user.created');
    assert.ok(run.branch?.startsWith('wf-'), 'a data run gets its own branch');
    const view = (await ok('GET', `/workflow-runs/${run.id}`)) as { run: { base_branch: string | null }; steps: { node_id: string; log: string[] }[] };
    assert.equal(view.run.base_branch, 'main'); // non-workspace mode: the write happened on main
    assert.ok(view.steps.find((s) => s.node_id === 'tell')!.log.some((l) => l.includes('Jane Doe joined')), 'placeholder in the message resolved');
    const onBranch = sql(`select role_id from iam.assignments as of '${run.branch}' where identity_id='jane-doe'`);
    assert.ok(onBranch.includes('accountant'), `run branch has the grant: ${onBranch}`);
    const onMain = sql(`select count(*) as n from iam.assignments as of 'main' where identity_id='jane-doe'`);
    assert.ok(onMain.trim().endsWith('0') || onMain.includes('\n0'), `main stays clean: ${onMain}`);
  });

  it('the match filter selects events: sales move ignored, finance move starts the mover workflow', async () => {
    mover = ((await ok('POST', '/workflows', { name: 'Mover finance', description: '', trigger: { event: 'user.department-changed', match: { to: 'finance' } }, graph: { nodes: [
      { id: 'grant', type: 'assign-role', name: 'Grant payment-creator', config: { identity: '{{event.subject}}', role: 'payment-creator' } },
    ], edges: [] } })) as { definition: { id: string } }).definition.id;
    await users.save('jane-doe', { department: 'sales' }, false, undefined, T);
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal((await runsOf(mover)).length, 0, 'a move to sales must not start the finance mover');
    await users.save('jane-doe', { department: 'finance' }, false, undefined, T);
    const run = await waitForRun(mover, 1);
    assert.equal(run.status, 'completed');
    assert.equal(run.startedBy, 'event:user.department-changed');
  });

  it('disabling an account starts the leaver workflow, which revokes for real on its branch', async () => {
    leaver = ((await ok('POST', '/workflows', { name: 'Leaver', description: '', trigger: { event: 'user.disabled' }, graph: { nodes: [
      { id: 'revoke', type: 'revoke-role', name: 'Revoke payment-creator', config: { identity: '{{event.subject}}', role: 'payment-creator' } },
    ], edges: [] } })) as { definition: { id: string } }).definition.id;
    // Triggered runs never merge back by themselves: jane's grants so far live on their run branches. For the
    // revoke to bite, grant her the role on main directly (as a merged review would have done).
    sql(`use iam; insert into assignments values ('jane-doe','payment-creator'); call dolt_add('assignments'); call dolt_commit('-m','test: jane holds payment-creator on main')`);
    await users.save('jane-doe', { login_enabled: false }, false, undefined, T);
    const run = await waitForRun(leaver, 1);
    assert.equal(run.status, 'completed', JSON.stringify(run));
    assert.equal(run.startedBy, 'event:user.disabled');
    const onBranch = sql(`select count(*) as n from iam.assignments as of '${run.branch}' where identity_id='jane-doe' and role_id='payment-creator'`);
    assert.ok(onBranch.trim().endsWith('\n0') || onBranch.trim().endsWith('0'), `revoked on the run branch: ${onBranch}`);
    const onMain = sql(`select count(*) as n from iam.assignments as of 'main' where identity_id='jane-doe' and role_id='payment-creator'`);
    assert.ok(onMain.trim().endsWith('1'), `main keeps the grant until review: ${onMain}`);
  });

  it('user.disabled fires only on the enabled -> disabled transition', async () => {
    await users.save('jane-doe', { login_enabled: false }, false, undefined, T); // already disabled: no transition
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal((await runsOf(leaver)).length, 1, 'saving an already-disabled account starts nothing');
    await users.save('jane-doe', { login_enabled: true }, false, undefined, T); // re-enable: not a disable
    await users.save('jane-doe', { login_enabled: false }, false, undefined, T); // real transition again
    const run = await waitForRun(leaver, 2);
    assert.equal(run.status, 'completed');
    assert.equal(run.startedBy, 'event:user.disabled');
  });

  it('approving a sign-up request really emits signup.approved and starts its workflow', async () => {
    const signup = ((await ok('POST', '/workflows', { name: 'Signup welcome', description: '', trigger: { event: 'signup.approved' }, graph: { nodes: [
      { id: 'tell', type: 'notify', name: 'Welcome (simulated)', config: { recipient: 'hr', message: '{{event.subject}} approved ({{event.email}})' } },
    ], edges: [] } })) as { definition: { id: string } }).definition.id;
    // Real SignupService with stubbed profile/outbox dependencies; the pending entry is what submit()+confirm() would have stored.
    const profileStub = { putWorking: async () => {} };
    const svc = new SignupService(profileStub as never, users, undefined, events);
    (svc as unknown as { pending: Map<string, unknown> }).pending.set('ida-hope', { id: 'ida-hope', display_name: 'Ida Hope', email: 'ida@example.invalid', values: {}, salt: 's', hash: 'h', tokenHash: 't', confirmed: true, at: Date.now() });
    await svc.approve(T, 'ida-hope', 'demo-alice');
    const run = await waitForRun(signup, 1);
    assert.equal(run.status, 'completed', JSON.stringify(run));
    assert.equal(run.startedBy, 'event:signup.approved');
    const view = (await ok('GET', `/workflow-runs/${run.id}`)) as { steps: { node_id: string; log: string[] }[] };
    assert.ok(view.steps[0].log.some((l) => l.includes('ida-hope approved (ida@example.invalid)')), 'both placeholders resolved from the approval');
    // The approval creates the user too, which is also a user.created event: the joiner starts as well.
    await waitForRun(joiner, 2);
  });

  it('submitting a sign-up request emits signup.requested and starts its workflow', async () => {
    const reg = ((await ok('POST', '/workflows', { name: 'Registration triage', description: '', trigger: { event: 'signup.requested' }, graph: { nodes: [
      { id: 'tell', type: 'notify', name: 'Tell HR (simulated)', config: { recipient: 'hr', message: 'sign-up request from {{event.subject}} ({{event.email}})' } },
    ], edges: [] } })) as { definition: { id: string } }).definition.id;
    const profileStub = { signupOpen: async () => true, signupValues: async () => ({}) };
    const authnStub = { outbox: { send: async () => {} } };
    const svc = new SignupService(profileStub as never, users, authnStub as never, events);
    await svc.submit(T, { id: 'ron-hope', display_name: 'Ron Hope', email: 'ron@example.invalid', password: 'x'.repeat(12) }, '10.0.0.9');
    const run = await waitForRun(reg, 1);
    assert.equal(run.status, 'completed', JSON.stringify(run));
    assert.equal(run.startedBy, 'event:signup.requested');
    const view = (await ok('GET', `/workflow-runs/${run.id}`)) as { steps: { node_id: string; log: string[] }[] };
    assert.ok(view.steps[0].log.some((l) => l.includes('sign-up request from ron-hope (ron@example.invalid)')), 'subject and email placeholders resolved');
  });

  it('set-profile-field records a value on the run branch only (real data step)', async () => {
    const def = ((await ok('POST', '/workflows', { name: 'Grade on arrival', description: '', trigger: { event: 'user.created', match: { department: 'hr' } }, graph: { nodes: [
      { id: 'grade', type: 'set-profile-field', name: 'Record the entry grade', config: { identity: '{{event.subject}}', field: 'hr-attributes.employee_grade', value: 'G1' } },
    ], edges: [] } })) as { definition: { id: string } }).definition.id;
    sql(`use iam; create table if not exists profile_field_values (tenant varchar(32) not null, subject varchar(32) not null, field_key varchar(80) not null, value json not null, primary key (tenant, subject, field_key)); call dolt_add('profile_field_values'); call dolt_commit('-m','test: profile values table on main')`);
    await users.save('ida-hr', { id: 'ida-hr', display_name: 'Ida Hr', department: 'hr', password: 'x'.repeat(12) }, true, undefined, T);
    const run = await waitForRun(def, 1);
    assert.equal(run.status, 'completed', JSON.stringify(run));
    const onBranch = sql(`select value from iam.profile_field_values as of '${run.branch}' where tenant='${T}' and subject='ida-hr' and field_key='hr-attributes.employee_grade'`);
    assert.ok(onBranch.includes('G1'), `run branch has the recorded grade: ${onBranch}`);
    const onMain = sql(`select count(*) as n from iam.profile_field_values as of 'main' where subject='ida-hr'`);
    assert.ok(onMain.trim().endsWith('0') || onMain.includes('\n0'), `main stays clean: ${onMain}`);
    const view = (await ok('GET', `/workflow-runs/${run.id}`)) as { steps: { node_id: string; log: string[] }[] };
    assert.ok(view.steps[0].log.some((l) => l.includes('recorded and committed')), 'the step logged its real commit');
  });

  it('admin profile edits emit profile.updated; a resolved review emits profile.review-resolved', async () => {
    const onUpdate = ((await ok('POST', '/workflows', { name: 'Profile watch', description: '', trigger: { event: 'profile.updated' }, graph: { nodes: [
      { id: 'tell', type: 'notify', name: 'Log (simulated)', config: { recipient: 'audit', message: '{{event.actor}} edited {{event.subject}}: {{event.keys}}' } },
    ], edges: [] } })) as { definition: { id: string } }).definition.id;
    const onReview = ((await ok('POST', '/workflows', { name: 'Validated profile grants role', description: '', trigger: { event: 'profile.review-resolved', match: { decision: 'accepted' } }, graph: { nodes: [
      { id: 'grant', type: 'assign-role', name: 'Grant employee', config: { identity: '{{event.subject}}', role: 'employee' } },
    ], edges: [] } })) as { definition: { id: string } }).definition.id;
    sql(`use iam; insert ignore into roles values ('employee','Employee (baseline)',0); call dolt_add('roles'); call dolt_commit('-m','test: employee role on main')`);
    const store = new MemoryProfileStore();
    const svc = new ProfileService(undefined as never, store, undefined, undefined, () => true, events);
    (svc as unknown as { subject: () => Promise<void> }).subject = async () => {};
    (svc as unknown as { check: (t: string, r: string, c: string, input: { values: Record<string, string> }) => Promise<Record<string, string>> }).check = async (_t, _r, _c, input) => input.values;
    (svc as unknown as { admin: () => Promise<object> }).admin = async () => ({});
    await svc.patchAdmin(T, 'jane-doe', { values: { 'hr-attributes.employee_grade': 'G4' } }, 'demo-alice');
    const upd = await waitForRun(onUpdate, 1);
    assert.equal(upd.status, 'completed', JSON.stringify(upd));
    const updView = (await ok('GET', `/workflow-runs/${upd.id}`)) as { steps: { node_id: string; log: string[] }[] };
    assert.ok(updView.steps[0].log.some((l) => l.includes('demo-alice edited jane-doe: hr-attributes.employee_grade')), 'actor, subject and keys resolved');
    // The validation workflow: a validator accepts the pending edit of someone else, the run grants the role on its branch.
    await store.putPending(T, 'jane-doe', { 'hr-attributes.phone': '+33 1 00 00 00 00' }, 'jane-doe');
    await svc.resolveReview(T, 'jane-doe', true, 'demo-boss');
    const rev = await waitForRun(onReview, 1);
    assert.equal(rev.status, 'completed', JSON.stringify(rev));
    assert.equal(rev.startedBy, 'event:profile.review-resolved');
    const grant = sql(`select role_id from iam.assignments as of '${rev.branch}' where identity_id='jane-doe'`);
    assert.ok(grant.includes('employee'), `validation run branch grants the role: ${grant}`);
    // A refusal does not match the filter.
    await store.putPending(T, 'jane-doe', { 'hr-attributes.phone': '+33 1 00 00 00 01' }, 'jane-doe');
    await svc.resolveReview(T, 'jane-doe', false, 'demo-boss');
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal((await runsOf(onReview)).length, 1, 'a refused review starts nothing');
  });

  it('joining an organization emits organization.member-added; the match filter picks the org', async () => {
    const fin = ((await ok('POST', '/workflows', { name: 'Finance member', description: '', trigger: { event: 'organization.member-added', match: { organization: 'finance' } }, graph: { nodes: [
      { id: 'grant', type: 'assign-role', name: 'Grant payment-creator', config: { identity: '{{event.subject}}', role: 'payment-creator' } },
      { id: 'tell', type: 'notify', name: 'Inform (simulated)', config: { recipient: 'finance-manager', message: '{{event.subject}} joined finance' } },
    ], edges: [{ from: 'grant', to: 'tell' }] } })) as { definition: { id: string } }).definition.id;
    const orgs = new OrgService({ pluginActive: async () => true } as never, new MemoryOrgStore(), events);
    await orgs.create(T, 'demo-alice', { id: 'finance', name: 'Finance' });
    await orgs.create(T, 'demo-alice', { id: 'sales', name: 'Sales' });
    await orgs.assign(T, 'demo-alice', 'jane-doe', ['sales']);
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal((await runsOf(fin)).length, 0, 'joining sales must not start the finance workflow');
    await orgs.assign(T, 'demo-alice', 'jane-doe', ['sales', 'finance']);
    const run = await waitForRun(fin, 1);
    assert.equal(run.status, 'completed', JSON.stringify(run));
    assert.equal(run.startedBy, 'event:organization.member-added');
    const grant = sql(`select role_id from iam.assignments as of '${run.branch}' where identity_id='jane-doe'`);
    assert.ok(grant.includes('payment-creator'), `run branch has the org-driven grant: ${grant}`);
    // Re-assigning the same set emits nothing new.
    await orgs.assign(T, 'demo-alice', 'jane-doe', ['sales', 'finance']);
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal((await runsOf(fin)).length, 1, 'no new membership, no new run');
  });

  it('while the workflows-iga plugin is disabled, events start nothing (and the API itself 403s)', async () => {
    const before = (await runsOf(joiner)).length;
    await ok('POST', '/plugins/workflows-iga/disable', {});
    await users.save('john-doe', { id: 'john-doe', display_name: 'John Doe', department: 'it', password: 'x'.repeat(12) }, true, undefined, T);
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal((await call('GET', `/workflow-runs?definition=${joiner}`)).status, 403, 'the whole feature is gated while disabled');
    await ok('POST', '/plugins/workflows-iga/enable', {});
    assert.equal((await runsOf(joiner)).length, before, 'no run was started while the plugin was disabled');
    await users.save('jules-doe', { id: 'jules-doe', display_name: 'Jules Doe', department: 'it', password: 'x'.repeat(12) }, true, undefined, T);
    const run = await waitForRun(joiner, before + 1);
    assert.equal(run.status, 'completed');
  });
});
