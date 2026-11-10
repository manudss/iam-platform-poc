import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { nextCronFire } from './model.js';
import { WorkflowStore } from './store.js';
import { WorkflowsService } from './workflows.service.js';

/**
 * Cron scheduler (phase 3): every tick, every ACTIVE definition whose trigger is a cron schedule and whose
 * Europe/Paris minute matches fires one run. The last fired minute is recorded per definition in the meta
 * store, and the run id is derived from (tenant, definition, minute): a restart inside the same minute never
 * double-fires. There is no catch-up: minutes missed while the server was down are simply skipped.
 * A paused definition never fires (the list card's switch), exactly like event triggers.
 */
@Injectable()
export class WorkflowCronService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('workflow-cron');
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  constructor(private readonly store: WorkflowStore, private readonly wf: WorkflowsService, private readonly reg: PluginRegistry) {}

  onModuleInit() {
    const tickMs = Number(process.env.WF_CRON_TICK_MS ?? 20000);
    this.timer = setInterval(() => void this.tick(), tickMs);
    this.timer.unref?.();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  /** The Paris wall-clock minute key of a timestamp: what the dedup marker and the stable run id use. */
  static minuteKey(ms: number): string {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
    return p; // e.g. "10/11/2026, 23:55"
  }

  async tick(): Promise<void> {
    if (this.ticking) return; // a slow tick (cold Dolt) never overlaps the next one
    this.ticking = true;
    try {
      const now = Date.now();
      const minute = WorkflowCronService.minuteKey(now);
      for (const d of await this.store.listAllDefinitions(this.store.liveRef)) {
        const cron = d.trigger?.cron;
        if (!cron || d.active === false) continue;
        if (!this.reg.isActive(d.tenant, 'workflows-iga')) continue;
        try {
          // Does the current Paris minute match? Ask for the next fire after the PREVIOUS minute.
          const next = nextCronFire(cron, now - 60000);
          if (next > now) continue; // next match is in the future: this minute does not match
          const marker = `cron-fired:${d.tenant}:${d.id}`;
          if ((await this.store.getMeta(marker)) === minute) continue; // already fired this minute
          await this.store.setMeta(marker, minute);
          const view = await this.wf.start(d.tenant, d.id, 'cron', { branch: this.store.liveRef, payload: {}, eventId: `cron:${minute}` });
          this.log.log(`cron "${cron}" started run ${view.run.id} of "${d.name}" (${minute})`);
        } catch (e) {
          this.log.warn(`cron of "${d.name}": ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.log.warn(`tick failed: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
