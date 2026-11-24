import { automationHeld } from '../automation/hold.js';
import { safeReason } from './log-safe.js';
import { dataReady } from '../migrations/readiness.js';
import { WorkflowConnections } from './connections.js';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { branchContext, workspaceMode } from '../workspace/context.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { externalEvent } from './model.js';
import { WorkflowStore } from './store.js';
import { WorkflowsService } from './workflows.service.js';

/**
 * The Jira done watcher (trigger jira.issue-done, contributed by the workflow-connectors plugin): every minute,
 * every LIVE (main) definition watching Jira is checked through the plugin's read-only poll function with a
 * managed Jira connection. Each ticket in the done status starts at most one run: the event id is the ticket
 * key, never its title, so a restart or a later poll returns the same run instead of a second one.
 * Same POC limits as the sheet watcher: main only, fixed 60 s cadence, at most 25 tickets per search (an already started ticket returns its existing run).
 */
@Injectable()
export class WorkflowJiraDonePollerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('jira-done-watcher');
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private busy = false;
  constructor(private readonly store: WorkflowStore, private readonly wf: WorkflowsService, private readonly reg: PluginRegistry, @Optional() private readonly branches?: BranchRegistries, @Optional() private readonly connections?: WorkflowConnections) {}

  onModuleInit() {
    if (automationHeld) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref?.();
    this.first = setTimeout(() => void this.tick(), 12_000);
    this.first.unref?.();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }

  async tick() {
    if (automationHeld || !dataReady()) return;
    if (this.busy) return;
    this.busy = true;
    try { await branchContext.run({ branch: this.store.liveRef }, () => this.scan()); }
    catch (e) { this.log.warn(`watch tick failed: ${safeReason(e)}`); }
    finally { this.busy = false; }
  }

  private async scan() {
    const desc = externalEvent('jira.issue-done');
    if (!desc?.poll) return;
    let defs;
    try { defs = await this.store.listAllDefinitions(this.store.liveRef); } catch (e) { this.log.warn(`watch scan failed: ${safeReason(e)}`); return; }
    const registry = workspaceMode() && this.branches ? await this.branches.get(this.store.liveRef) : this.reg;
    for (const d of defs.filter((x) => x.trigger?.event === 'jira.issue-done' && x.active !== false)) {
      if (!registry.isActive(d.tenant, 'workflows-iga') || !registry.isActive(d.tenant, 'workflow-connectors')) continue;
      let tickets;
      try {
        if (!this.connections || !d.trigger?.config?.connectionId) { this.log.warn(`${d.id}: managed Jira connection required; watcher idle`); continue; }
        const settings = (await this.connections.resolve(d.tenant, this.store.liveRef, String(d.trigger.config.connectionId), 'jira')).settings;
        tickets = await desc.poll(d.trigger.config ?? {}, { settings, log: (m: string) => this.log.log(`${d.id}: ${m}`) });
      } catch { this.log.warn(`${d.id}: read-only Jira poll failed; check the managed connection`); continue; }
      for (const t of tickets as unknown as Array<{ key: string; values: Record<string, string> }>) {
        const payload: Record<string, string> = {};
        for (const [k, v] of Object.entries(t.values)) if (/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(k)) payload[k.toLowerCase()] = String(v ?? '').slice(0, 500);
        const eventId = createHash('sha256').update(JSON.stringify(['jira-done', d.tenant, d.id, t.key])).digest('hex').slice(0, 32);
        try {
          const view = await this.wf.start(d.tenant, d.id, 'jira-done-watcher', { branch: this.store.liveRef, payload, eventId });
          this.log.log(`${d.id}: ticket ${t.key} -> run ${view.run.id} (${view.run.status})`);
        } catch (e) { this.log.warn(`${d.id}: ticket ${t.key} could not start: ${safeReason(e)}`); }
      }
    }
  }
}
