import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { connect, NatsConnection, JSONCodec, RetentionPolicy } from 'nats';

/**
 * Publishes domain events to NATS JetStream when IAM_NATS_URL is set (stream IAM_EVENTS, subjects iam.>).
 * POC scope: at-most-once from the API's point of view. There is NO transactional outbox: the journal commit and the
 * publish are not atomic, so a crash between them loses the event (the caller learns it through the return value).
 */
@Injectable()
export class NatsService implements OnModuleDestroy {
  private nc?: Promise<NatsConnection>;
  private readonly log = new Logger('nats');

  get enabled() { return !!process.env.IAM_NATS_URL; }

  private conn(): Promise<NatsConnection> {
    this.nc ??= connect({ servers: process.env.IAM_NATS_URL!, timeout: 2000, maxReconnectAttempts: 0 }).then(async (nc) => {
      await nc.jetstreamManager().then((m) => m.streams.add({ name: 'IAM_EVENTS', subjects: ['iam.>'], retention: RetentionPolicy.Limits }).catch(() => undefined));
      return nc;
    });
    return this.nc;
  }

  /** true = acknowledged by JetStream, false = not published (disabled or failure; failure is logged, never thrown). */
  async publish(subject: string, payload: object): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const ack = await (await this.conn()).jetstream().publish(subject, JSONCodec().encode(payload));
      return ack.seq > 0;
    } catch (e) {
      this.nc = undefined;
      this.log.warn(`publish failed: ${(e as Error).message}`);
      return false;
    }
  }

  async onModuleDestroy() { await (await this.nc?.catch(() => undefined))?.close(); }
}
