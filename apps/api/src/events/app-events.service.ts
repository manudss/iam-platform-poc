import { Injectable, Logger } from '@nestjs/common';

/**
 * In-process application events ("hooks") of the IAM demo: something real happened in the application
 * (a user was created, a department changed, an account was disabled, a sign-up was approved).
 * Emitted AFTER the write that caused them, never before; listeners are asynchronous and their failures
 * are logged, never propagated: an event listener (e.g. a workflow trigger) can never break the action
 * that produced the event.
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

type Listener = (e: AppEvent) => void | Promise<void>;

@Injectable()
export class AppEvents {
  private readonly log = new Logger('app-events');
  private listeners: Listener[] = [];
  on(l: Listener) { this.listeners.push(l); }
  /** Fire-and-forget by design: the caller's action is already committed; listener errors are only logged. */
  emit(e: AppEvent) {
    for (const l of this.listeners) Promise.resolve().then(() => l(e)).catch((err) => this.log.warn(`listener failed for ${e.type}: ${(err as Error).message}`));
  }
}
