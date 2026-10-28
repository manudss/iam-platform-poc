import { connect, JSONCodec, AckPolicy, NatsConnection } from 'nats';
import pg from 'pg';

export interface ActivationEvent { tenant: string; seq: number; commit: string; state: string }
/** Effect handler. It receives an idempotency key (tenant:seq) that any EXTERNAL system it calls must also honour. */
export type Handler = (e: ActivationEvent, idempotencyKey: string) => Promise<void>;

/**
 * Idempotent consumer of iam.activation.<tenant> events. The relay is at-least-once, so duplicates are expected.
 * Dedupe key = (tenant, seq), stored in PostgreSQL table processed_events in the same transaction as the handler call:
 * if the handler throws, nothing is recorded and a redelivery retries it. Limit: if the process dies AFTER an external effect
 * but BEFORE the commit, the handler runs again with the same key, so external systems must dedupe on that key.
 */
export class ActivationConsumer {
  private nc?: NatsConnection;
  private stopped = false;
  private running?: Promise<void>;
  private messages?: { close(): Promise<void | Error> };
  constructor(private readonly pool: pg.Pool, private readonly handler: Handler) {}

  async handle(e: ActivationEvent): Promise<'processed' | 'duplicate'> {
    const c = await this.pool.connect();
    try {
      await c.query('CREATE TABLE IF NOT EXISTS processed_events (tenant text NOT NULL, seq integer NOT NULL, processed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant, seq))');
      await c.query('BEGIN');
      const r = await c.query('INSERT INTO processed_events (tenant, seq) VALUES ($1,$2) ON CONFLICT DO NOTHING', [e.tenant, e.seq]);
      if (r.rowCount === 0) { await c.query('COMMIT'); return 'duplicate'; }
      await this.handler(e, `${e.tenant}:${e.seq}`);
      await c.query('COMMIT');
      return 'processed';
    } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
  }

  /** Durable JetStream pull consumer: ack after handle(), nak on failure (redelivered). */
  async start(natsUrl: string, durable = 'activation-consumer') {
    this.nc = await connect({ servers: natsUrl, maxReconnectAttempts: 0 });
    const jsm = await this.nc.jetstreamManager();
    await jsm.streams.add({ name: 'IAM_EVENTS', subjects: ['iam.>'] }).catch(() => undefined); // same stream as the publisher; no-op if it exists
    await jsm.consumers.add('IAM_EVENTS', { durable_name: durable, ack_policy: AckPolicy.Explicit, filter_subject: 'iam.activation.>' }).catch(() => undefined);
    const cons = await this.nc.jetstream().consumers.get('IAM_EVENTS', durable);
    const messages = await cons.consume();
    this.messages = messages;
    this.running = (async () => {
      for await (const m of messages) {
        if (this.stopped) break;
        try { await this.handle(JSONCodec<ActivationEvent>().decode(m.data)); m.ack(); } catch { m.nak(); }
      }
    })();
  }

  async stop() { this.stopped = true; await this.messages?.close().catch(() => undefined); await this.nc?.close(); await this.running?.catch(() => undefined); }
}
