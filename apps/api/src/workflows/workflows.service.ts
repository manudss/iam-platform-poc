import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PullRequestService } from '../versioning/pull-requests.service.js';
import { hasDataSteps, STEP_TYPES, validateGraph, WfGraph } from './model.js';
import { WorkflowEngine } from './engine.js';
import { DefinitionRow, RunRow, StepRow, WorkflowStore } from './store.js';

const ID = /^[a-z0-9][a-z0-9-]{0,38}$/;
const now = () => new Date().toISOString().slice(0, 23).replace('T', ' ');

export interface RunView { run: Omit<RunRow, 'graph'> & { simulatedOnly: boolean; order: string[] }; steps: (StepRow & { name: string; type: string; label: string })[] }

/** API surface of the workflows feature. All state changes are validated here; the engine only executes. */
@Injectable()
export class WorkflowsService {
  constructor(private readonly store: WorkflowStore, private readonly engine: WorkflowEngine, private readonly prs: PullRequestService) {}

  private checkId(id: unknown, what = 'id'): string {
    const s = String(id ?? '');
    if (!ID.test(s)) throw new BadRequestException(`invalid ${what}`);
    return s;
  }

  async list(tenant: string) {
    const defs = await this.store.listDefinitions(tenant);
    return { definitions: defs.map((d) => ({ id: d.id, name: d.name, description: d.description, steps: d.graph.nodes.length, simulatedSteps: d.graph.nodes.filter((n) => STEP_TYPES[n.type].simulated).length, dataSteps: d.graph.nodes.filter((n) => !STEP_TYPES[n.type].simulated).length, createdBy: d.created_by, createdAt: d.created_at, updatedAt: d.updated_at })) };
  }

  async get(tenant: string, id: unknown) {
    const d = await this.store.getDefinition(tenant, this.checkId(id, 'workflow id'));
    if (!d) throw new NotFoundException('unknown workflow');
    return { definition: { ...d, order: validateGraph(d.graph).order } };
  }

  async save(tenant: string, id: unknown, body: Record<string, unknown>, sub: unknown, create: boolean) {
    const wid = create ? `wf-def-${randomBytes(4).toString('hex')}` : this.checkId(id, 'workflow id');
    const name = String(body?.name ?? '').trim();
    if (!name || name.length > 80) throw new BadRequestException('a name is required (max 80)');
    const description = String(body?.description ?? '').slice(0, 500);
    if (Object.keys(body ?? {}).some((k) => !['name', 'description', 'graph'].includes(k))) throw new BadRequestException('unknown field');
    const { graph } = validateGraph(body?.graph);
    const existing = create ? null : await this.store.getDefinition(tenant, wid);
    if (!create && !existing) throw new NotFoundException('unknown workflow');
    const def: DefinitionRow = { id: wid, tenant, name, description, graph, created_by: existing?.created_by ?? String(sub ?? 'unknown'), created_at: existing?.created_at ?? now(), updated_at: now() };
    await this.store.putDefinition(def);
    return { definition: def };
  }

  async remove(tenant: string, id: unknown) {
    const wid = this.checkId(id, 'workflow id');
    const running = (await this.store.listRuns(tenant, wid, 100)).some((r) => r.status === 'queued' || r.status === 'running');
    if (running) throw new ConflictException('a run of this workflow is still active: cancel it first');
    if (!(await this.store.deleteDefinition(tenant, wid))) throw new NotFoundException('unknown workflow');
    return { deleted: wid };
  }

  async start(tenant: string, id: unknown, sub: unknown) {
    const d = await this.store.getDefinition(tenant, this.checkId(id, 'workflow id'));
    if (!d) throw new NotFoundException('unknown workflow');
    const active = (await this.store.listRuns(tenant, d.id, 100)).filter((r) => r.status === 'queued' || r.status === 'running');
    if (active.length >= 3) throw new ConflictException('3 runs of this workflow are already active: wait for one to finish (demo guard)');
    const { order } = validateGraph(d.graph);
    const run: RunRow = { id: `run-${randomBytes(6).toString('hex')}`, tenant, definition_id: d.id, name: d.name, graph: d.graph, branch: null, status: 'queued', error: null, started_by: String(sub ?? 'unknown'), started_at: now(), finished_at: null };
    const steps: StepRow[] = order.map((nodeId) => {
      const n = d.graph.nodes.find((x) => x.id === nodeId)!;
      return { run_id: run.id, node_id: nodeId, status: 'pending', simulated: STEP_TYPES[n.type].simulated, attempts: 0, error: null, log: [], started_at: null, finished_at: null };
    });
    await this.store.createRun(run, steps);
    this.engine.kick(run.id);
    return this.runView(tenant, run.id);
  }

