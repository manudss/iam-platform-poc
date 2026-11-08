import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { BusHostRef } from '../plugins/v1/bus-host.js';
import pg from 'pg';
import { DoltService } from '../dolt/dolt.service.js';
import { ActivationEffects } from './activation-effects.js';
import { EffectStore } from './effect-store.js';
import { renderMailOrLegacy } from '../plugins/v1/mail-catalogue.js';

/**
 * Opt-in runtime for the local demo effects: set IAM_EFFECTS=1 together with IAM_PG_URL and the core bus, plus
 * IAM_NOTIFY_SINK_URL and/or IAM_PROVISION_TARGET_URL (loopback http URLs only). Consumes the durable bus event
 * activation.applied on its own delivery address 'activation-effects' (at-least-once: a handler failure is nakked
 * and redelivered) and runs the effects, idempotent per effect key in PostgreSQL. Single instance only.
 */
@Injectable()
export class EffectsService implements OnModuleInit, OnModuleDestroy {
  private pool?: pg.Pool;
  constructor(private readonly dolt: DoltService, @Optional() private readonly plugins?: PluginRegistry, @Optional() private readonly busRef?: BusHostRef) {}

  async onModuleInit() {
    const { IAM_EFFECTS, IAM_PG_URL, IAM_NOTIFY_SINK_URL, IAM_PROVISION_TARGET_URL } = process.env;
    if (IAM_EFFECTS !== '1' || !IAM_PG_URL) return;
    const host = this.busRef?.host;
    if (!host) { console.warn('[effects] IAM_EFFECTS=1 but the core bus is not connected: no activation effects'); return; }
    this.pool = new pg.Pool({ connectionString: IAM_PG_URL, max: 3 });
    const fx = new ActivationEffects({
      store: new EffectStore(this.pool), snapshotAt: (c) => this.dolt.snapshotAt(c),
      previousCommit: async (tenant, seq) => (await this.pool!.query("SELECT commit_hash FROM activations WHERE tenant=$1 AND seq<$2 AND state='applied' ORDER BY seq DESC LIMIT 1", [tenant, seq])).rows[0]?.commit_hash,
      pluginNotify: this.plugins ? async (t, p) => {
        // Render through the notify.templates slot first (docs/mail-templates.md); a renderer problem degrades
        // to the legacy raw payload, explicitly logged, and never fails the role effects.
        const rendered = await renderMailOrLegacy(this.plugins!, t, p.template, p.data);
        await this.plugins!.emit(t, 'notify.send', { ...p, ...(rendered ? { subject: rendered.subject, text: rendered.text, ...(rendered.html ? { html: rendered.html } : {}) } : {}) });
      } : undefined,
      notifySinkUrl: IAM_NOTIFY_SINK_URL, provisionTargetUrl: IAM_PROVISION_TARGET_URL,
    });
    await host.serveService('activation-effects', ['activation.applied'], async (env) => {
      const p = env.payload as { tenant: string; seq: number; commit: string };
      await fx.handle({ tenant: p.tenant, seq: p.seq, commit: p.commit }); // throws -> nak -> redelivery (at-least-once)
    });
    // Catch-up: the bus keeps no copy for an address nobody registered, so activations applied while this
    // service was down (or before the bus existed) are replayed from the journal; per-effect idempotency keys
    // make already-done effects no-ops.
    // ActivationService owns the activations schema and creates it lazily: a fresh PG may not have it yet (42P01).
    const rows = (await this.pool.query("SELECT tenant, seq, commit_hash FROM activations WHERE state='applied' ORDER BY tenant, seq")
      .catch((e: { code?: string }) => ((e?.code === '42P01') ? { rows: [] as Record<string, unknown>[] } : Promise.reject(e)))).rows;
    for (const r of rows) await fx.handle({ tenant: r.tenant as string, seq: r.seq as number, commit: r.commit_hash as string })
      .catch((e) => console.warn(`[effects] catch-up failed for ${r.tenant}:${r.seq}: ${(e as Error).message}`));
  }
  async onModuleDestroy() { await this.pool?.end().catch(() => undefined); }
}
