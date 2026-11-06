import { HOOKS, HookHandler, PluginContext } from './hooks.js';
import { PluginManifest, validateManifest } from './manifest.js';
import { settingsExtend, toFormModel, validateSettings, FormModel } from './settings.js';

/** Hooks that sit on the sign-in or decision path. Declaring one is not enough: an admin must grant it. */
export const SENSITIVE_HOOKS = new Set(['auth.authenticate', 'auth.challenge', 'access.decide', 'risk.score']);

export interface PluginImpl { manifest: PluginManifest; handlers: Record<string, HookHandler>; }

/** What an admin approves when enabling a plugin. A manifest only requests; nothing is implied. */
export interface Grants {
  /** Allow running the install migrations (SQL limited to the plugin's own plg_ tables). */
  install?: boolean;
  /** Sensitive hooks the plugin may receive. */
  hooks?: string[];
  /** Allow packaged web components (render: 'component'). Schema-rendered screens need no grant. */
  uiComponents?: boolean;
}

export interface MigrationStore {
  applied(pluginId: string): Promise<{ id: string; checksum: string }[]>;
  /** Runs the statements in one transaction and records the migration. */
  apply(pluginId: string, id: string, checksum: string, sql: string[]): Promise<void>;
  /** Seeds one row for one tenant (the store adds the tenant column). Called once per tenant and plugin. */
  seed(tenant: string, pluginId: string, table: string, row: Record<string, unknown>): Promise<void>;
  /** True when this tenant already received the plugin's seed rows. */
  seeded(tenant: string, pluginId: string): Promise<boolean>;
}
export interface StoredState { tenant: string; plugin: string; installed: boolean; enabled: boolean; faulted: boolean; grants: Grants; }
/** Durable enablement, grants and fault flags: the admin state survives a restart. */
export interface StateStore {
  loadAll(): Promise<StoredState[]>;
  save(s: StoredState): Promise<void>;
}
export interface SettingsStore {
  get(tenant: string, pluginId: string): Promise<Record<string, unknown> | undefined>;
  put(tenant: string, pluginId: string, values: Record<string, unknown>): Promise<void>;
}
export interface RegistryAudit { (event: { tenant: string; action: string; plugin: string; detail?: string }): void; }

type State = { enabled: boolean; grants: Grants; installed: boolean };

export class PluginError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/** Step 2: the bridge to the core's event bus, provided by the plugin host (bus-host.ts) when it is enabled.
 * `routed` is false for every kind when the bus is off: behaviour is then exactly the in-process one. */
export interface BusBridge {
  /** True when this kind is delivered through the bus. Only pure-async hooks route in step 2; blocking hooks stay in process. */
  routed(kind: string): boolean;
  emit(tenant: string, kind: string, payload: unknown, effectKey?: string, branch?: string): Promise<{ plugin: string; result: unknown }[]>;
  /** `answered` is false when NO subscriber gave a usable reply (all silent or not-concerned): for a blocking
   * hook that is a refusal too ("no response = deny", plan step 3), even if the merged verdict says allow. */
  call(tenant: string, kind: string, payload: unknown, timeoutMs?: number, branch?: string): Promise<{ verdict: string; reason?: string; result: unknown; answered: boolean }>;
  /** Merged query (step 3: profile.enrich): the shallow union of the responders' objects, fields from the
   * responders only; `conflicts` lists the keys several plugins answered differently. */
  query(tenant: string, kind: string, payload: unknown, timeoutMs?: number, branch?: string): Promise<{ data: Record<string, unknown>; conflicts: string[]; answeredBy: string[] }>;
}

export class PluginRegistry {
  private impls = new Map<string, PluginImpl>();
  private state = new Map<string, State>(); // key: tenant/plugin
  /** Slot -> plugin id chosen by the admin as replacement; absent means the base plugin serves. */
  private chosen = new Map<string, string>(); // key: tenant/slot
  /** Replacements that failed at runtime (key tenant/plugin). A faulted replacement keeps its slot but answers every call with a refusal until an admin acts. */
  private faulted = new Set<string>();

