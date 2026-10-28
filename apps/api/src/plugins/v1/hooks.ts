import type { HookMode } from './manifest.js';

/**
 * Hook catalogue. Each hook has a fixed name, the modes it allows, and a payload/result shape.
 * `blocking` hooks sit on a request path: they have a deadline and fail closed (or to the base plugin).
 * `async` hooks react to events after the fact: they are idempotent and retried.
 */
export const HOOKS = new Map<string, HookMode[]>([
  ['auth.authenticate', ['blocking']], // verify a credential -> allow / deny / challenge
  ['auth.challenge', ['blocking']], // second factor or step-up prompt
  ['profile.enrich', ['blocking', 'async']], // add attributes or claims
  ['identity.changed', ['async']], // joiner / mover / leaver, role change
  ['access.decide', ['blocking']], // extra policy input, runs in the core (WASM)
  ['notify.send', ['async']], // deliver a message
  ['workflow.step', ['async']], // run one step of an approval or certification flow
  ['connector.provision', ['async']], // create / update / delete in a target
  ['connector.import', ['async']], // pull identities from a source
  ['audit.event', ['async']], // forward an audit event
  ['risk.score', ['blocking']], // return a 0..100 score for a sign-in or access request
  ['ui.screens', ['blocking']], // declare screens (static, answered from the manifest)
]);

export interface AuthenticatePayload { tenant: string; subject: string; credential: Record<string, unknown>; }
export type AuthenticateResult =
  | { outcome: 'allow'; subject: string; methods: string[] }
  | { outcome: 'deny'; reason: string }
  | { outcome: 'challenge'; challenge: string };

export interface EnrichPayload { tenant: string; subject: string; profile: Record<string, unknown>; }
export interface NotifyPayload { tenant: string; to: string; template: string; data: Record<string, unknown>; effectKey: string; }
export interface IdentityChangedPayload { tenant: string; subject: string; change: 'joiner' | 'mover' | 'leaver' | 'role.changed'; newRole?: string; effectKey: string; }
export interface RiskPayload { tenant: string; subject: string; context: Record<string, unknown>; }

export type HookHandler = (payload: any, ctx: PluginContext) => Promise<any> | any;
export interface PluginContext {
  tenant: string;
  /** The plugin's validated settings, with secrets resolved by reference. */
  settings: Record<string, unknown>;
}
