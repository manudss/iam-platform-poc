import { startTestBus, TestBus } from '../testing/test-bus.js';
// End-to-end with a REAL Dolt SQL server (no Docker, no core): workflow definitions and runs.
// Auth is replaced by a fake that mirrors the real guard's contract (bearer token, tenant claim must equal :tenant),
// because the real one needs the Rust core; the real AdminGuard is used. Skipped if the dolt binary is missing (DOLT_BIN).
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
import { WorkflowsController } from './workflows.controller.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { VersioningModule } from '../versioning/versioning.module.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { WorkflowStore } from './store.js';
import { createConnection } from 'mysql2/promise';
import { VersioningController } from '../versioning/versioning.controller.js';
import { OFFICIAL_TEMPLATES } from './templates-catalog.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { DoltPluginStore } from '../plugins/v1/dolt-stores.js';
import { authPassword, shippedPlugins } from '../plugins/v1/builtin/index.js';
import { BusHost, BusHostRef } from '../plugins/v1/bus-host.js';
import { ApplicationBus } from '../events/application-bus.service.js';
process.env.IAM_WORKFLOW_REAL_CONNECTIONS = '1';   // real connections are off by default on a server; these specs exercise them with fictional values

process.env.WF_CRON_TICK_MS = '2000'; // cron e2e: detect a matching minute within seconds, not 20 s
const root = resolve(process.cwd(), '../..');
const which = spawnSync('sh', ['-c', 'command -v dolt']).stdout.toString().trim();
const doltBin = process.env.DOLT_BIN ?? (which || '/tmp/dolt-linux-amd64/bin/dolt');
const have = existsSync(doltBin);
const PORT = 13431, API = 'http://127.0.0.1:13432', ADMIN = 'test-admin-token-0123456789';
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

interface RunView { run: { id: string; status: string; branch: string | null; error: string | null; simulatedOnly: boolean; test?: boolean }; steps: { node_id: string; status: string; simulated: boolean; attempts: number; log: string[]; input?: Record<string, unknown> | null; output?: Record<string, unknown> | null }[] }

// The harness registry is backed by the DOLT runtime store (like a deployment with a durable store): enablement,
// grants and faults are committed to the base (plugin_runtime_state on main), so an app restart over the same
// base boots with the plugins already enabled and the boot-time resume scan is the normal path - no manual
// re-enable. A memory store (the previous harness) lost the enablement at restart, which forced the old restart
// test to re-enable by hand and re-trigger the scan: an assisted proof, not the production path.
// DIVERGENCE from the flat production factory (plugins-v1.module): that one REFUSES a Dolt store when a shipped
// plugin declares secret settings (SSO plugins do); this harness registers the same shipped list without that
// guard because no secret value is ever written here (nothing SSO is configured). The durability and boot
// ordering under test are identical; the secret-refusal policy itself is not exercised by this suite.
const durablePlugins = async (v: VersioningService, events: ApplicationBus, busRef: BusHostRef): Promise<PluginRegistry> => {
  const ds = new DoltPluginStore(v);
  const r = new PluginRegistry(ds, ds, (e) => console.log(`[plugins] ${JSON.stringify(e)}`), ds);
  for (const p of [authPassword, ...shippedPlugins().slice(1)]) r.register(p);
  await r.load();
  const host = await BusHost.startIfConfigured(async () => r);
  if (!host) throw new Error('event bus required (test bus)');
  r.setBus(host.bridge()); host.attachEvents(events); busRef.host = host;
  return r;
};
const durablePluginsFactory = { factory: durablePlugins, inject: [VersioningService, ApplicationBus, BusHostRef] };