  async listRuns(tenant: string, definitionId?: string) {
    if (definitionId !== undefined) this.checkId(definitionId, 'workflow id');
    const runs = await this.store.listRuns(tenant, definitionId, 50);
    return { runs: runs.map((r) => this.publicRun(r)) };
  }

  private publicRun(r: RunRow) {
    return { id: r.id, definitionId: r.definition_id, name: r.name, branch: r.branch, status: r.status, error: r.error, startedBy: r.started_by, startedAt: r.started_at, finishedAt: r.finished_at, hasDataSteps: hasDataSteps(r.graph) };
  }

  async runView(tenant: string, runId: unknown): Promise<RunView> {
    const r = await this.store.getRun(tenant, this.checkId(runId, 'run id'));
    if (!r) throw new NotFoundException('unknown run');
    const steps = await this.store.steps(r.id);
    const nodes = new Map(r.graph.nodes.map((n) => [n.id, n]));
    const { order } = validateGraph(r.graph);
    return {
      run: { id: r.id, tenant: r.tenant, definition_id: r.definition_id, name: r.name, branch: r.branch, status: r.status, error: r.error, started_by: r.started_by, started_at: r.started_at, finished_at: r.finished_at, simulatedOnly: !hasDataSteps(r.graph), order },
      steps: order.map((nodeId) => {
        const s = steps.find((x) => x.node_id === nodeId);
        const n = nodes.get(nodeId)!;
        return { ...(s ?? { run_id: r.id, node_id: nodeId, status: 'pending' as const, simulated: STEP_TYPES[n.type].simulated, attempts: 0, error: null, log: [], started_at: null, finished_at: null }), name: n.name, type: n.type, label: STEP_TYPES[n.type].label };
      }),
    };
  }

  async retry(tenant: string, runId: unknown) {
    const view = await this.runView(tenant, runId);
    const r = view.run;
    if (r.status !== 'failed' && r.status !== 'canceled') throw new ConflictException(`only a failed or canceled run can be retried (this one is ${r.status})`);
    const failed = view.steps.find((s) => s.status === 'failed');
    for (const s of view.steps) {
      if (s.status === 'skipped' || (failed && s.node_id === failed.node_id)) await this.store.patchStep(r.id, s.node_id, { status: 'pending', error: null, finished_at: null });
    }
    await this.store.updateRun(r.id, { status: 'queued', error: null, finished_at: null });
    this.engine.kick(r.id);
    return this.runView(tenant, r.id);
  }

  async cancel(tenant: string, runId: unknown) {
    const view = await this.runView(tenant, runId);
    if (view.run.status !== 'queued' && view.run.status !== 'running') throw new ConflictException(`this run is already ${view.run.status}`);
    this.engine.cancelFlag(view.run.id);
    // A run parked between steps (queued, or running without a live executor after a crash) is canceled here.
    await this.store.updateRun(view.run.id, { status: 'canceled', finished_at: now() });
    return this.runView(tenant, view.run.id);
  }

  /** Opens (or reuses) the Dolt pull request reviewing the run's branch. The merge itself stays a human action. */
  async review(tenant: string, runId: unknown, sub: unknown) {
    const view = await this.runView(tenant, runId);
    const r = view.run;
    if (r.status !== 'completed') throw new ConflictException('only a completed run can be reviewed');
    if (!r.branch) throw new BadRequestException('this run only had simulated steps: there is no data branch to review');
    const open = await this.prs.list(tenant, 'open');
    const existing = open.pullRequests.find((p) => p.source === r.branch);
    if (existing) return { pullRequest: existing, reused: true };
    const pr = await this.prs.create(tenant, { title: `Workflow run ${r.id}: ${r.name}`, body: `Data changes produced by workflow run ${r.id} on branch ${r.branch}. Simulated steps have no effect; only the commits on this branch are reviewed here.`, source: r.branch, target: 'main' }, sub);
    return { pullRequest: pr, reused: false };
  }
}
