import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { AppEvent, AppEvents, APP_EVENT_KINDS } from '../events/app-events.service.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { workspaceMode } from '../workspace/context.js';
import { WorkflowStore } from './store.js';
import { WorkflowsService } from './workflows.service.js';

/**
 * Start triggers: when the application emits an event (a real write already happened), every workflow
 * definition whose trigger matches starts a run. The run is exactly like a manual one - same guards
 * (max 3 active per definition), same rules (data steps on the run's own branch, human review to merge) -
 * except it branches from the branch the event happened on and is reviewed back into it.
 *
 * Safety: trigger dispatch never loops (the engine writes through SQL, never through the services that
 * emit events), never breaks the action that fired the event (AppEvents is fire-and-forget), and stays
 * silent while the workflows-iga plugin is disabled on the event's branch.
 */
@Injectable()
export class WorkflowTriggersService implements OnModuleInit {
  private readonly log = new Logger('workflow-triggers');
  constructor(
    private readonly events: AppEvents,
    private readonly store: WorkflowStore,
    private readonly wf: WorkflowsService,
    private readonly reg: PluginRegistry,
    @Optional() private readonly branches?: BranchRegistries,
  ) {}

  onModuleInit() {
    this.events.on((e) => this.dispatch(e)); // no-bus fallback (unit tests, bus disabled)
    // Step 3: over the bus, this service consumes its own durable address (at-least-once; the run guards absorb a duplicate).
    this.events.consumeOnBus('workflow-triggers', APP_EVENT_KINDS, (e) => this.dispatch(e));
  }

  private async dispatch(e: AppEvent) {
    const registry = workspaceMode() && this.branches ? await this.branches.get(e.branch) : this.reg;
    if (!registry.isActive(e.tenant, 'workflows-iga')) { this.log.log(`${e.type} on ${e.branch}: workflows-iga disabled there, no run started`); return; }
    const defs = (await this.store.listDefinitions(e.tenant, this.store.liveRef)).filter((d) => {
      const t = d.trigger;
      if (!t || t.event !== e.type) return false;
      return Object.entries(t.match ?? {}).every(([k, v]) => e.payload[k] === v);
    });
    for (const d of defs) {
      try {
        const view = await this.wf.start(e.tenant, d.id, `event:${e.type}`, { branch: e.branch, payload: e.payload });
        this.log.log(`${e.type} (${e.payload.subject ?? '-'}) started run ${view.run.id} of "${d.name}"`);
      } catch (err) {
        this.log.warn(`${e.type} could not start "${d.name}": ${(err as Error).message}`);
      }
    }
  }
}
