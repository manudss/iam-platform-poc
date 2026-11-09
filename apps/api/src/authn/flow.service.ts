import { randomBytes } from 'node:crypto';
import { BadRequestException, Inject, Injectable, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import type { AuthenticateResult } from '../plugins/v1/hooks.js';
import { UsersService } from '../users/users.service.js';
import { currentBranch, workspaceMode } from '../workspace/context.js';
import { AuthnConfig, ChainAnalysis, CORE_SETTINGS_ID, EMPTY_CONFIG, SEED_CONFIG, isEmptyConfig, analyzeChain, parseStored, validateConfig } from './config.js';
import { SESSION_SETTINGS_ID, SessionConfig, parseSession, sessionClaims, validateSession } from './session-config.js';
import { branchName } from '../versioning/guards.js';
import { EnrollmentStore } from './enroll-store.js';
import { DemoOutbox, Prompt, methodType, methodTypes } from './methods.js';
import { renderMailOrLegacy } from '../plugins/v1/mail-catalogue.js';

export interface GateRequest { tenant: string; subject?: string; session?: string; chain?: string; branch?: string; answers?: Record<string, string> }
export type GateResponse =
  | { outcome: 'allow'; subject: string; claims: Record<string, unknown>; chain: string }
  | { outcome: 'deny'; reason: string; message: string }
  | { outcome: 'challenge'; session: string; step: { index: number; total: number; methodId: string; type: string } & Prompt; error?: string };

interface Session {
  id: string; tenant: string; subject: string; known: boolean; exp: number; index: number;
  /** Data branch under test (docs/branch-test.md): the whole attempt, its config and its directory lookups stay on it. */
  branch?: string;
  chain: { id: string; name: string; level: number };
  steps: { id: string; type: string; name: string; level: number; config: Record<string, unknown>; real: boolean }[];
  declared: number;
  done: { id: string; type: string; real: boolean }[];
  prepared?: { prompt: Prompt; state: Record<string, any> };
  tries: number;
}
const SESSION_MS = 5 * 60_000, MAX_TRIES = 3, THROTTLE_N = 10, THROTTLE_MS = 10 * 60_000;

/**
 * Orchestrates authentication chains ("the core runs the chain"). The Rust core only draws the pages and asks this service, step by step.
 * Rules: the LIVE configuration is the one on Dolt main (an unapplied working branch never changes sign-in); a session keeps the chain it started with;
 * a wrong answer at the first step ends the attempt with a generic denial; later steps allow up to 3 tries; unknown accounts get the same prompts and always fail;
 * a technical failure of a method throws (the gate answers 503 and the core refuses the sign-in: fail closed).
 */
/** Published FICTIONAL demo credentials for demo-alice (opt-in demo seed only). */
export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXP', DEMO_PIN = '246810', DEMO_PIN8 = '24681024';

@Injectable()
export class AuthnService implements OnApplicationBootstrap {
  readonly enroll = new EnrollmentStore();
  readonly outbox = new DemoOutbox();
  private sessions = new Map<string, Session>();
  private fails = new Map<string, number[]>();
  now = () => Date.now();
  constructor(@Inject(PluginRegistry) private readonly reg: PluginRegistry, @Optional() private readonly branches?: BranchRegistries, @Optional() private readonly users?: UsersService) {}

  private async registry(ref: 'live' | 'work', write = false): Promise<PluginRegistry> {
    if (!workspaceMode()) return this.reg;
    return this.branches!.get(ref === 'live' ? 'main' : currentBranch(write));
  }
  /** Sign-in reads its configuration on Dolt main, or on one tested data branch (the gate checked the ticket before calling here). */
  private async signinRegistry(branch?: string): Promise<PluginRegistry> {
    if (!branch) return this.registry('live');
    if (!workspaceMode()) throw new BadRequestException('branch test needs the hosted workspace mode');
    branchName(branch);
    if (branch === 'main') throw new BadRequestException('main is the live sign-in already: nothing to test');
    return this.branches!.get(branch);
  }
  private async signinConfig(tenant: string, branch?: string): Promise<AuthnConfig> { return parseStored(await (await this.signinRegistry(branch)).coreSettings(tenant, CORE_SETTINGS_ID)); }
  /**
   * DEMO ONLY, opt-in with IAM_AUTHN_DEMO_SEED=1 (the hosted demo sets it): when no authentication configuration is stored on main,
   * store the example methods and chains (no chain selected for sign-in, so live sign-in does not change) and enroll the FICTIONAL
   * account demo-alice with published fictional credentials so the examples can be tried at once. Never replaces an existing
   * configuration or enrollment. No real secret is created.
   */
  async onApplicationBootstrap() {
    if (process.env.IAM_AUTHN_DEMO_SEED !== '1') return;
    const tenant = process.env.IAM_AUTHN_DEMO_SEED_TENANT || 'acme-demo';
    try { await this.seedDemo(tenant); } catch (e) { console.warn('authn demo seed skipped:', (e as Error).message); }
  }
  async seedDemo(tenant: string): Promise<boolean> {
    const main = await (workspaceMode() ? this.branches!.get('main') : this.reg);
    if (!isEmptyConfig(parseStored(await main.coreSettings(tenant, CORE_SETTINGS_ID)))) return false;
    const cfg = validateConfig(SEED_CONFIG);
    await main.putCoreSettings(tenant, CORE_SETTINGS_ID, cfg as unknown as Record<string, unknown>);
    // The seeded chains use TOTP, e-mail code and PIN: their method plugins must serve the slots (step 2).
    for (const id of ['auth-totp', 'auth-email-otp', 'auth-digit-code']) { try { await main.install(tenant, id, {}); } catch { /* already installed */ } try { await main.enable(tenant, id, {}); } catch (e) { console.warn('authn demo seed: cannot enable', id, (e as Error).message); } }
    const have = await this.enroll.status(tenant, 'demo-alice');
    if (!have['authenticator-app']) await this.enroll.setTotp(tenant, 'demo-alice', 'authenticator-app', DEMO_TOTP_SECRET);
    if (!have['pin-keypad']) await this.enroll.setPin(tenant, 'demo-alice', 'pin-keypad', DEMO_PIN);
    if (!have['pin-keypad-8']) await this.enroll.setPin(tenant, 'demo-alice', 'pin-keypad-8', DEMO_PIN8);
    if (!have['e-mail-code']) await this.enroll.setEmail(tenant, 'demo-alice', 'e-mail-code', 'alice@example.invalid');
    return true;
  }
  /** Session length settings (docs/session.md): sign-in reads them on Dolt main, or on the tested branch; the console edits them on the working branch. */
  async signinSession(tenant: string, branch?: string): Promise<SessionConfig> { return parseSession(await (await this.signinRegistry(branch)).coreSettings(tenant, SESSION_SETTINGS_ID)); }
  async liveSession(tenant: string): Promise<SessionConfig> { return parseSession(await (await this.registry('live')).coreSettings(tenant, SESSION_SETTINGS_ID)); }
  async workingSession(tenant: string): Promise<SessionConfig> { return parseSession(await (await this.registry('work')).coreSettings(tenant, SESSION_SETTINGS_ID)); }
  async saveSession(tenant: string, input: unknown): Promise<SessionConfig> {
    const cfg = validateSession(input);
    await (await this.registry('work', true)).putCoreSettings(tenant, SESSION_SETTINGS_ID, cfg as unknown as Record<string, unknown>);
    return cfg;
  }
  async liveConfig(tenant: string): Promise<AuthnConfig> { return parseStored(await (await this.registry('live')).coreSettings(tenant, CORE_SETTINGS_ID)); }
  async workingConfig(tenant: string): Promise<AuthnConfig> { return parseStored(await (await this.registry('work')).coreSettings(tenant, CORE_SETTINGS_ID)); }
  async saveConfig(tenant: string, input: unknown): Promise<AuthnConfig> {
    const cfg = validateConfig(input);
    await (await this.registry('work', true)).putCoreSettings(tenant, CORE_SETTINGS_ID, cfg as unknown as Record<string, unknown>);
    return cfg;
  }
  analyses(cfg: AuthnConfig): ChainAnalysis[] { return cfg.chains.map((c) => analyzeChain(cfg, c)); }
  catalogue() { return methodTypes().map((t) => ({ id: t.id, name: t.name, description: t.description, factor: t.factor, maturity: t.maturity, suggestedLevel: t.suggestedLevel, provisioning: t.provisioning, instances: t.instances, settings: t.settings, simulatedByDefault: !t.verification(Object.fromEntries(t.settings.map((s) => [s.key, s.default]))).real && t.maturity === 'implemented' })); }

  /** Which instances and chains of a configuration are served right now by an ACTIVE plugin of the given registry (working branch or live).
   * A method is unavailable when the plugin serving its type is disabled or absent; a chain is unavailable when any of its steps is. Drives the "no longer active" state of the console. */
  async availability(tenant: string, cfg: AuthnConfig, ref: 'live' | 'work' = 'work') {
    const reg = await this.registry(ref);
    const methods: Record<string, { available: boolean; plugin?: string }> = {};
    for (const m of cfg.methods) { const p = this.provider(reg, tenant, m.type); methods[m.id] = p ? { available: true, plugin: p.manifest.id } : { available: false, plugin: undefined }; }
    const chains: Record<string, { available: boolean; missing: string[] }> = {};
    for (const c of cfg.chains) { const missing = c.steps.filter((id) => !methods[id]?.available); chains[c.id] = { available: !missing.length, missing }; }
    return { methods, chains };
  }

  private async known(tenant: string, subject: string, branch?: string): Promise<boolean> {
    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(subject)) return false;
    if (process.env.IAM_DIRECTORY_AUTH === '1' && this.users) { try { return (await this.users.list(branch ?? 'main')).some((u) => u.id === subject && u.login_enabled && u.hasCredential); } catch { return false; } }
    return true;
  }
  /** Profile address of the user on the relevant data branch (main normally), only when the directory is the source of accounts. */
  private async profileEmail(subject: string, branch?: string): Promise<string | undefined> {
    if (process.env.IAM_DIRECTORY_AUTH !== '1' || !this.users) return undefined;
    try { return ((await this.users.list(branch ?? 'main')).find((u) => u.id === subject && u.login_enabled && u.hasCredential) as { email?: string | null } | undefined)?.email || undefined; } catch { return undefined; }
  }
  /** The plugin SERVING a method type right now on this registry: the provider chosen for the auth.<type> slot
   * (the working base, or the enabled replacement) - and only when it really is a method (the refusing base of a
   * slot without an enabled method is NOT one). A disabled or removed method simply has no provider. */
  private provider(reg: PluginRegistry, tenant: string, type: string) {
    try { const p = reg.resolve(tenant, `auth.${type}`); return p.manifest.authMethod && reg.isActive(tenant, p.manifest.id) ? p : undefined; } catch { return undefined; }
  }
  /** Descriptive verification note THROUGH THE REGISTRY (never in-process at sign-in, review n:2): a disabled or
   * faulted plugin cannot answer, so the note degrades to 'unavailable' instead of lying. */
  private async verification(reg: PluginRegistry, tenant: string, m: { type: string; config: Record<string, unknown> }): Promise<{ real: boolean; note: string }> {
    if (!this.provider(reg, tenant, m.type)) return { real: false, note: 'Method unavailable (its plugin is disabled).' };
    try { return (await reg.callSlot<{ real: boolean; note: string }>(tenant, `auth.${m.type}`, 'auth.verification', { config: m.config })).result; }
    catch { return { real: false, note: 'Method unavailable (its plugin failed).' }; }
  }
  /** Read-side of the bus contract (step 2): the core assembles everything the pure plugin handler needs. */
  private async enrollment(tenant: string, subject: string, st: { id: string; type: string }) {
    if (st.type === 'totp') { const t = await this.enroll.totpRecord(tenant, subject, st.id); return t ? { totp: t } : {}; }
    if (st.type === 'digit-code') { const p = await this.enroll.pinRecord(tenant, subject, st.id); return p ? { pin: p } : {}; }
    if (st.type === 'email-otp') { const email = await this.enroll.email(tenant, subject, st.id); return email ? { email } : {}; }
    return {};
  }
  private async notifyCapability(reg: PluginRegistry, tenant: string) {
    // Delivery of one-time codes goes through the notify.default slot (P1-E): the plugin chosen on the slot
    // sends (durable emission); its notify.capability answer says whether delivery is real or simulated.
    try { return await (await reg.callSlot<{ real: boolean; note?: string }>(tenant, 'notify.default', 'notify.capability', {})).result; }
    catch (e) { console.error('[authn] notify capability lookup failed:', (e as Error).message); return undefined; } // the plugin then takes the simulated path
  }
  private async methodPayload(reg: PluginRegistry, s: Session, st: Session['steps'][number], state: Record<string, any>, answers?: Record<string, string>) {
    return {
      tenant: s.tenant, subject: s.subject, known: s.known, instanceId: st.id, config: st.config as Record<string, any>,
      state, answers, now: this.now(),
      enrollment: await this.enrollment(s.tenant, s.subject, st),
      ...(st.type === 'email-otp' ? { profileEmail: await this.profileEmail(s.subject, s.branch), notifyCapability: await this.notifyCapability(reg, s.tenant) } : {}),
      ...(st.type === 'password' && answers ? { passwordOutcome: (await reg.callSlot<AuthenticateResult>(s.tenant, 'auth.password', 'auth.authenticate', { tenant: s.tenant, subject: s.subject, credential: { password: answers.password ?? '' } })).result.outcome } : {}),
    };
  }
  private audit(e: Record<string, unknown>) { console.log('[authn]', JSON.stringify(e)); }
  private throttled(key: string) { const t = (this.fails.get(key) ?? []).filter((x) => x > this.now() - THROTTLE_MS); this.fails.set(key, t); return t.length >= THROTTLE_N; }
  private starts = new Map<string, number[]>();
  /** At most 30 sign-in starts per account per 10 minutes: bounds e-mail code floods. */
  private tooManyStarts(key: string) { const t = (this.starts.get(key) ?? []).filter((x) => x > this.now() - THROTTLE_MS); t.push(this.now()); this.starts.set(key, t); return t.length > 30; }
  private fail(key: string) { (this.fails.get(key) ?? this.fails.set(key, []).get(key)!).push(this.now()); }
  private sweep() { const n = this.now(); for (const [k, s] of this.sessions) if (s.exp < n) this.sessions.delete(k); while (this.sessions.size > 2000) this.sessions.delete(this.sessions.keys().next().value as string); }

  /** Chains a person may pick at sign-in: enabled chains of the LIVE configuration whose methods are all enabled
   * AND served by an active plugin on the sign-in registry (review n:2 / acceptance 3: disabling a method's plugin
   * retires the chains that use it from the sign-in options at once). */
  private async offered(cfg: AuthnConfig, reg: PluginRegistry, tenant: string) {
    return cfg.chains.filter((c) => c.enabled && c.steps.every((id) => { const m = cfg.methods.find((x) => x.id === id); return !!m?.enabled && !!this.provider(reg, tenant, m.type); }));
  }
  /** Cache of the public sign-in options, keyed by tenant, branch and Dolt head: the list only depends on the
   *  configuration and plugin state stored in Dolt, so one head check (a small query) replaces re-reading the
   *  configuration and re-asking every method plugin over the bus on each visit. Outside workspace mode (specs)
   *  there is no head to key on and nothing is cached. */
  private readonly optionsCache = new Map<string, Awaited<ReturnType<AuthnService['computeOptions']>>>();
  /** Public description of what can be chosen on the sign-in page. No enrollment, user or secret information. */
  async options(tenant: string, branch?: string) {
    const reg = await this.signinRegistry(branch);
    const head = this.branches?.headOf(branch ?? 'main');
    const key = head ? `${tenant}|${branch ?? 'main'}|${head}` : null;
    const hit = key ? this.optionsCache.get(key) : undefined;
    if (hit) return hit;
    const value = await this.computeOptions(reg, tenant, branch);
    if (key) {
      if (this.optionsCache.size >= 100) this.optionsCache.delete(this.optionsCache.keys().next().value as string);
      this.optionsCache.set(key, value);
    }
    return value;
  }
  private async computeOptions(reg: PluginRegistry, tenant: string, branch?: string) {
    const cfg = await this.signinConfig(tenant, branch), list = await this.offered(cfg, reg, tenant);
    return {
      mode: list.length ? 'choice' as const : 'legacy' as const,
      chains: await Promise.all(list.map(async (c) => {
        const a = analyzeChain(cfg, c);
        return { id: c.id, name: c.name, declaredLevel: c.level, effectiveLevel: a.effectiveLevel, mfa: a.mfa, simulated: a.simulatedSteps.length > 0, recommended: cfg.defaultChain === c.id,
          steps: await Promise.all(c.steps.map(async (id) => { const m = cfg.methods.find((x) => x.id === id)!; return { name: m.name, type: m.type, simulated: !(await this.verification(reg, tenant, m)).real }; })), ...(c.note ? { note: c.note } : {}) };
      })),
      note: 'Levels are declared by an administrator (10 = strongest), not measured. A simulated step proves nothing.',
      ...(branch ? { branch, test: true as const } : {}),
    };
  }
  /** Which chain a sign-in uses: the one the person picked, else the administrator's default, else the plain single-password chain (JSON /authorize, scripts). None = refuse. */
  private async resolve(cfg: AuthnConfig, reg: PluginRegistry, tenant: string, requested?: string) {
    const list = await this.offered(cfg, reg, tenant);
    if (typeof requested === 'string' && requested) return list.find((c) => c.id === requested);
    const def = list.find((c) => c.id === cfg.defaultChain);
    if (def) return def;
    return list.find((c) => c.steps.length === 1 && methodType(cfg.methods.find((m) => m.id === c.steps[0])!.type)?.id === 'password');
  }

  /** First page of the core's form. No chain is configured: classic form. Chains exist and none is picked: the list to choose from. A chain is picked: its first inputs. */
  async entry(tenant: string, chainId?: string, branch?: string): Promise<{ mode: 'legacy' } | { mode: 'choice'; chains: Awaited<ReturnType<AuthnService['options']>>['chains'] } | { mode: 'chain'; chain: { id: string; name: string }; fields: Prompt['fields'] }> {
    const reg = await this.signinRegistry(branch);
    const cfg = await this.signinConfig(tenant, branch), list = await this.offered(cfg, reg, tenant);
    if (!list.length) return { mode: 'legacy' };
    const chain = typeof chainId === 'string' && chainId ? list.find((c) => c.id === chainId) : undefined;
    if (!chain) return { mode: 'choice', chains: (await this.options(tenant, branch)).chains };
    const m = cfg.methods.find((x) => x.id === chain.steps[0])!, t = methodType(m.type)!;
    if (!t.inlineWithUsername(m.config)) return { mode: 'chain', chain: { id: chain.id, name: chain.name }, fields: [] };
    const s = { tenant, subject: '', known: false, branch } as Session;
    const st = { id: m.id, type: m.type, name: m.name, level: m.level, config: m.config, real: true };
    const p = (await reg.callSlot<{ prompt: Prompt }>(tenant, `auth.${m.type}`, 'auth.prepare', await this.methodPayload(reg, s, st, {}))).result;
    return { mode: 'chain', chain: { id: chain.id, name: chain.name }, fields: p.prompt.fields };
  }

  /** Returns null when no chain is live: the caller then uses the single base-password path unchanged. */
  async authenticate(b: GateRequest): Promise<GateResponse | null> {
    this.sweep();
    if (b.session) return this.answer(b);
    const reg = await this.signinRegistry(b.branch);
    const cfg = await this.signinConfig(b.tenant, b.branch);
    if (!(await this.offered(cfg, reg, b.tenant)).length) return null;   // nothing configured and enabled: the classic single-password path, unchanged
    const chain = await this.resolve(cfg, reg, b.tenant, typeof b.chain === 'string' ? b.chain.slice(0, 40) : undefined);
    if (!chain) return { outcome: 'deny', reason: 'bad-credentials', message: 'Sign-in failed. Check your details and try again.' };   // chains exist: never fall back to a laxer path
    const subject = typeof b.subject === 'string' ? b.subject : '';
    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(subject)) return { outcome: 'deny', reason: 'bad-credentials', message: 'Sign-in failed. Check your details and try again.' };
    const key = `${b.tenant}/${b.branch ?? 'live'}/${subject}`;
    if (this.throttled(key) || this.tooManyStarts(key)) { this.audit({ tenant: b.tenant, subject, outcome: 'throttled' }); return { outcome: 'deny', reason: 'bad-credentials', message: 'Sign-in failed. Check your details and try again.' }; }
    const a = analyzeChain(cfg, chain);
    const steps = await Promise.all(chain.steps.map(async (id) => { const m = cfg.methods.find((x) => x.id === id)!; return { id: m.id, type: m.type, name: m.name, level: m.level, config: m.config, real: (await this.verification(reg, b.tenant, m)).real }; }));
    const s: Session = { id: randomBytes(24).toString('base64url'), tenant: b.tenant, subject, branch: b.branch, known: await this.known(b.tenant, subject, b.branch), exp: this.now() + SESSION_MS, index: 0, chain: { id: chain.id, name: chain.name, level: a.effectiveLevel }, steps, declared: a.declaredLevel, done: [], tries: 0 };
    this.sessions.set(s.id, s);
    await this.prepare(s);
    const first = steps[0], t = methodType(first.type)!;
    if (b.answers && Object.keys(b.answers).length && t.inlineWithUsername(first.config)) return this.check(s, b.answers);
    return this.challenge(s);
  }
  private async answer(b: GateRequest): Promise<GateResponse> {
    const s = this.sessions.get(String(b.session));
    if (!s || s.tenant !== b.tenant || s.exp < this.now()) { if (s) this.sessions.delete(s.id); return { outcome: 'deny', reason: 'session-expired', message: 'Your sign-in session expired. Start again.' }; }
    if (s.branch && typeof b.branch === 'string' && b.branch && b.branch !== s.branch) return { outcome: 'deny', reason: 'bad-credentials', message: 'Sign-in failed. Check your details and try again.' };   // a running sign-in stays bound to its branch
    if (!b.answers || typeof b.answers !== 'object') return { outcome: 'deny', reason: 'bad-credentials', message: 'Sign-in failed. Check your details and try again.' };
    return this.check(s, b.answers);
  }
  private async prepare(s: Session) {
    const st = s.steps[s.index];
    const reg = await this.signinRegistry(s.branch);
    // The method plugin answers over the bus (callSlot: grants, deadline, faults, audit); a throw is a technical
    // failure: the gate answers 503 and the core refuses the sign-in (fail closed).
    const r = await reg.callSlot<{ prompt: Prompt; state: Record<string, any>; notify?: Record<string, unknown>; mail?: { tenant: string; to: string; subject: string; text: string; subjectUser: string } }>(s.tenant, `auth.${st.type}`, 'auth.prepare', await this.methodPayload(reg, s, st, {}));
    s.prepared = { prompt: r.result.prompt, state: r.result.state ?? {} }; s.tries = 0;
    // Effects the pure handler asked for: the core applies them (durable notify emission, demo outbox). The
    // mail content is rendered first through the notify.templates slot (mail-templates, docs/mail-templates.md):
    // a renderer problem degrades to the legacy raw payload, explicitly logged (never blocks a sign-in).
    if (r.result.notify) {
      const n = r.result.notify as { tenant: string; to: string; template: string; data?: Record<string, unknown>; effectKey: string };
      const rendered = await renderMailOrLegacy(reg, s.tenant, n.template, n.data ?? {});
      await reg.emit(s.tenant, 'notify.send', { ...n, ...(rendered ? { subject: rendered.subject, text: rendered.text, ...(rendered.html ? { html: rendered.html } : {}) } : {}) });
    }
    if (r.result.mail) {
      const m = r.result.mail as { tenant: string; to: string; subject: string; text: string; subjectUser: string; template?: string; data?: Record<string, unknown> };
      const rendered = m.template ? await renderMailOrLegacy(reg, s.tenant, m.template, m.data ?? {}) : undefined;
      await this.outbox.send(rendered ? { tenant: m.tenant, to: m.to, subject: rendered.subject, text: rendered.text, subjectUser: m.subjectUser } : m);
    }
  }
  private challenge(s: Session, error?: string): GateResponse {
    const st = s.steps[s.index];
    return { outcome: 'challenge', session: s.id, step: { index: s.index, total: s.steps.length, methodId: st.id, type: st.type, ...s.prepared!.prompt }, ...(error ? { error } : {}) };
  }
  private async check(s: Session, answers: Record<string, string>): Promise<GateResponse> {
    const st = s.steps[s.index], t = methodType(st.type)!, key = `${s.tenant}/${s.branch ?? 'live'}/${s.subject}`;
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(answers)) if (typeof v === 'string' && v.length <= 256 && /^[a-z0-9]{1,12}$/.test(k)) clean[k] = v;
    const reg = await this.signinRegistry(s.branch);
    let ok = false;
    try {
      const payload = await this.methodPayload(reg, s, st, s.prepared!.state, clean);
      if (t.id === 'digit-code') {   // the interactive method: one bus call per button press
        const r = (await reg.callSlot<{ done: boolean; ok?: boolean; prompt?: Prompt; state?: Record<string, any> }>(s.tenant, `auth.${st.type}`, 'auth.interact', payload)).result;
        if (!r.done) { s.prepared = { prompt: r.prompt!, state: r.state! }; return this.challenge(s); }   // a button press: no attempt used yet
        ok = !!r.ok;
      } else {
        const r = (await reg.callSlot<{ ok: boolean; consumeStep?: number; state?: Record<string, any> }>(s.tenant, `auth.${st.type}`, 'auth.verify', payload)).result;
        ok = !!r?.ok;
        if (r?.state) s.prepared!.state = r.state;   // e.g. the e-mail code's single-use flag
        // Anti-replay effect: the step the plugin accepted is consumed ATOMICALLY by the store (a parallel attempt
        // that read the same lastStep loses the race and fails here).
        if (ok && typeof r?.consumeStep === 'number') ok = await this.enroll.consumeTotpStep(s.tenant, s.subject, st.id, r.consumeStep);
      }
    } catch (e) { this.sessions.delete(s.id); throw e; }
    if (!ok) {
      this.fail(key); s.tries++;
      this.audit({ tenant: s.tenant, subject: s.subject, chain: s.chain.id, step: s.index, method: st.id, outcome: 'step-failed' });
      if (s.index === 0 || s.tries >= MAX_TRIES) { this.sessions.delete(s.id); return { outcome: 'deny', reason: 'bad-credentials', message: 'Sign-in failed. Check your details and try again.' }; }
      return this.challenge(s, `Incorrect answer. ${MAX_TRIES - s.tries} attempt(s) left.`);
    }
    s.done.push({ id: st.id, type: st.type, real: st.real }); s.index++;
    if (s.index < s.steps.length) { await this.prepare(s); return this.challenge(s); }
    this.sessions.delete(s.id); this.fails.delete(key);
    const real = s.done.filter((d) => d.real), factors = new Set(real.map((d) => methodType(d.type)!.factor));
    const claims = {
      amr: [...new Set(real.map((d) => methodType(d.type)!.amr))],
      auth_level: s.chain.level, auth_level_declared: s.declared, auth_level_basis: 'configured',
      auth_mfa: factors.size >= 2, auth_chain: s.chain.id, auth_methods: s.done.map((d) => d.id),
      auth_simulated: s.done.filter((d) => !d.real).map((d) => d.id),
      ...sessionClaims(await this.signinSession(s.tenant, s.branch)),
    };
    this.audit({ tenant: s.tenant, subject: s.subject, chain: s.chain.id, outcome: 'allow', mfa: claims.auth_mfa, level: claims.auth_level });
    return { outcome: 'allow', subject: s.subject, chain: s.chain.id, claims };
  }
}
export { EMPTY_CONFIG };
