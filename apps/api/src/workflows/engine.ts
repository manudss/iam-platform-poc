import { WorkflowConnections, connectionProvider } from './connections.js';
import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { branchContext, currentBranch, workspaceMode } from '../workspace/context.js';
import { validateSettings } from '../plugins/v1/settings.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { authorOf } from '../versioning/guards.js';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { resolveEngine } from '../plugins/v1/engines.js';
import { RunRow, StepRow, WorkflowStore } from './store.js';
import type { WfGraph } from './model.js';

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
interface EngineDeps {
  store: WorkflowStore;
  versioning: { createBranch: (branch: string, base: string) => Promise<unknown>; writeOn: <T>(branch: string, fn: (c: unknown) => Promise<T>) => Promise<T>; defaultBranch: string; deleteBranch?: (branch: string) => Promise<unknown> };
  authorOf: (actor: string) => string;
  branchRun: <T>(branch: string, fn: () => Promise<T>) => Promise<T>;
  settingsFor: (tenant: string, branch: string | null, pluginId: string) => Promise<Record<string, unknown>>;
  connectionFor?: (tenant: string, ref: string, id: string, type: string) => Promise<{ settings: Record<string, unknown>; secret: string }>;
  log: { warn: (m: string) => void; error: (m: string) => void };
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

  constructor(private readonly store: WorkflowStore, v: VersioningService, private readonly reg: PluginRegistry, @Optional() private readonly branches?: BranchRegistries, @Optional() private readonly connections?: WorkflowConnections) {
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
      log: { warn: (m) => this.log.warn(m), error: (m) => this.log.error(m) },
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

  /** Resumes interrupted runs: grouped by the registry that must resolve the provider, kicked individually. */
  async onModuleInit() {
    let runs: RunRow[] = [];
    try { runs = await this.store.runningRuns(); } catch (e) { this.log.warn(`resume scan failed: ${(e as Error).message}`); return; }
    for (const r of runs) {
      try { (await this.engineFor(r)).kick(r.id); } catch (e) { this.log.warn(`run ${r.id} not resumed: ${(e as Error).message}`); }
    }
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