  private bus?: BusBridge;
  /** Working branch this registry serves (decision 7): stamped on every envelope emitted through the bus. */
  private branchRef?: string;
  private activityListeners: (() => void)[] = [];
  constructor(private migrations: MigrationStore, private settings: SettingsStore, private audit: RegistryAudit = () => {}, private states?: StateStore) {}

  private readonly auditListeners: RegistryAudit[] = [];
  /** Step 3: extra audit sinks (the bus host turns them into audit.event). The constructor callback stays the primary sink. */
  onAudit(l: RegistryAudit): void { this.auditListeners.push(l); }
  private emitAudit(e: Parameters<RegistryAudit>[0]): void { this.audit(e); for (const l of this.auditListeners) l(e); }

  /** Attaches the bus bridge (step 2). Routing activates per kind, never globally. */
  setBus(b: BusBridge | undefined, branch?: string) { this.bus = b; this.branchRef = branch; }
  /** The bus host listens here to re-push registrations when enablement changes. */
  onActivityChange(fn: () => void) { this.activityListeners.push(fn); }
  private activity() { for (const f of this.activityListeners) { try { f(); } catch { /* a listener error never changes plugin state */ } } }
  /** Read access for the bus host (delivery path). */
  impl(id: string): PluginImpl | undefined { return this.impls.get(id); }
  /** Tenants that have any plugin state: the bus host syncs registrations for each of them. */
  tenants(): string[] { return [...new Set([...this.state.keys()].map((k) => k.split('/')[0]))]; }
  async settingsFor(tenant: string, id: string): Promise<Record<string, unknown> | undefined> { return this.settings.get(tenant, id); }

  /** Reload durable state after a restart. Call once after registering the plugins. Replacements that were enabled take their slots again; faults stay faults. */
  async load() {
    if (!this.states) return;
    for (const r of await this.states.loadAll()) {
      const p = this.impls.get(r.plugin);
      if (!p) continue; // plugin no longer shipped: its state is kept in the store but inert
      this.state.set(this.k(r.tenant, r.plugin), { enabled: r.enabled, grants: r.grants, installed: r.installed });
      if (r.faulted) this.faulted.add(this.k(r.tenant, r.plugin));
      if (r.enabled && p.manifest.extends) for (const sl of p.manifest.provides ?? []) this.chosen.set(this.k(r.tenant, sl), r.plugin);
    }
  }
  /** Platform-core settings that are not a plugin (for example the authentication methods and chains). They live in the same versioned store as plugin settings, so a working branch holds them until Apply. */
  coreSettings(tenant: string, key: string) { return this.settings.get(tenant, key); }
  async putCoreSettings(tenant: string, key: string, values: Record<string, unknown>) { await this.settings.put(tenant, key, values); this.emitAudit({ tenant, action: 'core.settings.changed', plugin: key }); }
  private async persist(tenant: string, id: string) {
    const st = this.state.get(this.k(tenant, id));
    if (this.states && st) await this.states.save({ tenant, plugin: id, installed: st.installed, enabled: st.enabled, faulted: this.faulted.has(this.k(tenant, id)), grants: st.grants });
  }

  private k = (tenant: string, id: string) => `${tenant}/${id}`;
  private plugin(id: string) {
    const p = this.impls.get(id);
    if (!p) throw new PluginError('unknown-plugin', `unknown plugin ${id}`);
    return p;
  }

