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

interface RunView { run: { id: string; status: string; branch: string | null; error: string | null; simulatedOnly: boolean; test?: boolean }; steps: { node_id: string; status: string; simulated: boolean; attempts: number; log: string[]; input?: Record<string, unknown> | null }[] }

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
    if (Date.now() > until) throw new Error(`run ${id} still ${v.run.status}, wanted ${want}`);
    await new Promise((r) => setTimeout(r, 120));
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
    Object.assign(process.env, { DOLT_PORT: String(PORT), DOLT_DATABASE: 'iam', IAM_API_ADMIN_TOKEN: ADMIN });
    delete process.env.IAM_WORKSPACE_MODE;
    const m = await Test.createTestingModule({ imports: [WorkflowsModule, VersioningModule] }).overrideGuard(AuthGuard).useValue(new FakeAuth()).compile();
    app = m.createNestApplication(); await app.init(); await app.listen(13432);
    // The feature is gated by the workflows-iga plugin: disabled by default, every route 403 until an admin enables it.
    assert.equal((await call('GET', '/workflows')).status, 403, 'workflows must be refused while the plugin is disabled');
    await ok('POST', '/plugins/workflows-iga/install', {});
    await ok('POST', '/plugins/workflows-iga/enable', {});
    assert.equal((await call('GET', '/workflows')).status, 200, 'workflows must answer once the plugin is enabled');
  });
  after(async () => { await app?.close(); dolt?.kill(); await new Promise((r) => setTimeout(r, 800)); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

  it('both guards protect every route (controller level)', () => {
    const guards: unknown[] = Reflect.getMetadata('__guards__', WorkflowsController) ?? [];
    const names = guards.map((g) => (g as { name: string }).name);
    assert.ok(names.includes('AuthGuard') && names.includes('AdminGuard'), `guards: ${names}`);
    const routes = Object.getOwnPropertyNames(WorkflowsController.prototype).filter((n) => n !== 'constructor' && Reflect.getMetadata('path', (WorkflowsController.prototype as never)[n]) !== undefined);
    assert.equal(routes.length, 21);
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
});

let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });
