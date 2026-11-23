import { SIGNUP_REQUEST_STORE, SignupRequestStore } from './signup-request-store.js';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { UsersService } from '../users/users.service.js';
import { AuthnService } from '../authn/flow.service.js';
import { ProfileService } from './profile.service.js';
import { ApplicationBus } from '../events/application-bus.service.js';
import { currentBranch, workspaceMode } from '../workspace/context.js';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { renderMailOrLegacy } from '../plugins/v1/mail-catalogue.js';

/**
 * Public sign-up. The management rules live in the directory plugin (plugins/directory/signup.mjs);
 * this core adapter wires the profile schema, the user directory, the mail outbox and the audit bus.
 */
interface SignupPluginModule {
  createSignupManager: (deps: {
    usersStage?: (id: string, body: Record<string, unknown>, pre: { salt: string; hash: string }, tenant: string) => Promise<unknown>;
    verifyPublished?: (tenant: string, p: any) => Promise<boolean>;
    finalizeHold?: (tenant: string, id: string) => Promise<void>;
    pendingLoad?: SignupRequestStore['load'];
    pendingSave?: SignupRequestStore['save'];
    signupOpen: (tenant: string) => Promise<boolean>;
    schema: (tenant: string, ctx: 'signup', ref: 'live') => Promise<{ key: string; label: string; type: string; help?: string; options?: string[]; required?: boolean }[]>;
    signupValues: (tenant: string, input: unknown) => Promise<Record<string, string | number | boolean | null>>;
    putWorking: (tenant: string, id: string, values: Record<string, string | number | boolean | null>, actor: string) => Promise<void>;
    usersList?: (ref: string) => Promise<{ id: string; email?: string | null }[]>;
    usersSave?: (id: string, body: Record<string, unknown>, create: boolean, pre: { salt: string; hash: string }, tenant: string) => Promise<unknown>;
    /** The password policy of the auth.password slot (base rule or the enabled replacement). Returns refusal reasons. */
    passwordCheck?: (tenant: string, input: { id: string; password: string; display_name: string; email: string }) => Promise<string[]>;
    outboxSend?: (message: { tenant: string; to: string; subject: string; text: string; subjectUser: string }) => Promise<void>;
    /** Templated delivery (docs/mail-templates.md): render via notify.templates, real send via notify.default
     * when its capability is real, otherwise the rendered text lands in the demo outbox. */
    deliver?: (message: { tenant: string; to: string; template: string; data: Record<string, unknown>; subjectUser: string; effectKey: string }) => Promise<void>;
    emit: (type: string, tenant: string, branch: string, payload: Record<string, string>) => void;
    currentBranch: () => string | undefined;
  }) => {
    stageApprove: (tenant: string, id: string, actor: string, snapshot: string, run: string, branch: string) => Promise<unknown>;
    finalize: (tenant: string, id: string, actor: string, run: string) => Promise<unknown>;
    pending: Map<string, unknown>;
    hits: Map<string, number[]>;
    schema: (tenant: string) => Promise<unknown>;
    submit: (tenant: string, body: unknown, ip: string) => Promise<unknown>;
    confirm: (tenant: string, token: unknown) => Promise<{ status: string; message: string }>;
    list: (tenant?: string) => { requests: unknown[] } | Promise<{ requests: unknown[] }>;
    approve: (tenant: string, id: string, actor: string, expectedSnapshot?: string) => Promise<unknown>;
    reject: (id: string, tenant?: string, expectedSnapshot?: string) => Promise<{ rejected: boolean }>;
  };
}
const plugin = loadPluginModule('directory', 'signup.mjs') as SignupPluginModule;

@Injectable()
export class SignupService {
  private readonly notifier?: PluginRegistry;
  private readonly events?: ApplicationBus;
  private readonly manager: ReturnType<SignupPluginModule['createSignupManager']>;
  constructor(profile: ProfileService, @Optional() users?: UsersService, @Optional() authn?: AuthnService, @Optional() events?: ApplicationBus, @Optional() reg?: PluginRegistry, @Optional() @Inject(SIGNUP_REQUEST_STORE) requests?: SignupRequestStore) {
    this.notifier = reg; this.authn = authn; this.events = events;
    this.manager = plugin.createSignupManager({
      usersStage: users ? (id, body, pre, tenant) => users.save(id, body, true, pre, tenant, undefined, true) : undefined,
      verifyPublished: users ? async (tenant, p) => {
        const live = (await users.list('main')).find(u => u.id === p.id) as Record<string, unknown> | undefined;
        return !!live && live.hasCredential === true && live.display_name === p.display_name && live.email === p.email && live.login_enabled === true && live.credential_revision === p.staged.revision && await profile.verifyPublishedSignup(tenant, p.id, p.values);
      } : undefined,
      finalizeHold: authn ? async (tenant) => {
        if ((await authn.liveSecurity(tenant)).holdAfterVerification) throw new Error('holdAfterVerification changed: stop and reconcile publication activation before finalizing signup');
      } : undefined,
      pendingLoad: requests ? (t) => requests.load(t) : undefined,
      pendingSave: requests ? (t, revision, rows) => requests.save(t, revision, rows) : undefined,
      signupOpen: (t) => profile.signupOpen(t),
      schema: (t, ctx, ref) => profile.schema(t, ctx, ref) as never,
      signupValues: (t, input) => profile.signupValues(t, input),
      putWorking: (t, id, values, actor) => profile.putWorking(t, id, values, actor),
      usersList: users ? (ref) => users.list(ref) as never : undefined,
      usersSave: users ? (id, body, create, pre, tenant) => users.save(id, body, create, pre, tenant) : undefined,
      // Sign-up is a live path: the policy check runs against the live slot configuration, like the delivery above.
      // A stubbed or older UsersService without the check falls back to the plugin's historical 12..128 rule.
      passwordCheck: users && typeof users.checkPasswordPolicy === 'function' ? async (tenant, x) => (await users.checkPasswordPolicy(tenant, x.id, x.password, { display_name: x.display_name, email: x.email })).errors : undefined,
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
  /** Read the live notifier only. A real capability declares delivery support, not a delivery guarantee. */
  async deliveryStatus(tenant: string): Promise<{ mode: 'real' | 'simulated' | 'unknown'; source: 'live' }> {
    if (!this.notifier) return { mode: 'simulated', source: 'live' };
    try {
      const capability = (await this.notifier.callSlot<{ real?: boolean }>(tenant, 'notify.default', 'notify.capability', {})).result;
      return { mode: capability?.real === true ? 'real' : capability?.real === false ? 'simulated' : 'unknown', source: 'live' };
    } catch { return { mode: 'unknown', source: 'live' }; }
  }
  schema(tenant: string) { return this.manager.schema(tenant); }
  submit(tenant: string, body: unknown, ip: string) { return this.manager.submit(tenant, body, ip); }
  confirm(tenant: string, token: unknown) { return this.manager.confirm(tenant, token); }
  list(tenant?: string) { return this.manager.list(tenant); }
  private readonly authn?: AuthnService;
  /**
   * Approval creates the account (on the working branch). When the tenant keeps new accounts blocked until someone or a workflow lifts the block
   * (setting holdAfterVerification), the account is also given a `pending_approval` hold block: it cannot sign in, even after Apply, until the block is lifted.
   * The e-mail confirmation and the administrator approval stay what they were; this only adds the hold.
   */
  async approve(tenant: string, id: string, actor: string, expectedSnapshot?: string) {
    const out = await this.manager.approve(tenant, id, actor, expectedSnapshot);
    if (this.authn && (await this.authn.liveSecurity(tenant)).holdAfterVerification) {
      await this.authn.blocks.add(tenant, { subject: id, kind: 'pending_approval', message: 'Your account was created and is waiting to be activated.', origin: 'automatic', setBy: 'system', setAt: Date.now(), hold: true });
      this.events?.emit({ type: 'user.blocked', tenant, branch: 'main', at: new Date().toISOString(), payload: { subject: id, kind: 'pending_approval', actor: 'system' } });
    }
    return out;
  }
  async stageApprove(tenant: string, id: string, actor: string, snapshot: string, run: string, branch: string) {
    if (!workspaceMode() || currentBranch(true) !== branch) throw new Error('signup staging requires workspace mode and the exact isolated run branch');
    if (this.authn && (await this.authn.liveSecurity(tenant)).holdAfterVerification) throw new Error('workflow signup approval with holdAfterVerification requires publication-coupled activation; refusing before effects');
    return this.manager.stageApprove(tenant, id, actor, snapshot, run, branch); }
  finalize(tenant: string, id: string, actor: string, run: string) { return this.manager.finalize(tenant, id, actor, run); }
  reject(id: string, tenant?: string, expectedSnapshot?: string) { return this.manager.reject(id, tenant, expectedSnapshot); }
}