  /** Called at startup for shipped and discovered plugins. Checks the manifest and the base/replacement rules. */
  register(impl: PluginImpl) {
    const m = impl.manifest;
    const errs = validateManifest(m, HOOKS);
    for (const h of m.hooks) if (!impl.handlers[h.name]) errs.push(`hook ${h.name} declared but no handler`);
    for (const s of m.subscribes ?? []) if (!impl.handlers[s.name]) errs.push(`subscribes: ${s.name} declared but no handler`);
    const declared = new Set([...m.hooks.map((d) => d.name), ...(m.subscribes ?? []).map((s) => s.name)]);
    for (const h of Object.keys(impl.handlers)) if (!declared.has(h)) errs.push(`handler for undeclared hook ${h}`);
    if (this.impls.has(m.id)) errs.push(`plugin ${m.id} already registered`);
    if (m.extends) {
      const base = this.impls.get(m.extends);
      if (!base) errs.push(`base plugin ${m.extends} is not registered`);
      else {
        if (!base.manifest.base) errs.push(`${m.extends} is not a base plugin`);
        const baseSlots = base.manifest.provides ?? [];
        if (!baseSlots.every((s) => m.provides?.includes(s))) errs.push('replacement must provide every slot of its base');
        errs.push(...settingsExtend(base.manifest.settings, m.settings));
        for (const h of base.manifest.hooks) if (!m.hooks.some((x) => x.name === h.name && x.mode === h.mode)) errs.push(`replacement must handle base hook ${h.name}`);
        for (const kd of base.manifest.kinds) if (!m.kinds.includes(kd)) errs.push(`replacement must keep kind ${kd}`);
      }
    }
    if (m.base) {
      for (const s of m.provides ?? []) {
        const other = [...this.impls.values()].find((i) => i.manifest.base && i.manifest.provides?.includes(s));
        if (other) errs.push(`slot ${s} already has base plugin ${other.manifest.id}`);
      }
    }
    if (errs.length) throw new PluginError('invalid-manifest', `${m.id}: ${errs.join('; ')}`);
    this.impls.set(m.id, impl);
  }

  list(tenant: string) {
    return [...this.impls.values()].map((i) => {
      const s = this.state.get(this.k(tenant, i.manifest.id));
      const base = !!i.manifest.base;
      return { id: i.manifest.id, name: i.manifest.name, version: i.manifest.version, kinds: i.manifest.kinds, base, provides: i.manifest.provides ?? [], extends: i.manifest.extends, enabled: base ? true : !!s?.enabled, faulted: this.faulted.has(this.k(tenant, i.manifest.id)), installed: base ? true : !!s?.installed,
        /** What enabling would ask the admin to grant. Shown in the console before the admin decides. */
        requests: { install: !!(i.manifest.install?.migrations.length || i.manifest.install?.seed?.length), sensitiveHooks: i.manifest.hooks.map((h) => h.name).filter((n) => SENSITIVE_HOOKS.has(n)), uiComponents: !!i.manifest.screens?.some((x) => x.render === 'component') },
        grants: s?.grants ?? {} };
    });
  }

  /** Profile fields declared by the plugins that are active for this tenant. */
  profileFields(tenant: string): { plugin: string; fields: import('../../profile/fields.js').ProfileFieldDecl[] }[] {
    return [...this.impls.values()].filter((i) => i.manifest.profileFields?.length && this.isActive(tenant, i.manifest.id)).map((i) => ({ plugin: i.manifest.id, fields: i.manifest.profileFields! }));
  }

  /** Install: runs migrations once (checksum-checked), seeds, only if the admin granted `install`. */
  async install(tenant: string, id: string, grants: Grants) {
    const p = this.plugin(id);
    const spec = p.manifest.install;
    if (spec?.migrations.length || spec?.seed?.length) {
      if (!grants.install && !p.manifest.base) throw new PluginError('grant-required', 'install requires the install grant');
    }
    const done = new Map((await this.migrations.applied(id)).map((a) => [a.id, a.checksum]));
    for (const mig of spec?.migrations ?? []) {
      const sum = checksum(JSON.stringify(mig.sql));
      const prev = done.get(mig.id);
      if (prev !== undefined) {
        if (prev !== sum) throw new PluginError('migration-changed', `migration ${mig.id} was edited after being applied`);
        continue;
      }
      await this.migrations.apply(id, mig.id, sum, mig.sql);
    }
    if (spec?.seed?.length && !(await this.migrations.seeded(tenant, id))) for (const s of spec.seed) await this.migrations.seed(tenant, id, s.table, s.row);
    const st = this.state.get(this.k(tenant, id)) ?? { enabled: false, grants: {}, installed: false };
    st.installed = true; st.grants = { ...st.grants, ...grants };
    this.state.set(this.k(tenant, id), st);
    await this.persist(tenant, id);
    this.emitAudit({ tenant, action: 'plugin.install', plugin: id });
  }

