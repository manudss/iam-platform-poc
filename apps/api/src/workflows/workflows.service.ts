import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PullRequestService } from '../versioning/pull-requests.service.js';
import { hasDataSteps, placeholderKeys, STEP_TYPES, substituteEventPayload, validateGraph, validateTrigger, WF_EVENTS, WfGraph } from './model.js';
import { WorkflowEngine } from './engine.js';
import { DefinitionRow, RunRow, StepRow, WorkflowStore } from './store.js';
import { currentBranch } from '../workspace/context.js';

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
    const defs = await this.store.listDefinitions(tenant, currentBranch());
    return { definitions: defs.map((d) => ({ id: d.id, name: d.name, description: d.description, trigger: d.trigger, steps: d.graph.nodes.length, simulatedSteps: d.graph.nodes.filter((n) => STEP_TYPES[n.type].simulated).length, dataSteps: d.graph.nodes.filter((n) => !STEP_TYPES[n.type].simulated).length, createdBy: d.created_by, createdAt: d.created_at, updatedAt: d.updated_at })) };
  }

  async get(tenant: string, id: unknown) {
    const d = await this.store.getDefinition(tenant, this.checkId(id, 'workflow id'), currentBranch());
    if (!d) throw new NotFoundException('unknown workflow');
    return { definition: { ...d, order: validateGraph(d.graph).order } };
  }

  async save(tenant: string, id: unknown, body: Record<string, unknown>, sub: unknown, create: boolean) {
    const wid = create ? `wf-def-${randomBytes(4).toString('hex')}` : this.checkId(id, 'workflow id');
    const name = String(body?.name ?? '').trim();
    if (!name || name.length > 80) throw new BadRequestException('a name is required (max 80)');
    const description = String(body?.description ?? '').slice(0, 500);
    if (Object.keys(body ?? {}).some((k) => !['name', 'description', 'graph', 'trigger'].includes(k))) throw new BadRequestException('unknown field');
    const trigger = validateTrigger(body?.trigger);
    const { graph } = validateGraph(body?.graph);
    // Every {{event.<key>}} placeholder must resolve from the chosen trigger's payload; without a trigger there is no event at all.
    for (const n of graph.nodes) for (const v of Object.values(n.config)) {
      for (const key of placeholderKeys(v)) {
        if (!trigger) throw new BadRequestException(`step "${n.id}" uses {{event.${key}}} but the workflow has no start trigger`);
        if (!WF_EVENTS[trigger.event].payload.includes(key)) throw new BadRequestException(`step "${n.id}": {{event.${key}}} is not a payload key of ${trigger.event} (${WF_EVENTS[trigger.event].payload.join(', ')})`);
      }
    }
    const ref = currentBranch(true);
    const existing = create ? null : await this.store.getDefinition(tenant, wid, ref);
    if (!create && !existing) throw new NotFoundException('unknown workflow');
    const def: DefinitionRow = { id: wid, tenant, name, description, graph, trigger, created_by: existing?.created_by ?? String(sub ?? 'unknown'), created_at: existing?.created_at ?? now(), updated_at: now() };
    await this.store.putDefinition(def, ref);
    return { definition: def };
  }

  async remove(tenant: string, id: unknown) {
    const wid = this.checkId(id, 'workflow id');
    const running = (await this.store.listRuns(tenant, wid, 100)).some((r) => r.status === 'queued' || r.status === 'running');
    if (running) throw new ConflictException('a run of this workflow is still active: cancel it first');
    if (!(await this.store.deleteDefinition(tenant, wid, currentBranch(true)))) throw new NotFoundException('unknown workflow');
    return { deleted: wid };
  }

  /**
   * Test a definition ON THE CURRENT REF without executing anything: validates the graph, walks it in order,
   * substitutes the sample event payload, and describes what every step WOULD do. No run row, no run branch,
   * no write on any branch, no notification: the only record of the test is the caller's own trace.
   */
  async dryRun(tenant: string, id: unknown, payload?: Record<string, unknown>) {
    const d = await this.store.getDefinition(tenant, this.checkId(id, 'workflow id'), currentBranch());
    if (!d) throw new NotFoundException('unknown workflow');
    const { order } = validateGraph(d.graph);
    const eventPayload: Record<string, string> = {};
    for (const [k, v] of Object.entries(payload ?? {})) if (/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(k)) eventPayload[k] = String(v).slice(0, 200);
    const autoFilled: string[] = [];
    if (d.trigger) for (const key of WF_EVENTS[d.trigger.event]?.payload ?? []) if (!(key in eventPayload)) { eventPayload[key] = `<${key}>`; autoFilled.push(key); }
    const resolved = substituteEventPayload(d.graph, eventPayload);
    const steps = order.map((nodeId) => {
      const n = resolved.nodes.find((x) => x.id === nodeId)!;
      const simulated = STEP_TYPES[n.type].simulated;
      return {
        step: n.id, type: n.type, name: n.name, simulated, config: n.config,
        would: simulated ? 'write a log line only (a simulated step never has an external effect)' : 'a REAL data write on the run branch - NOT executed in this test',
      };
    });
    return { definition: d.id, name: d.name, trigger: d.trigger, autoFilledEventKeys: autoFilled, steps, dataSteps: steps.filter((x) => !x.simulated).length, executed: false, note: 'test only: nothing was executed, written, sent or stored' };
  }

  async start(tenant: string, id: unknown, sub: unknown, event?: { branch: string; payload: Record<string, string>; eventId?: string }) {
    // A run executes effects now, so it always uses the LIVE (main) definition, never an unreviewed branch edit.
    const d = await this.store.getDefinition(tenant, this.checkId(id, 'workflow id'), this.store.liveRef);
    if (!d) throw new NotFoundException('unknown workflow');
    const runId = event?.eventId ? `run-${createHash('sha256').update(JSON.stringify([tenant, d.id, event.branch, event.eventId])).digest('hex').slice(0, 32)}` : `run-${randomBytes(6).toString('hex')}`;
    if (event?.eventId && await this.store.getRun(tenant, runId)) return this.runView(tenant, runId);
    const active = (await this.store.listRuns(tenant, d.id, 100)).filter((r) => r.status === 'queued' || r.status === 'running');
    if (active.length >= 3) throw new ConflictException('3 runs of this workflow are already active: wait for one to finish (demo guard)');
    // Resolve {{event.<key>}} placeholders from the triggering event (a manual start keeps the graph as saved,
    // so a definition that still needs placeholders cannot start manually: the error says which key is missing).
    const resolved = event ? substituteEventPayload(d.graph, event.payload) : substituteEventPayload(d.graph, {});
    const { order, graph } = validateGraph(resolved);
    const run: RunRow = { id: runId, tenant, definition_id: d.id, name: d.name, graph, branch: null, base_branch: event?.branch ?? null, status: 'queued', error: null, started_by: String(sub ?? 'unknown'), started_at: now(), finished_at: null };
    const steps: StepRow[] = order.map((nodeId) => {
      const n = graph.nodes.find((x) => x.id === nodeId)!;
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
      run: { id: r.id, tenant: r.tenant, definition_id: r.definition_id, name: r.name, branch: r.branch, base_branch: r.base_branch, status: r.status, error: r.error, started_by: r.started_by, started_at: r.started_at, finished_at: r.finished_at, simulatedOnly: !hasDataSteps(r.graph), order },
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
    const target = r.base_branch ?? 'main';
    const pr = await this.prs.create(tenant, { title: `Workflow run ${r.id}: ${r.name}`, body: `Data changes produced by workflow run ${r.id} on branch ${r.branch}. Simulated steps have no effect; only the commits on this branch are reviewed here.`, source: r.branch, target }, sub);
    return { pullRequest: pr, reused: false };
  }
}
