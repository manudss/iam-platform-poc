import { HOOKS, HookHandler, PluginContext } from './hooks.js';
import { sanitizeSvg } from '../../branding/svg.js';
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
  /** Uninstall: removes one tenant's rows from the plugin's own tables and its seed record. */
  removeTenantData(tenant: string, pluginId: string, tables: string[]): Promise<void>;
  /** Uninstall of the last tenant: runs a migration's declared inverse in one transaction and removes the migration record. */
  revert(pluginId: string, id: string, sql: string[]): Promise<void>;
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

/** Budget for ONE blocking bus round trip (control, query, slot call). 2s is comfortable on a developer
 * machine; the hosted demo runs on a tiny shared CPU where a delivery with its Dolt activity checks can take
 * longer, so the image sets IAM_HOOK_TIMEOUT_MS higher. Fail-closed semantics are unchanged: a timeout still
 * refuses the call. */
export function defaultHookTimeoutMs(): number {
  const v = Number(process.env.IAM_HOOK_TIMEOUT_MS);
  return Number.isFinite(v) && v >= 250 ? v : 2000;
}

/** Step 2: the bridge to the core's event bus, provided by the plugin host (bus-host.ts) when it is enabled.
 * Every routed call requires this bridge; absence refuses rather than executing locally. */
export interface BusBridge {
  /** True when this kind is delivered through the bus. Controls, queries and asynchronous kinds all route on the bus. */
  routed(kind: string): boolean;
  emit(tenant: string, kind: string, payload: unknown, effectKey?: string, branch?: string): Promise<{ plugin: string; result: unknown }[]>;
  /** `answered` is false when NO subscriber gave a usable reply (all silent or not-concerned): for a blocking
   * hook that is a refusal too ("no response = deny", plan step 3), even if the merged verdict says allow. */
  call(tenant: string, kind: string, payload: unknown, timeoutMs?: number, branch?: string): Promise<{ verdict: string; reason?: string; result: unknown; answered: boolean; answeredBy?: string; businessDenial?: boolean }>;
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

  /** Derived inventories (list/menu/screens/profileFields), computed once and cached per tenant (P1 cache):
   * every state or registration mutation clears the whole map - these views are small and recomputed lazily. */
  private derived = new Map<string, unknown>();
  private derive<T>(key: string, compute: () => T): T {
    const hit = this.derived.get(key);
    if (hit !== undefined) return hit as T;
    const v = compute(); this.derived.set(key, v); return v;
  }
  /** Public invalidation for the admin refresh path: re-derive every inventory on next read. */
  invalidateInventories(): void { this.derived.clear(); }
  private bus?: BusBridge;
  /** Working branch this registry serves (decision 7): stamped on every envelope emitted through the bus. */
  private branchRef?: string;
  private activityListeners: (() => void | Promise<void>)[] = [];
  constructor(private migrations: MigrationStore, private settings: SettingsStore, private audit: RegistryAudit = () => {}, private states?: StateStore) {}

  private readonly auditListeners: RegistryAudit[] = [];
  /** Step 3: extra audit sinks (the bus host turns them into audit.event). The constructor callback stays the primary sink. */
  onAudit(l: RegistryAudit): void { this.auditListeners.push(l); }
  private emitAudit(e: Parameters<RegistryAudit>[0]): void { this.audit(e); for (const l of this.auditListeners) l(e); }