  async configure(tenant: string, id: string, input: Record<string, unknown>) {
    const p = this.plugin(id);
    // A secret that is not re-sent keeps its stored value (the console never gets the secret back, only a mask).
    const stored = (await this.settings.get(tenant, id)) ?? {};
    const merged = { ...input };
    for (const f of p.manifest.settings) if (f.type === 'secret' && merged[f.key] === undefined && stored[f.key] !== undefined) merged[f.key] = stored[f.key];
    const r = validateSettings(p.manifest.settings, merged);
    if (!r.ok) throw new PluginError('invalid-settings', r.errors.join('; '));
    await this.settings.put(tenant, id, r.values);
    this.emitAudit({ tenant, action: 'plugin.configure', plugin: id, detail: Object.keys(r.values).filter((k) => p.manifest.settings.find((f) => f.key === k)?.type !== 'secret').join(',') });
  }

  async form(tenant: string, id: string): Promise<FormModel> {
    const p = this.plugin(id);
    return toFormModel(p.manifest.settings, (await this.settings.get(tenant, id)) ?? {});
  }

  private checkGrants(p: PluginImpl, g: Grants) {
    for (const h of p.manifest.hooks) if (SENSITIVE_HOOKS.has(h.name) && !g.hooks?.includes(h.name) && !p.manifest.base) throw new PluginError('grant-required', `hook ${h.name} is sensitive and was not granted`);
    if (p.manifest.screens?.some((s) => s.render === 'component') && !g.uiComponents && !p.manifest.base) throw new PluginError('grant-required', 'component screens were not granted');
  }

  async enable(tenant: string, id: string, grants: Grants = {}) {
    const p = this.plugin(id);
    if (p.manifest.base) return; // base plugins are always on
    const st = this.state.get(this.k(tenant, id));
    if (!st?.installed) throw new PluginError('not-installed', `${id} is not installed`);
    const g = { ...st.grants, ...grants };
    this.checkGrants(p, g);
    for (const r of p.manifest.requires ?? []) if (!this.isActive(tenant, r)) throw new PluginError('missing-dependency', `requires ${r}`);
    const cur = (await this.settings.get(tenant, id)) ?? {};
    const v = validateSettings(p.manifest.settings, cur);
    if (!v.ok) throw new PluginError('invalid-settings', `configure before enabling: ${v.errors.join('; ')}`);
    st.grants = g; st.enabled = true;
    // A replacement takes over its slots, the base keeps its own settings and data untouched.
    if (p.manifest.extends) for (const s of p.manifest.provides ?? []) this.chosen.set(this.k(tenant, s), id);
    this.faulted.delete(this.k(tenant, id));
    await this.persist(tenant, id);
    this.emitAudit({ tenant, action: 'plugin.enable', plugin: id });
    this.activity();
  }

  /** Current configuration in the form versioned in Dolt: enablement plus NON-SECRET settings (secret fields are never exported). */
  async exportConfig(tenant: string, id: string): Promise<{ enabled: boolean; settings: Record<string, unknown> }> {
    const p = this.plugin(id);
    const cur = (await this.settings.get(tenant, id)) ?? {};
    const settings = Object.fromEntries(Object.entries(cur).filter(([k]) => p.manifest.settings.find((f) => f.key === k)?.type !== 'secret'));
    return { enabled: this.isActive(tenant, id) && !p.manifest.base, settings };
  }

  /**
   * Applies a configuration that came from a reviewed and merged Dolt version. It goes through the same checks as the admin screen
   * (settings schema, dependencies, base validity) and NEVER widens grants: enabling reuses the grants an admin already gave, so a data merge
   * cannot grant a sensitive hook, SQL install or component screen. Secrets are untouched (kept as stored).
   */
  async applyVersionedConfig(tenant: string, id: string, cfg: { enabled: boolean; settings: Record<string, unknown> }) {
    const p = this.plugin(id);
    await this.configure(tenant, id, cfg.settings);
    if (p.manifest.base) return;
    if (cfg.enabled) await this.enable(tenant, id, {});
    else await this.disable(tenant, id);
    this.emitAudit({ tenant, action: 'plugin.config.applied', plugin: id, detail: 'from a merged Dolt version; grants unchanged' });
  }

