import type { SettingField } from '../plugins/v1/manifest.js';
import { pluginCatalogue } from '../plugins/v1/loader.js';
import type { HookHandler } from '../plugins/v1/hooks.js';

export type Factor = 'knowledge' | 'possession' | 'inherence';
export interface KeypadKey { id: string; digit: string; letters: string }
export interface PromptField { name: string; label: string; type: 'password' | 'text' | 'digits' | 'keypad' | 'webauthn'; maxLength?: number; hint?: string;
  /** keypad only: buttons in display order (opaque ids, valid for this page only), digits entered so far, digits needed. */
  keys?: KeypadKey[]; entered?: number; length?: number;
  /** webauthn only: the PublicKeyCredentialRequestOptionsJSON the core-rendered ceremony feeds to the browser. */
  options?: Record<string, unknown> }
export interface Prompt { title: string; message?: string; fields: PromptField[] }

/** One-time-code messages. The POC ships only the demo outbox: nothing leaves the process that way.
 * Real delivery goes through the notify.default slot (P1-E): the plugin chosen on the slot decides the path. */
export interface MailAdapter { id: string; real: boolean; send(m: { tenant: string; to: string; subject: string; text: string; subjectUser: string }): Promise<void> }
/** What the notifier chosen on notify.default declares (P1-E): real delivery or explicit simulation. */
export interface NotifyCapability { real: boolean; note?: string }
export interface OutboxMessage { at: string; tenant: string; to: string; subject: string; text: string; user: string }
export class DemoOutbox implements MailAdapter {
  id = 'demo-outbox'; real = false;
  private msgs: OutboxMessage[] = [];
  async send(m: { tenant: string; to: string; subject: string; text: string; subjectUser: string }) {
    this.msgs.unshift({ at: new Date().toISOString(), tenant: m.tenant, to: m.to, subject: m.subject, text: m.text, user: m.subjectUser });
    this.msgs.length = Math.min(this.msgs.length, 50);
  }
  list(tenant: string) { return this.msgs.filter((x) => x.tenant === tenant); }
  clear(tenant: string) { this.msgs = this.msgs.filter((x) => x.tenant !== tenant); }
}

/** Bus contract of a sign-in method (step 2, review n:2): every method call goes through the registry (callSlot on
 * the auth.<type> slot - grants, deadlines, faults, audit). The handler is PURE: everything it needs travels in the
 * JSON payload, every effect it asks for comes back in the result for the core to apply.
 * Payload: { tenant, subject, known, instanceId, config, state, answers, now, origin?,
 *            enrollment?: { totp?: {secret,lastStep}, pin?: {length,salt,hash}, email?: string, webauthn?: {credentials: [{id,publicKey,counter,transports?}]} },
 *            profileEmail?: string, notifyCapability?: {real, note?}, passwordOutcome?: 'allow'|'deny' }.
 * Results: auth.prepare  -> { prompt, state, notify?, mail? }  (the core sends via the notify.default slot / the outbox);
 *          auth.verify   -> { ok, consumeStep?, credentialCounter?: {id, counter}, state? }
 *                           (the core applies the anti-replay consume / counter advance / state patch atomically);
 *          auth.interact -> { done:false, prompt, state } | { done:true, ok };
 *          auth.enroll   -> options/attestation check of a self-service enrollment (passkeys), orchestrated by the API.
 * Business failures are DATA ({ok:false} / {done:true, ok:false}), never a thrown error: a throw is a plugin FAULT
 * (persisted, audited, fail closed - the slot's replacement refuses every later call until an admin acts). */
