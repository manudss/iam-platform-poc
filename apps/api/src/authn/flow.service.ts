import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import type { AuthenticateResult } from '../plugins/v1/hooks.js';
import { UsersService } from '../users/users.service.js';
import { currentBranch, workspaceMode } from '../workspace/context.js';
import { AuthnConfig, ChainAnalysis, CORE_SETTINGS_ID, EMPTY_CONFIG, analyzeChain, parseStored, validateConfig } from './config.js';
import { EnrollmentStore } from './enroll-store.js';
import { SmtpMailAdapter } from './mail.js';
import { CATALOGUE, DemoOutbox, MailAdapter, MethodCtx, Prompt, methodType } from './methods.js';

export interface GateRequest { tenant: string; subject?: string; session?: string; answers?: Record<string, string> }
export type GateResponse =
  | { outcome: 'allow'; subject: string; claims: Record<string, unknown>; chain: string }
  | { outcome: 'deny'; reason: string; message: string }
  | { outcome: 'challenge'; session: string; step: { index: number; total: number; methodId: string; type: string } & Prompt; error?: string };

interface Session {
  id: string; tenant: string; subject: string; known: boolean; exp: number; index: number;
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
@Injectable()
export class AuthnService {
  readonly enroll = new EnrollmentStore();
  readonly outbox = new DemoOutbox();
  /** Set from the server environment only; tests may replace it. */
  smtp: MailAdapter | null = SmtpMailAdapter.fromEnv();
  private sessions = new Map<string, Session>();
  private fails = new Map<string, number[]>();
  now = () => Date.now();
  constructor(@Inject(PluginRegistry) private readonly reg: PluginRegistry, @Optional() private readonly branches?: BranchRegistries, @Optional() private readonly users?: UsersService) {}

  private async registry(ref: 'live' | 'work', write = false): Promise<PluginRegistry> {
    if (!workspaceMode()) return this.reg;
    return this.branches!.get(ref === 'live' ? 'main' : currentBranch(write));
  }
  async liveConfig(tenant: string): Promise<AuthnConfig> { return parseStored(await (await this.registry('live')).coreSettings(tenant, CORE_SETTINGS_ID)); }
  async workingConfig(tenant: string): Promise<AuthnConfig> { return parseStored(await (await this.registry('work')).coreSettings(tenant, CORE_SETTINGS_ID)); }
  async saveConfig(tenant: string, input: unknown): Promise<AuthnConfig> {
    const cfg = validateConfig(input);
    await (await this.registry('work', true)).putCoreSettings(tenant, CORE_SETTINGS_ID, cfg as unknown as Record<string, unknown>);
    return cfg;
  }
  analyses(cfg: AuthnConfig): ChainAnalysis[] { return cfg.chains.map((c) => analyzeChain(cfg, c)); }
  catalogue() { return CATALOGUE.map((t) => ({ id: t.id, name: t.name, description: t.description, factor: t.factor, maturity: t.maturity, suggestedLevel: t.suggestedLevel, provisioning: t.provisioning, settings: t.settings, simulatedByDefault: !t.verification(Object.fromEntries(t.settings.map((s) => [s.key, s.default]))).real && t.maturity === 'implemented' })); }

  private async known(tenant: string, subject: string): Promise<boolean> {
    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(subject)) return false;
    if (process.env.IAM_DIRECTORY_AUTH === '1' && this.users) { try { return (await this.users.list('main')).some((u) => u.id === subject && u.login_enabled && u.hasCredential); } catch { return false; } }
    return true;
  }
  /** Live (main) profile address of the user, only when the directory is the source of accounts. */
  private async profileEmail(subject: string): Promise<string | undefined> {
    if (process.env.IAM_DIRECTORY_AUTH !== '1' || !this.users) return undefined;
    try { return ((await this.users.list('main')).find((u) => u.id === subject && u.login_enabled && u.hasCredential) as { email?: string | null } | undefined)?.email || undefined; } catch { return undefined; }
  }
  private async passwordCheck(tenant: string, subject: string, password: string) {
    const r = await (await this.registry('live')).callSlot<AuthenticateResult>(tenant, 'auth.password', 'auth.authenticate', { tenant, subject, credential: { password } });
    return r.result.outcome === 'allow';
  }
  private ctx(s: Session, step: Session['steps'][number]): MethodCtx {
    return { tenant: s.tenant, subject: s.subject, instanceId: step.id, config: step.config as Record<string, any>, known: s.known, enroll: this.enroll, mail: this.outbox, smtp: this.smtp, profileEmail: () => this.profileEmail(s.subject), passwordCheck: (t, u, p) => this.passwordCheck(t, u, p), now: this.now };
  }
  private audit(e: Record<string, unknown>) { console.log('[authn]', JSON.stringify(e)); }
  private throttled(key: string) { const t = (this.fails.get(key) ?? []).filter((x) => x > this.now() - THROTTLE_MS); this.fails.set(key, t); return t.length >= THROTTLE_N; }
  private starts = new Map<string, number[]>();
  /** At most 30 sign-in starts per account per 10 minutes: bounds e-mail code floods. */
  private tooManyStarts(key: string) { const t = (this.starts.get(key) ?? []).filter((x) => x > this.now() - THROTTLE_MS); t.push(this.now()); this.starts.set(key, t); return t.length > 30; }
  private fail(key: string) { (this.fails.get(key) ?? this.fails.set(key, []).get(key)!).push(this.now()); }
  private sweep() { const n = this.now(); for (const [k, s] of this.sessions) if (s.exp < n) this.sessions.delete(k); while (this.sessions.size > 2000) this.sessions.delete(this.sessions.keys().next().value as string); }