  /** Attaches the bus bridge (step 2). Mandatory since the step 3 cleanup (decision 6): every hook call goes
   * through the bus; a registry without a bridge refuses every call. Tests attach testing/fake-bus.ts. */
  setBus(b: BusBridge | undefined, branch?: string) { this.bus = b; this.branchRef = branch; }
  private requireBus(hook: string): BusBridge {
    if (!this.bus) throw new PluginError('bus-unavailable', `event bus required (step 3): no bridge attached, '${hook}' refused`);
    if (!this.bus.routed(hook)) throw new PluginError('bus-unavailable', `kind '${hook}' is not routed on the bus`);
    return this.bus;
  }
  /** The bus host listens here to re-push registrations when enablement changes. */
  onActivityChange(fn: () => void | Promise<void>) { this.activityListeners.push(fn); }
  private async activity() { for (const f of this.activityListeners) await f(); }
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
    this.invalidateInventories();
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
    for (const r of m.httpRoutes ?? []) if (!impl.handlers[r.handler ?? `http:${r.method} ${r.path}`]) errs.push(`http route ${r.handler ?? `http:${r.method} ${r.path}`} declared but no handler`);
    const declared = new Set([...m.hooks.map((d) => d.name), ...(m.subscribes ?? []).map((s) => s.name), ...(m.httpRoutes ?? []).map((r) => r.handler ?? `http:${r.method} ${r.path}`)]);
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
    // The base a replacement sees is the base REGISTERED HERE - it may carry runtime overrides (the
    // directory-backed `auth.authenticate` in workspace mode), not the one the loader wrapped at load time.
    if (m.extends) {
      const base = this.impls.get(m.extends)!;
      impl = { ...impl, handlers: Object.fromEntries(Object.entries(impl.handlers).map(([k, h]) => [k, (payload: unknown, ctx: PluginContext) => h(payload, { ...ctx, base: base.handlers })])) };
    }
    this.impls.set(m.id, impl);
    this.invalidateInventories();
  }

  list(tenant: string) {
    return this.derive(`list:${tenant}`, () => [...this.impls.values()].map((i) => {
      const s = this.state.get(this.k(tenant, i.manifest.id));
      const base = !!i.manifest.base;
      return { id: i.manifest.id, name: i.manifest.name, version: i.manifest.version, kinds: i.manifest.kinds, base, provides: i.manifest.provides ?? [], extends: i.manifest.extends, enabled: base ? true : !!s?.enabled, faulted: this.faulted.has(this.k(tenant, i.manifest.id)), installed: base ? true : !!s?.installed,
        /** What enabling would ask the admin to grant. Shown in the console before the admin decides. */
        requests: { install: !!(i.manifest.install?.migrations.length || i.manifest.install?.seed?.length), sensitiveHooks: i.manifest.hooks.map((h) => h.name).filter((n) => SENSITIVE_HOOKS.has(n)), uiComponents: !!i.manifest.screens?.some((x) => x.render === 'component') || !!i.manifest.profileComponents?.length },
        grants: s?.grants ?? {},
        /** Declared profile field keys (the console's uninstall export offers a CSV of them). */
        profileFields: i.manifest.profileFields?.map((f) => f.key) ?? [] };
    }));
  }

  /** Profile fields declared by the plugins that are active for this tenant. */
  profileFields(tenant: string): { plugin: string; fields: import('../../profile/fields.js').ProfileFieldDecl[] }[] {
    return this.derive(`pf:${tenant}`, () => [...this.impls.values()].filter((i) => i.manifest.profileFields?.length && this.isActive(tenant, i.manifest.id)).map((i) => ({ plugin: i.manifest.id, fields: i.manifest.profileFields! })));
  }

  /** Profile components declared by the plugins that are active for this tenant (My profile, the admin user sheet). */
  profileComponents(tenant: string): { plugin: string; components: import('./manifest.js').ProfileComponentDecl[] }[] {
    return this.derive(`pc:${tenant}`, () => [...this.impls.values()].filter((i) => i.manifest.profileComponents?.length && this.isActive(tenant, i.manifest.id)).map((i) => ({ plugin: i.manifest.id, components: i.manifest.profileComponents! })));
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
    this.invalidateInventories();
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
    if(p.manifest.provides?.includes('branding')) {
      try {
        for(const key of ['logoSvg','faviconSvg'])if(r.values[key])r.values[key]=sanitizeSvg(String(r.values[key]));
        if(r.values['logoMode']==='custom'&&!r.values['logoSvg'])throw Error('Custom logo requires SVG artwork');
      } catch(e) {throw new PluginError('invalid-settings',(e as Error).message);}
    }
    await this.settings.put(tenant, id, r.values);
    this.invalidateInventories();
    this.emitAudit({ tenant, action: 'plugin.configure', plugin: id, detail: Object.keys(r.values).filter((k) => p.manifest.settings.find((f) => f.key === k)?.type !== 'secret').join(',') });
  }

  async form(tenant: string, id: string): Promise<FormModel> {
    const p = this.plugin(id);
    return toFormModel(p.manifest.settings, (await this.settings.get(tenant, id)) ?? {});
  }

  private checkGrants(p: PluginImpl, g: Grants) {
    for (const h of p.manifest.hooks) if (SENSITIVE_HOOKS.has(h.name) && !g.hooks?.includes(h.name) && !p.manifest.base) throw new PluginError('grant-required', `hook ${h.name} is sensitive and was not granted`);
    // Packaged UI (admin screens or profile components) runs plugin-supplied JS in the console: it takes the explicit uiComponents grant.
    if ((p.manifest.screens?.some((s) => s.render === 'component') || !!p.manifest.profileComponents?.length) && !g.uiComponents && !p.manifest.base) throw new PluginError('grant-required', 'component screens were not granted');
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
    this.invalidateInventories();
    await this.persist(tenant, id);
    this.emitAudit({ tenant, action: 'plugin.enable', plugin: id });
    await this.activity();
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
    this.invalidateInventories();
    await this.persist(tenant, id);
    // The replacement's own state (failure counters, lockouts) is not carried to the base: say so in the audit trail.
    this.emitAudit({ tenant, action: 'plugin.disable', plugin: id, detail: p.manifest.extends ? `explicit return to ${p.manifest.extends}; replacement-owned state is kept but no longer enforced` : undefined });
    await this.activity();
  }

  /** Uninstall (plan D): the destructive inverse of install. The plugin must be disabled first (uninstall never silently
   * disables, so the base is restored by an explicit audited step). The tenant's rows are removed from the plugin's own
   * tables; the tables themselves are dropped by the declared down migrations only when no other tenant still has the
   * plugin installed (plugin tables are shared, rows are tenant-isolated). Every applied migration must still exist,
   * be unchanged and declare an inverse, otherwise uninstall refuses rather than guessing. Settings are kept for a
   * possible reinstall (secrets are not orphaned in logs). */
  async uninstall(tenant: string, id: string) {
    const p = this.plugin(id);
    if (p.manifest.base) throw new PluginError('base-required', `${id} is a base plugin and cannot be uninstalled`);
    const st = this.state.get(this.k(tenant, id));
    if (!st?.installed) return;
    if (st.enabled) throw new PluginError('still-enabled', `disable ${id} before uninstalling it`);
    for (const other of this.impls.values()) if (this.isActive(tenant, other.manifest.id) && other.manifest.requires?.includes(id)) throw new PluginError('in-use', `${other.manifest.id} requires ${id}`);
    const declared = new Map((p.manifest.install?.migrations ?? []).map((m) => [m.id, m]));
    const done = await this.migrations.applied(id);
    const lastTenant = ![...this.state.entries()].some(([k2, s2]) => k2 !== this.k(tenant, id) && k2.endsWith(`/${id}`) && s2.installed);
    const tables = ownedTables(p.manifest);
    if (done.length && lastTenant) {
      for (const a of [...done].reverse()) {
        const mig = declared.get(a.id);
        if (!mig) throw new PluginError('migration-unknown', `applied migration ${a.id} is no longer declared: uninstall cannot invert it`);
        if (checksum(JSON.stringify(mig.sql)) !== a.checksum) throw new PluginError('migration-changed', `migration ${a.id} was edited after being applied: uninstall refuses to guess the inverse`);
        if (!mig.down?.length) throw new PluginError('uninstall-incomplete', `migration ${a.id} declares no inverse: its tables would be orphaned`);
      }
      for (const a of [...done].reverse()) await this.migrations.revert(id, a.id, declared.get(a.id)!.down!);
      await this.migrations.removeTenantData(tenant, id, []); // clears the seed ledger row; the tables are dropped above
    } else {
      await this.migrations.removeTenantData(tenant, id, tables);
    }
    st.installed = false;
    st.enabled = false;
    st.grants = {};
    this.faulted.delete(this.k(tenant, id));
    for (const s of p.manifest.provides ?? []) if (this.chosen.get(this.k(tenant, s)) === id) this.chosen.delete(this.k(tenant, s));
    this.invalidateInventories();
    await this.persist(tenant, id);
    this.emitAudit({ tenant, action: 'plugin.uninstall', plugin: id, detail: done.length && lastTenant ? 'down migrations reverted; owned tables dropped' : `tenant rows removed; tables kept${lastTenant ? ' (no migrations applied)' : ' for other tenants'}` });
    await this.activity();
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
   * - No hook silently falls back to a weaker handler; notifications retry through durable delivery.
   * - The way out of a fault is an explicit admin action: `disable` (return to a valid base configuration, audited) or `enable` again.
   */
  /** Step 3 cleanup: a blocking handler that fails on the bus is marked faulted here (by the bus-host delivery,
   * or the fake bridge in unit specs). Persisted and audited; the replacement then refuses every call until an
   * admin disables or re-enables it (fail closed). There is NO fallback to the base anymore: at-least-once
   * redelivery replaced the old in-process fallback. */
  async markFaulted(tenant: string, id: string, detail: string) {
    if (this.faulted.has(this.k(tenant, id))) return;
    this.faulted.add(this.k(tenant, id));
    this.invalidateInventories();
    await this.persist(tenant, id);
    this.emitAudit({ tenant, action: 'plugin.fault.closed', plugin: id, detail });
  }

  /** Bus delivery of a blocking kind (step 3): only the plugin CHOSEN for the slot answers (single responder);
   * every other plugin with a handler is explicitly not concerned. A faulted replacement refuses (fail closed,
   * same rule as callSlot: the base is never asked in its place). */
  blockingResponder(tenant: string, id: string, kind: string, slot?: string): 'answer' | 'not-concerned' | 'refuse' {
    const impl = this.impls.get(id);
    if (!impl || !impl.handlers[kind] || !this.isActive(tenant, id)) return 'not-concerned';
    if (slot) {
      // Slot-targeted call (callSlot wrapper): only the plugin chosen for THIS slot answers; a faulted replacement
      // chosen for it refuses (fail closed, the base is never asked in its place).
      let chosen: string | undefined;
      try { chosen = this.resolve(tenant, slot).manifest.id; } catch { return 'not-concerned'; } // no provider at all: nobody is concerned
      if (chosen !== id) return 'not-concerned';
      if (impl.manifest.extends && this.faulted.has(this.k(tenant, id))) return 'refuse';
      return 'answer';
    }
    // A plugin WITHOUT a slot (risk signal, profile enrichment) answers whenever it is active; a slotted plugin
    // answers only when it is the one chosen for the slot (single responder: base or replacement).
    const slots = impl.manifest.provides ?? [];
    if (slots.length && !slots.some((s) => { try { return this.resolve(tenant, s).manifest.id === id; } catch { return false; } })) return 'not-concerned';
    if (impl.manifest.extends && this.faulted.has(this.k(tenant, id))) return 'refuse';
    return 'answer';
  }

  /** Generic blocking control (step 3: risk.score). Bus only (step 3 cleanup): one control call - a deny verdict
   * or no usable answer refuses (fail closed, sensitive hook). There is no in-process path anymore. */
  async control<R>(tenant: string, hook: string, payload: unknown, timeoutMs = defaultHookTimeoutMs()): Promise<{ result: R; servedBy: string }> {
    const bus = this.requireBus(hook);
    const r = await bus.call(tenant, hook, payload, timeoutMs, this.branchRef);
    if (r.verdict !== 'allow' || !r.answered) throw new PluginError('plugin-failed', `${hook} refused on the bus: ${r.reason ?? (r.answered ? 'denied' : 'no responder')}`);
    return { result: r.result as R, servedBy: r.answeredBy ?? 'bus' };
  }

  /** Merged query (step 3: profile.enrich): the union of the responders' fields - only the plugins that
   * answered appear; a key several plugins answer differently is reported as a conflict (first answer kept). */
  async queryHook<R extends Record<string, unknown>>(tenant: string, hook: string, payload: unknown, timeoutMs = defaultHookTimeoutMs()): Promise<{ data: R; conflicts: string[]; answeredBy: string[] }> {
    const bus = this.requireBus(hook);
    const r = await bus.query(tenant, hook, payload, timeoutMs, this.branchRef);
    return { data: r.data as R, conflicts: r.conflicts, answeredBy: r.answeredBy };
  }

  async callSlot<R>(tenant: string, slot: string, hook: string, payload: unknown, timeoutMs = defaultHookTimeoutMs()): Promise<{ result: R; servedBy: string; fellBack: boolean }> {
    // Bus only (step 3 cleanup): the call travels on the bus (envelope stamped with this registry's branch,
    // decision 7) and the serving plugin answers over NATS. Fail closed both ways: a deny verdict, a silent
    // mandatory subscriber (the core denies) or NO usable answer at all (bus down, nobody serving) refuse.
    // The hook name is shared by several slot families (auth.verify serves auth.password AND auth.totp), so the
    // slot travels inside the payload wrapper: the bus forwards it opaquely, the delivery unwraps it and only the
    // plugin chosen for THAT slot answers (blockingResponder).
    const bus = this.requireBus(hook);
    const r = await bus.call(tenant, hook, { __slot: slot, __payload: payload }, timeoutMs, this.branchRef);
    if (!r.answered) throw new PluginError('plugin-failed', `${hook} refused on the bus: ${r.reason ?? 'no responder'}`);
    // A plugin's own denial (bad credentials, locked out, ...) is DATA, not a fault: the answer rode back with
    // the deny verdict. A deny WITHOUT an answer payload is an infrastructure refusal (faulted replacement,
    // silent mandatory subscriber) and throws, exactly like the old in-process path distinguished them.
    if (r.verdict !== 'allow' && !r.businessDenial) throw new PluginError('plugin-failed', `${hook} refused on the bus: ${r.reason ?? 'denied'}`);
    return { result: r.result as R, servedBy: r.answeredBy ?? 'bus', fellBack: false };
  }

  /** Async hook fan-out: every active plugin that declared the hook, deduplicated by effectKey.
   * Step 2: when the bus routes this kind, the emission goes through the core (plugins answer over NATS).
   * A bus failure raises `bus-unavailable` WITHOUT an in-process fallback: the delivery may have happened, so
   * falling back would risk a double effect (D16). The caller retries the same effectKey; the host ledger dedupes. */
  private done = new Set<string>();
  async emit(tenant: string, hook: string, payload: { effectKey: string }) {
    // Bus only (step 3 cleanup): the emission goes through the core (plugins answer over NATS, at-least-once).
    // A bus failure raises `bus-unavailable` WITHOUT an in-process fallback: the delivery may have happened, so
    // falling back would risk a double effect (D16). The caller retries the same effectKey; the host ledger dedupes.
    const bus = this.requireBus(hook);
    const key = `${tenant}:bus:${hook}:${payload.effectKey}`;
    if (this.done.has(key)) return [];
    const out = await bus.emit(tenant, hook, payload, payload.effectKey, this.branchRef);
    this.done.add(key);
    return out;
  }

  /**
   * Matches a manifest httpRoute (step 3) for an ACTIVE plugin: method + path segments, `:param` placeholders.
   * The handler key is the declared one, or `http:<METHOD> <path>`. A declared route without a handler is a fault, not a 404.
   */
  httpRoute(tenant: string, id: string, method: string, path: string): { impl: PluginImpl; handler: HookHandler; auth: 'user' | 'admin' | 'public'; params: Record<string, string> } | undefined {
    const impl = this.impls.get(id);
    if (!impl || !this.isActive(tenant, id)) return undefined;
    for (const d of impl.manifest.httpRoutes ?? []) {
      if (d.method !== method) continue;
      const want = d.path.split('/').filter(Boolean), got = path.split('/').filter(Boolean);
      if (want.length !== got.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < want.length; i++) {
        if (want[i].startsWith(':')) params[want[i].slice(1)] = decodeURIComponent(got[i]);
        else if (want[i] !== got[i]) { ok = false; break; }
      }
      if (!ok) continue;
      const key = d.handler ?? `http:${d.method} ${d.path}`;
      const handler = impl.handlers[key];
      if (!handler) throw new PluginError('plugin-failed', `${id}: http route ${key} declared but no handler`);
      return { impl, handler, auth: d.auth ?? 'user', params };
    }
    return undefined;
  }

  /** Console menu entries declared by the plugins active for this tenant (manifest v3 `menu`). An entry disappears with its plugin. */
  menu(tenant: string) {
    return this.derive(`menu:${tenant}`, () => {
      const out: { plugin: string; id: string; title: string; area: 'admin' | 'self-service'; group: string; icon?: string; order?: number; path: string }[] = [];
      for (const p of this.impls.values()) {
        if (!this.isActive(tenant, p.manifest.id)) continue;
        for (const m of p.manifest.menu ?? []) out.push({ plugin: p.manifest.id, id: m.id, title: m.title, area: m.area, group: m.group, icon: m.icon, order: m.order, path: m.path });
      }
      return out.sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || a.title.localeCompare(b.title));
    });
  }

  /** Screens visible to the admin console. Component screens only appear if granted. */
  screens(tenant: string) {
    return this.derive(`screens:${tenant}`, () => {
      const res: { plugin: string; id: string; title: string; area: string; render: string; schemaRef?: string; component?: string }[] = [];
      for (const p of this.impls.values()) {
        if (!this.isActive(tenant, p.manifest.id)) continue;
        const g = this.state.get(this.k(tenant, p.manifest.id))?.grants ?? {};
        for (const s of p.manifest.screens ?? []) {
          if (s.render === 'component' && !g.uiComponents && !p.manifest.base) continue;
          res.push({ plugin: p.manifest.id, id: s.id, title: s.title, area: s.area, render: s.render, schemaRef: s.schemaRef, component: s.component });
        }
      }
      return res;
    });
  }
}

/** Tables created by the plugin's up migrations; scopes uninstall's per-tenant row removal to what the plugin owns. */
export function ownedTables(m: PluginManifest): string[] {
  const out: string[] = [];
  for (const mig of m.install?.migrations ?? []) for (const s of mig.sql) {
    const t = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi;
    let x: RegExpExecArray | null;
    while ((x = t.exec(s))) out.push(x[1].toLowerCase());
  }
  return [...new Set(out)];
}

function checksum(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