export interface AuthMethodType {
  id: string; name: string; description: string;
  /** Category of factor the method DECLARES. It is a classification, not a measurement of strength or independence. */
  factor: Factor; amr: string;
  maturity: 'implemented' | 'catalogue';
  suggestedLevel: number;
  settings: SettingField[];
  provisioning: 'directory' | 'admin-demo' | 'none';
  /** `single`: one instance at most per configuration. `multiple` (default): several, each with its own settings. */
  instances: 'single' | 'multiple';
  inlineWithUsername(config: Record<string, any>): boolean;
  /** `real` = the check proves what the factor category says. A demo delivery channel proves nothing, so it is not real.
   * DESCRIPTIVE metadata for the catalogue and the chain analysis (config-only, never touches tenant state). Sign-in
   * NEVER uses this in-process call: at sign-in the same question goes through the registry (callSlot
   * auth.verification) so a disabled or faulted plugin cannot answer. */
  verification(config: Record<string, any>): { real: boolean; note: string };
}

/** Ideas shown in the catalogue so the list reads as a roadmap. They cannot be created: nothing is implemented for them. */
const planned = (id: string, name: string, description: string, factor: Factor, level: number, amr: string): AuthMethodType => ({
  id, name, description, factor, amr, maturity: 'catalogue', suggestedLevel: level, settings: [], provisioning: 'none', instances: 'single',
  inlineWithUsername: () => false, verification: () => ({ real: false, note: 'Not implemented.' }),
});
const PLANNED: AuthMethodType[] = [
  planned('recovery-code', 'Recovery codes', 'One-time printed codes for account recovery. Not built.', 'knowledge', 5, 'otp'),
  planned('federation', 'External identity provider (OIDC/SAML)', 'Delegate sign-in to another IdP and map its claims. Not built.', 'other' as Factor, 6, 'fed'),
];

/**
 * The method type catalogue, sourced from the folder plugins (step 4b): every plugin whose manifest declares
 * `authMethod` is a type. DESCRIPTIVE metadata only (name, factor, settings, the config-only verification note):
 * the sign-in behaviour lives behind the registry (auth.prepare/verify/interact via callSlot, step 2).
 */
function fromPlugin(impl: { manifest: import('../plugins/v1/manifest.js').PluginManifest; handlers: Record<string, HookHandler> }): AuthMethodType {
  const a = impl.manifest.authMethod!;
  const id = (impl.manifest.provides ?? []).find((s) => s.startsWith('auth.'))!.slice('auth.'.length);
  return {
    id, name: a.name, description: a.description, factor: a.factor as Factor, amr: a.amr, maturity: a.maturity,
    suggestedLevel: a.suggestedLevel, settings: impl.manifest.settings, provisioning: a.provisioning, instances: a.instances ?? 'multiple',
    inlineWithUsername: () => !!a.inlineWithUsername,
    verification: (config) => (impl.handlers['auth.verification']?.({ config }, { tenant: '', settings: {} }) ?? { real: false, note: 'no verification handler' }) as { real: boolean; note: string },
  };
}

// The shared verified catalogue does the folder scan + signature verification once per process (P1); the
// PLANNED merge here is cheap, so recomputing per call picks up a catalogue refresh without a restart.
export function methodTypes(): AuthMethodType[] {
  return [...pluginCatalogue().impls().filter((i) => i.manifest.authMethod).map(fromPlugin), ...PLANNED];
}
/** No frozen catalogue (review n:3): the lookup runs at EVERY call, so a plugin imported at runtime appears
 * without a restart and a removed one disappears. */
export const methodType = (id: string) => methodTypes().find((m) => m.id === id);

/** The folder plugin that serves a method type (its `provides` slot), undefined for base/planned types. */
export function methodPluginId(typeId: string): string | undefined {
  return pluginCatalogue().impls().find((i) => i.manifest.authMethod && (i.manifest.provides ?? []).includes('auth.' + typeId))?.manifest.id;
}
/** The profile component through which a method type is managed, when the serving plugin declares one. */
export function methodComponent(typeId: string): { plugin: string; id: string } | undefined {
  const impl = pluginCatalogue().impls().find((i) => i.manifest.authMethod && (i.manifest.provides ?? []).includes('auth.' + typeId));
  const c = impl?.manifest.profileComponents?.[0];
  return impl && c ? { plugin: impl.manifest.id, id: c.id } : undefined;
}
