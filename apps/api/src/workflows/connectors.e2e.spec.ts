// End-to-end for the workflow-connectors spike (Activepieces block catalogue), REAL Dolt SQL server, no core.
// Skipped if the dolt binary is missing (DOLT_BIN) - CI runs it with the real binary. The Google and Jira
// sides stay on their simulated contexts here (demo sheet, dry-run): no external credential exists in tests.
import 'reflect-metadata';
import { describe, it, before, after, mock } from 'node:test';
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
import { WorkflowSheetPollerService } from './sheet-poller.js';
import { startTestBus, TestBus } from '../testing/test-bus.js';

const root = resolve(process.cwd(), '../..');
const which = spawnSync('sh', ['-c', 'command -v dolt']).stdout.toString().trim();
const doltBin = process.env.DOLT_BIN ?? (which || '/tmp/dolt-linux-amd64/bin/dolt');
const have = existsSync(doltBin);
const PORT = 13441, API = 'http://127.0.0.1:13442', ADMIN = 'test-admin-token-0123456789';
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

const call = async (method: string, path: string, body?: object, o: { token?: string | null } = {}) => {
  const token = o.token === undefined ? `${T}:demo-alice` : o.token;
  const r = await fetch(`${API}/tenants/${T}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-api-admin-token': ADMIN }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json: unknown; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json as never };
};
const ok = async (method: string, path: string, body?: object) => { const r = await call(method, path, body); assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const waitRun = async (id: string, want: string[], timeoutMs = 20000): Promise<{ run: { id: string; status: string }; steps: { node_id: string; status: string; log: string[]; output: Record<string, unknown> | null }[] }> => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = (await ok('GET', `/workflow-runs/${id}`)) as Awaited<ReturnType<typeof waitRun>>;
    if (want.includes(v.run.status)) return v;
    if (Date.now() > until) throw new Error(`run ${id} still ${v.run.status}: ` + v.steps.map((s) => `${s.node_id}=${s.status} ${s.log.join(' | ')}`).join(' // '));
    if (v.run.status === 'failed') throw new Error(`run ${id} failed: ` + v.steps.map((s) => `${s.node_id}=${s.status} ${s.log.join(' | ')}`).join(' // '));
    await new Promise((r) => setTimeout(r, 120));
  }
};

// Enabling a plugin requires the durable event bus (step 3, decision 6): the file-level bus boot mirrors
// workflows.e2e.spec.ts (hook-fails loudly when the NATS/core binaries are missing, CI has them).
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

describe('workflow-connectors spike + real Dolt', { skip: !have && 'dolt binary missing' }, () => {
  let dolt: ChildProcess, app: INestApplication, dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-wfc-'));
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
    // Guard decorators and the dynamic HTTP controller both use AuthGuard. Nest's
    // overrideGuard and overrideProvider share a token map and overwrite one another.
    // Mock the method in this isolated test process so both invocation paths use FakeAuth.
    mock.method(AuthGuard.prototype, 'canActivate', (ctx: ExecutionContext) => new FakeAuth().canActivate(ctx));
    const m = await Test.createTestingModule({ imports: [WorkflowsModule, VersioningModule] }).compile();
    app = m.createNestApplication(); await app.init(); await app.listen(13442);
    await ok('POST', '/plugins/workflows-iga/install', {});
    await ok('POST', '/plugins/workflows-iga/enable', {});
  });
  after(async () => { await app?.close(); mock.restoreAll(); dolt?.kill(); await new Promise((r) => setTimeout(r, 800)); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

  it('the block catalogue lists contributed blocks with their provider state', async () => {
    const before1 = (await ok('GET', '/workflow-blocks')) as { blocks: { type: string; provider: string | null; providerActive: boolean }[] };
    const lyam = before1.blocks.find((b) => b.type === 'lyam-create-user');
    assert.equal(lyam?.provider, 'workflow-connectors');
    assert.equal(lyam?.providerActive, false, 'provider disabled until installed+enabled');
    assert.ok(before1.blocks.some((b) => b.provider === null), 'built-ins listed too');
  });

  it('a workflow using contributed blocks cannot be saved while the provider is disabled', async () => {
    const r = await call('POST', '/workflows', { name: 'x', graph: { nodes: [{ id: 'a', type: 'text-transform', name: 'a', config: { operation: 'lower', text: 'X' } }], edges: [] } });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /workflow-connectors/);
    await ok('POST', '/plugins/workflow-connectors/install', {});
    await ok('POST', '/plugins/workflow-connectors/enable', {});
    assert.equal((await call('POST', '/workflows', { name: 'x', graph: { nodes: [{ id: 'a', type: 'text-transform', name: 'a', config: { operation: 'lower', text: 'X' } }], edges: [] } })).status, 201);
    const after2 = (await ok('GET', '/workflow-blocks')) as { blocks: { type: string; providerActive: boolean }[] };
    assert.equal(after2.blocks.find((b) => b.type === 'lyam-create-user')?.providerActive, true);
  });

  it('webhook trigger: public route, wrong token refused, run completes with substituted output, _dedupe idempotent', async () => {
    const def = (await ok('POST', '/workflows', {
      name: 'webhook test', trigger: { event: 'http.webhook-received', config: { token: 'test-token-1234' } },
      graph: { nodes: [{ id: 'low', type: 'text-transform', name: 'lower', config: { operation: 'lower', text: '{{event.nom}}' } }], edges: [] },
    })) as { definition: { id: string } };
    const id = def.definition.id;
    assert.equal((await call('POST', `/workflow-hooks/nope/${'test-token-1234'}`, {}, { token: null })).status, 404);
    assert.equal((await call('POST', `/workflow-hooks/${id}/wrong-token`, {}, { token: null })).status, 401);
    const fired = (await call('POST', `/workflow-hooks/${id}/test-token-1234`, { nom: 'MARTIN', _dedupe: 'abc' }, { token: null }));
    assert.equal(fired.status, 201);
    const runId = (fired.body as { run: string }).run;
    const v = await waitRun(runId, ['completed']);
    assert.equal(v.steps[0].output?.value, 'martin');
    const again = (await call('POST', `/workflow-hooks/${id}/test-token-1234`, { nom: 'MARTIN', _dedupe: 'abc' }, { token: null }));
    assert.equal((again.body as { run: string }).run, runId, 'same _dedupe key returns the same run');
  });

  it('sheet watcher: a ready demo row starts the onboarding chain; default Simulation does not mutate the sheet', async () => {
    const def = (await ok('POST', '/workflows', {
      name: 'watcher test',
      trigger: { event: 'google-sheets.row-ready', config: { source: 'demo-sheet', watchColumn: 'process', watchValue: 'OK', doneColumn: 'cree', doneValue: 'ok' } },
      graph: {
        nodes: [
          { id: 'join', type: 'text-transform', name: 'join', config: { operation: 'concat', values: '{{event.nom}}\n.\n{{event.prenom}}', separator: '' } },
          { id: 'lower', type: 'text-transform', name: 'lower', config: { operation: 'lower', text: '{{steps.join.value}}' } },
          { id: 'create', type: 'lyam-create-user', name: 'create', config: { identity: '{{steps.lower.value}}', displayName: '{{event.prenom}} {{event.nom}}', email: '{{steps.lower.value}}@lyam.demo', department: '{{event.departement}}' } },
          { id: 'role', type: 'assign-role', name: 'role', config: { identity: '{{steps.lower.value}}', role: '{{event.role}}' } },
          { id: 'mark', type: 'google-sheets-update', name: 'mark', config: { source: 'demo-sheet', rowNumber: '{{event.rownumber}}', column: 'cree', value: 'ok' } },
        ],
        edges: [{ from: 'join', to: 'lower' }, { from: 'lower', to: 'create' }, { from: 'create', to: 'role' }, { from: 'role', to: 'mark' }],
      },
    })) as { definition: { id: string } };
    await app.get(WorkflowSheetPollerService).tick();
    const runs = (await ok('GET', `/workflow-runs?definition=${def.definition.id}`)) as { runs: { id: string; status: string }[] };
    assert.ok(runs.runs.length >= 2, `rows Martin + Dubois are ready, got ${runs.runs.length} run(s)`);
    const completed = await Promise.all(runs.runs.map((r) => waitRun(r.id, ['completed'])));
    const v = completed[0];
    const create = v.steps.find((s) => s.node_id === 'create')!;
    assert.ok(create.log.some((l) => l.includes('created on the run branch')), `lyam write on the run branch: ${create.log}`);
    const sheet = (await ok('GET', '/plugins/workflow-connectors/demo-sheet')) as { rows: { rowNumber: number; values: Record<string, string> }[] };
    const martin = sheet.rows.find((r) => r.values.nom === 'Martin')!;
    assert.notEqual(martin.values.cree, 'ok', 'Simulation never marks a sheet row done');
    assert.ok(v.steps.find(s => s.node_id === 'mark')!.log.some(l => l.includes('SIMULATION')));
    // A second tick starts nothing new: the same ready values are deduplicated.
    await app.get(WorkflowSheetPollerService).tick();
    const runs2 = (await ok('GET', `/workflow-runs?definition=${def.definition.id}`)) as { runs: unknown[] };
    assert.equal(runs2.runs.length, runs.runs.length);
  });
});
