import type { HookMode } from './manifest.js';

/**
 * Hook catalogue. Each hook has a fixed name, the modes it allows, and a payload/result shape.
 * `blocking` hooks sit on a request path: they have a deadline and fail closed (or to the base plugin).
 * `async` hooks react to events after the fact: they are idempotent and retried.
 */
export const HOOKS = new Map<string, HookMode[]>([
  ['auth.authenticate', ['blocking']], // verify a credential -> allow / deny / challenge
  ['auth.challenge', ['blocking']], // second factor or step-up prompt
  ['auth.prepare', ['blocking']], // build the first prompt and the private state of a sign-in step
  ['auth.verify', ['blocking']], // check the answers of a sign-in step
  ['auth.interact', ['blocking']], // interactive step (keypad): one call per button press
  ['auth.verification', ['blocking']], // what the method instance proves: { real, note }
  ['auth.enroll', ['blocking']], // self-service enrollment ceremony of a method (passkey creation options + attestation check), orchestrated by the self-service controller
  ['profile.enrich', ['blocking', 'async']], // add attributes or claims; the blocking mode is a merged bus query (step 3)
  ['identity.changed', ['async']], // joiner / mover / leaver, role change
  ['access.decide', ['blocking']], // extra policy input, runs in the core (WASM) - documented bus exception (decision 8)
  ['notify.send', ['async']], // deliver a message
  ['notify.capability', ['blocking']], // the notifier chosen on the slot declares its real delivery capability (P1-E)
  ['notify.render', ['blocking']], // render a mail template (catalogue decl + branch customization + layout) into subject/text/html before delivery
  ['workflow.step', ['async']], // run one step of an approval or certification flow
  ['connector.provision', ['async']], // create / update / delete in a target
  ['connector.import', ['async']], // pull identities from a source
  ['audit.event', ['async']], // forward an audit event
  ['risk.score', ['blocking']], // return a 0..100 score for a sign-in or access request; mandatory bus control (step 3)
  ['ui.screens', ['blocking']], // declare screens (static, answered from the manifest) - documented bus exception (decision 8)
  // Directory management rules (slot directory.default, phase 2 step 1): the base directory plugin owns the PURE
  // decisions; identity storage and data plumbing stay in the core adapters. A replacement extends directory and
  // must handle all of them (extension contract); disabling returns every rule to the base, data untouched.
  ['directory.user.validate', ['blocking']], // check a user payload before write -> { valid, errors? }
  ['directory.fields.validateDecls', ['blocking']], // one plugin's field declarations at manifest time -> { errors }
  ['directory.fields.catalogue', ['blocking']], // declarations -> catalogue entries -> { catalogue }
  ['directory.fields.parseConfig', ['blocking']], // stored profile configuration -> normalized config -> { config }
  ['directory.fields.validateConfig', ['blocking']], // admin configuration input against the catalogue -> { valid, config?, errors? }
  ['directory.fields.effectiveSchema', ['blocking']], // effective field list for a context (signup/self/admin) -> { fields }
  ['directory.fields.checkValue', ['blocking']], // one entered value against its field rule -> { value }
  ['directory.effects.compute', ['blocking']], // role assignment diff between two versions -> { changes }
]);

export interface AuthenticatePayload { tenant: string; subject: string; credential: Record<string, unknown>; }
export type AuthenticateResult =
  | { outcome: 'allow'; subject: string; methods: string[] }
  | { outcome: 'deny'; reason: string }
  | { outcome: 'challenge'; challenge: string };

export interface EnrichPayload { tenant: string; subject: string; profile: Record<string, unknown>; }
export interface NotifyPayload { tenant: string; to: string; template: string; data: Record<string, unknown>; effectKey: string;
  /** Rendered content, attached by the core after a notify.render call on the notify.templates slot (mail-templates).
   * Absent on the legacy path (a renderer failure degrades to the raw template dump, explicitly logged). */
  subject?: string; text?: string; html?: string; }
/** notify.render payload: the template declaration comes from the owning plugin's manifest (mailTemplates),
 * the customization (override) and the layout are read core-side on the relevant Dolt branch and travel IN THE
 * PAYLOAD (bus-safe contract, same rule as the auth methods): the handler is pure interpolation. */
export interface NotifyRenderPayload {
  tenant: string; key: string; lang: string; data: Record<string, unknown>;
  decl?: { subject: string; text: string; html?: string } | null;
  override?: { subject: string; text: string; html?: string } | null;
  layout?: { subject?: string; text?: string; html?: string; vars?: Record<string, string> } | null;
  layoutOverride?: { html?: string; vars?: Record<string, string> } | null;
}
export interface NotifyRenderResult { subject: string; text: string; html?: string }
export interface IdentityChangedPayload { tenant: string; subject: string; change: 'joiner' | 'mover' | 'leaver' | 'role.changed'; newRole?: string; effectKey: string; }
export interface RiskPayload { tenant: string; subject: string; context: Record<string, unknown>; }

export type HookHandler = (payload: any, ctx: PluginContext) => Promise<any> | any;
export interface PluginContext {
  tenant: string;
  /** The plugin's validated settings, with secrets resolved by reference. */
  settings: Record<string, unknown>;
  /** For a replacement (manifest `extends`): the base plugin's handlers, so it can reuse the base behaviour
   * (for example the lockout replacement asking the base password check). Set by the loader/registry, never by the plugin. */
  base?: Record<string, HookHandler>;
}
