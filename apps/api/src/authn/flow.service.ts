import { seedAuthnV1 } from '../migrations/v0001/authn-seed.js';
import { randomBytes } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { PluginRegistry, PluginImpl } from '../plugins/v1/registry.js';
import { validateSettings } from '../plugins/v1/settings.js';
import type { AuthenticateResult } from '../plugins/v1/hooks.js';
import { UsersService } from '../users/users.service.js';
import { currentBranch, workspaceMode } from '../workspace/context.js';
import { AuthnConfig, ChainAnalysis, CORE_SETTINGS_ID, EMPTY_CONFIG, SEED_CONFIG, isEmptyConfig, analyzeChain, parseStored, validateConfig } from './config.js';
import { SESSION_SETTINGS_ID, SessionConfig, parseSession, sessionClaims, validateSession } from './session-config.js';
import { branchName } from '../versioning/guards.js';
import { EnrollmentStore } from './enroll-store.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { appRequirement, chainOptions, checkAssurance, eligibleChains, type ChainOption, type StepUpVerdict } from './step-up.js';
import { SECURITY_SETTINGS_ID, SecurityConfig, parseSecurity, storedSecurity, validateSecurity } from '../accounts/security-config.js';
import { BlockStore } from '../accounts/block-store.js';
import { inForce, lockoutVerdict, refusalMessage, shownBlock } from '../accounts/blocks.js';
import { ExternalIdentity, ExternalProfile, ExternalStart, ProviderRefusal, buildAuthorizeUrl, callbackUrl as externalCallbackUrl, checkStart, exchangeOidc, exchangeUserinfo, externalRefusalMessage, mint, mintPkceVerifier, pkceChallenge } from './federation.js';
import { DemoOutbox, Prompt, methodType, methodTypes } from './methods.js';

/** The console-facing mask for a stored secret; the same sentinel the plugin settings form uses (settings.ts). */
const SECRET_MASK = '********';

/** Per-method budget of the console's in-process verification call: generous for a config-pure handler (they
 * are synchronous lookups), small enough that a stalled third-party handler cannot push the console GET past
 * the edge proxy timeout (all methods race in parallel, so the worst added latency is one budget). */
const VERDICT_BUDGET_MS = 1000;
function verdictBounded<R>(p: Promise<R>): Promise<R> {
  let timer: ReturnType<typeof setTimeout>;
  const bounded = new Promise<R>((_, reject) => { timer = setTimeout(() => reject(new Error('verification timed out')), VERDICT_BUDGET_MS); });
  return Promise.race([p.finally(() => clearTimeout(timer)), bounded]);
}
const methodPluginId = (type: string) => methodType(type)?.pluginId;
import { renderMailOrLegacy } from '../plugins/v1/mail-catalogue.js';

export interface GateRequest { tenant: string; subject?: string; session?: string; chain?: string; branch?: string; answers?: Record<string, string>; origin?: string;
  /** Federated sign-in (docs/sso-federation.md): start the provider round-trip of the running session's current step. */
  externalStart?: boolean;
  /** The provider (or DEMO chooser) callback parameters. */
  externalCallback?: Record<string, string>;
  /** The authorize params the core captured (the fixed provider callback URL cannot carry them; re-validated by the core on resume). */
  authorize?: Record<string, string> }
export type GateResponse =
  | { outcome: 'allow'; subject: string; claims: Record<string, unknown>; chain: string; resume?: Record<string, string> }
  | { outcome: 'deny'; reason: string; message: string }
  | { outcome: 'challenge'; session: string; step: { index: number; total: number; methodId: string; type: string } & Prompt; error?: string; resume?: Record<string, string> }
  /** Start the provider round-trip in the browser (the core 302s to the url). */
  | { outcome: 'external-redirect'; url: string }
  /** SIMULATED provider: the core renders the marked DEMO chooser from these fictional identities. */
  | { outcome: 'external-sim'; title: string; identities: ExternalIdentity[]; state: string }
  /** Self-service linking finished: the provider identity is recorded on the member's account (the core 302s to returnTo). */
  | { outcome: 'external-linked'; returnTo?: string };

interface Session {
  id: string; tenant: string; subject: string; known: boolean; exp: number; index: number;
  /** Data branch under test (docs/branch-test.md): the whole attempt, its config and its directory lookups stay on it. */
  branch?: string;
  /** Origin (scheme://host) of the sign-in page, passed by the core: passkey ceremonies are bound to it. */
  origin?: string;
  chain: { id: string; name: string; level: number };
  steps: { id: string; type: string; name: string; level: number; config: Record<string, unknown>; real: boolean }[];
  declared: number;
  done: { id: string; type: string; real: boolean }[];
  prepared?: { prompt: Prompt; state: Record<string, any> };
  tries: number;
  /** The authorize params captured by the core at the external start (returned as `resume` after the callback). */
  authorize?: Record<string, string>;
  /** The running external round-trip: state/nonce/verifier live HERE, never in the browser beyond the state itself. */
  pendingExternal?: { instanceId: string; mode: 'oidc' | 'oauth2-userinfo' | 'simulated'; state: string; nonce: string; verifier?: string; start: ExternalStart };
}
const SESSION_MS = 5 * 60_000, MAX_TRIES = 3, THROTTLE_N = 10, THROTTLE_MS = 10 * 60_000;

/**
 * Orchestrates authentication chains ("the core runs the chain"). The Rust core only draws the pages and asks this service, step by step.
 * Rules: the LIVE configuration is the one on Dolt main (an unapplied working branch never changes sign-in); a session keeps the chain it started with;
 * a wrong answer at the first step ends the attempt with a generic denial; later steps allow up to 3 tries; unknown accounts get the same prompts and always fail;
 * a technical failure of a method throws (the gate answers 503 and the core refuses the sign-in: fail closed).
 */
/** Published FICTIONAL demo credentials for demo-alice (opt-in demo seed only). */
export { DEMO_TOTP_SECRET, DEMO_PIN, DEMO_PIN8 } from '../migrations/v0001/authn-seed.js';

