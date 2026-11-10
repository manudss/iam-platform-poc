import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PullRequestService } from '../versioning/pull-requests.service.js';
import { blockCatalogue, externalBlockProvider, hasDataSteps, isWildcardEvent, placeholderKeys, STEP_TYPES, stepCategoryOf, substituteEventPayload, validateGraph, validateStepPlaceholders, validateTrigger, WF_EVENTS, WfGraph } from './model.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { WorkflowEngine } from './engine.js';
import { DefinitionRow, RunRow, StepRow, WorkflowStore } from './store.js';
import { currentBranch, workspaceMode } from '../workspace/context.js';

const ID = /^[a-z0-9][a-z0-9-]{0,38}$/;
const now = () => new Date().toISOString().slice(0, 23).replace('T', ' ');

export interface RunView { run: Omit<RunRow, 'graph'> & { simulatedOnly: boolean; order: string[]; edges: { from: string; to: string; label?: string }[] }; steps: (StepRow & { name: string; type: string; label: string; category: string })[] }

/** API surface of the workflows feature. All state changes are validated here; the engine only executes. */
@Injectable()
export class WorkflowsService {
  constructor(private readonly store: WorkflowStore, private readonly engine: WorkflowEngine, private readonly prs: PullRequestService, private readonly reg: PluginRegistry, @Optional() private readonly branches?: BranchRegistries) {}

  /** The registry of the current workspace branch (plugin enablement is per tenant AND branch). */
  private async registry(): Promise<PluginRegistry> {
    return workspaceMode() && this.branches ? this.branches.get(currentBranch(false)) : this.reg;
  }

  /** Every external block used by the graph must have its provider plugin enabled (fail closed). */
  private async checkProviders(tenant: string, graph: WfGraph) {
    const registry = await this.registry();
    const used = [...new Set(graph.nodes.map((n) => externalBlockProvider(n.type)).filter((p): p is string => !!p))];
    for (const p of used)
      if (!registry.isActive(tenant, p)) throw new BadRequestException(`this workflow uses blocks from the "${p}" plugin, which is disabled for this tenant: enable it from the Plugins page`);
  }

  /** The editor palette: built-in step types + contributed blocks, with each provider's enabled state. */
  async catalogue(tenant: string) {
    const registry = await this.registry();
    return { blocks: blockCatalogue().map((b) => ({ ...b, providerActive: b.provider ? registry.isActive(tenant, b.provider) : true })) };
  }

