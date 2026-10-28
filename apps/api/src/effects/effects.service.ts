import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PluginRegistry } from '../plugins/v1/registry.js';
import pg from 'pg';
import { DoltService } from '../dolt/dolt.service.js';
import { ActivationConsumer } from '../integrations/activation-consumer.js';
import { ActivationEffects } from './activation-effects.js';
import { EffectStore } from './effect-store.js';

/**
 * Opt-in runtime for the local demo effects: set IAM_EFFECTS=1 together with IAM_PG_URL and IAM_NATS_URL, plus
 * IAM_NOTIFY_SINK_URL and/or IAM_PROVISION_TARGET_URL (loopback http URLs only). Consumes iam.activation.* from NATS (durable,
 * idempotent per tenant+seq) and runs the effects. Single instance only.
 */
@Injectable()
export class EffectsService implements OnModuleInit, OnModuleDestroy {
  private pool?: pg.Pool;
  private consumer?: ActivationConsumer;
  constructor(private readonly dolt: DoltService, @Optional() private readonly plugins?: PluginRegistry) {}

  async onModuleInit() {
    const { IAM_EFFECTS, IAM_PG_URL, IAM_NATS_URL, IAM_NOTIFY_SINK_URL, IAM_PROVISION_TARGET_URL } = process.env;
    if (IAM_EFFECTS !== '1' || !IAM_PG_URL || !IAM_NATS_URL) return;
    this.pool = new pg.Pool({ connectionString: IAM_PG_URL, max: 3 });
    const fx = new ActivationEffects({
      store: new EffectStore(this.pool), snapshotAt: (c) => this.dolt.snapshotAt(c),
      previousCommit: async (tenant, seq) => (await this.pool!.query("SELECT commit_hash FROM activations WHERE tenant=$1 AND seq<$2 AND state='applied' ORDER BY seq DESC LIMIT 1", [tenant, seq])).rows[0]?.commit_hash,
      pluginNotify: this.plugins ? async (t, p) => { await this.plugins!.emit(t, 'notify.send', p); } : undefined,
      notifySinkUrl: IAM_NOTIFY_SINK_URL, provisionTargetUrl: IAM_PROVISION_TARGET_URL,
    });
    this.consumer = new ActivationConsumer(this.pool, async (e) => { await fx.handle(e); });
    await this.consumer.start(IAM_NATS_URL, 'iam-effects');
  }
  async onModuleDestroy() { await this.consumer?.stop(); await this.pool?.end().catch(() => undefined); }
}
