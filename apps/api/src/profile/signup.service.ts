import { Inject, Injectable, Optional } from '@nestjs/common';
import { UsersService } from '../users/users.service.js';
import { AuthnService } from '../authn/flow.service.js';
import { ProfileService } from './profile.service.js';
import { ApplicationBus } from '../events/application-bus.service.js';
import { currentBranch } from '../workspace/context.js';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { renderMailOrLegacy } from '../plugins/v1/mail-catalogue.js';

/**
 * Public sign-up. The management rules live in the directory plugin (plugins/directory/signup.mjs);
 * this core adapter wires the profile schema, the user directory, the mail outbox and the audit bus.
 */
interface SignupPluginModule {
  createSignupManager: (deps: {
    signupOpen: (tenant: string) => Promise<boolean>;
    schema: (tenant: string, ctx: 'signup', ref: 'live') => Promise<{ key: string; label: string; type: string; help?: string; options?: string[]; required?: boolean }[]>;
    signupValues: (tenant: string, input: unknown) => Promise<Record<string, string | number | boolean | null>>;
    putWorking: (tenant: string, id: string, values: Record<string, string | number | boolean | null>, actor: string) => Promise<void>;
    usersList?: (ref: string) => Promise<{ id: string; email?: string | null }[]>;
    usersSave?: (id: string, body: Record<string, unknown>, create: boolean, pre: { salt: string; hash: string }, tenant: string) => Promise<unknown>;
    outboxSend?: (message: { tenant: string; to: string; subject: string; text: string; subjectUser: string }) => Promise<void>;
    /** Templated delivery (docs/mail-templates.md): render via notify.templates, real send via notify.default
     * when its capability is real, otherwise the rendered text lands in the demo outbox. */
    deliver?: (message: { tenant: string; to: string; template: string; data: Record<string, unknown>; subjectUser: string; effectKey: string }) => Promise<void>;
    emit: (type: string, tenant: string, branch: string, payload: Record<string, string>) => void;
    currentBranch: () => string | undefined;
  }) => {
    pending: Map<string, unknown>;
    hits: Map<string, number[]>;
    schema: (tenant: string) => Promise<unknown>;
    submit: (tenant: string, body: unknown, ip: string) => Promise<unknown>;
    confirm: (tenant: string, token: unknown) => { status: string; message: string };
    list: () => { requests: unknown[] };
    approve: (tenant: string, id: string, actor: string) => Promise<unknown>;
    reject: (id: string) => { rejected: boolean };
  };
}
const plugin = loadPluginModule('directory', 'signup.mjs') as SignupPluginModule;

@Injectable()
export class SignupService {
  private readonly manager: ReturnType<SignupPluginModule['createSignupManager']>;
  constructor(profile: ProfileService, @Optional() users?: UsersService, @Optional() authn?: AuthnService, @Optional() events?: ApplicationBus, @Optional() reg?: PluginRegistry) {
    this.manager = plugin.createSignupManager({
      signupOpen: (t) => profile.signupOpen(t),
      schema: (t, ctx, ref) => profile.schema(t, ctx, ref) as never,
      signupValues: (t, input) => profile.signupValues(t, input),
      putWorking: (t, id, values, actor) => profile.putWorking(t, id, values, actor),
      usersList: users ? (ref) => users.list(ref) as never : undefined,
      usersSave: users ? (id, body, create, pre, tenant) => users.save(id, body, create, pre, tenant) : undefined,
      outboxSend: authn ? (m) => authn.outbox.send(m) : undefined,
      // Sign-up mails render through the notify.templates slot and deliver through notify.default when it really
      // delivers (same rule as the sign-in code, P1-E); otherwise the rendered text lands in the demo outbox.
      // Sign-up is a live path: the MAIN registry renders and sends (a working branch never changes live sign-up).
      deliver: reg ? async (m) => {
        const rendered = await renderMailOrLegacy(reg, m.tenant, m.template, m.data);
        let real = false;
        try { real = !!(await reg.callSlot<{ real: boolean }>(m.tenant, 'notify.default', 'notify.capability', {})).result.real; } catch { /* no capability answer: simulated path */ }
        if (real) await reg.emit(m.tenant, 'notify.send', { effectKey: m.effectKey, tenant: m.tenant, to: m.to, template: m.template, data: m.data, ...(rendered ? { subject: rendered.subject, text: rendered.text, ...(rendered.html ? { html: rendered.html } : {}) } : {}) } as { effectKey: string });
        else if (authn) await authn.outbox.send({ tenant: m.tenant, to: m.to, subject: rendered?.subject ?? `[iam] ${m.template}`, text: rendered?.text ?? Object.entries(m.data).map(([k, v]) => `${k}: ${v}`).join('\n'), subjectUser: m.subjectUser });
      } : undefined,
      emit: (type, tenant, branch, payload) => events?.emit({ type, tenant, branch, at: new Date().toISOString(), payload }),
      currentBranch: () => { try { return currentBranch(); } catch { return undefined; } },
    });
  }
  /** Exposed for tests and operational inspection (same objects the plugin engine mutates). */
  get hits() { return this.manager.hits; }
  get pending() { return this.manager.pending; }
  schema(tenant: string) { return this.manager.schema(tenant); }
  submit(tenant: string, body: unknown, ip: string) { return this.manager.submit(tenant, body, ip); }
  confirm(tenant: string, token: unknown) { return this.manager.confirm(tenant, token); }
  list() { return this.manager.list(); }
  approve(tenant: string, id: string, actor: string) { return this.manager.approve(tenant, id, actor); }
  reject(id: string) { return this.manager.reject(id); }
}
