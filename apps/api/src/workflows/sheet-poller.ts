import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { branchContext, workspaceMode } from '../workspace/context.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { validateSettings } from '../plugins/v1/settings.js';
import { externalEvent } from './model.js';
import { WorkflowStore } from './store.js';
import { WorkflowsService } from './workflows.service.js';

/**
 * The sheet row watcher (trigger google-sheets.row-ready, contributed by the workflow-connectors plugin):
 * every minute, every LIVE (main) definition watching a sheet is checked through the provider's poll
 * function. Each ready row starts one run, deduplicated by a stable event id (same row + same values =
 * same run, returned instead of duplicated). At most 3 rows per definition per tick.
 *
 * POC scope: the watcher reads definitions and plugin settings on MAIN only (a row watcher authored on an
 * unmerged working branch does not poll yet), and the poll cadence is fixed at 60s. The demo source is the
 * plugin's simulated sheet; with a service account typed in the console it polls the real Google Sheets API.
 */
@Injectable()
export class WorkflowSheetPollerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('sheet-watcher');
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private busy = false;
  constructor(private readonly store: WorkflowStore, private readonly wf: WorkflowsService, private readonly reg: PluginRegistry, @Optional() private readonly branches?: BranchRegistries) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref?.();
    this.first = setTimeout(() => void this.tick(), 12_000);
    this.first.unref?.();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try { await branchContext.run({ branch: this.store.liveRef }, () => this.scan()); }
    catch (e) { this.log.warn(`watch tick failed: ${(e as Error).message}`); }
    finally { this.busy = false; }
  }

  private async scan() {
    const desc = externalEvent('google-sheets.row-ready');
    if (!desc?.poll) return;
    let defs;
    try { defs = await this.store.listAllDefinitions(this.store.liveRef); } catch (e) { this.log.warn(`watch scan failed: ${(e as Error).message}`); return; }
    const registry = workspaceMode() && this.branches ? await this.branches.get(this.store.liveRef) : this.reg;
    for (const d of defs.filter((x) => x.trigger?.event === 'google-sheets.row-ready' && x.active !== false)) {
      if (!registry.isActive(d.tenant, 'workflows-iga') || !registry.isActive(d.tenant, 'workflow-connectors')) continue;
      const impl = registry.impl('workflow-connectors');
      if (!impl) continue;
      const settings = validateSettings(impl.manifest.settings, (await registry.settingsFor(d.tenant, 'workflow-connectors')) ?? {}).values;
      let rows;
      try {
        rows = await desc.poll(d.trigger?.config ?? {}, { settings, log: (m) => this.log.log(`${d.id}: ${m}`) });
      } catch (e) { this.log.warn(`${d.id}: poll failed: ${(e as Error).message}`); continue; }
      for (const row of rows.slice(0, 3)) {
        const payload: Record<string, string> = { rownumber: String(row.rowNumber) };
        for (const [k, v] of Object.entries(row.values)) if (/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(k)) payload[k.toLowerCase()] = String(v ?? '').slice(0, 500);
        const eventId = createHash('sha256').update(JSON.stringify(['sheet-row', d.tenant, d.id, row.rowNumber, JSON.stringify(row.values)])).digest('hex').slice(0, 32);
        try {
          const view = await this.wf.start(d.tenant, d.id, 'sheet-watcher', { branch: this.store.liveRef, payload, eventId });
          this.log.log(`${d.id}: row ${row.rowNumber} -> run ${view.run.id} (${view.run.status})`);
        } catch (e) { this.log.warn(`${d.id}: row ${row.rowNumber} could not start: ${(e as Error).message}`); }
      }
    }
  }
}
