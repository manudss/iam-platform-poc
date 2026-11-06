import { Injectable, Logger } from '@nestjs/common';

/**
 * In-process application events ("hooks") of the IAM demo: something real happened in the application
 * (a user was created, a department changed, an account was disabled, a sign-up was approved).
 * Emitted AFTER the write that caused them, never before; listeners are asynchronous and their failures
 * are logged, never propagated: an event listener (e.g. a workflow trigger) can never break the action
 * that produced the event.
 *
 * Step 3: when the core bus is up, the plugins-v1 bus host calls attachBus below and the events travel on
 * the bus as notify kinds declared by `api` (durable JetStream deliveries, at-least-once). The listeners
 * (workflow triggers, SSO audit trail) then consume their own durable delivery address via consumeOnBus.
 * Without the bus, the historical in-process fan-out applies, unchanged.
 */
export interface AppEvent {
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
  'user.created', 'user.department-changed', 'user.disabled',
  'signup.requested', 'signup.approved',
  'profile.updated', 'profile.review-resolved',
  'organization.member-added',
  'app.registered', 'app.updated', 'app.removed',
  'sso.login.succeeded', 'sso.login.denied', 'sso.login.failed', 'sso.assertion.issued', 'sso.token.issued',
] as const;

/** Bus shape of an emitted application event (what the core delivers to the consumers). */
export interface AppEventEnvelope { kind: string; tenant?: string; branch?: string; payload: unknown }

/** Rebuilds the AppEvent the emitter sent, from the delivered bus envelope (`at` rides inside the payload). */
export function envelopeToAppEvent(env: AppEventEnvelope): AppEvent {
  const raw = (env.payload ?? {}) as Record<string, unknown>;
  const { at, ...rest } = raw;
  const payload: Record<string, string> = {};
  for (const [k, v] of Object.entries(rest)) payload[k] = String(v);
  return { type: env.kind, tenant: env.tenant ?? '', branch: env.branch ?? 'main', payload, at: typeof at === 'string' ? at : '' };
}

type Listener = (e: AppEvent) => void | Promise<void>;
type BusServe = (address: string, kinds: string[], handler: (env: AppEventEnvelope) => Promise<void>) => void;

@Injectable()
export class AppEvents {
  private readonly log = new Logger('app-events');
  private listeners: Listener[] = [];
  private consumers: { address: string; kinds: string[]; handler: Listener }[] = [];
  private sink?: (e: AppEvent) => void;
  private busServe?: BusServe;

  /** In-process listener: the fallback fan-out, used only while the bus is NOT attached. */
  on(l: Listener) { this.listeners.push(l); }

  /** A service of the API process consumes the events on its own durable bus address. Served immediately when
   * the bus is already attached, otherwise replayed by attachBus. Keep an `on` listener too when a no-bus
   * fallback is wanted: only one of the two paths ever fires for a given event. */
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
    this.busServe!(c.address, c.kinds, async (env) => { await c.handler(envelopeToAppEvent(env)); });
  }

  /** Fire-and-forget by design: the caller's action is already committed; listener and bus errors are only logged. */
  emit(e: AppEvent) {
    if (this.sink) {
      try { this.sink(e); } catch (err) { this.log.warn(`bus emit failed for ${e.type}: ${(err as Error).message}`); }
      return;
    }
    for (const l of this.listeners) Promise.resolve().then(() => l(e)).catch((err) => this.log.warn(`listener failed for ${e.type}: ${(err as Error).message}`));
  }
}