  /** Disable: slots fall back to the base plugin with the base's own stored configuration. Data is never dropped. */
  async disable(tenant: string, id: string) {
    const p = this.plugin(id);
    if (p.manifest.base) throw new PluginError('base-required', `${id} is a base plugin and cannot be disabled; enable a replacement instead`);
    const st = this.state.get(this.k(tenant, id));
    if (!st?.enabled) return;
    for (const other of this.impls.values()) if (this.isActive(tenant, other.manifest.id) && other.manifest.requires?.includes(id)) throw new PluginError('in-use', `${other.manifest.id} requires ${id}`);
    // Explicit return to the base: its own stored configuration must be valid on its own schema, otherwise refuse and keep the current state.
    if (p.manifest.extends) {
      const base = this.plugin(p.manifest.extends);
      const v = validateSettings(base.manifest.settings, (await this.settings.get(tenant, base.manifest.id)) ?? {});
      if (!v.ok) throw new PluginError('base-config-invalid', `the base plugin ${base.manifest.id} has no valid configuration: ${v.errors.join('; ')}`);
    }
    st.enabled = false;
    this.faulted.delete(this.k(tenant, id));
    for (const s of p.manifest.provides ?? []) if (this.chosen.get(this.k(tenant, s)) === id) this.chosen.delete(this.k(tenant, s));
    await this.persist(tenant, id);
    // The replacement's own state (failure counters, lockouts) is not carried to the base: say so in the audit trail.
    this.emitAudit({ tenant, action: 'plugin.disable', plugin: id, detail: p.manifest.extends ? `explicit return to ${p.manifest.extends}; replacement-owned state is kept but no longer enforced` : undefined });
    this.activity();
  }

  isActive(tenant: string, id: string) {
    const p = this.impls.get(id);
    if (!p) return false;
    return !!p.manifest.base || !!this.state.get(this.k(tenant, id))?.enabled;
  }

  /** Which plugin serves a slot now: the enabled replacement if the admin chose one, otherwise the base. A fault does NOT change this: see callSlot. */
  resolve(tenant: string, slot: string): PluginImpl {
    const id = this.chosen.get(this.k(tenant, slot));
    if (id) return this.plugin(id);
    const base = [...this.impls.values()].find((i) => i.manifest.base && i.manifest.provides?.includes(slot));
    if (!base) throw new PluginError('no-provider', `no provider for slot ${slot}`);
    return base;
  }

  isFaulted(tenant: string, id: string) { return this.faulted.has(this.k(tenant, id)); }

  /**
   * Call a slot's hook.
   * - Sensitive hooks (auth, risk, policy) FAIL CLOSED. If the serving replacement throws or exceeds the deadline, the call is refused
   *   (PluginError `plugin-failed`) and the replacement is marked faulted: every later call is refused too. The base plugin is NEVER asked
   *   after a refusal, error or timeout of a replacement, because the base may be less restrictive (no lockout, no extra factor). Callers must
   *   treat the error as a denial. Failure counters and other state of a replacement are never rolled back or reset by the registry.
   * - Non-sensitive hooks (for example notifications) may fall back to the base: a missed message is not an access decision.
   * - The way out of a fault is an explicit admin action: `disable` (return to a valid base configuration, audited) or `enable` again.
   */
  /** Bus delivery of a blocking kind (step 3): only the plugin CHOSEN for the slot answers (single responder);
   * every other plugin with a handler is explicitly not concerned. A faulted replacement refuses (fail closed,
   * same rule as callSlot: the base is never asked in its place). */
  blockingResponder(tenant: string, id: string, kind: string): 'answer' | 'not-concerned' | 'refuse' {
    const impl = this.impls.get(id);
    if (!impl || !impl.handlers[kind] || !this.isActive(tenant, id)) return 'not-concerned';
    // A plugin WITHOUT a slot (risk signal, profile enrichment) answers whenever it is active; a slotted plugin
    // answers only when it is the one chosen for the slot (single responder: base or replacement).
    const slots = impl.manifest.provides ?? [];
    if (slots.length && !slots.some((s) => { try { return this.resolve(tenant, s).manifest.id === id; } catch { return false; } })) return 'not-concerned';
    if (impl.manifest.extends && this.faulted.has(this.k(tenant, id))) return 'refuse';
    return 'answer';
  }