const call = async (method: string, path: string, body?: object, o: { token?: string | null; admin?: string | null } = {}) => {
  const token = o.token === undefined ? `${T}:demo-alice` : o.token;
  const admin = o.admin === undefined ? ADMIN : o.admin;
  const r = await fetch(`${API}/tenants/${T}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(admin ? { 'x-api-admin-token': admin } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json: unknown; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json as never };
};
const ok = async (method: string, path: string, body?: object) => { const r = await call(method, path, body); assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const waitRun = async (id: string, want: string[], timeoutMs = 20000): Promise<RunView> => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = (await ok('GET', `/workflow-runs/${id}`)) as RunView;
    if (want.includes(v.run.status)) return v;
    if (Date.now() > until) throw new Error(`run ${id} still ${v.run.status}, wanted ${want}, error: ${v.run.error}`);
    await new Promise((r) => setTimeout(r, 120));
  }
};
const waitTask = async (runId: string, kind: string, timeoutMs = 30000) => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const inbox = (await ok('GET', '/workflow-tasks?scope=all')) as { tasks: { id: string; kind: string; run_id: string | null; detail: Record<string, unknown> }[] };
    const t = inbox.tasks.find((x) => x.run_id === runId && x.kind === kind);
    if (t) return t;
    if (Date.now() > until) throw new Error(`no ${kind} task for run ${runId} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

describe('workflows API + real Dolt', { skip: !have && 'dolt binary missing' }, () => {
  let dolt: ChildProcess, app: INestApplication, dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-wf-'));
    const home = join(dir, 'home'), data = join(dir, 'data'); mkdirSync(home); mkdirSync(data);
    const env = { ...process.env, HOME: home };
    for (const [k, v] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(doltBin, ['config', '--global', '--add', k, v], { env });
    const seed = spawnSync(doltBin, ['sql'], { cwd: data, env, input: readFileSync(resolve(root, 'data/demo/01-schema.sql')) });
    assert.equal(seed.status, 0, 'seed failed: ' + seed.stderr);
    dolt = spawn(doltBin, ['sql-server', '--host', '127.0.0.1', '--port', String(PORT), '--data-dir', data], { cwd: data, env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      if (spawnSync(doltBin, ['--host', '127.0.0.1', '--port', String(PORT), '--no-tls', '-u', 'root', 'sql', '-q', 'select 1'], { env }).status === 0) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    Object.assign(process.env, { DOLT_PORT: String(PORT), DOLT_DATABASE: 'iam', IAM_API_ADMIN_TOKEN: ADMIN, IAM_API_ADMIN_SUBJECTS: 'demo-alice,admin-two', IAM_API_IGA_SUBJECTS: 'demo-alice,iga-reviewer' });
    delete process.env.IAM_WORKSPACE_MODE;
    const m = await Test.createTestingModule({ imports: [WorkflowsModule, VersioningModule] }).overrideGuard(AuthGuard).useValue(new FakeAuth()).overrideProvider(PluginRegistry).useFactory(durablePluginsFactory).compile();
    app = m.createNestApplication(); await app.init(); await app.listen(13432);
    // The feature is gated by the workflows-iga plugin: disabled by default, every route 403 until an admin enables it.
    assert.equal((await call('GET', '/workflows')).status, 403, 'workflows must be refused while the plugin is disabled');
    await ok('POST', '/plugins/workflows-iga/install', {});
    await ok('POST', '/plugins/workflows-iga/enable', {});
    assert.equal((await call('GET', '/workflows')).status, 200, 'workflows must answer once the plugin is enabled');
    await ok('POST', '/plugins/workflow-connectors/install', {});
    await ok('POST', '/plugins/workflow-connectors/enable', {});
  });
  after(async () => { await app?.close(); dolt?.kill(); await new Promise((r) => setTimeout(r, 800)); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

  it('both guards protect every route (controller level)', () => {
    const guards: unknown[] = Reflect.getMetadata('__guards__', WorkflowsController) ?? [];
    const names = guards.map((g) => (g as { name: string }).name);
    assert.ok(names.includes('AuthGuard') && names.includes('AdminGuard'), `guards: ${names}`);
    const routes = Object.getOwnPropertyNames(WorkflowsController.prototype).filter((n) => n !== 'constructor' && Reflect.getMetadata('path', (WorkflowsController.prototype as never)[n]) !== undefined);
    assert.equal(routes.length, 21);
  });

  it('tenant binding and PII minimization on the REAL API (guard chain + response projections)', async () => {
    // (a) The bearer token's tenant is bound to the route :tenant: a token of another tenant is refused
    // on every surface, EVEN with a valid admin token (the identity binding wins over the capability).
    const foreign = 'other-tenant:demo-alice';
    for (const [m, p, b] of [['GET', '/workflows', undefined], ['POST', '/workflows', { name: 'x', graph: { nodes: [{ id: 'a', type: 'wait', name: 'a', config: {} }], edges: [] } }], ['GET', '/workflow-tasks?scope=all', undefined], ['GET', '/versioning/tables', undefined], ['GET', '/versioning/tables/identities?ref=main', undefined]] as const)
      assert.equal((await call(m, p, b as object | undefined, { token: foreign })).status, 403, `${m} ${p} must refuse another tenant's token`);
    // (b) No token at all is refused; a malformed one too.
    assert.equal((await call('GET', '/workflows', undefined, { token: null })).status, 401);
    assert.equal((await call('GET', '/workflows', undefined, { token: 'garbage' })).status, 401);
    // (c) The raw table browser returns FULL rows (every column a schema adds): it stays behind the
    // admin capability - unlike the workflow/IGA surfaces which project minimal fields (asserted below
    // on the evidence file of the recertification journeys).
    assert.equal((await call('GET', '/versioning/tables/identities?ref=main', undefined, { admin: null })).status, 403, 'raw full-row reads are admin-only');
    const rows = ((await ok('GET', '/versioning/tables/identities?ref=main')) as { rows: Record<string, unknown>[] }).rows;
    assert.ok(rows.length >= 2 && rows.every((r) => r.id && r.display_name !== undefined), 'admin sees the raw rows');
    // (d) The workflow surfaces project: a run view carries no identity profile columns at all.
    const def = (await ok('POST', '/workflows', { name: 'Projection probe', graph: { nodes: [{ id: 'a', type: 'wait', name: 'a', config: { seconds: 0 } }], edges: [] } })) as { definition: { id: string } };
    const started = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    await waitRun(started.run.id, ['completed']);
    const view = (await ok('GET', `/workflow-runs/${started.run.id}`)) as RunView;
    assert.deepEqual(Object.keys(view.run).sort(), ['base_branch', 'branch', 'definition_id', 'edges', 'error', 'finished_at', 'id', 'name', 'order', 'simulatedOnly', 'started_at', 'started_by', 'status', 'tenant', 'test'].sort(), 'the run view is a fixed minimal projection (pinned: a future profile/PII field breaks this)');
    assert.equal(typeof (view.run as unknown as Record<string, unknown>).started_by, 'string', 'started_by is an actor id, never a profile');
    assert.ok(!JSON.stringify(view).includes('display_name') && !JSON.stringify(view).includes('email'), 'no identity profile field leaks into a run view');
  });

  it('read steps PERSIST minimal projections: the step store holds no email/profile by default, logs carry no display name', async () => {
    const def = (await ok('POST', '/workflows', { name: 'Read persistence probe', graph: { nodes: [
      { id: 'r', type: 'lyam-read-user', name: 'read', config: { id: 'demo-bob' } },
      { id: 's', type: 'lyam-search-users', name: 'search', config: { query: 'demo' } },
    ], edges: [{ from: 'r', to: 's' }] } })) as { definition: { id: string } };
    const started = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    await waitRun(started.run.id, ['completed']);
    // Inspect the PERSISTED rows, not the API view: what stays in the store is what a later reader sees.
    const meta = await createConnection({ host: '127.0.0.1', port: PORT, user: 'root', database: 'iam_meta', dateStrings: true });
    try {
      const [rows] = await meta.query('select node_id, output, log from workflow_steps where run_id = ?', [started.run.id]);
      const byNode = new Map((rows as { node_id: string; output: unknown; log: unknown }[]).map((r) => [r.node_id, r]));
      const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown>;
      const readOut = parse(byNode.get('r')!.output);
      assert.ok(!('email' in readOut) && !('profileFields' in readOut), 'read-user persisted output: no email, no profile values');
      assert.deepEqual(Object.keys(readOut).sort(), ['department', 'displayName', 'id', 'loginEnabled', 'manager', 'roles'].sort());
      const searchOut = parse(byNode.get('s')!.output);
      for (const u of searchOut.users as Record<string, unknown>[]) assert.ok(!('email' in u), 'search persisted output: no emails');
      const logs = JSON.stringify(parse(byNode.get('r')!.log) as unknown);
      assert.ok(!logs.includes('Bob Demo') && !logs.includes('demo-bob ('), 'the persisted log carries no display name');
    } finally { await meta.end(); }
  });

  it('refuses an invalid graph (cycle, unknown type) and an unknown field', async () => {
    const bad = (g: object) => call('POST', '/workflows', { name: 'x', graph: g });
    assert.equal((await bad({ nodes: [{ id: 'a', type: 'wait', name: 'a', config: {} }, { id: 'b', type: 'wait', name: 'b', config: {} }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] })).status, 400);
    assert.equal((await bad({ nodes: [{ id: 'a', type: 'hack', name: 'a', config: {} }], edges: [] })).status, 400);
    assert.equal((await call('POST', '/workflows', { name: 'x', evil: true, graph: { nodes: [{ id: 'a', type: 'wait', name: 'a', config: {} }], edges: [] } })).status, 400);
  });

  it('simulated run: wait + notify complete, nothing sent, no branch, review refused', async () => {
    const def = (await ok('POST', '/workflows', { name: 'Simulated only', description: 'demo', graph: { nodes: [
      { id: 'w', type: 'wait', name: 'Wait a bit', config: { seconds: 1 } },
      { id: 'n', type: 'notify', name: 'Notify the manager', config: { recipient: 'manager-of:demo-bob', message: 'done' } },
    ], edges: [{ from: 'w', to: 'n' }] } })) as { definition: { id: string } };
    const started = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    assert.equal(started.run.simulatedOnly, true);
    const v = await waitRun(started.run.id, ['completed']);
    assert.equal(v.run.branch, null);
    assert.deepEqual(v.steps.map((s) => s.status), ['done', 'done']);
    assert.ok(v.steps.every((s) => s.simulated));
    assert.ok(v.steps[1].log.some((l) => l.includes('nothing was sent')));
    assert.equal((await call('POST', `/workflow-runs/${started.run.id}/review`)).status, 400); // no data branch to review
  });

  it('test-run from the editor: ad-hoc branching graph, disposable branch, hidden from the default list', async () => {
    const started = (await ok('POST', '/workflows/test-run', { graph: { nodes: [
      { id: 'cond', type: 'if', name: 'Department is finance?', config: { left: '{{event.to}}', op: 'equals', right: 'finance' } },
      { id: 't', type: 'notify', name: 'finance path', config: { recipient: 'fin', message: 'yes' } },
      { id: 'f', type: 'notify', name: 'other path', config: { recipient: 'hr', message: 'no' } },
    ], edges: [{ from: 'cond', to: 't', label: 'true' }, { from: 'cond', to: 'f', label: 'false' }] }, trigger: { event: 'user.department-changed' }, payload: { subject: 'demo-bob', to: 'finance' } })) as RunView;
    assert.equal(started.run.test, true);
    const v = await waitRun(started.run.id, ['completed']);
    const byId = Object.fromEntries(v.steps.map((s) => [s.node_id, s]));
    assert.equal(byId['t'].status, 'done');
    assert.equal(byId['f'].status, 'skipped');
    assert.equal((byId['cond'] as { input?: { left?: string } }).input?.left, 'finance'); // the resolved input is recorded
    assert.ok(!((await ok('GET', '/workflow-runs')) as { runs: { id: string }[] }).runs.some((r) => r.id === started.run.id), 'test runs are hidden by default');
    assert.ok(((await ok('GET', '/workflow-runs?tests=1')) as { runs: { id: string }[] }).runs.some((r) => r.id === started.run.id));
    assert.equal((await call('POST', `/workflow-runs/${started.run.id}/review`)).status, 400); // a test run is never reviewed
  });

  it('error link: a failing step routes to its error path, the run completes', async () => {
    const started = (await ok('POST', '/workflows/test-run', { graph: { nodes: [
      { id: 'risky', type: 'fail', name: 'always fails', config: { mode: 'always', message: 'boom' } },
      { id: 'rescue', type: 'notify', name: 'caught', config: { recipient: 'hr', message: 'handled' } },
    ], edges: [{ from: 'risky', to: 'rescue', label: 'error' }] } })) as RunView;
    const v = await waitRun(started.run.id, ['completed']);
    const byId = Object.fromEntries(v.steps.map((s) => [s.node_id, s]));
    assert.equal(byId['risky'].status, 'failed');
    assert.equal(byId['rescue'].status, 'done');
  });

  it('duplicate + re-run from a step', async () => {
    const def = (await ok('POST', '/workflows', { name: 'Rerun source', graph: { nodes: [
      { id: 'w', type: 'wait', name: 'w', config: { seconds: 0 } },
      { id: 'o', type: 'fail', name: 'fails once', config: {} },
      { id: 'n', type: 'notify', name: 'n', config: { recipient: 'hr', message: 'done' } },
    ], edges: [{ from: 'w', to: 'o' }, { from: 'o', to: 'n' }] } })) as { definition: { id: string } };
    const dup = (await ok('POST', `/workflows/${def.definition.id}/duplicate`)) as { definition: { id: string; name: string } };
    assert.match(dup.definition.name, /\(copy\)$/);
    const started = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    const v1 = await waitRun(started.run.id, ['failed']); // fail step fails on its first attempt
    assert.equal((await call('POST', `/workflow-runs/${started.run.id}/rerun-from/ghost`)).status, 404); // unknown step: not found
    await ok('POST', `/workflow-runs/${started.run.id}/rerun-from/o`);
    const v2 = await waitRun(started.run.id, ['completed']); // fail recovers on retry (demo convention)
    const byId = Object.fromEntries(v2.steps.map((s) => [s.node_id, s]));
    assert.equal(byId['w'].attempts, 1); // upstream of the re-run point: untouched
    assert.equal(byId['o'].attempts, 2);
    assert.equal(byId['n'].status, 'done');
    void v1;
  });

  it('plugin disabled mid-run: the run in flight finishes, every route answers 403 until re-enabled', async () => {
    const def = (await ok('POST', '/workflows', { name: 'In flight while disabled', graph: { nodes: [
      { id: 'w', type: 'wait', name: 'slow', config: { seconds: 2 } },
      { id: 'n', type: 'notify', name: 'after', config: { recipient: 'hr', message: 'hi' } },
    ], edges: [{ from: 'w', to: 'n' }] } })) as { definition: { id: string } };
    const started = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    await ok('POST', '/plugins/workflows-iga/disable');
    try {
      assert.equal((await call('GET', '/workflows')).status, 403);
      assert.equal((await call('GET', `/workflow-runs/${started.run.id}`)).status, 403);
      assert.equal((await call('POST', `/workflows/${def.definition.id}/runs`, {})).status, 403);
      // documented choice: a run already executing is left to finish (its data stays on its own branch)
      await new Promise((r) => setTimeout(r, 3000));
    } finally {
      await ok('POST', '/plugins/workflows-iga/enable', {});
    }
    const v = await waitRun(started.run.id, ['completed']);
    assert.deepEqual(v.steps.map((s) => s.status), ['done', 'done']);
  });

  it('data run: assignment lands on the run branch only, review opens a Dolt PR, main changes only on merge', async () => {
    const def = (await ok('POST', '/workflows', { name: 'Grant accountant', graph: { nodes: [
      { id: 'g', type: 'assign-role', name: 'Make demo-bob accountant', config: { identity: 'demo-bob', role: 'accountant' } },
    ], edges: [] } })) as { definition: { id: string } };
    const started = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    const v = await waitRun(started.run.id, ['completed']);
    assert.match(v.run.branch ?? '', /^workflow\/[0-9a-f]{8}$/);
    assert.equal(v.steps[0].simulated, false);
    assert.ok(v.steps[0].log.some((l) => l.includes('commit')));
    // "Open the row in Data": the write is recorded in the step output (table + primary key)
    assert.deepEqual((v.steps[0].output as { dataRow?: unknown }).dataRow, { table: 'assignments', pk: { identity_id: 'demo-bob', role_id: 'accountant' } });
    // main untouched: only the seeded assignments
    const rows = (await ok('GET', '/versioning/tables/assignments?ref=main')) as { rows: unknown[] };
    assert.equal(rows.rows.length, 4);
    const onBranch = (await ok('GET', `/versioning/tables/assignments?ref=${v.run.branch}`)) as { rows: unknown[] };
    assert.equal(onBranch.rows.length, 5);
    // review opens a pull request, reused on a second call, merge applies to main
    const pr = (await ok('POST', `/workflow-runs/${started.run.id}/review`)) as { pullRequest: { id: number; source: string }; reused: boolean };
    assert.equal(pr.pullRequest.source, v.run.branch);
    const again = (await ok('POST', `/workflow-runs/${started.run.id}/review`)) as { reused: boolean };
    assert.equal(again.reused, true);
    const merged = await call('POST', `/versioning/pulls/${pr.pullRequest.id}/merge`);
    assert.ok(merged.status < 300, JSON.stringify(merged.body));
    const after = (await ok('GET', '/versioning/tables/assignments?ref=main')) as { rows: unknown[] };
    assert.equal(after.rows.length, 5);
  });

  it('lyam-grant-assignment refuses a SoD-conflicting grant BEFORE any write (no branch, no commit)', async () => {
    const def = (await ok('POST', '/workflows', { name: 'Grant conflict', graph: { nodes: [
      { id: 'g', type: 'lyam-grant-assignment', name: 'Grant payment-approver', config: { identity: 'demo-bob', role: 'payment-approver' } },
    ], edges: [] } })) as { definition: { id: string } };
    const before = ((await ok('GET', '/versioning/tables/assignments?ref=main')) as { rows: unknown[] }).rows.length;
    const started = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    const v = await waitRun(started.run.id, ['failed']);
    assert.match(v.run.error ?? '', /segregation of duties/, 'demo-bob already holds payment-creator: the grant is refused before the write');
    assert.match(v.run.error ?? '', /BEFORE any write/);
    // Nothing was written: main is unchanged, and the lazily created branch carries no assignment either.
    const rows = (await ok('GET', '/versioning/tables/assignments?ref=main')) as { rows: unknown[] };
    assert.equal(rows.rows.length, before, 'main untouched');
    if (v.run.branch) {
      const onBranch = (await ok('GET', `/versioning/tables/assignments?ref=${v.run.branch}`)) as { rows: unknown[] };
      assert.equal(onBranch.rows.length, before, 'the refusal happened before any write: the branch carries no assignment');
    }
  });

  it('SoD conflict produced by a run is logged and refused at merge', async () => {
    const def = (await ok('POST', '/workflows', { name: 'Conflict on purpose', graph: { nodes: [
      { id: 'g', type: 'assign-role', name: 'Give approver to the creator', config: { identity: 'demo-bob', role: 'payment-approver' } },
    ], edges: [] } })) as { definition: { id: string } };
    const started = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    const v = await waitRun(started.run.id, ['completed']);
    assert.ok(v.steps[0].log.some((l) => l.includes('SoD conflict')));
    const pr = (await ok('POST', `/workflow-runs/${started.run.id}/review`)) as { pullRequest: { id: number } };
    const merged = await call('POST', `/versioning/pulls/${pr.pullRequest.id}/merge`);
    assert.equal(merged.status, 409);
  });

  it('failing step: run failed, later steps skipped, retry re-runs from the failed step', async () => {
    const def = (await ok('POST', '/workflows', { name: 'Goes wrong', graph: { nodes: [
      { id: 'w', type: 'wait', name: 'ok first', config: { seconds: 0 } },
      { id: 'f', type: 'fail', name: 'breaks', config: { message: 'boom for the demo' } },
      { id: 'n', type: 'notify', name: 'never reached', config: { recipient: 'x', message: 'y' } },
    ], edges: [{ from: 'w', to: 'f' }, { from: 'f', to: 'n' }] } })) as { definition: { id: string } };
    const started = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    const v = await waitRun(started.run.id, ['failed']);
    assert.deepEqual(v.steps.map((s) => s.status), ['done', 'failed', 'skipped']);
    assert.ok((v.run.error ?? '').includes('boom for the demo'));
    assert.equal((await call('POST', `/workflow-runs/${started.run.id}/review`)).status, 409); // only completed runs
    // retry: the failed step is attempted again (attempts 2) and recovers (default mode "once"), the run completes
    await ok('POST', `/workflow-runs/${started.run.id}/retry`);
    const v2 = await waitRun(started.run.id, ['completed']);
    assert.equal(v2.steps[1].attempts, 2);
    assert.deepEqual(v2.steps.map((s) => s.status), ['done', 'done', 'done']);
    assert.ok(v2.steps[1].log.some((l) => l.includes('SIMULATED recovery')));
  });

  it('fail mode "always": the step keeps failing on retry, the run stays failed', async () => {
    const def = (await ok('POST', '/workflows', { name: 'Always broken', graph: { nodes: [
      { id: 'f', type: 'fail', name: 'never recovers', config: { message: 'down for good', mode: 'always' } },
    ], edges: [] } })) as { definition: { id: string } };
    const started = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    await waitRun(started.run.id, ['failed']);
    await ok('POST', `/workflow-runs/${started.run.id}/retry`);
    const v = await waitRun(started.run.id, ['failed']);
    assert.equal(v.steps[0].attempts, 2);
    assert.ok((v.run.error ?? '').includes('down for good'));
  });

  it('data step failure: unknown role fails the run, the branch keeps earlier commits only', async () => {
    const def = (await ok('POST', '/workflows', { name: 'Two data steps, second breaks', graph: { nodes: [
      { id: 'g', type: 'assign-role', name: 'valid', config: { identity: 'demo-bob', role: 'accountant' } },
      { id: 'h', type: 'assign-role', name: 'invalid', config: { identity: 'demo-bob', role: 'no-such-role' } },
    ], edges: [{ from: 'g', to: 'h' }] } })) as { definition: { id: string } };
    const started = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    const v = await waitRun(started.run.id, ['failed']);
    assert.deepEqual(v.steps.map((s) => s.status), ['done', 'failed']);
    assert.ok((v.run.error ?? '').includes('unknown role'));
    const onBranch = (await ok('GET', `/versioning/tables/assignments?ref=${v.run.branch}`)) as { rows: unknown[] };
    assert.equal(onBranch.rows.length, 5); // seed (4) + first commit kept, nothing half-written by the failed step
  });

  it('cancel stops a waiting run', async () => {
    const def = (await ok('POST', '/workflows', { name: 'Long wait', graph: { nodes: [
      { id: 'w', type: 'wait', name: 'slow', config: { seconds: 30 } },
      { id: 'n', type: 'notify', name: 'after', config: { recipient: 'x', message: 'y' } },
    ], edges: [{ from: 'w', to: 'n' }] } })) as { definition: { id: string } };
    const started = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    await waitRun(started.run.id, ['running'], 5000).catch(() => undefined);
    await ok('POST', `/workflow-runs/${started.run.id}/cancel`);
    const v = await waitRun(started.run.id, ['canceled']);
    assert.equal(v.run.status, 'canceled');
  });

  it('cancel also cancels the durable approval task (the task service is really injected, not undefined)', async () => {
    const def = (await ok('POST', '/workflows', { name: 'Approval wait', graph: { nodes: [
      { id: 'a', type: 'lyam-request-approval', name: 'approve', config: { title: 'Go?', assignee: 'admin' } },
    ], edges: [] } })) as { definition: { id: string } };
    const started = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    await waitRun(started.run.id, ['waiting']);
    const before = (await ok('GET', '/workflow-tasks?scope=all')) as { tasks: { id: string; status: string; run_id: string | null }[] };
    const task = before.tasks.find((t) => t.run_id === started.run.id);
    assert.ok(task, 'a durable approval task was opened by the waiting block');
    assert.equal(task!.status, 'open');
    await ok('POST', `/workflow-runs/${started.run.id}/cancel`);
    await waitRun(started.run.id, ['canceled']);
    const after = (await ok('GET', '/workflow-tasks?scope=all&status=all')) as { tasks: { id: string; status: string }[] };
    assert.equal(after.tasks.find((t) => t.id === task!.id)!.status, 'canceled', 'canceling the run canceled its task: no orphan approval');
  });

  it('recertification journey: campaign > review task > pool decision > resume > strict close (real Dolt)', async () => {
    const def = (await ok('POST', '/workflows', { name: 'Recert journey', graph: { nodes: [
      { id: 'c1', type: 'iga-create-campaign', name: 'campaign', config: { name: 'Q4 recert demo-bob', users: 'demo-bob', ref: 'main' } },
      { id: 'c2', type: 'iga-open-review-tasks', name: 'open', config: { campaignId: '{{steps.c1.id}}', assignTo: 'iga' } },
      { id: 'c3', type: 'iga-await-decisions', name: 'await', config: { campaignId: '{{steps.c1.id}}' } },
      { id: 'c4', type: 'iga-close-campaign', name: 'close', config: { campaignId: '{{steps.c1.id}}' } },
    ], edges: [{ from: 'c1', to: 'c2' }, { from: 'c2', to: 'c3' }, { from: 'c3', to: 'c4' }] } })) as { definition: { id: string } };
    const started = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    await waitRun(started.run.id, ['waiting']);
    const inbox = (await ok('GET', '/workflow-tasks?scope=all')) as { tasks: { id: string; kind: string; assignee: string; run_id: string | null; detail: Record<string, unknown> }[] };
    const review = inbox.tasks.find((t) => t.run_id === started.run.id && t.kind === 'iga-review');
    assert.ok(review, 'the review task exists');
    assert.equal(review!.assignee, 'demo-alice', 'the iga pool resolves to its first member for the inbox');
    const selfDecide = await call('POST', `/workflow-tasks/${review!.id}/decision`, { decision: 'approved' });
    assert.equal(selfDecide.status, 403, 'the run starter never decides (anti-self-approval)');
    const decidedCall = await call('POST', `/workflow-tasks/${review!.id}/decision`, { decision: 'approved' }, { token: `${T}:iga-reviewer` });
    assert.ok(decidedCall.status < 300, JSON.stringify(decidedCall.body).slice(0, 200));
    const decided = decidedCall.body as { status: string; decided_by: string };
    assert.equal(decided.decided_by, 'iga-reviewer', 'another pool member decided');
    const v = await waitRun(started.run.id, ['completed']);
    const closeStep = v.steps.find((st) => st.node_id === 'c4')!;
    assert.equal(closeStep.status, 'done');
    const evidence = (closeStep.output as Record<string, unknown>)?.evidence as Record<string, unknown>;
    assert.ok(typeof evidence?.digest === 'string' && (evidence.digest as string).length === 64, 'the closing evidence carries its digest');
    assert.equal((evidence?.totals as Record<string, unknown>)?.approved, 1);
    assert.equal((await ok('GET', `/workflow-tasks?scope=all`) as never as { tasks: { status: string }[] }).tasks.filter((t) => t.status === 'open').length, 0, 'no open task remains');
  });

  it('recertification with denial: revoke on branch, real publication (PR merged), remediation verified, close', async () => {
    const def = (await ok('POST', '/workflows', { name: 'Recert denial journey', graph: { nodes: [
      { id: 'c1', type: 'iga-create-campaign', name: 'campaign', config: { name: 'Denial recert demo-bob', users: 'demo-bob', ref: 'main' } },
      { id: 'c2', type: 'iga-open-review-tasks', name: 'open', config: { campaignId: '{{steps.c1.id}}', assignTo: 'iga' } },
      { id: 'c3', type: 'iga-await-decisions', name: 'await', config: { campaignId: '{{steps.c1.id}}' } },
      { id: 'c4', type: 'iga-prepare-remediation', name: 'prepare', config: { campaignId: '{{steps.c1.id}}' } },
      // The campaign snapshot carries EVERY role demo-bob holds on main at start (earlier tests grant
      // 'accountant' and merge it): the remediation must revoke each denied role, not just one.
      { id: 'c5', type: 'lyam-revoke-assignment', name: 'revoke', config: { identity: 'demo-bob', role: 'payment-creator' } },
      { id: 'c5b', type: 'lyam-revoke-assignment', name: 'revoke accountant', config: { identity: 'demo-bob', role: 'accountant' } },
      { id: 'c6', type: 'lyam-request-publish', name: 'publish', config: { title: 'Revoke payment-creator from demo-bob' } },
      { id: 'c7', type: 'iga-mark-remediated', name: 'remediated', config: { campaignId: '{{steps.c1.id}}', item: 'demo-bob', note: 'revoked and published' } },
      { id: 'c8', type: 'iga-close-campaign', name: 'close', config: { campaignId: '{{steps.c1.id}}' } },
    ], edges: [{ from: 'c1', to: 'c2' }, { from: 'c2', to: 'c3' }, { from: 'c3', to: 'c4' }, { from: 'c4', to: 'c5' }, { from: 'c5', to: 'c5b' }, { from: 'c5b', to: 'c6' }, { from: 'c6', to: 'c7' }, { from: 'c7', to: 'c8' }] } })) as { definition: { id: string } };
    const started = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    await waitRun(started.run.id, ['waiting']);
    const inbox1 = (await ok('GET', '/workflow-tasks?scope=all')) as { tasks: { id: string; kind: string; run_id: string | null }[] };
    const review = inbox1.tasks.find((t) => t.run_id === started.run.id && t.kind === 'iga-review')!;
    const denied = await call('POST', `/workflow-tasks/${review.id}/decision`, { decision: 'denied', justification: 'no longer needed for the job' }, { token: `${T}:iga-reviewer` });
    assert.ok(denied.status < 300, JSON.stringify(denied.body).slice(0, 200));
    // The resume is kicked asynchronously: wait for the publish-approval task itself (the stale
    // 'waiting' state from the review step would otherwise win the race).
    const approval = await waitTask(started.run.id, 'publish-approval');
    await waitRun(started.run.id, ['waiting'], 30000); // c4 prepare > c5 revoke on branch > c6 publishes and waits
    const prId = Number((approval.detail.pr as Record<string, unknown>).id);
    const selfPub = await call('POST', `/workflow-tasks/${approval.id}/decision`, { decision: 'approved' });
    assert.equal(selfPub.status, 403, 'the run starter never approves the publication');
    const approved = await call('POST', `/workflow-tasks/${approval.id}/decision`, { decision: 'approved' }, { token: `${T}:admin-two` });
    assert.ok(approved.status < 300, JSON.stringify(approved.body).slice(0, 200));
    const watch = await waitTask(started.run.id, 'publish-merge-watch'); // created when the approved publication observes the PR still open
    let v = await ok('GET', `/workflow-runs/${started.run.id}`) as RunView;
    assert.equal(v.run.status, 'waiting', 'the approval alone does NOT finish the publication: the PR is still open');
    // The actual merge is what lands the publication (a contradicted "merged" marking is covered by the unit spec).
    const merged = await call('POST', `/versioning/pulls/${prId}/merge`, {}, { token: `${T}:demo-alice` });
    assert.ok(merged.status < 300, JSON.stringify(merged.body).slice(0, 300));
    const marked = await call('POST', `/workflow-tasks/${watch!.id}/decision`, { decision: 'merged', justification: 'merged after review' }, { token: `${T}:admin-two` });
    assert.ok(marked.status < 300, JSON.stringify(marked.body).slice(0, 200));
    await waitRun(started.run.id, ['completed'], 30000);
    v = await ok('GET', `/workflow-runs/${started.run.id}`) as RunView;
    const step = (id: string) => v.steps.find((st) => st.node_id === id)!;
    assert.equal((step('c5').output as Record<string, unknown>).revoked, true, 'the revocation really ran on the branch');
    assert.equal((step('c6').output as Record<string, unknown>).merged, true, 'publication = real merge, not the approval');
    assert.equal((step('c7').output as Record<string, unknown>).state, 'remediated', 'remediation verified effective on main');
    const evidence = (step('c8').output as Record<string, unknown>).evidence as Record<string, unknown>;
    assert.equal((evidence.totals as Record<string, unknown>).remediated, 1);
  });

  // The journeys below run the REAL catalog template graph (never a hand-copied lookalike): only the
  // campaign scope placeholder is parameterized with the fictional identities, so a template drift breaks them.
  const templateGraph = (users: string) => {
    const t = OFFICIAL_TEMPLATES.find((x) => x.id === 'recertification-denial-remediation')!;
    return JSON.parse(JSON.stringify({ nodes: t.nodes, edges: t.edges }).replaceAll('replace-with-user-id', users)) as { nodes: { id: string; type: string; name: string; config: Record<string, unknown> }[]; edges: { from: string; to: string; label?: string }[] };
  };

  it('recertification mixed: the APPROVED identity keeps every right, only the denied one is remediated', async () => {
    // Isolated fixture: bob MUST hold at least one role, whatever the suite order, so the denial below
    // can never pass without a real revocation and a real publication. Granted through the normal path.
    const held0 = ((await ok('GET', '/versioning/tables/assignments?ref=main')) as { rows: { identity_id: string; role_id: string }[] }).rows.filter((r) => r.identity_id === 'demo-bob').map((r) => r.role_id);
    const fixtureRole = ['accountant', 'payment-approver'].find((r) => !held0.includes(r) && !(r === 'payment-approver' && held0.includes('payment-creator')));
    assert.ok(fixtureRole, `no SoD-safe fixture role available (bob holds ${held0.join(',')})`);
    const grantDef = (await ok('POST', '/workflows', { name: 'Mixed fixture grant', graph: { nodes: [
      { id: 'grant', type: 'lyam-grant-assignment', name: 'grant', config: { identity: 'demo-bob', role: fixtureRole } },
      { id: 'publish', type: 'lyam-request-publish', name: 'publish', config: { title: 'Mixed fixture' } },
    ], edges: [{ from: 'grant', to: 'publish' }] } })) as { definition: { id: string } };
    const grantRun = (await ok('POST', `/workflows/${grantDef.definition.id}/runs`)) as RunView;
    const gApproval = await waitTask(grantRun.run.id, 'publish-approval');
    const gPr = Number((gApproval.detail.pr as Record<string, unknown>).id);
    assert.ok((await call('POST', `/workflow-tasks/${gApproval.id}/decision`, { decision: 'approved' }, { token: `${T}:admin-two` })).status < 300);
    const gWatch = await waitTask(grantRun.run.id, 'publish-merge-watch');
    assert.ok((await call('POST', `/versioning/pulls/${gPr}/merge`, {}, { token: `${T}:demo-alice` })).status < 300);
    assert.ok((await call('POST', `/workflow-tasks/${gWatch.id}/decision`, { decision: 'merged', justification: 'merged' }, { token: `${T}:admin-two` })).status < 300);
    await waitRun(grantRun.run.id, ['completed'], 30000);
    const before = ((await ok('GET', '/versioning/tables/assignments?ref=main')) as { rows: { identity_id: string; role_id: string }[] }).rows;
    const bobRoles = before.filter((r) => r.identity_id === 'demo-bob').map((r) => r.role_id).sort();
    assert.ok(bobRoles.length >= 1, 'the denied identity holds at least one role: the journey must revoke and publish for real');
    const aliceRoles = before.filter((r) => r.identity_id === 'demo-alice').map((r) => r.role_id).sort();
    assert.ok(aliceRoles.length >= 3, 'alice still holds her seeded roles at this point of the suite');
    const def = (await ok('POST', '/workflows', { name: 'Recert mixed', graph: templateGraph('demo-bob,demo-alice') })) as { definition: { id: string } };
    const started = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    await waitRun(started.run.id, ['waiting']);
    const inbox = (await ok('GET', '/workflow-tasks?scope=all')) as { tasks: { id: string; kind: string; run_id: string | null; detail: Record<string, unknown> }[] };
    const reviews = inbox.tasks.filter((t) => t.run_id === started.run.id && t.kind === 'iga-review');
    assert.equal(reviews.length, 2);
    for (const r of reviews) {
      const approvedOne = r.detail.identity === 'demo-alice';
      const d = await call('POST', `/workflow-tasks/${r.id}/decision`, { decision: approvedOne ? 'approved' : 'denied', justification: approvedOne ? 'still needed' : 'no longer needed' }, { token: `${T}:iga-reviewer` });
      assert.ok(d.status < 300, JSON.stringify(d.body).slice(0, 200));
    }
    // If the denied identity holds no role (suite-order dependent), there is nothing to publish:
    // the publish step must SKIP explicitly; otherwise a real approval + merge drives the publication.
    const deadline = Date.now() + 30000;
    let published = false;
    for (;;) {
      const inboxNow = (await ok('GET', '/workflow-tasks?scope=all')) as { tasks: { id: string; kind: string; run_id: string | null }[] };
      const approval = inboxNow.tasks.find((t) => t.run_id === started.run.id && t.kind === 'publish-approval' && true);
      if (approval) {
        const prId = Number(((approval as { detail?: Record<string, unknown> }).detail!.pr as Record<string, unknown>).id);
        assert.ok((await call('POST', `/workflow-tasks/${approval.id}/decision`, { decision: 'approved' }, { token: `${T}:admin-two` })).status < 300);
        const watch = await waitTask(started.run.id, 'publish-merge-watch');
        assert.ok((await call('POST', `/versioning/pulls/${prId}/merge`, {}, { token: `${T}:demo-alice` })).status < 300);
        assert.ok((await call('POST', `/workflow-tasks/${watch.id}/decision`, { decision: 'merged', justification: 'merged after review' }, { token: `${T}:admin-two` })).status < 300);
        published = true;
        break;
      }
      const cur = (await ok('GET', `/workflow-runs/${started.run.id}`)) as RunView;
      const pub = cur.steps.find((x) => x.node_id === 'publish');
      if (pub?.status === 'done' && (pub.output as Record<string, unknown>).skipped) break; // nothing to publish: legitimate
      if (Date.now() > deadline) throw new Error('neither a publish-approval task nor a skipped publish step');
      await new Promise((r) => setTimeout(r, 500));
    }
    await waitRun(started.run.id, ['completed'], 30000);
    assert.equal(published, true, 'bob held a role: the publication MUST have happened (no silent skip)');
    const v = (await ok('GET', `/workflow-runs/${started.run.id}`)) as RunView;
    assert.equal(((v.steps.find((x) => x.node_id === 'publish')!.output as Record<string, unknown>).skipped ?? false), !published, 'publish happened exactly when there was something to publish');
    const evidence = (v.steps.find((x) => x.node_id === 'close')!.output as Record<string, unknown>).evidence as Record<string, unknown>;
    assert.equal((evidence.totals as Record<string, unknown>).remediated, 1, 'only the denied identity was remediated');
    const after = ((await ok('GET', '/versioning/tables/assignments?ref=main')) as { rows: { identity_id: string; role_id: string }[] }).rows;
    assert.deepEqual(after.filter((r) => r.identity_id === 'demo-alice').map((r) => r.role_id).sort(), aliceRoles, 'APPROVED: demo-alice keeps every role, exactly as before');
    for (const role of bobRoles) assert.ok(!after.some((r) => r.identity_id === 'demo-bob' && r.role_id === role), `denied: ${role} really revoked on main`);
  });

  it('recertification template shape: conditional denial branch, remediation LOOPS over several identities and roles', async () => {
    // Same graph as the catalog template, parameterized for two identities. demo-alice holds 3 roles,
    // demo-bob 1-2 (earlier tests may have merged 'accountant'): the loops must cover them ALL.
    const def = (await ok('POST', '/workflows', { name: 'Recert loop journey', graph: templateGraph('demo-bob,demo-alice') })) as { definition: { id: string } };
    const started = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    await waitRun(started.run.id, ['waiting']);
    const inbox1 = (await ok('GET', '/workflow-tasks?scope=all')) as { tasks: { id: string; kind: string; run_id: string | null }[] };
    const reviews = inbox1.tasks.filter((t) => t.run_id === started.run.id && t.kind === 'iga-review');
    assert.equal(reviews.length, 2, 'one review task per identity');
    for (const r of reviews) {
      const d = await call('POST', `/workflow-tasks/${r.id}/decision`, { decision: 'denied', justification: 'no longer needed' }, { token: `${T}:iga-reviewer` });
      assert.ok(d.status < 300, JSON.stringify(d.body).slice(0, 200));
    }
    const approval = await waitTask(started.run.id, 'publish-approval');
    const prId = Number((approval.detail.pr as Record<string, unknown>).id);
    // All prepared actions really ran on the branch, for BOTH identities.
    const mid = (await ok('GET', `/workflow-runs/${started.run.id}`)) as RunView;
    const prep = (mid.steps.find((x) => x.node_id === 'prepare')!.output as Record<string, unknown>);
    const actions = prep.actions as { identity: string; role: string }[];
    // Earlier journeys may already have revoked/merged some of bob's roles: expect exactly the roles
    // each identity still holds on main right now (alice's seeded 3 at minimum).
    const current = ((await ok('GET', '/versioning/tables/assignments?ref=main')) as { rows: { identity_id: string; role_id: string }[] }).rows
      .filter((r) => r.identity_id === 'demo-bob' || r.identity_id === 'demo-alice');
    assert.ok(current.length >= 3, 'alice keeps her 3 seeded roles in every suite order');
    const pairs = (l: { identity: string; role: string }[]) => l.map((a) => ({ identity: a.identity, role: a.role })).sort((a, b) => (a.identity + a.role).localeCompare(b.identity + b.role));
    assert.deepEqual(pairs(actions), pairs(current.map((r) => ({ identity: r.identity_id, role: r.role_id }))), 'every role still held by a denied identity is prepared, nothing more');
    assert.ok((prep.conflicts as number) === 0, 'no snapshot conflict in this journey');
    const approved = await call('POST', `/workflow-tasks/${approval.id}/decision`, { decision: 'approved' }, { token: `${T}:admin-two` });
    assert.ok(approved.status < 300, JSON.stringify(approved.body).slice(0, 200));
    const watch = await waitTask(started.run.id, 'publish-merge-watch');
    const merged = await call('POST', `/versioning/pulls/${prId}/merge`, {}, { token: `${T}:demo-alice` });
    assert.ok(merged.status < 300, JSON.stringify(merged.body).slice(0, 300));
    const marked = await call('POST', `/workflow-tasks/${watch.id}/decision`, { decision: 'merged', justification: 'merged after review' }, { token: `${T}:admin-two` });
    assert.ok(marked.status < 300, JSON.stringify(marked.body).slice(0, 200));
    await waitRun(started.run.id, ['completed'], 30000);
    const v = (await ok('GET', `/workflow-runs/${started.run.id}`)) as RunView;
    const step = (id: string) => v.steps.find((st) => st.node_id === id)!;
    assert.equal((step('any').output as Record<string, unknown>).branch, 'true', 'the denial branch was taken');
    assert.equal((step('revloop').status), 'done');
    assert.equal(((step('revoke').output as Record<string, unknown>)!).revoked, true);
    const evidence = (step('close').output as Record<string, unknown>).evidence as Record<string, unknown>;
    assert.equal((evidence.totals as Record<string, unknown>).remediated, 2, 'both denied identities remediated');
    // Effective on main: none of the denied roles remains assigned.
    const rows = ((await ok('GET', '/versioning/tables/assignments?ref=main')) as { rows: { identity_id: string; role_id: string }[] }).rows;
    for (const a of actions) assert.ok(!rows.some((r) => r.identity_id === a.identity && r.role_id === a.role), `${a.identity} still holds ${a.role} on main`);
  });

  it('recertification approved everywhere: no branch, no pull request, straight to the close', async () => {
    const def = (await ok('POST', '/workflows', { name: 'Recert all approved', graph: templateGraph('demo-bob') })) as { definition: { id: string } };
    const started = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    await waitRun(started.run.id, ['waiting']);
    const review = ((await ok('GET', '/workflow-tasks?scope=all')) as { tasks: { id: string; kind: string; run_id: string | null }[] }).tasks.find((t) => t.run_id === started.run.id && t.kind === 'iga-review')!;
    const d = await call('POST', `/workflow-tasks/${review.id}/decision`, { decision: 'approved' }, { token: `${T}:iga-reviewer` });
    assert.ok(d.status < 300, JSON.stringify(d.body).slice(0, 200));
    await waitRun(started.run.id, ['completed'], 30000);
    const v = (await ok('GET', `/workflow-runs/${started.run.id}`)) as RunView;
    const step = (id: string) => v.steps.find((st) => st.node_id === id)!;
    assert.equal((step('any').output as Record<string, unknown>).branch, 'false', 'no denial: the remediation branch was NOT taken');
    assert.equal(step('prepare').status, 'skipped');
    assert.equal(step('publish').status, 'skipped', 'approval preserves the rights: no useless pull request');
    assert.equal(v.run.branch, null, 'no data branch at all');
    assert.equal(step('close').status, 'done');
    // PII minimization: the persisted evidence file projects each item to exactly these fields -
    // no displayName, no email, no profile column the schema may carry.
    const ev = (step('close').output as Record<string, unknown>).evidence as Record<string, unknown>;
    for (const it of ev.items as Record<string, unknown>[])
      assert.deepEqual(Object.keys(it).sort(), ['decidedAt', 'decidedBy', 'identity', 'reason', 'remediation', 'roles', 'state'].sort(), 'minimal item projection in the evidence file');
    assert.ok(!JSON.stringify(ev).includes('Alice Demo'), 'no display name persisted in the evidence');
  });

  it('recertification snapshot conflict: no useless pull request, the close stays blocked and the conflict visible', async () => {
    // The template over demo-bob alone. While the run WAITS on the review, bob's roles change on main
    // (a real granted+merged publication): the snapshot is stale, the prepare must flag a conflict.
    const def = (await ok('POST', '/workflows', { name: 'Recert conflict', graph: templateGraph('demo-bob') })) as { definition: { id: string } };
    const started = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    await waitRun(started.run.id, ['waiting']);
    // Change bob's roles on main through the NORMAL path: a grant run, human publication approval, real merge.
    const grantDef = (await ok('POST', '/workflows', { name: 'Grant bob payment-approver', graph: { nodes: [
      { id: 'grant', type: 'lyam-grant-assignment', name: 'grant', config: { identity: 'demo-bob', role: 'payment-approver' } },
      { id: 'publish', type: 'lyam-request-publish', name: 'publish', config: { title: 'Grant for conflict journey' } },
    ], edges: [{ from: 'grant', to: 'publish' }] } })) as { definition: { id: string } };
    const grantRun = (await ok('POST', `/workflows/${grantDef.definition.id}/runs`)) as RunView;
    const gApproval = await waitTask(grantRun.run.id, 'publish-approval');
    const gPr = Number((gApproval.detail.pr as Record<string, unknown>).id);
    assert.ok((await call('POST', `/workflow-tasks/${gApproval.id}/decision`, { decision: 'approved' }, { token: `${T}:admin-two` })).status < 300);
    const gWatch = await waitTask(grantRun.run.id, 'publish-merge-watch');
    assert.ok((await call('POST', `/versioning/pulls/${gPr}/merge`, {}, { token: `${T}:demo-alice` })).status < 300);
    assert.ok((await call('POST', `/workflow-tasks/${gWatch.id}/decision`, { decision: 'merged', justification: 'merged' }, { token: `${T}:admin-two` })).status < 300);
    await waitRun(grantRun.run.id, ['completed'], 30000);
    // Now deny bob's access: the snapshot (taken before the grant) no longer matches main.
    const review = ((await ok('GET', '/workflow-tasks?scope=all')) as { tasks: { id: string; kind: string; run_id: string | null }[] }).tasks.find((t) => t.run_id === started.run.id && t.kind === 'iga-review')!;
    assert.ok((await call('POST', `/workflow-tasks/${review.id}/decision`, { decision: 'denied', justification: 'role changed mid-review' }, { token: `${T}:iga-reviewer` })).status < 300);
    // The run resumes, prepares, finds the conflict: no revoke action, NO pull request, then the strict close refuses.
    const exception = await waitTask(started.run.id, 'iga-close-exception');
    const unresolved = (exception.detail.unresolved as { identity: string; state: string }[]);
    assert.ok(unresolved.some((u) => u.identity === 'demo-bob' && u.state === 'denied'), 'the conflicted item stays visible and unresolved');
    const mid = (await ok('GET', `/workflow-runs/${started.run.id}`)) as RunView;
    const step = (id: string) => mid.steps.find((x) => x.node_id === id)!;
    const prep = step('prepare').output as Record<string, unknown>;
    assert.equal(prep.conflicts, 1, 'the snapshot drift is a conflict');
    assert.equal(prep.actionCount, 0, 'no remediation action for a conflicted item');
    assert.equal((step('publish').output as Record<string, unknown>).skipped, true, 'nothing written on the run branch: no useless pull request opened');
    const refused = await call('POST', `/workflow-tasks/${exception.id}/decision`, { decision: 'refused', justification: 'conflict must be re-reviewed' }, { token: `${T}:iga-reviewer` });
    assert.ok(refused.status < 300, JSON.stringify(refused.body).slice(0, 200));
    await waitRun(started.run.id, ['failed'], 30000);
    const end = (await ok('GET', `/workflow-runs/${started.run.id}`)) as RunView;
    assert.equal(end.steps.find((x) => x.node_id === 'close')!.status, 'failed', 'no lying close over a conflicted campaign');
  });

  it('tags: free-form labels are validated, saved, listed and updated', async () => {
    const g = { nodes: [{ id: 'a', type: 'wait', name: 'a', config: { seconds: 0 } }], edges: [] };
    const created = (await ok('POST', '/workflows', { name: 'Tagged', graph: g, tags: ['HR', 'joiner', 'hr'] })) as { definition: { id: string } };
    const id = created.definition.id;
    const fromGet = (await ok('GET', `/workflows/${id}`)) as { definition: { tags: string[] } };
    assert.deepEqual(fromGet.definition.tags, ['hr', 'joiner'], 'lowercased and deduped');
    const fromList = (await ok('GET', '/workflows')) as { definitions: { id: string; tags: string[] }[] };
    assert.deepEqual(fromList.definitions.find((d) => d.id === id)!.tags, ['hr', 'joiner']);
    await ok('PUT', `/workflows/${id}`, { name: 'Tagged', graph: g, tags: ['finance'] });
    assert.deepEqual(((await ok('GET', `/workflows/${id}`)) as { definition: { tags: string[] } }).definition.tags, ['finance']);
    const bad = await call('POST', '/workflows', { name: 'Bad tag', graph: g, tags: ['not a tag!'] });
    assert.equal(bad.status, 400);
    const tooMany = await call('POST', '/workflows', { name: 'Too many', graph: g, tags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'] });
    assert.equal(tooMany.status, 400);
    const notArray = await call('POST', '/workflows', { name: 'Not array', graph: g, tags: 'hr' });
    assert.equal(notArray.status, 400);
    await ok('DELETE', `/workflows/${id}`);
  });

  it('update, list and delete a definition; deleting while active is refused', async () => {
    const def = (await ok('POST', '/workflows', { name: 'To edit', graph: { nodes: [{ id: 'a', type: 'wait', name: 'a', config: { seconds: 0 } }], edges: [] } })) as { definition: { id: string } };
    const updated = (await ok('PUT', `/workflows/${def.definition.id}`, { name: 'Edited', description: 'v2', graph: { nodes: [{ id: 'a', type: 'wait', name: 'a', config: { seconds: 0 } }, { id: 'b', type: 'notify', name: 'b', config: { recipient: 'r', message: 'm' } }], edges: [{ from: 'a', to: 'b' }] } })) as { definition: { name: string } };
    assert.equal(updated.definition.name, 'Edited');
    const list = (await ok('GET', '/workflows')) as { definitions: { id: string; steps: number; active: boolean }[] };
    assert.ok(list.definitions.some((d) => d.id === def.definition.id && d.steps === 2));
    assert.ok(list.definitions.every((d) => d.active), 'definitions are active by default');
    // active: persisted, preserved across an update that omits it, flippable back
    const graph2 = { nodes: [{ id: 'a', type: 'wait', name: 'a', config: { seconds: 0 } }], edges: [] };
    await ok('PUT', `/workflows/${def.definition.id}`, { name: 'Edited', description: 'v2', graph: graph2, active: false });
    assert.equal(((await ok('GET', `/workflows/${def.definition.id}`)) as { definition: { active: boolean } }).definition.active, false);
    assert.equal(((await ok('GET', '/workflows')) as { definitions: { id: string; active: boolean }[] }).definitions.find((d) => d.id === def.definition.id)!.active, false);
    await ok('PUT', `/workflows/${def.definition.id}`, { name: 'Edited', description: 'v2', graph: graph2 });
    assert.equal(((await ok('GET', `/workflows/${def.definition.id}`)) as { definition: { active: boolean } }).definition.active, false, 'an update that omits active keeps the flag');
    await ok('PUT', `/workflows/${def.definition.id}`, { name: 'Edited', description: 'v2', graph: graph2, active: true });
    assert.equal(((await ok('GET', `/workflows/${def.definition.id}`)) as { definition: { active: boolean } }).definition.active, true);
    await ok('DELETE', `/workflows/${def.definition.id}`);
    assert.equal((await call('GET', `/workflows/${def.definition.id}`)).status, 404);
  });

  it('list cards: run stats per definition, the pause switch endpoint, deleting a finished run', async () => {
    const def = (await ok('POST', '/workflows', { name: 'Stats', description: '', graph: { nodes: [{ id: 'a', type: 'wait', name: 'a', config: { seconds: 0 } }], edges: [] } })) as { definition: { id: string } };
    const started = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    await waitRun(started.run.id, ['completed']);
    const row = ((await ok('GET', '/workflows')) as { definitions: { id: string; stats: { runs: number; okPct: number; lastStatus: string } | null }[] }).definitions.find((d) => d.id === def.definition.id)!;
    assert.ok(row.stats && row.stats.runs === 1 && row.stats.okPct === 100 && row.stats.lastStatus === 'completed', JSON.stringify(row.stats));
    // the cards' pause switch flips only the flag
    assert.equal(((await ok('POST', `/workflows/${def.definition.id}/active`, { active: false })) as { definition: { active: boolean } }).definition.active, false);
    assert.equal((await call('POST', `/workflows/${def.definition.id}/active`, {})).status, 400);
    assert.equal(((await ok('GET', `/workflows/${def.definition.id}`)) as { definition: { active: boolean } }).definition.active, false);
    // a finished run can be deleted (and stops counting), a missing one 404s
    assert.equal(((await ok('DELETE', `/workflow-runs/${started.run.id}`)) as { deleted: string }).deleted, started.run.id);
    assert.equal((await call('GET', `/workflow-runs/${started.run.id}`)).status, 404);
    assert.equal((await call('DELETE', `/workflow-runs/${started.run.id}`)).status, 404);
    const second = (await ok('POST', `/workflows/${def.definition.id}/runs`)) as RunView;
    await waitRun(second.run.id, ['completed']);
    const row2 = ((await ok('GET', '/workflows')) as { definitions: { id: string; stats: { runs: number } | null }[] }).definitions.find((d) => d.id === def.definition.id)!;
    assert.equal(row2.stats!.runs, 1, 'the deleted run no longer counts');
  });

  it('meta->main migration runs ONCE: a definition deleted afterwards is not resurrected at the next startup', async () => {
    // simulate a pre-migration meta row (the old unversioned storage) and force re-migration
    const meta = await createConnection({ host: '127.0.0.1', port: PORT, user: 'root', database: 'iam_meta', dateStrings: true });
    try {
      await meta.query('delete from workflow_definitions where tenant=? and id=?', [T, 'wf-stale-meta']);
      await meta.query("delete from workflow_store_meta where k='defs_migrated'");
      await meta.query('insert into workflow_definitions (tenant,id,name,description,graph,trigger_json,created_by,created_at,updated_at) values (?,?,?,?,?,null,?,?,?)',
        [T, 'wf-stale-meta', 'Stale from meta', 'old storage', JSON.stringify({ nodes: [{ id: 'n', type: 'notify', name: 'N', config: { recipient: 'x', message: 'y' } }], edges: [] }), 'test', '2026-01-01 00:00:00.000', '2026-01-01 00:00:00.000']);
    } finally { await meta.end(); }
    const s1 = new WorkflowStore(app.get(VersioningService));
    await s1.listRuns(T); // first meta access runs the startup bootstrap, including the migration
    assert.ok(await s1.getDefinition(T, 'wf-stale-meta', s1.liveRef), 'first startup migrates the stale meta row to main');
    assert.ok(await s1.deleteDefinition(T, 'wf-stale-meta', s1.liveRef), 'deleted on main');
    const s2 = new WorkflowStore(app.get(VersioningService)); // a second "restart"
    await s2.listRuns(T);
    assert.equal(await s2.getDefinition(T, 'wf-stale-meta', s2.liveRef), null, 'the marker prevents resurrection from the stale meta row');
  });

  it('cron: an active schedule fires a run on the matching minute, a paused one never fires', async () => {
    const g = { nodes: [{ id: 'a', type: 'wait', name: 'a', config: { seconds: 0 } }], edges: [] };
    const on = (await ok('POST', '/workflows', { name: 'Cron every minute', graph: g, trigger: { cron: '* * * * *' } })) as { definition: { id: string; trigger: { cron: string } } };
    assert.equal(on.definition.trigger.cron, '* * * * *');
    const off = (await ok('POST', '/workflows', { name: 'Cron paused', graph: g, trigger: { cron: '* * * * *' }, active: false })) as { definition: { id: string } };
    // The list exposes the next scheduled start for the active one only
    const list = (await ok('GET', '/workflows')) as { definitions: { id: string; nextRunAt?: string | null }[] };
    assert.ok(list.definitions.find((d) => d.id === on.definition.id)!.nextRunAt, 'active cron has a next run');
    assert.equal(list.definitions.find((d) => d.id === off.definition.id)!.nextRunAt ?? null, null, 'paused: no next run');
    // Validation
    assert.equal((await call('POST', '/workflows', { name: 'bad', graph: g, trigger: { cron: 'nope' } })).status, 400);
    assert.equal((await call('POST', '/workflows', { name: 'bad', graph: g, trigger: { cron: '* * * * *', event: 'user.created' } })).status, 400);
    // Wait for the scheduler (tick 2 s, cron matches every minute: worst case a full minute + a tick)
    const until = Date.now() + 90000;
    let fired: { id: string; startedBy: string } | undefined;
    while (Date.now() < until) {
      const runs = (await ok('GET', `/workflow-runs?definition=${on.definition.id}`)) as { runs: { id: string; startedBy: string }[] };
      fired = runs.runs.find((r) => r.startedBy === 'cron');
      if (fired) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    assert.ok(fired, 'the cron scheduler started a run within 90 s');
    const pausedRuns = (await ok('GET', `/workflow-runs?definition=${off.definition.id}`)) as { runs: unknown[] };
    assert.equal(pausedRuns.runs.length, 0, 'a paused cron workflow never fires');
    await ok('DELETE', `/workflows/${on.definition.id}`);
    await ok('DELETE', `/workflows/${off.definition.id}`);
  });

  it('templates: save from a definition or a canvas, gallery merges official + user, only user templates deletable', async () => {
    const all0 = (await ok('GET', '/workflow-templates')) as { templates: { id: string; source: string; createdBy?: string | null; trigger?: { cron?: string } }[] };
    assert.ok(all0.templates.filter((t) => t.source === 'official').length >= 8, 'the official catalog is served by the API');
    const community0 = all0.templates.filter((t) => t.source === 'community');
    assert.ok(community0.length >= 3, 'community picks are served too');
    assert.ok(community0.every((t) => t.createdBy), 'community picks carry their author');
    assert.ok(community0.some((t) => t.trigger?.cron), 'a community pick shows a cron trigger');
    assert.ok(!all0.templates.some((t) => t.source === 'user'), 'no user template before any save');
    const g = { nodes: [{ id: 'a', type: 'wait', name: 'a', config: { seconds: 0 } }, { id: 'b', type: 'notify', name: 'b', config: { recipient: 'hr', message: 'hi' } }], edges: [{ from: 'a', to: 'b' }] };
    const def = (await ok('POST', '/workflows', { name: 'Tpl source', description: 'to template', graph: g })) as { definition: { id: string } };
    const t1 = (await ok('POST', '/workflow-templates', { name: 'My first template', description: 'from a definition', category: 'Tests', fromDefinition: def.definition.id })) as { template: { id: string; source: string; nodes: unknown[]; category: string } };
    assert.equal(t1.template.source, 'user');
    assert.equal(t1.template.nodes.length, 2, 'the template copies the definition graph');
    const t2 = (await ok('POST', '/workflow-templates', { name: 'Canvas template', description: '', category: '', graph: g })) as { template: { id: string; category: string } };
    assert.equal(t2.template.category, 'My templates', 'an empty category falls back');
    const all1 = (await ok('GET', '/workflow-templates')) as { templates: { id: string; source: string }[] };
    assert.ok(all1.templates.some((t) => t.id === t1.template.id && t.source === 'user'), 'the gallery shows the saved template');
    assert.ok(all1.templates.some((t) => t.source === 'official'), 'the official entries stay');
    assert.equal((await call('POST', '/workflow-templates', { name: 'bad', graph: { nodes: [{ id: 'a', type: 'teleport', name: 'a', config: {} }], edges: [] } })).status, 400);
    assert.equal((await call('POST', '/workflow-templates', { name: 'bad', graph: { nodes: [{ id: 'a', type: 'assign-role', name: 'a', config: { identity: '{{event.subject}}', role: 'employee' } }], edges: [] } })).status, 400, 'an event placeholder without a trigger is refused');
    assert.equal((await call('DELETE', `/workflow-templates/${all0.templates[0].id}`)).status, 400, 'an official template cannot be deleted');
    assert.equal((await call('DELETE', `/workflow-templates/${community0[0].id}`)).status, 400, 'a community template cannot be deleted');
    await ok('DELETE', `/workflow-templates/${t1.template.id}`);
    await ok('DELETE', `/workflow-templates/${t2.template.id}`);
    assert.equal((await call('DELETE', `/workflow-templates/${t1.template.id}`)).status, 404);
    const all2 = (await ok('GET', '/workflow-templates')) as { templates: { id: string }[] };
    assert.ok(!all2.templates.some((t) => t.id === t1.template.id), 'the deleted template leaves the gallery');
    await ok('DELETE', `/workflows/${def.definition.id}`);
  });
  it('restart durability: a waiting run survives a REAL app restart, a crashed effectful step fails closed', async () => {
    const graph = { nodes: [
      { id: 'grant', type: 'lyam-grant-assignment', name: 'grant', config: { identity: 'demo-bob', role: 'branch-merger' } },
      { id: 'publish', type: 'lyam-request-publish', name: 'publish', config: { title: 'Restart durability' } },
    ], edges: [{ from: 'grant', to: 'publish' }] };
    // Run A: left WAITING on its publication approval when the process dies.
    const defA = (await ok('POST', '/workflows', { name: 'Restart waiting', graph })) as { definition: { id: string } };
    const runA = (await ok('POST', `/workflows/${defA.definition.id}/runs`)) as RunView;
    const approvalA = await waitTask(runA.run.id, 'publish-approval');
    // Run B: same, but the crash is simulated MID-EFFECT: its data step is forced back to 'running'.
    const defB = (await ok('POST', '/workflows', { name: 'Restart crashed', graph })) as { definition: { id: string } };
    const runB = (await ok('POST', `/workflows/${defB.definition.id}/runs`)) as RunView;
    await waitTask(runB.run.id, 'publish-approval');
    const meta = await createConnection({ host: '127.0.0.1', port: PORT, user: 'root', database: 'iam_meta', dateStrings: true });
    try {
      await meta.query("update workflow_runs set status='running', finished_at=null where id=?", [runB.run.id]);
      await meta.query("update workflow_steps set status='running', finished_at=null, output=null where run_id=? and node_id='grant'", [runB.run.id]);
    } finally { await meta.end(); }
    // REAL restart: the whole Nest application stops and boots again over the SAME Dolt base.
    await app.close();
    const m2 = await Test.createTestingModule({ imports: [WorkflowsModule, VersioningModule] }).overrideGuard(AuthGuard).useValue(new FakeAuth()).overrideProvider(PluginRegistry).useFactory(durablePluginsFactory).compile();
    app = m2.createNestApplication(); await app.init(); await app.listen(13432);
    // The durable state store kept the enablement: the routes answer right after the boot, and the boot-time
    // resume scan (onModuleInit, run during app.init) recovers the interrupted runs on the NORMAL path - no
    // manual re-enable, no re-triggered scan.
    assert.equal((await call('GET', '/workflows')).status, 200, 'the plugin enablement survived the restart (durable store)');
    // B: the resume scan refuses to guess the effect of the cut step: failed closed, marked for reconciliation.
    const vB = await waitRun(runB.run.id, ['failed'], 30000);
    assert.match(String(vB.run.error), /interrupted by a restart/, 'the crashed run fails closed');
    const grantB = vB.steps.find((x) => x.node_id === 'grant')!;
    assert.equal(grantB.status, 'failed');
    assert.equal((grantB as unknown as Record<string, unknown>).error, 'EXTERNAL_EFFECT_REVIEW_REQUIRED');
    // A: the durable task and the run survived; deciding after the restart resumes and finishes the run.
    const prA = Number((approvalA.detail.pr as Record<string, unknown>).id);
    assert.ok((await call('POST', `/workflow-tasks/${approvalA.id}/decision`, { decision: 'approved' }, { token: `${T}:admin-two` })).status < 300);
    const watchA = await waitTask(runA.run.id, 'publish-merge-watch');
    assert.ok((await call('POST', `/versioning/pulls/${prA}/merge`, {}, { token: `${T}:demo-alice` })).status < 300);
    assert.ok((await call('POST', `/workflow-tasks/${watchA.id}/decision`, { decision: 'merged', justification: 'merged after a full restart' }, { token: `${T}:admin-two` })).status < 300);
    await waitRun(runA.run.id, ['completed'], 30000);
    const vA = (await ok('GET', `/workflow-runs/${runA.run.id}`)) as RunView;
    assert.equal(vA.run.status, 'completed', 'the waiting run resumed and completed after the restart');
    assert.ok(((vA.steps.find((x) => x.node_id === 'publish')!.output as Record<string, unknown>).merged) === true);
  });

  it('connection CRUD and draft probes stay behind tenant/auth/admin and never reveal credentials', async()=>{
    for(const [method,path,body] of [['GET','/workflow-connections',undefined],['POST','/workflow-connections/probe',{name:'API',provider:'http',config:{baseUrl:'https://127.0.0.1'}}]] as const) {
      assert.equal((await call(method,path,body,{token:null})).status,401);
      assert.equal((await call(method,path,body,{admin:null})).status,403);
      assert.equal((await call(method,path,body,{token:'another:demo-alice'})).status,403);
    }
    const create=await ok('POST','/workflow-connections',{name:'Local refused',provider:'http',config:{baseUrl:'https://127.0.0.1'}}) as any;
    assert.equal(create.connection.secretConfigured,false);assert.ok(!JSON.stringify(create).includes('secretRef'));
    const probe=await ok('POST','/workflow-connections/probe',{name:'Unsaved',provider:'http',config:{baseUrl:'https://127.0.0.1'},secret:'FICTIONAL-PROBE-SECRET'}) as any;
    assert.equal(probe.status,'Failed');assert.equal(probe.readOnly,true);assert.ok(!JSON.stringify(probe).includes('FICTIONAL'));
    const list=await ok('GET','/workflow-connections') as any;assert.equal(list.connections.filter((c:any)=>c.name==='Unsaved').length,0);
    assert.equal((await call('POST','/workflow-connections',{name:'Fail closed',provider:'jira',config:{instanceUrl:'https://team.atlassian.net',email:'test@example.invalid'},secret:'FICTIONAL-PROBE-SECRET'})).status,503);
    await ok('PUT',`/workflow-connections/${create.connection.id}`,{name:'Edited',provider:'http',config:{baseUrl:'https://127.0.0.1/api'}});
    const checked=await ok('POST',`/workflow-connections/${create.connection.id}/test`) as any;assert.equal(checked.status,'Failed');assert.equal(checked.readOnly,true);
    await ok('DELETE',`/workflow-connections/${create.connection.id}`);
    assert.equal((await call('POST',`/workflow-connections/${create.connection.id}/test`)).status,404);
  });

});

let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });
