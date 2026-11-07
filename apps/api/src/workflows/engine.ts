import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { branchContext } from '../workspace/context.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { authorOf } from '../versioning/guards.js';
import { defaultPluginsDir } from '../plugins/v1/loader.js';
import { RunRow, StepRow, WorkflowStore } from './store.js';
import type { WfGraph } from './model.js';

export { hasDataSteps } from './model.js';

/**
 * Local workflow runner (the DEFAULT execution path, used by the hosted demo which has no Temporal
 * server). The execution logic lives in the `workflows-iga` plugin folder
 * (`plugins/workflows-iga/engine.mjs`); this core adapter holds the Nest wiring: it feeds the engine
 * the store and the Dolt versioning primitives, and resumes interrupted runs on boot.
 */
interface EngineDeps {
  store: WorkflowStore;
  versioning: { createBranch: (branch: string, base: string) => Promise<unknown>; writeOn: <T>(branch: string, fn: (c: unknown) => Promise<T>) => Promise<T>; defaultBranch: string };
  authorOf: (actor: string) => string;
  branchRun: <T>(branch: string, fn: () => Promise<T>) => Promise<T>;
  log: { warn: (m: string) => void; error: (m: string) => void };
}
interface WorkflowEngineApi {
  resume: () => Promise<void>;
  kick: (runId: string) => void;
  cancelFlag: (runId: string) => void;
  forget: (runId: string) => void;
}
const plugin = createRequire(import.meta.url)(resolve(defaultPluginsDir(), 'workflows-iga', 'engine.mjs')) as { createWorkflowEngine: (deps: EngineDeps) => WorkflowEngineApi };

@Injectable()
export class WorkflowEngine implements OnModuleInit {
  private readonly log = new Logger('workflows');
  private readonly engine: WorkflowEngineApi;

  constructor(store: WorkflowStore, v: VersioningService) {
    this.engine = plugin.createWorkflowEngine({
      store,
      versioning: { createBranch: (b, base) => v.createBranch(b, base), writeOn: (b, fn) => v.writeOn(b, fn as never), defaultBranch: v.defaultBranch },
      authorOf,
      branchRun: (b, fn) => branchContext.run({ branch: b }, fn),
      log: { warn: (m) => this.log.warn(m), error: (m) => this.log.error(m) },
    });
  }

  async onModuleInit() { await this.engine.resume(); }

  /** Starts the asynchronous execution of a run already recorded as queued. Returns immediately. */
  kick(runId: string) { this.engine.kick(runId); }
  cancelFlag(runId: string) { this.engine.cancelFlag(runId); }
  forget(runId: string) { this.engine.forget(runId); }
}

// Types referenced by the engine's callers.
export type { RunRow, StepRow, WfGraph };