@Injectable()
export class AuthnService implements OnApplicationBootstrap {
  readonly enroll = new EnrollmentStore();
  /** Account blocks (suspended, disabled, locked, waiting for approval or verification): checked by the core of the chain, never by a plugin. */
  readonly blocks = new BlockStore();
  private lockFails = new Map<string, number[]>();
  readonly outbox = new DemoOutbox();
  private sessions = new Map<string, Session>();
  private fails = new Map<string, number[]>();
  now = () => Date.now();
  constructor(@Inject(PluginRegistry) private readonly reg: PluginRegistry, @Optional() private readonly branches?: BranchRegistries, @Optional() private readonly users?: UsersService) {
    AdminGuard.assurance = (tenant, claims) => this.adminAssurance(tenant, claims);
  }

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
    if (process.env.IAM_DATA_MIGRATIONS === '1') return;
    if (process.env.IAM_AUTHN_DEMO_SEED !== '1') return;
    const tenant = process.env.IAM_AUTHN_DEMO_SEED_TENANT || 'acme-demo';
    try { await this.seedDemo(tenant); } catch (e) { console.warn('authn demo seed skipped:', (e as Error).message); }
  }
  async seedDemo(tenant: string): Promise<boolean> {
    return seedAuthnV1(tenant, this.reg, this.enroll, this.branches);
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
  /** Account security settings (lockout, administration level): versioned like the session settings. Sign-in reads them on main, or on the tested branch. */
  async signinSecurity(tenant: string, branch?: string): Promise<SecurityConfig> { return parseSecurity(await (await this.signinRegistry(branch)).coreSettings(tenant, SECURITY_SETTINGS_ID)); }
  async liveSecurity(tenant: string): Promise<SecurityConfig> { return parseSecurity(await (await this.registry('live')).coreSettings(tenant, SECURITY_SETTINGS_ID)); }
  async workingSecurity(tenant: string): Promise<SecurityConfig> { return parseSecurity(await (await this.registry('work')).coreSettings(tenant, SECURITY_SETTINGS_ID)); }
  /** Chains the person can complete to reach `minLevel` (never a weaker one, never simulated, only what they have set up). */
  async stepUpOptions(tenant: string, subject: string, minLevel: number): Promise<ChainOption[]> {
    const cfg = await this.liveConfig(tenant);
    const analysis = Object.fromEntries(cfg.chains.map((c) => { const a = analyzeChain(cfg, c); return [c.id, { effectiveLevel: a.effectiveLevel, simulatedSteps: a.simulatedSteps }]; }));
    return eligibleChains(chainOptions(cfg, analysis, await this.enroll.status(tenant, subject) as never), minLevel);
  }
  /** The rule for administration pages: the level (and optional freshness) of the sign-in behind the session. Off at 0. */
  async adminAssurance(tenant: string, claims: { auth_level?: unknown; auth_time?: unknown } | undefined): Promise<StepUpVerdict> {
    const sec = await this.liveSecurity(tenant);
    if (sec.adminMinLevel <= 0) return { ok: true };
    const level = typeof claims?.auth_level === 'number' ? claims.auth_level : 0;
    const authTime = typeof claims?.auth_time === 'number' ? claims.auth_time * 1000 : 0;
    const v = checkAssurance({ level, authTime }, { minLevel: sec.adminMinLevel, ...(sec.adminMaxAgeSeconds ? { maxAgeMs: sec.adminMaxAgeSeconds * 1000 } : {}) }, this.now());
    if (v.ok) return v;
    // Safety net for a settings change that arrived without passing saveSecurity (a merged branch, a workflow): when no enabled chain without a
    // simulated step reaches the level, nobody could ever satisfy it, so the rule is not applied and the administrators are not locked out.
    if (!(await this.levelReachable(tenant, sec.adminMinLevel))) { console.warn(`[security] administration level ${sec.adminMinLevel} is not reachable by any sign-in chain; the rule is not applied`); return { ok: true }; }
    return v;
  }
  /** Whether at least one enabled chain, without a simulated step, declares and proves this level (configuration only, not who is enrolled). */
  async levelReachable(tenant: string, minLevel: number): Promise<boolean> {
    const cfg = await this.liveConfig(tenant);
    return cfg.chains.some((c) => { const a = analyzeChain(cfg, c); return c.steps.every((id) => cfg.methods.find((m) => m.id === id)?.enabled) && !a.simulatedSteps.length && a.effectiveLevel >= minLevel; });
  }
  /** The level rule of one application against this session. Applications without a rule always pass. The answer names the chains the person can use to step up. */
  async appAssurance(tenant: string, appId: string, subject: string, claims: { auth_level?: unknown; auth_time?: unknown } | undefined): Promise<{ ok: true } | (Extract<StepUpVerdict, { ok: false }> & { app: string; chains: { id: string; name: string; level: number }[] })> {
    const req = appRequirement((await this.liveSecurity(tenant)).appLevels, appId);
    if (!req) return { ok: true };
    const v = checkAssurance({ level: typeof claims?.auth_level === 'number' ? claims.auth_level : 0, authTime: typeof claims?.auth_time === 'number' ? claims.auth_time * 1000 : 0 }, req, this.now());
    if (v.ok) return v;
    return { ...v, app: appId, chains: (await this.stepUpOptions(tenant, subject, req.minLevel)).map((c) => ({ id: c.id, name: c.name, level: c.effectiveLevel })) };
  }
  /**
   * Saving security settings. Raising the administration level is refused when the person saving does not hold that level themselves right now,
   * or when no enabled chain without a simulated step reaches it: the change can never be the one that locks the administrators out.
   */
  async saveSecurity(tenant: string, input: unknown, actor?: { sub: string; level: number }): Promise<SecurityConfig> {
    const cfg = validateSecurity(input);
    const before = await this.workingSecurity(tenant);
    if (cfg.adminMinLevel > before.adminMinLevel) {
      if (!actor || actor.level < cfg.adminMinLevel) throw new BadRequestException({ code: 'would-lock-out-the-applier', message: `Level ${cfg.adminMinLevel} is above your current sign-in (${actor?.level ?? 0}). Sign in with a stronger method first, so this change cannot lock you out.` });
      if (!(await this.stepUpOptions(tenant, actor.sub, cfg.adminMinLevel)).length) throw new BadRequestException({ code: 'no-chain-reaches-level', message: `No enabled sign-in chain without a simulated step reaches level ${cfg.adminMinLevel} for you.` });
    }
    await (await this.registry('work', true)).putCoreSettings(tenant, SECURITY_SETTINGS_ID, storedSecurity(cfg));
    return cfg;
  }
  async liveConfig(tenant: string): Promise<AuthnConfig> { return parseStored(await (await this.registry('live')).coreSettings(tenant, CORE_SETTINGS_ID)); }
  async workingConfig(tenant: string): Promise<AuthnConfig> { return parseStored(await (await this.registry('work')).coreSettings(tenant, CORE_SETTINGS_ID)); }
  async saveConfig(tenant: string, input: unknown): Promise<AuthnConfig> {
    const cfg = validateConfig(input);
    const reg = await this.registry('work', true);
    // An INSTANCE-scoped secret setting (the generic OIDC provider's clientSecret) never lands in the versioned
    // config: it goes to the plugin secret store under `<instanceId>.<key>`. The intent is read from the RAW input
    // (validateSettings rewrites an empty string to the default): a re-sent mask or an absent key keeps the
    // stored value, an empty string clears it. validateConfig already stripped plugin-scoped settings.
    const rawMethods = (input && typeof input === 'object' && Array.isArray((input as { methods?: unknown }).methods) ? (input as { methods: Record<string, any>[] }).methods : []);
    for (const m of cfg.methods) {
      const t = methodType(m.type), pluginId = methodPluginId(m.type);
      if (!t || !pluginId || t.settingsScope === 'plugin') continue; // plugin-scoped: settings were stripped, never stored per instance
      const raw = rawMethods.find((x) => x && x.id === m.id && x.config && typeof x.config === 'object')?.config as Record<string, unknown> | undefined;
      for (const f of t.settings.filter((x) => x.type === 'secret')) {
        delete m.config[f.key];
        const v = raw?.[f.key];
        if (v === undefined || v === SECRET_MASK) continue; // untouched: keep the stored secret
        await reg.writeSecret(tenant, pluginId, `${m.id}.${f.key}`, typeof v === 'string' ? v : '');
      }
    }
    await reg.putCoreSettings(tenant, CORE_SETTINGS_ID, cfg as unknown as Record<string, unknown>);
    return cfg;
  }

  /** The config as the console may read it: instance-scoped secrets masked (the real values never leave the
   * secret store). The console re-sends the mask unchanged; saveConfig keeps the stored secret for it. */
  async consoleConfig(tenant: string): Promise<AuthnConfig> {
    const cfg = await this.workingConfig(tenant);
    const reg = await this.registry('work');
    // Parallel: the console GET cannot afford a serial round-trip per instance (cold secret store + edge timeout).
    await Promise.all(cfg.methods.map(async (m) => {
      const t = methodType(m.type), pluginId = methodPluginId(m.type);
      if (!t || !pluginId || t.settingsScope === 'plugin') return;
      await Promise.all(t.settings.filter((x) => x.type === 'secret').map(async (f) => {
        if (m.config[f.key] !== undefined) return;
        if (await reg.readSecret(tenant, pluginId, `${m.id}.${f.key}`)) m.config[f.key] = SECRET_MASK;
      }));
    }));
    return cfg;
  }

  /** The runtime config of a method instance: the versioned values plus its instance-scoped secrets from the
   * secret store. Plugin-scoped settings are NOT here - the serving plugin's own store holds them (c.settings). */
  private async instanceConfig(reg: PluginRegistry, tenant: string, m: { id: string; type: string; config: Record<string, any> }): Promise<Record<string, any>> {
    const t = methodType(m.type), pluginId = methodPluginId(m.type);
    const out = { ...m.config };
    if (!t || !pluginId || t.settingsScope === 'plugin') return out; // plugin-scoped settings live in the serving plugin's store (c.settings)
    for (const f of t.settings.filter((x) => x.type === 'secret')) {
      if (out[f.key] !== undefined) continue;
      const v = await reg.readSecret(tenant, pluginId, `${m.id}.${f.key}`);
      if (v) out[f.key] = v;
    }
    return out;
  }

  /** The client secret of a federated method for the provider exchange: the serving plugin's settings for a
   * plugin-scoped method (the named providers), the instance's secret store entry otherwise (generic OIDC). */
  private async externalSecret(reg: PluginRegistry, tenant: string, m: { id: string; type: string; config: Record<string, any> }): Promise<string> {
    const serving = this.provider(reg, tenant, m.type);
    if (serving && this.methodDeclaration(reg, serving)?.manifest.authMethod?.settingsScope === 'plugin') {
      const v = (await reg.settingsFor(tenant, serving.manifest.id))?.clientSecret;
      return typeof v === 'string' ? v : '';
    }
    const v = (await this.instanceConfig(reg, tenant, m)).clientSecret;
    return typeof v === 'string' ? v : '';
  }

  analyses(cfg: AuthnConfig): ChainAnalysis[] { return cfg.chains.map((c) => analyzeChain(cfg, c)); }

  /** Registry-aware analyses: the real/simulated verdict of each method with the serving plugin's settings (and
   * the instance's secrets) merged in, so a plugin-scoped method is not misread as simulated from its empty
   * instance config. The verification handlers are config-pure by contract (config + serving settings only, no
   * I/O), so they answer IN-PROCESS with the same context the bus delivery would inject: no per-method bus
   * round-trips - a fan-out of those overruns the edge proxy timeout on a throttled hosted deployment. */
  async analysesReg(tenant: string, cfg: AuthnConfig, ref: 'live' | 'work' = 'work'): Promise<ChainAnalysis[]> {
    const reg = await this.registry(ref);
    const servings = new Map(cfg.methods.map((m) => [m.id, this.provider(reg, tenant, m.type)] as const));
    const pluginIds = [...new Set([...servings.values()].filter((p): p is PluginImpl => !!p).map((p) => p.manifest.id))];
    const settings = new Map(await Promise.all(pluginIds.map(async (id) => {
      const impl = reg.impl(id);
      return [id, impl ? validateSettings(impl.manifest.settings ?? [], (await reg.settingsFor(tenant, id)) ?? {}).values : {}] as const;
    })));
    const verdicts = new Map(await Promise.all(cfg.methods.map(async (m) => {
      const serving = servings.get(m.id);
      if (!serving) return [m.id, { real: false, note: 'Method unavailable (its plugin is disabled).' }] as const;
      // Same fail-closed rule as the bus delivery: a faulted replacement refuses every call until an admin acts.
      if (serving.manifest.extends && reg.isFaulted(tenant, serving.manifest.id)) return [m.id, { real: false, note: 'Method unavailable (its plugin failed).' }] as const;
      let impl: PluginImpl | undefined = serving;
      while (impl && !impl.handlers['auth.verification'] && impl.manifest.extends) impl = reg.impl(impl.manifest.extends);
      const h = impl?.handlers['auth.verification'] as ((p: { config: Record<string, unknown> }, c: { tenant: string; settings: Record<string, unknown> }) => { real: boolean; note: string }) | undefined;
      if (!impl || !h) return [m.id, { real: false, note: 'Method unavailable (its plugin declares no verification).' }] as const;
      const decl = this.methodDeclaration(reg, serving);
      const config = decl?.manifest.authMethod?.settingsScope === 'plugin' ? m.config : await this.instanceConfig(reg, tenant, m);
      try {
        // Bounded even though the handlers are config-pure by contract: a third-party handler that answers late
        // or never degrades to the same fail-closed verdict instead of stalling the console GET. (A handler that
        // blocks the event loop synchronously stalls any request path, bus or not: no path protects against that.)
        const v = await verdictBounded(Promise.resolve(h({ config: config as Record<string, unknown> }, { tenant, settings: settings.get(serving.manifest.id) ?? {} })));
        return [m.id, { real: v?.real === true, note: typeof v?.note === 'string' ? v.note : 'Method unavailable (its plugin failed).' }] as const;
      } catch { return [m.id, { real: false, note: 'Method unavailable (its plugin failed).' }] as const; }
    })));
    return cfg.chains.map((c) => analyzeChain(cfg, c, (m) => verdicts.get(m.id)));
  }

  /** Passkey self-enrollment, step 1: the creation options of the auth.enroll hook of the method plugin on the
   * slot (the plugin owns the attestation logic; this service only orchestrates). The pending challenge is stored
   * for a few minutes, spent at most once, and bound to the origin it was minted for. */
  async webauthnEnrollOptions(tenant: string, subject: string, inst: string, config: Record<string, unknown>, origin: string) {
    const reg = await this.registry('live');
    const existing = (await this.enroll.webauthnRecord(tenant, subject, inst))?.credentials ?? [];
    const r = (await reg.callSlot<{ ok: boolean; reason?: string; options?: Record<string, unknown>; challenge?: string; origin?: string; rpId?: string }>(tenant, 'auth.webauthn', 'auth.enroll',
      { mode: 'options', tenant, subject, config, origin, now: this.now(), existing: existing.map(({ id, transports }) => ({ id, transports })) })).result;
    if (!r.ok || !r.options || !r.challenge || !r.origin || !r.rpId) return { ok: false as const, reason: r.reason ?? 'the method plugin refused the enrollment' };
    const pending = { challenge: r.challenge, origin: r.origin, rpId: r.rpId, exp: this.now() + 5 * 60_000 };
    await this.enroll.setWebAuthnPending(tenant, subject, inst, pending);
    return { ok: true as const, options: r.options };
  }
  /** Passkey self-enrollment, step 2: the attestation check against the pending challenge. */
  async webauthnEnrollVerify(tenant: string, subject: string, inst: string, config: Record<string, unknown>, credential: Record<string, unknown>, name?: string) {
    const pending = await this.enroll.webAuthnPending(tenant, subject, inst);
    if (!pending || this.now() > pending.exp) return { ok: false as const, reason: 'the enrollment session expired: start again' };
    await this.enroll.clearWebAuthnPending(tenant, subject, inst);   // one pending challenge, one attempt
    const reg = await this.registry('live');
    const r = (await reg.callSlot<{ ok: boolean; reason?: string; record?: { id: string; publicKey: string; counter: number; transports?: string[]; aaguid?: string; deviceType?: string; backedUp?: boolean } }>(tenant, 'auth.webauthn', 'auth.enroll',
      { mode: 'verify', tenant, subject, config, challenge: pending.challenge, origin: pending.origin, rpId: pending.rpId, credential, now: this.now() })).result;
    if (!r.ok || !r.record) return { ok: false as const, reason: r.reason ?? 'the authenticator answer was refused' };
    const cred = { ...r.record, ...(name ? { name: name.slice(0, 60) } : {}), createdAt: new Date().toISOString() };
    if (!(await this.enroll.addWebAuthnCredential(tenant, subject, inst, cred))) return { ok: false as const, reason: 'this credential id is already enrolled with a different key' };
    return { ok: true as const, enrolled: { id: cred.id, name: cred.name ?? null } };
  }
  catalogue() { return methodTypes().map((t) => ({ id: t.id, name: t.name, description: t.description, factor: t.factor, maturity: t.maturity, suggestedLevel: t.suggestedLevel, provisioning: t.provisioning, instances: t.instances, settings: t.settings, ...(t.settingsScope ? { settingsScope: t.settingsScope } : {}), simulatedByDefault: !t.verification(Object.fromEntries(t.settings.map((s) => [s.key, s.default]))).real && t.maturity === 'implemented' })); }

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
   * (the working base, or the enabled replacement) - and only when it really is a method. The replacement of a
   * WORKING method (password lockout, advanced password policy) declares no `authMethod` of its own: it IS the
   * same method as its base, so the base's declaration is enough and enabling it must be transparent - no
   * method retired, no chain dropped, no reconfiguration. The REFUSING base of a slot without an enabled
   * method (auth-totp-base and friends) declares none and extends nothing: NOT a provider. */
  private provider(reg: PluginRegistry, tenant: string, type: string) {
    try {
      const p = reg.resolve(tenant, `auth.${type}`);
      if (!reg.isActive(tenant, p.manifest.id)) return undefined;
      if (p.manifest.authMethod) return p;
      const base = p.manifest.extends ? reg.impl(p.manifest.extends) : undefined;
      return base?.manifest.authMethod ? p : undefined;
    } catch { return undefined; }
  }

  /** The plugin that DECLARES a served method (walks `extends` to the authMethod declaration): its
   * `settingsScope` tells whether the Authentication drawer edits per-instance config (default, the TOTP
   * pattern: handed to the hooks in the payload) or the serving plugin's own settings store (the password
   * pattern: the slot-wide policy the hooks read as c.settings). */
  private methodDeclaration(reg: PluginRegistry, serving: PluginImpl): PluginImpl | undefined {
    let cur: PluginImpl | undefined = serving;
    while (cur && !cur.manifest.authMethod && cur.manifest.extends) cur = reg.impl(cur.manifest.extends);
    return cur?.manifest.authMethod ? cur : undefined;
  }

  /** The Authentication drawer's plugin-scoped forms: for each method instance served by a plugin whose method
   * declaration says `settingsScope: 'plugin'`, the schema and current values of the SERVING plugin (the enabled
   * replacement when there is one - its richer policy is what the administrator must see and edit), read from the
   * same settings store the sign-in hooks consume. Instance-scoped methods are absent from this map. */
  async servingSettings(tenant: string, cfg: AuthnConfig, ref: 'live' | 'work' = 'work') {
    const reg = await this.registry(ref);
    const out: Record<string, { plugin: string; settings: import('../plugins/v1/manifest.js').SettingField[]; values: Record<string, unknown> }> = {};
    for (const m of cfg.methods) {
      const serving = this.provider(reg, tenant, m.type);
      if (!serving) continue;
      const decl = this.methodDeclaration(reg, serving);
      if (decl?.manifest.authMethod?.settingsScope !== 'plugin') continue;
      // Mask secret values: the drawer needs to know one is set, never the value itself. The mask is a
      // sentinel saveServingSettings drops (see SECRET_MASK).
      const values = { ...((await reg.settingsFor(tenant, serving.manifest.id)) ?? {}) };
      for (const f of (serving.manifest.settings ?? []).filter((x) => x.type === 'secret')) if (values[f.key]) values[f.key] = SECRET_MASK;
      out[m.id] = { plugin: serving.manifest.id, settings: serving.manifest.settings ?? [], values };
    }
    return out;
  }

  /** Saving a plugin-scoped method form writes the SERVING plugin's settings store (audited, manifest-validated,
   * secrets split out by configure): what sign-in applies immediately after Apply. Never the instance config. */
  async saveServingSettings(tenant: string, methodId: string, values: Record<string, unknown>) {
    const cfg = await this.workingConfig(tenant);
    const m = cfg.methods.find((x) => x.id === methodId);
    if (!m) throw new NotFoundException('unknown method instance');
    const reg = await this.registry('work', true);
    const serving = this.provider(reg, tenant, m.type);
    if (!serving || this.methodDeclaration(reg, serving)?.manifest.authMethod?.settingsScope !== 'plugin') throw new BadRequestException(`method ${methodId} has no plugin-scoped form`);
    // A secret field still holding the mask means "unchanged": drop it so configure keeps the stored value.
    const schema = serving.manifest.settings ?? [];
    const out: Record<string, unknown> = { ...values };
    for (const f of schema.filter((x) => x.type === 'secret')) if (out[f.key] === SECRET_MASK) delete out[f.key];
    await reg.configure(tenant, serving.manifest.id, out);
    return { configured: serving.manifest.id };
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
    if (st.type === 'webauthn') { const w = await this.enroll.webauthnRecord(tenant, subject, st.id); return w ? { webauthn: w } : {}; }
    return {};
  }
  private async notifyCapability(reg: PluginRegistry, tenant: string) {
    // Delivery of one-time codes goes through the notify.default slot (P1-E): the plugin chosen on the slot
    // sends (durable emission); its notify.capability answer says whether delivery is real or simulated.
    try { return await (await reg.callSlot<{ real: boolean; note?: string }>(tenant, 'notify.default', 'notify.capability', {})).result; }
    catch (e) { console.error('[authn] notify capability lookup failed:', (e as Error).message); return undefined; } // the plugin then takes the simulated path
  }
  /** Change date of the current directory password, when the credential history knows it (password expiry policies). */
  private async passwordChangedAt(tenant: string, subject: string) {
    if (!this.users) return undefined;
    try { return await this.users.passwordChangedAt(tenant, subject); } catch { return undefined; }
  }
  private async methodPayload(reg: PluginRegistry, s: Session, st: Session['steps'][number], state: Record<string, any>, answers?: Record<string, string>) {
    const passwordChangedAt = st.type === 'password' ? await this.passwordChangedAt(s.tenant, s.subject) : undefined;
    return {
      tenant: s.tenant, subject: s.subject, known: s.known, instanceId: st.id, config: await this.instanceConfig(reg, s.tenant, st),
      state, answers, now: this.now(), ...(s.origin ? { origin: s.origin } : {}),
      enrollment: await this.enrollment(s.tenant, s.subject, st),
      ...(st.type === 'email-otp' ? { profileEmail: await this.profileEmail(s.subject, s.branch), notifyCapability: await this.notifyCapability(reg, s.tenant) } : {}),
      ...(passwordChangedAt ? { passwordChangedAt } : {}),
      ...(st.type === 'password' && answers ? { passwordOutcome: (await reg.callSlot<AuthenticateResult>(s.tenant, 'auth.password', 'auth.authenticate', { tenant: s.tenant, subject: s.subject, credential: { password: answers.password ?? '' }, ...(passwordChangedAt ? { passwordChangedAt } : {}) })).result.outcome } : {}),
    };
  }
  private audit(e: Record<string, unknown>) { console.log('[authn]', JSON.stringify(e)); }
  private throttled(key: string) { const t = (this.fails.get(key) ?? []).filter((x) => x > this.now() - THROTTLE_MS); this.fails.set(key, t); return t.length >= THROTTLE_N; }
  private starts = new Map<string, number[]>();
  /** At most 30 sign-in starts per account per 10 minutes: bounds e-mail code floods. */
  private tooManyStarts(key: string) { const t = (this.starts.get(key) ?? []).filter((x) => x > this.now() - THROTTLE_MS); t.push(this.now()); this.starts.set(key, t); return t.length > 30; }
  private fail(key: string) { (this.fails.get(key) ?? this.fails.set(key, []).get(key)!).push(this.now()); }
  private sweep() { const n = this.now(); for (const [k, s] of this.sessions) if (s.exp < n) this.sessions.delete(k); while (this.sessions.size > 2000) this.sessions.delete(this.sessions.keys().next().value as string); for (const [k, l] of this.pendingLinks) if (l.exp < n) this.pendingLinks.delete(k); while (this.pendingLinks.size > 1000) this.pendingLinks.delete(this.pendingLinks.keys().next().value as string); }

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
  async entry(tenant: string, chainId?: string, branch?: string): Promise<{ mode: 'legacy' } | { mode: 'error'; message: string } | { mode: 'choice'; chains: Awaited<ReturnType<AuthnService['options']>>['chains'] } | { mode: 'chain'; chain: { id: string; name: string }; fields: Prompt['fields']; session?: string; noSubject?: boolean; title?: string; message?: string }> {
    const reg = await this.signinRegistry(branch);
    const cfg = await this.signinConfig(tenant, branch), list = await this.offered(cfg, reg, tenant);
    if (!list.length) return { mode: 'legacy' };
    const chain = typeof chainId === 'string' && chainId ? list.find((c) => c.id === chainId) : undefined;
    if (!chain) return { mode: 'choice', chains: (await this.options(tenant, branch)).chains };
    const m = cfg.methods.find((x) => x.id === chain.steps[0])!, t = methodType(m.type)!;
    // A chain OPENING on a federation step starts without a username (the classic "Sign in with <provider>"
    // button): the session is subject-less until the callback resolves the account through the explicit link
    // (docs/sso-federation.md). The link step renders on the first page, its session created here.
    if (t.factor === 'other') {
      const key = `${tenant}/${branch ?? 'live'}//external-entry`;
      if (this.tooManyStarts(key)) { this.audit({ tenant, outcome: 'throttled' }); return { mode: 'error', message: 'Too many attempts. Try again later.' }; }
      const a = analyzeChain(cfg, chain);
      const steps = await Promise.all(chain.steps.map(async (id) => { const sm = cfg.methods.find((x) => x.id === id)!; return { id: sm.id, type: sm.type, name: sm.name, level: sm.level, config: sm.config, real: (await this.verification(reg, tenant, sm)).real }; }));
      const s: Session = { id: randomBytes(24).toString('base64url'), tenant, subject: '', branch, known: false, exp: this.now() + SESSION_MS, index: 0, chain: { id: chain.id, name: chain.name, level: a.effectiveLevel }, steps, declared: a.declaredLevel, done: [], tries: 0 };
      this.sessions.set(s.id, s);
      await this.prepare(s);
      return { mode: 'chain', chain: { id: chain.id, name: chain.name }, fields: s.prepared!.prompt.fields, session: s.id, noSubject: true, title: s.prepared!.prompt.title, ...(s.prepared!.prompt.message ? { message: s.prepared!.prompt.message } : {}) };
    }
    if (!t.inlineWithUsername(m.config)) return { mode: 'chain', chain: { id: chain.id, name: chain.name }, fields: [] };
    const s = { tenant, subject: '', known: false, branch } as Session;
    const st = { id: m.id, type: m.type, name: m.name, level: m.level, config: m.config, real: true };
    const p = (await reg.callSlot<{ prompt: Prompt }>(tenant, `auth.${m.type}`, 'auth.prepare', await this.methodPayload(reg, s, st, {}))).result;
    return { mode: 'chain', chain: { id: chain.id, name: chain.name }, fields: p.prompt.fields };
  }

  /** Returns null when no chain is live: the caller then uses the single base-password path unchanged. */
  async authenticate(b: GateRequest): Promise<GateResponse | null> {
    this.sweep();
    if (b.externalStart) return this.startExternal(b);
    if (b.externalCallback) return this.completeExternal(b);
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
    const s: Session = { id: randomBytes(24).toString('base64url'), tenant: b.tenant, subject, branch: b.branch, origin: typeof b.origin === 'string' ? b.origin.slice(0, 200) : undefined, known: await this.known(b.tenant, subject, b.branch), exp: this.now() + SESSION_MS, index: 0, chain: { id: chain.id, name: chain.name, level: a.effectiveLevel }, steps, declared: a.declaredLevel, done: [], tries: 0 };
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

  /** The session a start/callback leg belongs to, with the same expiry and tenant rules as a form answer. */
  private externalSession(b: GateRequest): Session | GateResponse {
    const s = b.session ? this.sessions.get(String(b.session)) : undefined;
    if (!s || s.tenant !== b.tenant || s.exp < this.now()) { if (s) this.sessions.delete(s.id); return { outcome: 'deny', reason: 'session-expired', message: 'Your sign-in session expired. Start again.' }; }
    if (s.branch && typeof b.branch === 'string' && b.branch && b.branch !== s.branch) return { outcome: 'deny', reason: 'bad-credentials', message: 'Sign-in failed. Check your details and try again.' };
    return s;
  }

  /** Federated sign-in, leg 1 (docs/sso-federation.md): the plugin on the slot returns its provider's metadata as
   * DATA (auth.external.start); this service mints state/nonce/PKCE, keeps them server-side in the session, and
   * answers with the provider URL (the core 302s) or the DEMO chooser data of a SIMULATED provider. */
  private async startExternal(b: GateRequest): Promise<GateResponse> {
    const found = this.externalSession(b);
    if ('outcome' in found) return found;
    const s = found;
    const st = s.steps[s.index], t = methodType(st.type);
    if (!t || t.factor !== 'other') return { outcome: 'deny', reason: 'bad-credentials', message: 'Sign-in failed. Check your details and try again.' };   // the current step is not a federation step
    if (b.authorize && typeof b.authorize === 'object') {
      const keys = ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'branch', 'ticket'];
      s.authorize = Object.fromEntries(keys.map((k) => [k, b.authorize![k]]).filter(([, v]) => typeof v === 'string' && (v as string).length <= 512)) as Record<string, string>;
    }
    const reg = await this.signinRegistry(s.branch);
    const payload = await this.methodPayload(reg, s, st, s.prepared?.state ?? {});
    const start = checkStart((await reg.callSlot<ExternalStart>(s.tenant, `auth.${st.type}`, 'auth.external.start', { ...payload, callbackUrl: externalCallbackUrl() })).result);
    if (!start.ok) { this.audit({ tenant: s.tenant, subject: s.subject, chain: s.chain.id, step: s.index, method: st.id, outcome: 'external-refused', reason: start.reason }); return { outcome: 'deny', reason: 'external-unavailable', message: 'This sign-in method is not available. Try another one.' }; }
    const state = mint();
    if (start.mode === 'simulated') {
      s.pendingExternal = { instanceId: st.id, mode: 'simulated', state, nonce: '', start };
      this.audit({ tenant: s.tenant, subject: s.subject, chain: s.chain.id, step: s.index, method: st.id, outcome: 'external-start', mode: 'simulated' });
      return { outcome: 'external-sim', title: start.title!, identities: start.identities!, state };
    }
    const cbUrl = externalCallbackUrl();
    if (!cbUrl) throw new Error('IAM_EXTERNAL_CALLBACK_URL is not configured: a real external provider cannot be reached');   // technical misconfiguration: fail closed (503)
    const nonce = mint(), verifier = mintPkceVerifier();
    const url = buildAuthorizeUrl(start, cbUrl, { state, nonce, challenge: pkceChallenge(verifier) });
    s.pendingExternal = { instanceId: st.id, mode: start.mode!, state, nonce, verifier, start };
    this.audit({ tenant: s.tenant, subject: s.subject, chain: s.chain.id, step: s.index, method: st.id, outcome: 'external-start', mode: start.mode });
    return { outcome: 'external-redirect', url };
  }

  /** Federated sign-in, leg 2: the provider state resolves the session when the fixed callback URL could not
   * carry it; the token exchange runs HERE (openid-client for OIDC, a plain token+userinfo read for OAuth2-only
   * providers); the plugin decides ok/deny from the resolved profile and the EXPLICIT link only. */
  private async completeExternal(b: GateRequest): Promise<GateResponse> {
    const cb = b.externalCallback!;
    let s = b.session ? this.sessions.get(String(b.session)) : undefined;
    if (!s && typeof cb.state === 'string' && cb.state) s = [...this.sessions.values()].find((x) => x.pendingExternal?.state === cb.state);
    // Not a sign-in session: the state may belong to a self-service LINK round-trip (member profile page).
    if (!s && typeof cb.state === 'string' && cb.state) { const l = this.pendingLinks.get(cb.state); if (l && l.tenant === b.tenant) return this.completeExternalLink(l, cb); }
    if (!s || s.tenant !== b.tenant || s.exp < this.now()) { if (s) this.sessions.delete(s.id); return { outcome: 'deny', reason: 'session-expired', message: 'Your sign-in session expired. Start again.' }; }
    const deny = (message: string): GateResponse => ({ outcome: 'deny', reason: 'external-failed', message });
    const p = s.pendingExternal;
    if (!p || typeof cb.state !== 'string' || cb.state !== p.state) return deny('External sign-in failed. Try again.');
    const st = s.steps[s.index];
    if (st.id !== p.instanceId) return deny('External sign-in failed. Try again.');
    if (cb.error) { this.audit({ tenant: s.tenant, subject: s.subject, chain: s.chain.id, step: s.index, method: st.id, outcome: 'external-denied-by-provider', error: cb.error.slice(0, 80) }); return deny('The provider refused the sign-in. Try again.'); }
    let profile: ExternalProfile;
    const reg = await this.signinRegistry(s.branch);
    if (p.mode === 'simulated') {
      const id = p.start.identities!.find((x) => x.sub === cb.sim);
      if (!id) return deny('External sign-in failed. Try again.');
      profile = { sub: id.sub, ...(id.email ? { email: id.email, emailVerified: true } : {}), name: id.label };
    } else {
      const cbUrl = externalCallbackUrl();
      const secret = await this.externalSecret(reg, s.tenant, st);
      try {
        profile = p.mode === 'oidc' ? await exchangeOidc(p.start, secret, cbUrl, cb, p) : await exchangeUserinfo(p.start, secret, cbUrl, cb, p);
      } catch (e) {
        // A definitive provider refusal is an actionable denial, not a technical failure; anything else stays 503 (fail closed).
        const refusal = externalRefusalMessage(e);
        if (!refusal) throw e;
        this.audit({ tenant: s.tenant, subject: s.subject, chain: s.chain.id, step: s.index, method: st.id, outcome: 'external-exchange-refused', where: (e as ProviderRefusal).where, status: String((e as ProviderRefusal).status), ...((e as ProviderRefusal).providerReason ? { providerReason: (e as ProviderRefusal).providerReason } : {}) });
        return deny(refusal);
      }
    }
    const link = s.subject ? await this.enroll.externalLink(s.tenant, s.subject, st.id) : undefined;
    const linked = await this.enroll.findExternalLink(s.tenant, st.id, profile.sub);
    const verdict = (await reg.callSlot<{ ok: boolean; reason?: string; message?: string }>(s.tenant, `auth.${st.type}`, 'auth.external.verify',
      { ...await this.methodPayload(reg, s, st, s.prepared?.state ?? {}), intent: 'signin', external: profile, link: link ?? null, linkedSubject: linked?.user ?? null })).result;
    const key = `${s.tenant}/${s.branch ?? 'live'}/${s.subject}`;
    // The link is the ONLY way in (docs/sso-federation.md): no link for this provider subject, no sign-in,
    // whatever the plugin answered. A linked account that is not the session's account is refused too.
    if (!verdict?.ok || !linked || (s.subject && linked.user !== s.subject)) {
      this.fail(key); s.tries++; await this.recordFailure(s);
      this.audit({ tenant: s.tenant, subject: s.subject, chain: s.chain.id, step: s.index, method: st.id, outcome: 'step-failed', via: 'external' });
      const message = verdict?.ok ? 'No account is linked to this provider sign-in.' : (typeof verdict?.message === 'string' && verdict.message.length <= 160 ? verdict.message : 'External sign-in failed. Try again.');
      if (s.index === 0 || s.tries >= MAX_TRIES) { this.sessions.delete(s.id); return deny('Sign-in failed. Check your details and try again.'); }
      return deny(message);
    }
    if (!s.subject) { s.subject = linked.user; s.known = await this.known(s.tenant, linked.user, s.branch); }
    s.pendingExternal = undefined;
    const r = await this.advance(s);
    return { ...r, ...(s.authorize ? { resume: s.authorize } : {}) };
  }
  // ---- self-service linking (docs/sso-federation.md rules 1-2: a link is created from the member's OWN session,
  // through a provider round-trip with its own state/nonce/PKCE; the provider subject then identifies exactly one
  // account). The pending records live server-side, one-use, 5 minutes, swept with the sign-in sessions.
  private pendingLinks = new Map<string, { tenant: string; subject: string; instanceId: string; mode: 'oidc' | 'oauth2-userinfo' | 'simulated'; state: string; nonce: string; verifier?: string; start: ExternalStart; returnTo?: string; exp: number }>();

  /** Link leg 1 (member authenticated on the console): validates the instance, asks the plugin for its provider
   * metadata, and answers the provider URL (real) or the fictional identities (simulated). */
  async startExternalLink(tenant: string, subject: string, inst: string, returnTo?: string): Promise<{ mode: 'simulated'; title: string; identities: ExternalIdentity[]; state: string } | { mode: 'redirect'; url: string }> {
    this.sweep();
    const key = `${tenant}//${subject}/link`;
    if (this.tooManyStarts(key)) { this.audit({ tenant, subject, outcome: 'throttled' }); throw Object.assign(new Error('Too many attempts. Try again later.'), { code: 'throttled' }); }
    const cfg = await this.signinConfig(tenant);
    const m = cfg.methods.find((x) => x.id === inst && x.enabled);
    const t = m && methodType(m.type);
    if (!m || !t || t.factor !== 'other') throw Object.assign(new Error('unknown or disabled federation method instance'), { code: 'no-instance' });
    const reg = await this.signinRegistry(undefined);
    const payload = { tenant, subject, known: true, instanceId: m.id, config: m.config as Record<string, any>, state: {}, answers: undefined, now: this.now(), enrollment: {} };
    const start = checkStart((await reg.callSlot<ExternalStart>(tenant, `auth.${m.type}`, 'auth.external.start', { ...payload, callbackUrl: externalCallbackUrl() })).result);
    if (!start.ok) { this.audit({ tenant, subject, method: inst, outcome: 'external-link-refused', reason: start.reason }); throw Object.assign(new Error('This sign-in method is not available.'), { code: 'external-refused' }); }
    const state = mint();
    const rec = { tenant, subject, instanceId: inst, mode: start.mode!, state, nonce: '', start, ...(returnTo ? { returnTo } : {}), exp: this.now() + SESSION_MS };
    if (start.mode === 'simulated') {
      this.pendingLinks.set(state, rec);
      this.audit({ tenant, subject, method: inst, outcome: 'external-link-start', mode: 'simulated' });
      return { mode: 'simulated', title: start.title!, identities: start.identities!, state };
    }
    const cbUrl = externalCallbackUrl();
    if (!cbUrl) throw new Error('IAM_EXTERNAL_CALLBACK_URL is not configured: a real external provider cannot be reached');   // misconfiguration: fail closed
    const nonce = mint(), verifier = mintPkceVerifier();
    const url = buildAuthorizeUrl(start, cbUrl, { state, nonce, challenge: pkceChallenge(verifier) });
    this.pendingLinks.set(state, { ...rec, nonce, verifier });
    this.audit({ tenant, subject, method: inst, outcome: 'external-link-start', mode: start.mode });
    return { mode: 'redirect', url };
  }

  /** Simulated link leg 2 from the console chooser (the provider round-trip of a DEMO provider happens in-page). */
  async completeExternalLinkSimulated(tenant: string, subject: string, inst: string, state: string, sim: string): Promise<GateResponse> {
    const rec = this.pendingLinks.get(state);
    if (!rec || rec.tenant !== tenant || rec.subject !== subject || rec.instanceId !== inst || rec.mode !== 'simulated') throw Object.assign(new Error('unknown or expired link request'), { code: 'no-link-request' });
    return this.completeExternalLink(rec, { state, sim });
  }

  /** Link leg 2: the exchange runs, the PLUGIN judges the profile (its own policy: hosted domain, app check...),
   * then the link is recorded - one provider subject per account, a clash refuses and keeps the existing link. */
  private async completeExternalLink(rec: { tenant: string; subject: string; instanceId: string; mode: 'oidc' | 'oauth2-userinfo' | 'simulated'; state: string; nonce: string; verifier?: string; start: ExternalStart; returnTo?: string; exp: number }, cb: Record<string, string>): Promise<GateResponse> {
    const deny = (message: string): GateResponse => ({ outcome: 'deny', reason: 'external-link-failed', message });
    if (rec.exp < this.now()) { this.pendingLinks.delete(rec.state); return deny('The link request expired. Start again.'); }
    this.pendingLinks.delete(rec.state);   // one-use, whatever happens next
    const auditBase = { tenant: rec.tenant, subject: rec.subject, method: rec.instanceId };
    if (cb.error) { this.audit({ ...auditBase, outcome: 'external-link-denied-by-provider', error: cb.error.slice(0, 80) }); return deny('The provider refused the sign-in. Try again.'); }
    const cfg = await this.signinConfig(rec.tenant);
    const m = cfg.methods.find((x) => x.id === rec.instanceId);
    if (!m) return deny('This sign-in method is not available.');
    const reg = await this.signinRegistry(undefined);
    let profile: ExternalProfile;
    if (rec.mode === 'simulated') {
      const id = rec.start.identities!.find((x) => x.sub === cb.sim);
      if (!id) return deny('The link failed. Try again.');
      profile = { sub: id.sub, ...(id.email ? { email: id.email, emailVerified: true } : {}), name: id.label };
    } else {
      const cbUrl = externalCallbackUrl();
      const secret = await this.externalSecret(reg, rec.tenant, m);
      try {
        profile = rec.mode === 'oidc' ? await exchangeOidc(rec.start, secret, cbUrl, cb, rec) : await exchangeUserinfo(rec.start, secret, cbUrl, cb, rec);
      } catch (e) {
        // Same rule as the sign-in leg: a definitive provider refusal is an actionable denial; anything else stays 503.
        const refusal = externalRefusalMessage(e);
        if (!refusal) throw e;
        this.audit({ ...auditBase, outcome: 'external-exchange-refused', where: (e as ProviderRefusal).where, status: String((e as ProviderRefusal).status), ...((e as ProviderRefusal).providerReason ? { providerReason: (e as ProviderRefusal).providerReason } : {}) });
        return deny(refusal);
      }
    }
    const payload = { tenant: rec.tenant, subject: rec.subject, known: true, instanceId: m.id, config: await this.instanceConfig(reg, rec.tenant, m), state: {}, answers: undefined, now: this.now(), enrollment: {} };
    const verdict = (await reg.callSlot<{ ok: boolean; reason?: string; message?: string }>(rec.tenant, `auth.${m.type}`, 'auth.external.verify',
      { ...payload, intent: 'link', external: profile, link: null, linkedSubject: null })).result;
    if (!verdict?.ok) { this.audit({ ...auditBase, outcome: 'external-link-refused', reason: verdict?.reason }); return deny(typeof verdict?.message === 'string' && verdict.message.length <= 160 ? verdict.message : 'The link failed. Try again.'); }
    try { await this.enroll.setExternalLink(rec.tenant, rec.subject, rec.instanceId, { sub: profile.sub, ...(profile.email ? { email: profile.email } : {}) }); }
    catch (e) { if ((e as { code?: string }).code === 'external-sub-taken') { this.audit({ ...auditBase, outcome: 'external-link-clash' }); return deny('This provider identity is already linked to another account.'); } throw e; }
    this.audit({ ...auditBase, outcome: 'external-linked', mode: rec.mode });
    return { outcome: 'external-linked', ...(rec.returnTo ? { returnTo: rec.returnTo } : {}) };
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
  /** The refusal for an account that carries a block, or null. Called once a step is proven, so the reason is never shown to someone who has not proved it (anti-enumeration). */
  private async blockGate(s: Session): Promise<GateResponse | null> {
    if (!s.known) return null;
    const shown = shownBlock(await this.blocks.list(s.tenant, s.subject), this.now());
    if (!shown) return null;
    this.audit({ tenant: s.tenant, subject: s.subject, chain: s.chain.id, outcome: 'blocked', kind: shown.kind, block: shown.id });
    return { outcome: 'deny', reason: 'account-blocked', message: refusalMessage(shown) };
  }
  /** A failed answer counts toward the automatic lock, only when an administrator turned it on. Unknown accounts are never given a block. */
  private async recordFailure(s: Session) {
    const settings = (await this.signinSecurity(s.tenant, s.branch)).lockout;
    if (!settings.enabled || !s.known) return;
    const k = `${s.tenant}/${s.subject}`, now = this.now(), list = [...(this.lockFails.get(k) ?? []).filter((x) => now - x < settings.windowMs), now];
    this.lockFails.set(k, list);
    if (!lockoutVerdict(list, now, settings, s.subject).lock) return;
    this.lockFails.delete(k);
    await this.blocks.add(s.tenant, { subject: s.subject, kind: 'locked', message: 'Too many failed attempts. Try again later or ask an administrator.', origin: 'automatic', setBy: 'system', setAt: now, ...(settings.hold ? { hold: true } : { until: now + settings.lockMs }) });
    this.audit({ tenant: s.tenant, subject: s.subject, chain: s.chain.id, outcome: 'locked' });
  }
  private async check(s: Session, answers: Record<string, string>): Promise<GateResponse> {
    const st = s.steps[s.index], t = methodType(st.type)!, key = `${s.tenant}/${s.branch ?? 'live'}/${s.subject}`;
    // An account locked by too many failures does not evaluate any answer: guessing stops while the lock is in force.
    if (s.known && inForce((await this.blocks.list(s.tenant, s.subject)).filter((b) => b.kind === 'locked'), this.now()).length) {
      this.sessions.delete(s.id); this.audit({ tenant: s.tenant, subject: s.subject, chain: s.chain.id, outcome: 'refused-while-locked' });
      return { outcome: 'deny', reason: 'bad-credentials', message: 'Sign-in failed. Check your details and try again.' };
    }
    const clean: Record<string, string> = {};
    // One answer value is at most 256 chars, except the passkey ceremony answer: a signed WebAuthn JSON of a few KB.
    for (const [k, v] of Object.entries(answers)) if (typeof v === 'string' && v.length <= (k === 'webauthn' ? 16384 : 256) && /^[a-z0-9]{1,12}$/.test(k)) clean[k] = v;
    const reg = await this.signinRegistry(s.branch);
    let ok = false;
    try {
      const payload = await this.methodPayload(reg, s, st, s.prepared!.state, clean);
      if (t.id === 'digit-code') {   // the interactive method: one bus call per button press
        const r = (await reg.callSlot<{ done: boolean; ok?: boolean; prompt?: Prompt; state?: Record<string, any> }>(s.tenant, `auth.${st.type}`, 'auth.interact', payload)).result;
        if (!r.done) { s.prepared = { prompt: r.prompt!, state: r.state! }; return this.challenge(s); }   // a button press: no attempt used yet
        ok = !!r.ok;
        if (ok) await this.enroll.touchPinUsed(s.tenant, s.subject, st.id);   // the plugin verified from a snapshot: the core records the use
      } else {
        const r = (await reg.callSlot<{ ok: boolean; consumeStep?: number; credentialCounter?: { id: string; counter: number }; state?: Record<string, any> }>(s.tenant, `auth.${st.type}`, 'auth.verify', payload)).result;
        ok = !!r?.ok;
        if (r?.state) s.prepared!.state = r.state;   // e.g. the e-mail code's single-use flag, the passkey's spent challenge
        // Anti-replay effect: the step the plugin accepted is consumed ATOMICALLY by the store (a parallel attempt
        // that read the same lastStep loses the race and fails here).
        if (ok && typeof r?.consumeStep === 'number') ok = await this.enroll.consumeTotpStep(s.tenant, s.subject, st.id, r.consumeStep);   // also stamps lastUsedAt
        // Anti-clone effect (passkeys): the authenticator counter the plugin accepted must really advance.
        if (ok && r?.credentialCounter) ok = await this.enroll.advanceWebAuthnCounter(s.tenant, s.subject, st.id, String(r.credentialCounter.id), Number(r.credentialCounter.counter));
      }
    } catch (e) { this.sessions.delete(s.id); throw e; }
    if (!ok) {
      this.fail(key); s.tries++;
      this.audit({ tenant: s.tenant, subject: s.subject, chain: s.chain.id, step: s.index, method: st.id, outcome: 'step-failed' });
      if (s.index === 0 || s.tries >= MAX_TRIES) { this.sessions.delete(s.id); return { outcome: 'deny', reason: 'bad-credentials', message: 'Sign-in failed. Check your details and try again.' }; }
      return this.challenge(s, `Incorrect answer. ${MAX_TRIES - s.tries} attempt(s) left.`);
    }
    return this.advance(s);
  }
  /** The accepted step is recorded and the chain moves on: next step's challenge, or the final allow with the claims. */
  private async advance(s: Session): Promise<GateResponse> {
    const st = s.steps[s.index];
    s.done.push({ id: st.id, type: st.type, real: st.real }); s.index++;
    const blocked = await this.blockGate(s);
    if (blocked) { this.sessions.delete(s.id); return blocked; }
    if (s.index < s.steps.length) { await this.prepare(s); return this.challenge(s); }
    this.sessions.delete(s.id); this.fails.delete(`${s.tenant}/${s.branch ?? 'live'}/${s.subject}`);
    // Factor 'other' (federation) never counts toward MFA by itself: a federated step asserts a sign-in happened
    // at the provider, not an independent factor of THIS service (docs/sso-federation.md).
    const real = s.done.filter((d) => d.real), factors = new Set(real.map((d) => methodType(d.type)!.factor).filter((f) => f !== 'other'));
    const claims = {
      amr: [...new Set(real.map((d) => methodType(d.type)!.amr))],
      auth_time: Math.floor(this.now() / 1000), auth_level: s.chain.level, auth_level_declared: s.declared, auth_level_basis: 'configured',
      auth_mfa: factors.size >= 2, auth_chain: s.chain.id, auth_methods: s.done.map((d) => d.id),
      auth_simulated: s.done.filter((d) => !d.real).map((d) => d.id),
      ...sessionClaims(await this.signinSession(s.tenant, s.branch)),
    };
    this.audit({ tenant: s.tenant, subject: s.subject, chain: s.chain.id, outcome: 'allow', mfa: claims.auth_mfa, level: claims.auth_level });
    return { outcome: 'allow', subject: s.subject, chain: s.chain.id, claims };
  }
}
export { EMPTY_CONFIG };
