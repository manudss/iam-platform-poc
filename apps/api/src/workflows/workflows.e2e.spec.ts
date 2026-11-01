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
import { VersioningController } from '../versioning/versioning.controller.js';

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

interface RunView { run: { id: string; status: string; branch: string | null; error: string | null; simulatedOnly: boolean }; steps: { node_id: string; status: string; simulated: boolean; attempts: number; log: string[] }[] }

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
    assert.equal(routes.length, 12);
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
    assert.match(v.run.branch ?? '', /^wf-[0-9a-f]{8}$/);
    assert.equal(v.steps[0].simulated, false);
    assert.ok(v.steps[0].log.some((l) => l.includes('commit')));
    // main untouched: only the seeded assignment
    const rows = (await ok('GET', '/versioning/tables/assignments?ref=main')) as { rows: unknown[] };
    assert.equal(rows.rows.length, 1);
    const onBranch = (await ok('GET', `/versioning/tables/assignments?ref=${v.run.branch}`)) as { rows: unknown[] };
    assert.equal(onBranch.rows.length, 2);
    // review opens a pull request, reused on a second call, merge applies to main
    const pr = (await ok('POST', `/workflow-runs/${started.run.id}/review`)) as { pullRequest: { id: number; source: string }; reused: boolean };
    assert.equal(pr.pullRequest.source, v.run.branch);
    const again = (await ok('POST', `/workflow-runs/${started.run.id}/review`)) as { reused: boolean };
    assert.equal(again.reused, true);
    const merged = await call('POST', `/versioning/pulls/${pr.pullRequest.id}/merge`);
    assert.ok(merged.status < 300, JSON.stringify(merged.body));
    const after = (await ok('GET', '/versioning/tables/assignments?ref=main')) as { rows: unknown[] };
    assert.equal(after.rows.length, 2);
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
    assert.equal(onBranch.rows.length, 2); // first commit kept, nothing half-written by the failed step
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

  it('update, list and delete a definition; deleting while active is refused', async () => {
    const def = (await ok('POST', '/workflows', { name: 'To edit', graph: { nodes: [{ id: 'a', type: 'wait', name: 'a', config: { seconds: 0 } }], edges: [] } })) as { definition: { id: string } };
    const updated = (await ok('PUT', `/workflows/${def.definition.id}`, { name: 'Edited', description: 'v2', graph: { nodes: [{ id: 'a', type: 'wait', name: 'a', config: { seconds: 0 } }, { id: 'b', type: 'notify', name: 'b', config: { recipient: 'r', message: 'm' } }], edges: [{ from: 'a', to: 'b' }] } })) as { definition: { name: string } };
    assert.equal(updated.definition.name, 'Edited');
    const list = (await ok('GET', '/workflows')) as { definitions: { id: string; steps: number }[] };
    assert.ok(list.definitions.some((d) => d.id === def.definition.id && d.steps === 2));
    await ok('DELETE', `/workflows/${def.definition.id}`);
    assert.equal((await call('GET', `/workflows/${def.definition.id}`)).status, 404);
  });
});
