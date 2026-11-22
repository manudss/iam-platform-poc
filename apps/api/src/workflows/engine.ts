import { dataReady, awaitDataReady } from '../migrations/readiness.js';
import { WorkflowConnections, connectionProvider } from './connections.js';
import { WorkspacePublisher } from '../workspace/workspace-publisher.js';
import { forwardRef, Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { branchContext, currentBranch, workspaceMode } from '../workspace/context.js';
import { validateSettings } from '../plugins/v1/settings.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { PullRequestService } from '../versioning/pull-requests.service.js';
import { authorOf } from '../versioning/guards.js';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { resolveEngine } from '../plugins/v1/engines.js';
import { RunRow, StepRow, WorkflowStore } from './store.js';
import { WorkflowTasksService } from './tasks.js';
import { WorkflowReads } from './reads.js';
import { WorkflowsIgaService } from './iga.service.js';
import type { WfGraph } from './model.js';
import { AuthnService } from '../authn/flow.service.js';
import { ApplicationBus } from '../events/application-bus.service.js';
import { BlocksService } from '../accounts/blocks.service.js';
import { inForce } from '../accounts/blocks.js';
import { patchSecurity } from '../accounts/security-config.js';
import { UsersService } from '../users/users.service.js';
import { RunSecrets } from './run-secrets.js';
import { CorePolicySource } from '../policies/policy-studio.js';
import { STEP_TYPES, substituteEventPayload, validateGraph } from './model.js';
import { randomBytes } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

export { hasDataSteps } from './model.js';

/**
 * Local workflow runner (the DEFAULT execution path, used by the hosted demo which has no Temporal
 * server). The execution logic lives in the `workflows-iga` plugin folder
 * (`plugins/workflows-iga/engine.mjs`); this core adapter holds the Nest wiring: it feeds the engine
 * the store and the Dolt versioning primitives, and resumes interrupted runs on boot.
 *
 * Step 3: the engine is RESOLVED through the plugin registry (slot `workflows.engine`) per run, from the
 * run's tenant and branch, instead of being created from a hardcoded plugin id in the constructor.
 * Disabling the plugin fails closed (no engine: runs stay queued, the HTTP guard already 403s); a
 * replacement plugin extending `workflows-engine-base` takes over with no core change. A run in flight
 * when the provider changes finishes on the engine instance that started it.
 */
interface PublishEffects { diff: (from: string, to: string) => Promise<unknown>; status: (tenant: string, id: number) => Promise<{ pullRequest: unknown }>; request: (tenant: string, runId: string, title: string) => Promise<{ pullRequest: unknown; reused: boolean }> }
interface EngineDeps {
  store: WorkflowStore;
  versioning: { createBranch: (branch: string, base: string) => Promise<unknown>; writeOn: <T>(branch: string, fn: (c: unknown) => Promise<T>) => Promise<T>; defaultBranch: string; deleteBranch?: (branch: string) => Promise<unknown> };
  authorOf: (actor: string) => string;
  branchRun: <T>(branch: string, fn: () => Promise<T>) => Promise<T>;
  settingsFor: (tenant: string, branch: string | null, pluginId: string) => Promise<Record<string, unknown>>;
  connectionFor?: (tenant: string, ref: string, id: string, type: string) => Promise<{ settings: Record<string, unknown>; secret: string }>;
  accounts?: AccountEffects;
  workspace?: WorkspaceEffects;
  secrets?: RunSecrets;
  users?: UserEffects;
  links?: LinkEffects;
  /** Durable human tasks, business reads and IGA campaigns (the lyam-* and iga-* blocks). Absent in minimal test harnesses: the blocks then refuse honestly. */
  tasks?: WorkflowTasksService;
  reads?: WorkflowReads;
  iga?: WorkflowsIgaService;
  publish?: PublishEffects;
  runs?: unknown;
  policies?: unknown;
  pluginsAdmin?: unknown;
  log: { warn: (m: string) => void; error: (m: string) => void };
}
/** The durable ticket > account > sheet-row correlation (meta store). Every call is scoped to the run's tenant by the engine; a block never passes a tenant. */
export interface LinkEffects {
  put: (tenant: string, l: { connectionId: string; project: string; issueKey: string; account: string; source: string; spreadsheetId: string; sheetId: number; keyColumn: string; keyValue: string; runId: string }) => Promise<void>;
  claim: (tenant: string, k: { connectionId: string; project: string; issueKey: string }, runId: string) => Promise<{ account: string; phase1Run: string; source: string; spreadsheetId: string; sheetId: number; keyColumn: string; keyValue: string } | null>;
  complete: (tenant: string, k: { connectionId: string; project: string; issueKey: string }, runId: string) => Promise<boolean>;
}
/** What account blocks and security settings blocks may do. Operational effects apply at once (with audit and event), settings only patch a stored row the block writes on the run branch. */
export interface AccountEffects {
  block: (tenant: string, a: { runId: string; subject: string; kind: string; message: string; untilSeconds?: number }) => Promise<{ applied: boolean; blockId: string }>;
  unblock: (tenant: string, a: { runId: string; subject: string; kind?: string; ownerRun?: string }) => Promise<{ lifted: number; remaining: number }>;
  /** The blocks in force on an account, read live (guard before a secret mail). */
  activeBlocks: (tenant: string, subject: string) => Promise<{ kind: string; setBy: string }[]>;
  patchSecurity: (current: Record<string, unknown> | undefined, setting: string, value: string) => Record<string, unknown>;
}
/** Publication of a run branch to main (the lyam-publish-workspace block). Absent when the server has no publisher: the block then refuses. */
export interface WorkspaceEffects {
  headOf: (branch: string) => Promise<string | null>;
  proof: (tenant: string, sourceHead: string) => Promise<{ mainCommit: string; activation: string; activationCommit: string; containsHead: boolean }>;
  publish: (tenant: string, a: { runId: string; workflowId: string; branch: string; expectedHead: string }) => Promise<{ published: boolean; branch: string; sourceHead: string; mainCommit: string; activation: string }>;
}
/** Temporary password on the run branch, and the real first-access state of an account on a ref (the credential revision and its server-side expiry; never the password). */
export interface UserEffects {
  setTemporary: (tenant: string, a: { runId: string; branch: string; id: string; password: string; hours: number }) => Promise<{ revision: string; expiresAt: number }>;
  emailOf: (tenant: string, id: string, ref: string) => Promise<string | null>;
  firstAccess: (tenant: string, id: string, ref: string) => Promise<{ required: false } | { required: true; expired: boolean; revision: string; expiresAt: number }>;
}
interface WorkflowEngineApi {
  resume: () => Promise<void>;
  kick: (runId: string) => void;
  cancelFlag: (runId: string) => void;
  forget: (runId: string) => void;
}

@Injectable()
export class WorkflowEngine implements OnModuleInit {
  private readonly log = new Logger('workflows');
  private readonly deps: EngineDeps;

  constructor(private readonly store: WorkflowStore, v: VersioningService, private readonly reg: PluginRegistry, @Optional() private readonly branches?: BranchRegistries, @Optional() private readonly connections?: WorkflowConnections, @Optional() private readonly authn?: AuthnService, @Optional() private readonly events?: ApplicationBus, @Optional() private readonly publisher?: WorkspacePublisher, @Optional() private readonly users?: UsersService, @Optional() @Inject(forwardRef(() => WorkflowTasksService)) private readonly tasks?: unknown, @Optional() @Inject(forwardRef(() => WorkflowReads)) private readonly reads?: unknown, @Optional() @Inject(forwardRef(() => WorkflowsIgaService)) private readonly iga?: unknown, @Optional() @Inject(forwardRef(() => PullRequestService)) private readonly prs?: unknown) {
    this.deps = {
      store,
      versioning: { createBranch: (b, base) => v.createBranch(b, base), writeOn: (b, fn) => v.writeOn(b, fn as never), defaultBranch: v.defaultBranch, deleteBranch: (b) => v.deleteBranch(b, async () => false) },
      authorOf,
      branchRun: (b, fn) => branchContext.run({ branch: b }, fn),
      settingsFor: (tenant, branch, pluginId) => this.settingsFor(tenant, branch, pluginId),
      connectionFor: async (tenant, ref, id, type) => {
        const provider = connectionProvider(type);
        if (!this.connections || !provider) throw new Error('managed connections unavailable');
        return this.connections.resolve(tenant, ref, id, provider);
      },
      accounts: this.accountEffects(),
      workspace: this.workspaceEffects(v),
      secrets: new RunSecrets(),
      users: this.userEffects(),
      links: this.linkEffects(store),
      tasks: (tasks ?? undefined) as WorkflowTasksService | undefined, reads: (reads ?? undefined) as WorkflowReads | undefined, iga: (iga ?? undefined) as WorkflowsIgaService | undefined,
      runs: this.runEffects(),
      publish: this.publishEffects(v),
      policies: { validate: async (_tenant: string, candidate: unknown) => { try { const r = await new CorePolicySource().validate(candidate as never); return { valid: true, ...(r && typeof r === 'object' ? r as unknown as Record<string, unknown> : {}) }; } catch (e) { return { valid: false, errors: [(e as Error).message] }; } } },
      log: { warn: (m) => this.log.warn(m), error: (m) => this.log.error(m) },
    };
  }

  /**
   * The only server-side gate of a workflow publication is HERE, before any call: the exact immutable id of the workflow being executed (run.definition_id, set by the engine, never by a block
   * config or a run input) must be listed in the `publishAllowedWorkflows` setting read from MAIN (never from the run branch, so a run cannot widen it). Absent, unreadable, malformed or empty = refusal.
   */
  private workspaceEffects(v: VersioningService): WorkspaceEffects | undefined {
    const publisher = this.publisher; if (!publisher) return undefined;
    return {
      proof: (tenant, sourceHead) => publisher.liveProof(tenant, sourceHead),
      headOf: async (branch) => (await v.branches()).branches.find((b) => b.name === branch)?.commit ?? null,
      publish: async (tenant, a) => {
        let allowed: string[] = [];
        try { allowed = String((await this.settingsFor(tenant, v.defaultBranch, 'workflow-connectors')).publishAllowedWorkflows ?? '').split(',').map((x) => x.trim()).filter(Boolean); } catch { throw new Error('lyam-publish-workspace: the authorization setting cannot be read (nothing published)'); }
        if (!a.workflowId || !allowed.includes(a.workflowId)) throw new Error('lyam-publish-workspace: this workflow is not authorized to publish (an administrator lists its id in the publishAllowedWorkflows setting)');
        return publisher.publishForRun({ tenant, ...a });
      },
    };
  }

  private linkEffects(store: WorkflowStore): LinkEffects {
    return {
      put: async (tenant, l) => { await store.putTicketLink({ tenant, ...l }); },
      claim: async (tenant, k, runId) => { const r = await store.claimTicketLink({ tenant, ...k }, runId); return r ? { account: r.account, phase1Run: r.phase1_run, source: r.source, spreadsheetId: r.spreadsheet_id, sheetId: Number(r.sheet_id), keyColumn: r.key_column, keyValue: r.key_value } : null; },
      complete: (tenant, k, runId) => store.completeTicketLink({ tenant, ...k }, runId),
    };
  }

  private userEffects(): UserEffects | undefined {
    const users = this.users; if (!users) return undefined;
    return {
      setTemporary: async (tenant, a) => {
        await branchContext.run({ branch: a.branch }, () => users.setTemporaryPassword(tenant, `workflow:${a.runId}`, a.id, a.password, a.hours));
        const st = await users.firstAccessState(tenant, a.id, a.branch);
        if (!st.required) throw new Error('the temporary password was not recorded with the first-access rule');
        return { revision: st.revision, expiresAt: st.expiresAt };
      },
      firstAccess: (tenant, id, ref) => users.firstAccessState(tenant, id, ref),
      emailOf: async (_tenant, id, ref) => { const e = ((await users.list(ref)).find((x) => x.id === id) as { email?: unknown } | undefined)?.email; return typeof e === 'string' ? e : null; },
    };
  }

  /** Child runs and run reads (the lyam-start-workflow / lyam-read-run blocks). A child run is a normal
   *  queued run started by 'workflow:<parent run id>': it validates and runs on the same engine. */
  private runEffects() {
    const store = this.store;
    return {
      get: async (tenant: string, runId: string) => {
        const r = await store.getRun(tenant, runId);
        if (!r) throw new BadRequestException(`lyam-read-run: unknown run "${runId}"`);
        const steps = await store.steps(r.id);
        return { id: r.id, definitionId: r.definition_id, name: r.name, status: r.status, error: r.error, startedBy: r.started_by, startedAt: r.started_at, finishedAt: r.finished_at, steps: steps.map((s) => ({ step: s.node_id, status: s.status, output: s.output })) };
      },
      start: async (tenant: string, workflowId: string, input: Record<string, unknown>, startedBy: string) => {
        const d = await store.getDefinition(tenant, workflowId, currentBranch() ?? 'main');
        if (!d) throw new BadRequestException(`lyam-start-workflow: unknown workflow "${workflowId}" on this ref`);
        if (!d.active) throw new BadRequestException(`lyam-start-workflow: the workflow "${workflowId}" is disabled`);
        // Sub-workflow guards: a disabled definition never starts; the SAME definition never appears twice in
        // the starter chain (runaway recursion — unique run ids alone detect nothing); nesting stops at 8 runs;
        // a run starts at most 32 direct children (fanout bound).
        let parentRef: string | null = startedBy.startsWith('workflow:') ? startedBy.slice('workflow:'.length) : null;
        if (parentRef && (await store.countRunsStartedBy(tenant, startedBy)) >= 32) throw new BadRequestException(`lyam-start-workflow: run ${parentRef} already started 32 child runs (fanout bound)`);
        for (let depth = 0; parentRef; depth++) {
          if (depth >= 8) throw new BadRequestException('lyam-start-workflow: sub-workflow nesting too deep (8 runs maximum)');
          const parent: RunRow | null = await store.getRun(tenant, parentRef);
          if (!parent) break;
          if (parent.definition_id === d.id) throw new BadRequestException(`lyam-start-workflow: the workflow "${workflowId}" is already running upstream in this starter chain (recursive invocation refused)`);
          parentRef = parent.started_by?.startsWith('workflow:') ? parent.started_by.slice('workflow:'.length) : null;
        }
        const payload: Record<string, string> = {};
        for (const [k, v] of Object.entries(input ?? {})) if (/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(k)) payload[k] = String(v).slice(0, 200);
        const resolved = substituteEventPayload(d.graph, payload);
        const { order, graph } = validateGraph(resolved);
        const runId = `run-${randomBytes(6).toString('hex')}`;
        const run: RunRow = { id: runId, tenant, definition_id: d.id, name: d.name, graph, branch: null, base_branch: currentBranch(), status: 'queued', error: null, started_by: startedBy, started_at: new Date().toISOString().slice(0, 23).replace('T', ' '), finished_at: null, test: false };
        const steps: StepRow[] = order.map((nodeId: string) => {
          const n = graph.nodes.find((x: { id: string }) => x.id === nodeId)!;
          return { run_id: run.id, node_id: nodeId, status: 'pending', simulated: STEP_TYPES[n.type].simulated, attempts: 0, error: null, log: [], input: null, output: null, started_at: null, finished_at: null };
        });
        await store.createRun(run, steps);
        this.kick(run.id);
        return { id: run.id, definitionId: d.id, started: true };
      },
    };
  }

  /** Publication of a run branch: the Dolt diff, and opening (or reusing) the pull request a human reviews.
   *  The merge itself stays a human action; absent in minimal servers, the blocks refuse honestly. */
  private publishEffects(v: VersioningService): PublishEffects | undefined {
    const prs = this.prs as PullRequestService | undefined;
    const store = this.store;
    if (!prs) return undefined;
    return {
      diff: async (from: string, to: string) => v.diffSummary(from, to, true),
      status: async (tenant: string, id: number) => { const r = await prs.get(tenant, id); return { pullRequest: (r as { pullRequest: unknown }).pullRequest }; },
      request: async (tenant: string, runId: string, title: string) => {
        const r = await store.getRun(tenant, runId);
        if (!r) throw new BadRequestException(`lyam-request-publish: unknown run "${runId}"`);
        if (r.test) throw new BadRequestException('lyam-request-publish: a test run has no publishable branch');
        if (!r.branch) throw new BadRequestException('lyam-request-publish: this run only had simulated steps: there is no data branch to publish');
        const target = r.base_branch ?? 'main';
        const open = await prs.list(tenant, 'open');
        const existing = (open.pullRequests as { source: string }[]).find((p) => p.source === r.branch);
        if (existing) return { pullRequest: existing as unknown, reused: true };
        try {
          const pr = await prs.create(tenant, { title, body: `Data changes produced by workflow run ${r.id} on branch ${r.branch}. The merge stays a human action.`, source: r.branch, target }, `workflow:${runId}`);
          return { pullRequest: pr as unknown, reused: false };
        } catch (e) {
          if ((e as { status?: number }).status === 409) { const again = await prs.list(tenant, 'open'); const pr = (again.pullRequests as { source: string }[]).find((p) => p.source === r.branch); if (pr) return { pullRequest: pr as unknown, reused: true }; }
          throw e;
        }
      },
    };
  }

  private accountEffects(): AccountEffects | undefined {
    const authn = this.authn; if (!authn) return undefined;
    const svc = new BlocksService(authn.blocks, (e) => this.events?.emit({ ...e, branch: 'main' } as never));
    const admins = () => (process.env.IAM_API_ADMIN_SUBJECTS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    return {
      // The workflow definition was reviewed and merged by people who hold the right: it acts with that right. The protections that no right overrides still apply (last active administrator).
      block: async (tenant, a) => {
        const now = Date.now();
        const existing = inForce(await authn.blocks.list(tenant, a.subject), now).find((b) => b.kind === a.kind);
        if (existing) return { applied: false, blockId: existing.id };
        const b = await svc.block({ tenant, actor: `workflow:${a.runId}`, subject: a.subject, kind: a.kind, message: a.message, ...(a.untilSeconds ? { until: now + a.untilSeconds * 1000 } : {}), admins: admins() });
        return { applied: true, blockId: b.id };
      },
      unblock: async (tenant, a) => {
        const blocks = (await authn.blocks.list(tenant, a.subject)).filter((b) => (!a.kind || b.kind === a.kind) && (!a.ownerRun || b.setBy === `workflow:${a.ownerRun}`));
        let lifted = 0;
        // Two concurrent lifts of the same block: the loser finds it already gone, which is the wanted end state, not a failure.
        for (const b of blocks) { try { await svc.unblock({ tenant, actor: `workflow:${a.runId}`, subject: a.subject, blockId: b.id }); lifted++; } catch (e) { if ((e as { status?: number }).status !== 404) throw e; } }
        return { lifted, remaining: inForce(await authn.blocks.list(tenant, a.subject), Date.now()).length };
      },
      activeBlocks: async (tenant, subject) => inForce(await authn.blocks.list(tenant, subject), Date.now()).map((b) => ({ kind: b.kind, setBy: b.setBy })),
      patchSecurity,
    };
  }

  /** The validated settings of a block provider plugin (secrets resolved), on the current branch registry. */
  private async settingsFor(tenant: string, branch: string | null, pluginId: string): Promise<Record<string, unknown>> {
    const registry = await this.registryFor(branch);
    const impl = registry.impl(pluginId);
    if (!impl) return {};
    const raw = (await registry.settingsFor(tenant, pluginId)) ?? {};
    return validateSettings(impl.manifest.settings, raw).values;
  }

  /** The registry of the run's branch (engine choice is per tenant AND branch, like the enable guard). */
  private async registryFor(branch: string | null): Promise<PluginRegistry> {
    if (!workspaceMode() || !this.branches) return this.reg;
    return this.branches.get(branch ?? 'main');
  }

  /** The engine of the plugin serving the workflows.engine slot for this run. */
  private async engineFor(run: RunRow): Promise<WorkflowEngineApi> {
    return resolveEngine(() => this.registryFor(run.branch), run.tenant, 'workflows.engine', 'engine.mjs', (mod: { createWorkflowEngine: (deps: EngineDeps) => WorkflowEngineApi }) => mod.createWorkflowEngine(this.deps), this);
  }

  /** Resumes interrupted runs: grouped by the registry that must resolve the provider, kicked individually. A
   * run whose provider cannot be resolved at boot is retried with backoff, then left with an explicit
   * reconciliable error: never silently stuck in 'running', never blindly replayed. */
  async onModuleInit() {
    if (!dataReady()) { void awaitDataReady().then(() => this.onModuleInit()).catch(() => this.log.error('resume refused after data migrations')); return; }
    let runs: RunRow[] = [];
    try { runs = await this.store.runningRuns(); } catch (e) { this.log.warn(`resume scan failed: ${(e as Error).message}`); return; }
    for (const r of runs) {
      try { (await this.engineFor(r)).kick(r.id); } catch (e) { void this.resumeWithRetry(r, (e as Error).message); }
    }
  }

  /** Bounded retry of a boot resume that could not resolve the run's engine (provider plugin still loading or
   * faulted). After the last attempt the run keeps its status but carries an explicit RESUME_FAILED error, so a
   * stuck run is visible and reconciliable instead of silently 'running' forever. Every attempt only ever calls
   * kick: execution re-derives from the persisted steps, so no effect is blindly replayed. */
  private resumeTimers = new Set<ReturnType<typeof setTimeout>>();
  private resumeStopped = false;
  onModuleDestroy() { this.resumeStopped = true; for (const t of this.resumeTimers) clearTimeout(t); this.resumeTimers.clear(); }
  private resumeDelay(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.resumeTimers.delete(t); resolve(!this.resumeStopped); }, ms);
      this.resumeTimers.add(t);
    });
  }
  private async resumeWithRetry(run: RunRow, firstError: string) {
    const delays = (process.env.WF_RESUME_RETRY_DELAYS_MS ?? '5000,30000,120000').split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0);
    let last = firstError;
    for (const d of delays) {
      if (!(await this.resumeDelay(d))) return; // shutting down: no late write after close
      try {
        (await this.engineFor(run)).kick(run.id);
        this.log.log(`run ${run.id} resumed after a retry`);
        try { await this.store.clearResumeFailed(run.id); } catch { /* the marker stays, the run did resume */ }
        return;
      } catch (e) { last = (e as Error).message; }
    }
    if (this.resumeStopped) return;
    const message = `RESUME_FAILED: engine unavailable after ${delays.length + 1} attempts: ${last}`;
    this.log.error(`run ${run.id}: ${message}`);
    try { await this.store.markResumeFailed(run.id, message); } catch (e) { this.log.error(`run ${run.id}: the resume failure could not be recorded: ${(e as Error).message}`); }
  }

  /** Starts the asynchronous execution of a run already recorded as queued. Returns immediately. */
  kick(runId: string) { void this.delegate(runId, (e) => e.kick(runId)); }
  cancelFlag(runId: string) { void this.delegate(runId, (e) => e.cancelFlag(runId)); }
  forget(runId: string) { void this.delegate(runId, (e) => e.forget(runId)); }

  private async delegate(runId: string, op: (e: WorkflowEngineApi) => void) {
    try {
      const run = await this.store.getRunById(runId);
      if (!run) { this.log.warn(`run ${runId} not found`); return; }
      op(await this.engineFor(run));
    } catch (e) { this.log.warn(`run ${runId}: ${(e as Error).message}`); }
  }
}

// Types referenced by the engine's callers.
export type { RunRow, StepRow, WfGraph };