  /** Generic blocking control (step 3: risk.score). On the bus: one control call - a deny verdict or no usable
   * answer refuses (fail closed, sensitive hook). In process: every active plugin with the handler answers; a
   * deny or an error refuses; the last answer is the result (mirrors the bus contract). */
  async control<R>(tenant: string, hook: string, payload: unknown, timeoutMs = 2000): Promise<{ result: R; servedBy: string }> {
    if (this.bus?.routed(hook)) {
      const r = await this.bus.call(tenant, hook, payload, timeoutMs, this.branchRef);
      if (r.verdict !== 'allow' || !r.answered) throw new PluginError('plugin-failed', `${hook} refused on the bus: ${r.reason ?? (r.answered ? 'denied' : 'no responder')}`);
      return { result: r.result as R, servedBy: 'bus' };
    }
    let last: unknown; const answered: string[] = [];
    for (const p of this.impls.values()) {
      if (!this.isActive(tenant, p.manifest.id) || !p.handlers[hook]) continue;
      const settings = validateSettings(p.manifest.settings, (await this.settings.get(tenant, p.manifest.id)) ?? {}).values;
      const res = await withTimeout(Promise.resolve(p.handlers[hook](payload, { tenant, settings })), timeoutMs);
      if (res?.outcome === 'deny') throw new PluginError('plugin-failed', `${hook} denied by ${p.manifest.id}: ${res.reason ?? 'denied'}`);
      last = res; answered.push(p.manifest.id);
    }
    if (!answered.length) throw new PluginError('plugin-failed', `${hook}: no active plugin answers`);
    return { result: last as R, servedBy: answered.join('+') };
  }

  /** Merged query (step 3: profile.enrich): the union of the responders' fields - only the plugins that
   * answered appear; a key several plugins answer differently is reported as a conflict (first answer kept). */
  async queryHook<R extends Record<string, unknown>>(tenant: string, hook: string, payload: unknown, timeoutMs = 2000): Promise<{ data: R; conflicts: string[]; answeredBy: string[] }> {
    if (this.bus?.routed(hook)) {
      const r = await this.bus.query(tenant, hook, payload, timeoutMs, this.branchRef);
      return { data: r.data as R, conflicts: r.conflicts, answeredBy: r.answeredBy };
    }
    const data: Record<string, unknown> = {}; const conflicts: string[] = []; const answeredBy: string[] = [];
    for (const p of this.impls.values()) {
      if (!this.isActive(tenant, p.manifest.id) || !p.handlers[hook]) continue;
      const settings = validateSettings(p.manifest.settings, (await this.settings.get(tenant, p.manifest.id)) ?? {}).values;
      const res = (await withTimeout(Promise.resolve(p.handlers[hook](payload, { tenant, settings })), timeoutMs)) as Record<string, unknown> | undefined;
      for (const [k, v] of Object.entries(res ?? {})) {
        if (k in data && data[k] !== v) { if (!conflicts.includes(k)) conflicts.push(k); } else data[k] = v;
      }
      answeredBy.push(p.manifest.id);
    }
    return { data: data as R, conflicts, answeredBy };
  }