  /** Free-form tags: 0 to 8 lowercase labels (letters, digits, hyphens), 1-24 chars each, deduped. */
  private static validateTags(input: unknown): string[] {
    if (input === undefined || input === null) return [];
    if (!Array.isArray(input)) throw new BadRequestException('tags must be an array of labels');
    const out: string[] = [];
    for (const raw of input) {
      const t = String(raw ?? '').trim().toLowerCase();
      if (!t) continue;
      if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(t)) throw new BadRequestException(`tag "${t}": lowercase letters, digits, hyphens (1-24 characters)`);
      if (!out.includes(t)) out.push(t);
      if (out.length > 8) throw new BadRequestException('at most 8 tags per workflow');
    }
    return out;
  }

  private checkId(id: unknown, what = 'id'): string {
    const s = String(id ?? '');
    if (!ID.test(s)) throw new BadRequestException(`invalid ${what}`);
    return s;
  }

  async list(tenant: string) {
    const defs = await this.store.listDefinitions(tenant, currentBranch());
    const stats = await this.store.runStats(tenant);
    return { definitions: defs.map((d) => { const s = stats.get(d.id); return { id: d.id, name: d.name, description: d.description, trigger: d.trigger, active: d.active, tags: d.tags, steps: d.graph.nodes.length, graph: { nodes: d.graph.nodes.map((n) => ({ id: n.id, type: n.type })), edges: d.graph.edges }, simulatedSteps: d.graph.nodes.filter((n) => stepCategoryOf(n.type) === 'simulated').length, computedSteps: d.graph.nodes.filter((n) => stepCategoryOf(n.type) === 'computed').length, dataSteps: d.graph.nodes.filter((n) => stepCategoryOf(n.type) === 'real').length, createdBy: d.created_by, createdAt: d.created_at, updatedAt: d.updated_at, stats: s ? { runs: s.runs, okPct: s.runs ? Math.round((s.ok / s.runs) * 100) : null, lastStatus: s.last?.status ?? null, lastAt: s.last?.started_at ?? null, lastDurationMs: s.last?.finished_at ? Date.parse(s.last.finished_at) - Date.parse(s.last.started_at) : null } : null }; }) };
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
    if (Object.keys(body ?? {}).some((k) => !['name', 'description', 'graph', 'trigger', 'active', 'tags'].includes(k))) throw new BadRequestException('unknown field');
    const tags = WorkflowsService.validateTags(body?.tags);
    const trigger = validateTrigger(body?.trigger);
    const { graph, order } = validateGraph(body?.graph);
    validateStepPlaceholders(graph, order);
    await this.checkProviders(tenant, graph);
    // Every {{event.<key>}} placeholder must resolve from the chosen trigger's payload; without a trigger there is no event at all.
    for (const n of graph.nodes) for (const v of Object.values(n.config)) {
      for (const key of placeholderKeys(v)) {
        if (!trigger) throw new BadRequestException(`step "${n.id}" uses {{event.${key}}} but the workflow has no start trigger`);
        if (!isWildcardEvent(trigger.event) && !WF_EVENTS[trigger.event].payload.includes(key)) throw new BadRequestException(`step "${n.id}": {{event.${key}}} is not a payload key of ${trigger.event} (${WF_EVENTS[trigger.event].payload.join(', ')})`);
      }
    }
    const ref = currentBranch(true);
    const existing = create ? null : await this.store.getDefinition(tenant, wid, ref);
    if (!create && !existing) throw new NotFoundException('unknown workflow');
    // active defaults to true on create and is preserved on update unless the caller passes it (false = paused: event triggers skip it).
    const active = body.active === undefined ? (existing?.active ?? true) : body.active === true || body.active === 'true';
    const def: DefinitionRow = { id: wid, tenant, name, description, graph, trigger, active, tags, created_by: existing?.created_by ?? String(sub ?? 'unknown'), created_at: existing?.created_at ?? now(), updated_at: now() };
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

  /** Flips only the active flag (the list cards' pause switch): no graph revalidation needed. */
  async setActive(tenant: string, id: unknown, active: unknown) {
    const ref = currentBranch(true);
    const d = await this.store.getDefinition(tenant, this.checkId(id, 'workflow id'), ref);
    if (!d) throw new NotFoundException('unknown workflow');
    if (typeof active !== 'boolean') throw new BadRequestException('active (boolean) is required');
    await this.store.putDefinition({ ...d, active }, ref);
    return { definition: { id: d.id, active } };
  }

  /** Deletes a finished run and its steps; a live run must be canceled first. */
  async removeRun(tenant: string, runId: unknown) {
    const r = await this.store.getRun(tenant, this.checkId(runId, 'run id'));
    if (!r) throw new NotFoundException('unknown run');
    if (r.status === 'queued' || r.status === 'running') throw new ConflictException('cancel the run first');
    await this.store.deleteRun(r.id);
    return { deleted: r.id };
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
      const category = stepCategoryOf(n.type);
      return {
        step: n.id, type: n.type, name: n.name, simulated, category, config: n.config,
        would: externalBlockProvider(n.type)
          ? category === 'computed'
            ? `a computed block from the "${externalBlockProvider(n.type)}" plugin (really runs, no external effect) - NOT executed in this test`
            : `an external block from the "${externalBlockProvider(n.type)}" plugin (HTTP call, sheet or Jira write, user creation) - NOT executed in this test`
          : simulated ? 'write a log line only (a simulated step never has an external effect)' : 'a REAL data write on the run branch - NOT executed in this test',
      };
    });
    return { definition: d.id, name: d.name, trigger: d.trigger, autoFilledEventKeys: autoFilled, steps, dataSteps: steps.filter((x) => !x.simulated).length, executed: false, note: 'test only: nothing was executed, written, sent or stored' };
  }

  async start(tenant: string, id: unknown, sub: unknown, event?: { branch: string; payload: Record<string, string>; eventId?: string }) {
    // A run executes effects now, so it always uses the LIVE (main) definition, never an unreviewed branch edit.
    const d = await this.store.getDefinition(tenant, this.checkId(id, 'workflow id'), this.store.liveRef);
    if (!d) throw new NotFoundException('unknown workflow');
    await this.checkProviders(tenant, d.graph);
    const runId = event?.eventId ? `run-${createHash('sha256').update(JSON.stringify([tenant, d.id, event.branch, event.eventId])).digest('hex').slice(0, 32)}` : `run-${randomBytes(6).toString('hex')}`;
    if (event?.eventId && await this.store.getRun(tenant, runId)) return this.runView(tenant, runId);
    const active = (await this.store.listRuns(tenant, d.id, 100)).filter((r) => r.status === 'queued' || r.status === 'running');
    if (active.length >= 3) throw new ConflictException('3 runs of this workflow are already active: wait for one to finish (demo guard)');
    // Resolve {{event.<key>}} placeholders from the triggering event (a manual start keeps the graph as saved,
    // so a definition that still needs placeholders cannot start manually: the error says which key is missing).
    const resolved = event ? substituteEventPayload(d.graph, event.payload) : substituteEventPayload(d.graph, {});
    const { order, graph } = validateGraph(resolved);
    const run: RunRow = { id: runId, tenant, definition_id: d.id, name: d.name, graph, branch: null, base_branch: event?.branch ?? null, status: 'queued', error: null, started_by: String(sub ?? 'unknown'), started_at: now(), finished_at: null, test: false };
    const steps: StepRow[] = order.map((nodeId) => {
      const n = graph.nodes.find((x) => x.id === nodeId)!;
      return { run_id: run.id, node_id: nodeId, status: 'pending', simulated: STEP_TYPES[n.type].simulated, attempts: 0, error: null, log: [], input: null, output: null, started_at: null, finished_at: null };
    });
    await this.store.createRun(run, steps);
    this.engine.kick(run.id);
    return this.runView(tenant, run.id);
  }

  async listRuns(tenant: string, definitionId?: string, filters: { status?: string; tests?: boolean } = {}) {
    if (definitionId !== undefined) this.checkId(definitionId, 'workflow id');
    if (filters.status !== undefined && !['queued', 'running', 'completed', 'failed', 'canceled'].includes(filters.status)) throw new BadRequestException('status: queued, running, completed, failed or canceled');
    const runs = (await this.store.listRuns(tenant, definitionId, 200))
      .filter((r) => (filters.tests ? true : !r.test) && (!filters.status || r.status === filters.status))
      .slice(0, 50);
    return { runs: runs.map((r) => this.publicRun(r)) };
  }

  private publicRun(r: RunRow) {
    return { id: r.id, definitionId: r.definition_id, name: r.name, branch: r.branch, status: r.status, error: r.error, startedBy: r.started_by, startedAt: r.started_at, finishedAt: r.finished_at, hasDataSteps: hasDataSteps(r.graph), test: r.test };
  }

  /**
   * TEST RUN from the editor: executes an AD-HOC graph (not necessarily saved) with a test event payload.
   * Real steps write on a DISPOSABLE workflow/test-* branch, dropped when the run settles. Test runs are hidden
   * from the default run list and can never be reviewed or merged.
   */
  async testRun(tenant: string, body: Record<string, unknown>, sub: unknown) {
    if (Object.keys(body ?? {}).some((k) => !['graph', 'trigger', 'payload'].includes(k))) throw new BadRequestException('unknown field');
    const trigger = validateTrigger(body?.trigger);
    const { graph, order } = validateGraph(body?.graph);
    validateStepPlaceholders(graph, order);
    await this.checkProviders(tenant, graph);
    for (const n of graph.nodes) for (const v of Object.values(n.config)) {
      for (const key of placeholderKeys(v)) {
        if (!trigger && !body?.payload) throw new BadRequestException(`step "${n.id}" uses {{event.${key}}} but the test has no trigger/payload`);
        if (trigger && !isWildcardEvent(trigger.event) && !WF_EVENTS[trigger.event].payload.includes(key)) throw new BadRequestException(`step "${n.id}": {{event.${key}}} is not a payload key of ${trigger.event}`);
      }
    }
    const eventPayload: Record<string, string> = {};
    for (const [k, v] of Object.entries((body?.payload as Record<string, unknown>) ?? {})) if (/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(k)) eventPayload[k] = String(v).slice(0, 200);
    if (trigger) for (const key of WF_EVENTS[trigger.event]?.payload ?? []) if (!(key in eventPayload) && key !== '*') eventPayload[key] = `<${key}>`;
    const resolved = substituteEventPayload(graph, eventPayload);
    const checked = validateGraph(resolved);
    const runId = `run-${randomBytes(6).toString('hex')}`;
    const run: RunRow = { id: runId, tenant, definition_id: 'editor-test', name: 'Test run (editor)', graph: checked.graph, branch: null, base_branch: currentBranch(), status: 'queued', error: null, started_by: String(sub ?? 'unknown'), started_at: now(), finished_at: null, test: true };
    const steps: StepRow[] = checked.order.map((nodeId) => {
      const n = checked.graph.nodes.find((x) => x.id === nodeId)!;
      return { run_id: run.id, node_id: nodeId, status: 'pending', simulated: STEP_TYPES[n.type].simulated, attempts: 0, error: null, log: [], input: null, output: null, started_at: null, finished_at: null };
    });
    await this.store.createRun(run, steps);
    this.engine.kick(run.id);
    return this.runView(tenant, run.id);
  }

  /** Re-runs a terminal run FROM a given step: that step and everything downstream are reset to pending. */
  async rerunFrom(tenant: string, runId: unknown, nodeId: unknown) {
    const view = await this.runView(tenant, runId);
    const r = view.run;
    if (!['completed', 'failed', 'canceled'].includes(r.status)) throw new ConflictException(`only a finished run can be re-run from a step (this one is ${r.status})`);
    const nid = this.checkId(nodeId, 'step id');
    if (!view.run.order.includes(nid)) throw new NotFoundException('unknown step in this run');
    const down = new Set([nid]);
    let grew = true;
    while (grew) { grew = false; for (const e of view.run.edges) if (down.has(e.from) && !down.has(e.to)) { down.add(e.to); grew = true; } }
    for (const s of view.steps) if (down.has(s.node_id)) await this.store.patchStep(r.id, s.node_id, { status: 'pending', error: null, input: null, output: null, finished_at: null });
    await this.store.updateRun(r.id, { status: 'queued', error: null, finished_at: null });
    this.engine.kick(r.id);
    return this.runView(tenant, r.id);
  }

  /** Duplicates a definition (same graph/trigger, new id, "(copy)" name). */
  async duplicate(tenant: string, id: unknown, sub: unknown) {
    const ref = currentBranch(true);
    const d = await this.store.getDefinition(tenant, this.checkId(id, 'workflow id'), ref);
    if (!d) throw new NotFoundException('unknown workflow');
    const copy: DefinitionRow = { ...d, id: `wf-def-${randomBytes(4).toString('hex')}`, name: `${d.name.slice(0, 70)} (copy)`, created_by: String(sub ?? 'unknown'), created_at: now(), updated_at: now() };
    await this.store.putDefinition(copy, ref);
    return { definition: copy };
  }

  async runView(tenant: string, runId: unknown): Promise<RunView> {
    const r = await this.store.getRun(tenant, this.checkId(runId, 'run id'));
    if (!r) throw new NotFoundException('unknown run');
    const steps = await this.store.steps(r.id);
    const nodes = new Map(r.graph.nodes.map((n) => [n.id, n]));
    const { order } = validateGraph(r.graph);
    return {
      run: { id: r.id, tenant: r.tenant, definition_id: r.definition_id, name: r.name, branch: r.branch, base_branch: r.base_branch, status: r.status, error: r.error, started_by: r.started_by, started_at: r.started_at, finished_at: r.finished_at, simulatedOnly: !hasDataSteps(r.graph), order, edges: r.graph.edges, test: r.test },
      steps: order.map((nodeId) => {
        const s = steps.find((x) => x.node_id === nodeId);
        const n = nodes.get(nodeId)!;
        return { ...(s ?? { run_id: r.id, node_id: nodeId, status: 'pending' as const, simulated: STEP_TYPES[n.type].simulated, attempts: 0, error: null, log: [], input: null, output: null, started_at: null, finished_at: null }), name: n.name, type: n.type, label: STEP_TYPES[n.type].label, category: stepCategoryOf(n.type) };
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
    if (r.test) throw new BadRequestException('a test run cannot be reviewed: its branch is disposable and is dropped when the run settles');
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