  /** Which fields the very first page must show next to the user name: the first step's inputs when it needs no server action before input. */
  async entry(tenant: string): Promise<{ mode: 'legacy' } | { mode: 'chain'; fields: Prompt['fields'] }> {
    const cfg = await this.liveConfig(tenant), chain = cfg.chains.find((c) => c.id === cfg.defaultChain && c.enabled);
    if (!chain) return { mode: 'legacy' };
    const m = cfg.methods.find((x) => x.id === chain.steps[0])!, t = methodType(m.type)!;
    if (!t.inlineWithUsername(m.config)) return { mode: 'chain', fields: [] };
    const s = { tenant, subject: '', known: false } as Session;
    const p = await t.prepare!(this.ctx(s, { id: m.id, type: m.type, name: m.name, level: m.level, config: m.config, real: true }));
    return { mode: 'chain', fields: p.prompt.fields };
  }

  /** Returns null when no chain is live: the caller then uses the single base-password path unchanged. */
  async authenticate(b: GateRequest): Promise<GateResponse | null> {
    this.sweep();
    if (b.session) return this.answer(b);
    const cfg = await this.liveConfig(b.tenant), chain = cfg.chains.find((c) => c.id === cfg.defaultChain && c.enabled);
    if (!chain) return null;
    const subject = typeof b.subject === 'string' ? b.subject : '';
    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(subject)) return { outcome: 'deny', reason: 'bad-credentials', message: 'Sign-in failed. Check your details and try again.' };
    const key = `${b.tenant}/${subject}`;
    if (this.throttled(key) || this.tooManyStarts(key)) { this.audit({ tenant: b.tenant, subject, outcome: 'throttled' }); return { outcome: 'deny', reason: 'bad-credentials', message: 'Sign-in failed. Check your details and try again.' }; }
    const a = analyzeChain(cfg, chain);
    const steps = chain.steps.map((id) => { const m = cfg.methods.find((x) => x.id === id)!; return { id: m.id, type: m.type, name: m.name, level: m.level, config: m.config, real: methodType(m.type)!.verification(m.config).real }; });
    const s: Session = { id: randomBytes(24).toString('base64url'), tenant: b.tenant, subject, known: await this.known(b.tenant, subject), exp: this.now() + SESSION_MS, index: 0, chain: { id: chain.id, name: chain.name, level: a.effectiveLevel }, steps, declared: a.declaredLevel, done: [], tries: 0 };
    this.sessions.set(s.id, s);
    await this.prepare(s);
    const first = steps[0], t = methodType(first.type)!;
    if (b.answers && Object.keys(b.answers).length && t.inlineWithUsername(first.config)) return this.check(s, b.answers);
    return this.challenge(s);
  }
  private async answer(b: GateRequest): Promise<GateResponse> {
    const s = this.sessions.get(String(b.session));
    if (!s || s.tenant !== b.tenant || s.exp < this.now()) { if (s) this.sessions.delete(s.id); return { outcome: 'deny', reason: 'session-expired', message: 'Your sign-in session expired. Start again.' }; }
    if (!b.answers || typeof b.answers !== 'object') return { outcome: 'deny', reason: 'bad-credentials', message: 'Sign-in failed. Check your details and try again.' };
    return this.check(s, b.answers);
  }
  private async prepare(s: Session) {
    const st = s.steps[s.index], t = methodType(st.type)!;
    s.prepared = await t.prepare!(this.ctx(s, st)); s.tries = 0;
  }
  private challenge(s: Session, error?: string): GateResponse {
    const st = s.steps[s.index];
    return { outcome: 'challenge', session: s.id, step: { index: s.index, total: s.steps.length, methodId: st.id, type: st.type, ...s.prepared!.prompt }, ...(error ? { error } : {}) };
  }
  private async check(s: Session, answers: Record<string, string>): Promise<GateResponse> {
    const st = s.steps[s.index], t = methodType(st.type)!, key = `${s.tenant}/${s.subject}`;
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(answers)) if (typeof v === 'string' && v.length <= 256 && /^[a-z0-9]{1,12}$/.test(k)) clean[k] = v;
    let ok = false;
    try {
      if (t.interact) {
        const r = await t.interact(this.ctx(s, st), s.prepared!.state, clean);
        if (!r.done) { s.prepared = { prompt: r.prompt, state: r.state }; return this.challenge(s); }   // a button press: no attempt used yet
        ok = r.ok;
      } else ok = await t.verify!(this.ctx(s, st), s.prepared!.state, clean);
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
    };
    this.audit({ tenant: s.tenant, subject: s.subject, chain: s.chain.id, outcome: 'allow', mfa: claims.auth_mfa, level: claims.auth_level });
    return { outcome: 'allow', subject: s.subject, chain: s.chain.id, claims };
  }
}
export { EMPTY_CONFIG };
