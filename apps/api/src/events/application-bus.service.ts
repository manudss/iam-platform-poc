import { Injectable, Logger } from '@nestjs/common';

/** Bus-only facade for application events. Writes emit after commit; each service consumes a durable address.
 * No local fan-out, feature flag or no-bus fallback exists. NATS and the core are required at API startup. */
export interface AppEvent {
  id?: string;
  /** Event type, see WF_EVENTS in the workflows model (e.g. 'user.created'). */
  type: string;
  tenant: string;
  /** Dolt branch the producing write happened on (a triggered run branches from it and is reviewed back into it). */
  branch: string;
  /** Small string payload (subject, from/to, email...). Placeholders {{event.<key>}} in workflow steps resolve from it. */
  payload: Record<string, string>;
  at: string;
}

/** Every application event kind of the platform: the canonical list mirrors WF_EVENTS (workflows/model.ts). */
export const APP_EVENT_KINDS = [
  'policy.changed',
  'user.created', 'user.department-changed', 'user.disabled',
  'signup.requested', 'signup.approved',
  'profile.updated', 'profile.review-resolved',
  'organization.member-added',
  'app.registered', 'app.updated', 'app.removed',
  'sso.login.succeeded', 'sso.login.denied', 'sso.login.failed', 'sso.assertion.issued', 'sso.token.issued',
] as const;

/** Bus shape of an emitted application event (what the core delivers to the consumers). */
export interface AppEventEnvelope { id?: string; kind: string; tenant?: string; branch?: string; payload: unknown }

/** Rebuilds the AppEvent the emitter sent, from the delivered bus envelope (`at` rides inside the payload). */
export function envelopeToAppEvent(env: AppEventEnvelope): AppEvent {
  const raw = (env.payload ?? {}) as Record<string, unknown>;
  const { at, ...rest } = raw;
  const payload: Record<string, string> = {};
  for (const [k, v] of Object.entries(rest)) payload[k] = String(v);
  return { id: env.id, type: env.kind, tenant: env.tenant ?? '', branch: env.branch ?? 'main', payload, at: typeof at === 'string' ? at : '' };
}

type Listener = (e: AppEvent) => void | Promise<void>;
type BusServe = (address: string, kinds: string[], handler: (env: AppEventEnvelope) => Promise<void>) => void | Promise<void>;

@Injectable()
export class ApplicationBus {
  private readonly log = new Logger('app-events');
  private consumers: { address: string; kinds: string[]; handler: Listener }[] = [];
  private sink?: (e: AppEvent) => void;
  private busServe?: BusServe;
  private registrations: Promise<void>[] = [];
  async ready() { await Promise.all(this.registrations); }

  /** A service of the API process consumes the events on its own durable bus address. Served immediately when
   * the bus is already attached, otherwise registered by attachBus. */
  consumeOnBus(address: string, kinds: readonly string[], handler: Listener) {
    const c = { address, kinds: [...kinds], handler };
    this.consumers.push(c);
    if (this.busServe) this.serveConsumer(c);
  }

  /** Called once by the plugins-v1 bus host when it connects: emissions go through the bus from now on and
   * every registered consumer gets its durable delivery address. */
  attachBus(sink: (e: AppEvent) => void, serve: BusServe) {
    this.sink = sink;
    this.busServe = serve;
    for (const c of this.consumers) this.serveConsumer(c);
  }

  get routedToBus() { return !!this.sink; }

  private serveConsumer(c: { address: string; kinds: string[]; handler: Listener }) {
    this.registrations.push(Promise.resolve(this.busServe!(c.address, c.kinds, async (env) => { await c.handler(envelopeToAppEvent(env)); })));
  }

  /** Fire-and-forget by design: the caller's action is already committed; listener and bus errors are only logged. */
  emit(e: AppEvent) {
    if (this.sink) {
      try { this.sink(e); } catch (err) { this.log.warn(`bus emit failed for ${e.type}: ${(err as Error).message}`); }
      return;
    }
    throw new Error('event bus required: no emission sink attached');
  }
}
