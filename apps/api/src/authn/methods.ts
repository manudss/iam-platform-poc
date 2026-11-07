import type { SettingField } from '../plugins/v1/manifest.js';
import type { EnrollmentStore } from './enroll-store.js';
import { loadPlugins } from '../plugins/v1/loader.js';
import type { HookHandler } from '../plugins/v1/hooks.js';

export type Factor = 'knowledge' | 'possession' | 'inherence';
export interface KeypadKey { id: string; digit: string; letters: string }
export interface PromptField { name: string; label: string; type: 'password' | 'text' | 'digits' | 'keypad'; maxLength?: number; hint?: string;
  /** keypad only: buttons in display order (opaque ids, valid for this page only), digits entered so far, digits needed. */
  keys?: KeypadKey[]; entered?: number; length?: number }
export interface Prompt { title: string; message?: string; fields: PromptField[] }

/** Delivery channel of one-time codes. The POC ships only the demo outbox: nothing leaves the process. */
export interface MailAdapter { id: string; real: boolean; send(m: { tenant: string; to: string; subject: string; text: string; subjectUser: string }): Promise<void> }
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

/** Capabilities the core flow engine hands to a method plugin's handlers (step 4, decision 1: the chains and
 * their levels stay in the core; the method behaviour lives in the plugin and receives this context). */
export interface MethodCtx {
  tenant: string; subject: string; instanceId: string; config: Record<string, any>;
  /** False when the account does not exist or cannot sign in: methods still behave the same way from the outside (no enumeration). */
  known: boolean;
  enroll: EnrollmentStore; mail: DemoOutbox;
  /** Real mail adapter when the server is configured for it (see mail.ts), else null. */
  smtp: MailAdapter | null;
  /** E-mail address from the user's profile (live data), if any. */
  profileEmail(): Promise<string | undefined>;
  /** Password check through the platform's auth.password slot (so a lockout replacement keeps working). */
  passwordCheck(tenant: string, subject: string, password: string): Promise<boolean>;
  now(): number;
}
export interface AuthMethodType {
  id: string; name: string; description: string;
  /** Category of factor the method DECLARES. It is a classification, not a measurement of strength or independence. */
  factor: Factor; amr: string;
  maturity: 'implemented' | 'catalogue';
  suggestedLevel: number;
  settings: SettingField[];
  provisioning: 'directory' | 'admin-demo' | 'none';
  inlineWithUsername(config: Record<string, any>): boolean;
  /** `real` = the check proves what the factor category says. A demo delivery channel proves nothing, so it is not real. */
  verification(config: Record<string, any>): { real: boolean; note: string };
  prepare?(ctx: MethodCtx): Promise<{ prompt: Prompt; state: Record<string, any> }>;
  verify?(ctx: MethodCtx, state: Record<string, any>, answers: Record<string, string>): Promise<boolean>;
  /** Interactive methods (keypad): one call per button press. `done:false` shows the next prompt and keeps the step open; `done:true` ends it with a verdict. */
  interact?(ctx: MethodCtx, state: Record<string, any>, answers: Record<string, string>): Promise<{ done: false; prompt: Prompt; state: Record<string, any> } | { done: true; ok: boolean }>;
}

/** Ideas shown in the catalogue so the list reads as a roadmap. They cannot be created: nothing is implemented for them. */
const planned = (id: string, name: string, description: string, factor: Factor, level: number, amr: string): AuthMethodType => ({
  id, name, description, factor, amr, maturity: 'catalogue', suggestedLevel: level, settings: [], provisioning: 'none',
  inlineWithUsername: () => false, verification: () => ({ real: false, note: 'Not implemented.' }),
});
const PLANNED: AuthMethodType[] = [
  planned('passkey', 'Passkey (WebAuthn)', 'Phishing-resistant public-key credential bound to a device. Needs a browser ceremony and a relying-party configuration: not built.', 'possession', 9, 'hwk'),
  planned('recovery-code', 'Recovery codes', 'One-time printed codes for account recovery. Not built.', 'knowledge', 5, 'otp'),
  planned('federation', 'External identity provider (OIDC/SAML)', 'Delegate sign-in to another IdP and map its claims. Not built.', 'other' as Factor, 6, 'fed'),
];

/**
 * The method type catalogue, sourced from the folder plugins (step 4b): every plugin whose manifest declares
 * `authMethod` is a type, its handlers are the implementation. The payload/ctx split mirrors the hook contract:
 * payload = { config, subject, instanceId, known, answers, state }, ctx = the MethodCtx capabilities above.
 */
function fromPlugin(impl: { manifest: import('../plugins/v1/manifest.js').PluginManifest; handlers: Record<string, HookHandler> }): AuthMethodType {
  const a = impl.manifest.authMethod!;
  const id = (impl.manifest.provides ?? []).find((s) => s.startsWith('auth.'))!.slice('auth.'.length);
  const payload = (ctx: MethodCtx, state: Record<string, any>, answers?: Record<string, string>) => ({ config: ctx.config, subject: ctx.subject, instanceId: ctx.instanceId, known: ctx.known, state, answers });
  return {
    id, name: a.name, description: a.description, factor: a.factor as Factor, amr: a.amr, maturity: a.maturity,
    suggestedLevel: a.suggestedLevel, settings: impl.manifest.settings, provisioning: a.provisioning,
    inlineWithUsername: () => !!a.inlineWithUsername,
    verification: (config) => (impl.handlers['auth.verification']?.({ config }, { tenant: '', settings: {} }) ?? { real: false, note: 'no verification handler' }) as { real: boolean; note: string },
    // The method plugins receive the MethodCtx capabilities directly (their ctx.settings is unused; only a replacement's own hooks see it).
    ...(impl.handlers['auth.prepare'] ? { prepare: (ctx: MethodCtx) => impl.handlers['auth.prepare'](payload(ctx, {}), ctx as never) } : {}),
    ...(impl.handlers['auth.verify'] ? { verify: (ctx: MethodCtx, state: Record<string, any>, answers: Record<string, string>) => impl.handlers['auth.verify'](payload(ctx, state, answers), ctx as never) } : {}),
    ...(impl.handlers['auth.interact'] ? { interact: (ctx: MethodCtx, state: Record<string, any>, answers: Record<string, string>) => impl.handlers['auth.interact'](payload(ctx, state, answers), ctx as never) } : {}),
  };
}

let cached: AuthMethodType[] | undefined;
export function methodTypes(): AuthMethodType[] {
  if (!cached) cached = [...loadPlugins().filter((i) => i.manifest.authMethod).map(fromPlugin), ...PLANNED];
  return cached;
}
export const CATALOGUE: AuthMethodType[] = methodTypes();
export const methodType = (id: string) => CATALOGUE.find((m) => m.id === id);