  async callSlot<R>(tenant: string, slot: string, hook: string, payload: unknown, timeoutMs = 2000): Promise<{ result: R; servedBy: string; fellBack: boolean }> {
    if (this.bus?.routed(hook)) {
      // Step 3 (auth migration): the call travels on the bus (envelope stamped with this registry's branch,
      // decision 7) and the serving plugin answers over NATS. Fail closed both ways: a deny verdict, a silent
      // mandatory subscriber (the core denies) or NO usable answer at all (bus down, nobody serving) refuse.
      const r = await this.bus.call(tenant, hook, payload, timeoutMs, this.branchRef);
      if (r.verdict !== 'allow' || !r.answered) throw new PluginError('plugin-failed', `${hook} refused on the bus: ${r.reason ?? (r.answered ? 'denied' : 'no responder')}`);
      return { result: r.result as R, servedBy: 'bus', fellBack: false };
    }
    const primary = this.resolve(tenant, slot);
    const run = async (p: PluginImpl) => {
      const h = p.handlers[hook];
      if (!h) throw new PluginError('no-handler', `${p.manifest.id} has no ${hook}`);
      const settings = validateSettings(p.manifest.settings, (await this.settings.get(tenant, p.manifest.id)) ?? {}).values;
      const ctx: PluginContext = { tenant, settings };
      return await withTimeout(Promise.resolve(h(payload, ctx)), timeoutMs);
    };
    const sensitive = SENSITIVE_HOOKS.has(hook);
    const fk = this.k(tenant, primary.manifest.id);
    if (primary.manifest.extends && this.faulted.has(fk)) throw new PluginError('plugin-failed', `${primary.manifest.id} is faulted: refused until an admin disables or re-enables it`);
    try {
      return { result: (await run(primary)) as R, servedBy: primary.manifest.id, fellBack: false };
    } catch (e) {
      if (!primary.manifest.extends) throw e; // the base itself failed: nothing to fall back to
      this.faulted.add(fk);
      await this.persist(tenant, primary.manifest.id);
      this.emitAudit({ tenant, action: sensitive ? 'plugin.fault.closed' : 'plugin.fault.fallback', plugin: primary.manifest.id, detail: String((e as Error).message) });
      if (sensitive) throw new PluginError('plugin-failed', `${primary.manifest.id} failed (${(e as Error).message}); refused, no fallback for ${hook}`);
      const base = [...this.impls.values()].find((i) => i.manifest.base && i.manifest.provides?.includes(slot))!;
      return { result: (await run(base)) as R, servedBy: base.manifest.id, fellBack: true };
    }
  }

  /** Async hook fan-out: every active plugin that declared the hook, deduplicated by effectKey.
   * Step 2: when the bus routes this kind, the emission goes through the core (plugins answer over NATS).
   * A bus failure raises `bus-unavailable` WITHOUT an in-process fallback: the delivery may have happened, so
   * falling back would risk a double effect (D16). The caller retries the same effectKey; the host ledger dedupes. */
  private done = new Set<string>();
  async emit(tenant: string, hook: string, payload: { effectKey: string }) {
    if (this.bus?.routed(hook)) {
      const key = `${tenant}:bus:${hook}:${payload.effectKey}`;
      if (this.done.has(key)) return [];
      const out = await this.bus.emit(tenant, hook, payload, payload.effectKey, this.branchRef);
      this.done.add(key);
      return out;
    }
    const out: { plugin: string; result: unknown }[] = [];
    for (const p of this.impls.values()) {
      if (!this.isActive(tenant, p.manifest.id)) continue;
      const decl = p.manifest.hooks.find((h) => h.name === hook && h.mode === 'async');
      if (!decl) continue;
      const key = `${tenant}:${p.manifest.id}:${hook}:${payload.effectKey}`;
      if (this.done.has(key)) continue;
      const settings = validateSettings(p.manifest.settings, (await this.settings.get(tenant, p.manifest.id)) ?? {}).values;
      out.push({ plugin: p.manifest.id, result: await p.handlers[hook](payload, { tenant, settings }) });
      this.done.add(key);
    }
    return out;
  }

  /** Screens visible to the admin console. Component screens only appear if granted. */
  screens(tenant: string) {
    const res: { plugin: string; id: string; title: string; area: string; render: string; schemaRef?: string }[] = [];
    for (const p of this.impls.values()) {
      if (!this.isActive(tenant, p.manifest.id)) continue;
      const g = this.state.get(this.k(tenant, p.manifest.id))?.grants ?? {};
      for (const s of p.manifest.screens ?? []) {
        if (s.render === 'component' && !g.uiComponents && !p.manifest.base) continue;
        res.push({ plugin: p.manifest.id, id: s.id, title: s.title, area: s.area, render: s.render, schemaRef: s.schemaRef });
      }
    }
    return res;
  }
}

function checksum(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new PluginError('timeout', `hook exceeded ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}
