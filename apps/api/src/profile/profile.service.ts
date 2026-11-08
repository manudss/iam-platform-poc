import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { UsersService } from '../users/users.service.js';
import { currentBranch, workspaceMode } from '../workspace/context.js';
import { branchName } from '../versioning/guards.js';
import { BASE_FIELDS, CORE_PROFILE_SETTINGS_ID, CatalogField, Context, EffectiveField, ProfileConfig, settingFor, toCatalog } from './fields.js';
import { ProfileValueStore, Values } from './store.js';
import { ApplicationBus } from '../events/application-bus.service.js';

export const PROFILE_STORE = 'PROFILE_VALUE_STORE';
/** Public sign-up may only exist in the hosted workspace mode, where every administration route is guarded. Provided as a function so tests can exercise the open path without a Dolt-backed workspace. */
export const SIGNUP_ALLOWED = 'SIGNUP_ALLOWED';
export const defaultSignupAllowed = () => workspaceMode();
const SUBJECT = /^[A-Za-z0-9._@-]{1,64}$/;

@Injectable()
export class ProfileService {
  constructor(@Inject(PluginRegistry) private readonly reg: PluginRegistry, @Inject(PROFILE_STORE) private readonly store: ProfileValueStore, @Optional() private readonly branches?: BranchRegistries, @Optional() private readonly users?: UsersService, @Optional() @Inject(SIGNUP_ALLOWED) private readonly signupAllowed: () => boolean = defaultSignupAllowed, @Optional() private readonly events?: ApplicationBus) {}

  private async registry(ref: 'live' | 'work', write = false): Promise<PluginRegistry> {
    if (!workspaceMode()) return this.reg;
    return this.branches!.get(ref === 'live' ? 'main' : currentBranch(write));
  }
  /** Base fields plus the fields of the plugins that are active in that registry. */
  async catalogue(tenant: string, ref: 'live' | 'work'): Promise<CatalogField[]> {
    const r = await this.registry(ref);
    return [...BASE_FIELDS, ...r.profileFields(tenant).flatMap((p) => toCatalog(p.plugin, p.fields))];
  }
  async activePlugins(tenant: string, ref: 'live' | 'work' = 'live'): Promise<string[]> { return (await this.registry(ref)).list(tenant).filter((x: { id: string; enabled?: boolean; active?: boolean }) => x.enabled ?? x.active).map((x: { id: string }) => x.id); }
  async pluginActive(tenant: string, id: string, ref: 'live' | 'work') { return (await this.registry(ref)).isActive(tenant, id); }
  async config(tenant: string, ref: 'live' | 'work'): Promise<ProfileConfig> {
    const reg = await this.registry(ref);
    const raw = await reg.coreSettings(tenant, CORE_PROFILE_SETTINGS_ID);
    return (await reg.callSlot<{ config: ProfileConfig }>(tenant, 'directory.default', 'directory.fields.parseConfig', { value: raw })).result.config;
  }
  async saveConfig(tenant: string, input: unknown): Promise<ProfileConfig> {
    const cat = await this.catalogue(tenant, 'work');
    const v = (await (await this.registry('work')).callSlot<{ valid: boolean; config?: ProfileConfig; errors?: string[] }>(tenant, 'directory.default', 'directory.fields.validateConfig', { input, catalogue: cat })).result;
    if (!v.valid) throw new BadRequestException(v.errors?.join('; ') ?? 'invalid profile configuration');
    const cfg = v.config!;
    if (cfg.signup?.open && !this.signupAllowed()) throw new BadRequestException('public sign-up can only be opened in the hosted workspace mode (it is refused here, whatever the setting)');
    await (await this.registry('work', true)).putCoreSettings(tenant, CORE_PROFILE_SETTINGS_ID, cfg as unknown as Record<string, unknown>);
    return cfg;
  }
  async schema(tenant: string, ctx: Context, ref: 'live' | 'work'): Promise<EffectiveField[]> {
    const cat = await this.catalogue(tenant, ref), cfg = await this.config(tenant, ref);
    return (await (await this.registry(ref)).callSlot<{ fields: EffectiveField[] }>(tenant, 'directory.default', 'directory.fields.effectiveSchema', { catalogue: cat, config: cfg, context: ctx })).result.fields;
  }

  private async subject(tenant: string, id: string, ref: 'live' | 'work') {
    if (!SUBJECT.test(id)) throw new BadRequestException('invalid user id');
    if (process.env.IAM_DIRECTORY_AUTH === '1' && this.users) { if (!(await this.users.list(ref === 'live' ? 'main' : currentBranch())).some((u) => u.id === id)) throw new NotFoundException('unknown user'); }
  }
  private async visible(tenant: string, ctx: Context, ref: 'live' | 'work', values: Values) {
    const fields = await this.schema(tenant, ctx, ref);
    return { fields, values: Object.fromEntries(fields.filter((f) => f.key in values).map((f) => [f.key, values[f.key]])) };
  }
  /** The user's own profile, as the relevant side's configuration shows it (live, or the tested data branch). The subject always comes from the token. */
  async selfEditPolicy(tenant: string, ref: 'live' | 'work' = 'live'): Promise<'immediate' | 'review'> { return (await this.config(tenant, ref)).selfEditPolicy === 'review' ? 'review' : 'immediate'; }
  /** Base fields (name, e-mail, department, manager) live in the identity directory, not in the value store: show them from there. Stored values win. */
  private async baseValues(sub: string, ref: 'live' | 'work'): Promise<Record<string, unknown>> {
    if (!this.users || !workspaceMode()) return {};
    try {
      const u = (await this.users.list(ref === 'live' ? 'main' : currentBranch())).find((x) => x.id === sub); if (!u) return {};
      const r = u as unknown as Record<string, unknown>; const out: Record<string, unknown> = {};
      for (const k of ['display_name', 'email', 'department', 'manager_id']) if (r[k] !== null && r[k] !== undefined && r[k] !== '') out['base.' + k] = r[k];
      return out;
    } catch { return {}; }
  }
  async self(tenant: string, sub: string, ref: 'live' | 'work' = 'live') {
    await this.subject(tenant, sub, ref);
    const policy = await this.selfEditPolicy(tenant, ref);
    // Branch test: the values come from the tested branch; the pending-review mechanism (shared personal branches) is not part of a test.
    const live = await this.store.get(tenant, sub, ref), pending = policy === 'review' ? await this.store.pending(tenant, sub, ref === 'work' ? currentBranch() : 'main') : {};
    const shown = { ...(await this.baseValues(sub, ref)), ...live } as Record<string, unknown>; for (const [k, v] of Object.entries(pending)) { if (v === null) delete shown[k]; else shown[k] = v; }
    return { ...(await this.visible(tenant, 'self', ref, shown as Values)), policy, pending: Object.keys(pending), ...(ref === 'work' ? { branchTest: true as const } : {}) };
  }
  /** Immediate policy: the value changes at once (on main live, on the tested branch in a branch test). Review policy: the edits wait on the person's own pending change set until a validator accepts them — the same circuit on main and in a branch test; in a test the set is cut from and merged back into the TESTED branch, never main. */
  async patchSelf(tenant: string, sub: string, input: unknown, ref: 'live' | 'work' = 'live') {
    await this.subject(tenant, sub, ref);
    const changes = await this.check(tenant, ref, 'self', input);
    const branch = ref === 'work' ? currentBranch() : 'main';
    if (await this.selfEditPolicy(tenant, ref) === 'review') await this.store.putPending(tenant, sub, changes, sub, branch);
    else {
      await this.store.put(tenant, sub, changes, ref, sub);
      this.events?.emit({ type: 'profile.updated', tenant, branch, at: new Date().toISOString(), payload: { subject: sub, keys: Object.keys(changes).join(','), actor: sub } });
    }
    return this.self(tenant, sub, ref);
  }
  /** Validator view: who has pending edits and what would change (current live value next to the proposed one). Profile values only: no authority field can be in a pending set. */
  async reviews(tenant: string) {
    const out = [];
    for (const { subject: s, base } of await this.store.listPending(tenant)) {
      if (base !== 'main' && currentBranch() !== base) continue; // a branch test's reviews are handled from that branch's console
      const pend = await this.store.pending(tenant, s, base); if (!Object.keys(pend).length) continue;
      const ref = base === 'main' ? 'live' : 'work';
      const live = await this.store.get(tenant, s, ref), cat = await this.catalogue(tenant, ref);
      out.push({ id: base === 'main' ? s : `${s};${base}`, subject: s, ...(base !== 'main' ? { branch: base } : {}), changes: Object.entries(pend).map(([k, to]) => ({ key: k, label: cat.find((c) => c.fullKey === k)?.label ?? k, from: live[k] ?? null, to })) });
    }
    return { policy: await this.selfEditPolicy(tenant), reviews: out };
  }
  /** A validator cannot accept their own edits (separation of duties). Accepting merges the personal branch into its base (main, or the tested branch whose console the validator is using), refusing deletes it. */
  async resolveReview(tenant: string, id: string, accept: boolean, actor: string) {
    const i = id.lastIndexOf(';');
    const subject = i < 0 ? id : id.slice(0, i), base = i < 0 ? 'main' : id.slice(i + 1);
    if (!SUBJECT.test(subject)) throw new BadRequestException('invalid user id');
    if (base !== 'main') { branchName(base); if (currentBranch() !== base) throw new ForbiddenException(`select the ${base} branch to review these edits`); }
    if (accept && subject === actor) throw new ForbiddenException('you cannot accept your own pending edits: another validator must');
    if (!Object.keys(await this.store.pending(tenant, subject, base)).length) throw new NotFoundException('nothing pending for this user');
    await this.store.resolvePending(tenant, subject, accept, actor, base);
    this.events?.emit({ type: 'profile.review-resolved', tenant, branch: base, at: new Date().toISOString(), payload: { subject, decision: accept ? 'accepted' : 'refused', actor } });
    return { resolved: accept ? 'accepted' : 'refused', subject };
  }
  async admin(tenant: string, id: string) { await this.subject(tenant, id, 'work'); return this.visible(tenant, 'admin', 'work', { ...(await this.baseValues(id, 'work')), ...(await this.store.get(tenant, id, 'work')) } as Values); }
  async patchAdmin(tenant: string, id: string, input: unknown, actor: string) {
    await this.subject(tenant, id, 'work');
    const changes = await this.check(tenant, 'work', 'admin', input);
    await this.store.put(tenant, id, changes, 'work', actor);
    this.events?.emit({ type: 'profile.updated', tenant, branch: currentBranch(), at: new Date().toISOString(), payload: { subject: id, keys: Object.keys(changes).join(','), actor } });
    return this.admin(tenant, id);
  }
  /** Every rule is enforced here, on the server, from the configuration of the right side (live for a user, working for an admin). */
  private async check(tenant: string, ref: 'live' | 'work', ctx: Context, input: unknown): Promise<Record<string, string | number | boolean | null>> {
    const b = input as { values?: unknown } | undefined;
    if (!b || typeof b !== 'object' || !b.values || typeof b.values !== 'object' || Array.isArray(b.values) || Object.keys(b).some((k) => k !== 'values')) throw new BadRequestException('body must be { values: { key: value } }');
    const entries = Object.entries(b.values as Record<string, unknown>); if (!entries.length || entries.length > 40) throw new BadRequestException('1 to 40 values');
    const cat = await this.catalogue(tenant, ref), cfg = await this.config(tenant, ref), out: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of entries) {
      const f = cat.find((c) => c.fullKey === k); if (!f) throw new BadRequestException(`unknown profile field ${k}`);
      const s = settingFor(f, cfg);
      const allowed = s.enabled && f.storage !== 'identities' && (ctx === 'self' ? s.selfEdit && f.klass === 'profile' : s.adminEdit);
      if (!allowed) throw new ForbiddenException(`${k} cannot be changed here`);
      out[k] = await this.checkValue(tenant, ref, f, v);
    }
    return out;
  }

  /** One entered value against the directory slot's rule (phase 2 step 1): a refusal is a 400, never a plugin fault. */
  private async checkValue(tenant: string, ref: 'live' | 'work', f: CatalogField, v: unknown): Promise<string | number | boolean | null> {
    const r = (await (await this.registry(ref)).callSlot<{ valid: boolean; value?: string | number | boolean | null; error?: string }>(tenant, 'directory.default', 'directory.fields.checkValue', { field: f, value: v })).result;
    if (!r.valid) throw new BadRequestException(r.error ?? 'invalid value');
    return r.value ?? null;
  }

  /** Sign-up support. The switch and the schema are the LIVE ones: nothing staged on a branch opens the public form. */
  async signupOpen(tenant: string): Promise<boolean> { return this.signupAllowed() && !!(await this.config(tenant, 'live')).signup?.open; }
  /** Only fields the live sign-up schema offers (authority fields never are). Required plugin fields must be present. */
  async signupValues(tenant: string, input: unknown): Promise<Record<string, string | number | boolean | null>> {
    if (input === undefined) input = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BadRequestException('values must be an object');
    const schema = (await this.schema(tenant, 'signup', 'live')).filter((f) => !f.key.startsWith('base.'));
    const cat = await this.catalogue(tenant, 'live'), out: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (!schema.some((f) => f.key === k)) throw new BadRequestException(`${k} is not asked at sign-up`);
      out[k] = await this.checkValue(tenant, 'live', cat.find((c) => c.fullKey === k)!, v);
    }
    for (const f of schema) if (f.required && (out[f.key] === undefined || out[f.key] === null || out[f.key] === '')) throw new BadRequestException(`${f.label} is required`);
    return out;
  }
  async putWorking(tenant: string, id: string, values: Record<string, string | number | boolean | null>, actor: string) { if (Object.keys(values).length) await this.store.put(tenant, id, values, 'work', actor); }

  /** Profile components contributed by the plugins active on this side, with the configuration applied. surface=self is the person's own page; surface=admin the administrator's user sheet. */
  async components(tenant: string, surface: 'self' | 'admin', ref: 'live' | 'work') {
    const reg = await this.registry(ref);
    const cfg = await this.config(tenant, ref);
    const listed = new Map(reg.list(tenant).map((x: { id: string; base?: boolean; grants?: { uiComponents?: boolean } }) => [x.id, x]));
    const out: { key: string; plugin: string; id: string; title: string; component: string; mode: 'manage' | 'readonly'; order: number }[] = [];
    for (const { plugin, components } of reg.profileComponents(tenant)) {
      const info = listed.get(plugin);
      if (info && !info.base && !info.grants?.uiComponents) continue; // same rule as component screens: granted explicitly
      for (const c of components) {
        const ov = cfg.components?.[`${plugin}:${c.id}`] ?? {};
        const mode = ov[surface] ?? c.surfaces?.[surface] ?? 'hidden';
        if (mode === 'hidden') continue;
        out.push({ key: `${plugin}:${c.id}`, plugin, id: c.id, title: c.title, component: c.component, mode, order: ov.order ?? c.order ?? 500 });
      }
    }
    return out.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  }
  /** The admin configuration view of every component: manifest defaults plus the current overrides, hidden included. */
  async componentsInventory(tenant: string, ref: 'live' | 'work' = 'work') {
    const reg = await this.registry(ref);
    const cfg = await this.config(tenant, ref);
    const out: { key: string; plugin: string; id: string; title: string; component: string; defaults: { self: string; admin: string }; effective: { self: string; admin: string }; order: number }[] = [];
    for (const { plugin, components } of reg.profileComponents(tenant))
      for (const c of components) {
        const ov = cfg.components?.[`${plugin}:${c.id}`] ?? {};
        out.push({ key: `${plugin}:${c.id}`, plugin, id: c.id, title: c.title, component: c.component,
          defaults: { self: c.surfaces?.self ?? 'hidden', admin: c.surfaces?.admin ?? 'hidden' },
          effective: { self: ov.self ?? c.surfaces?.self ?? 'hidden', admin: ov.admin ?? c.surfaces?.admin ?? 'hidden' },
          order: ov.order ?? c.order ?? 500 });
      }
    return out.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  }
  /** Uninstall hygiene (plugin lifecycle contract): a plugin that goes away takes its profile configuration with it - field settings and component overrides. Written on the working branch like every configuration change. */
  async purgePlugin(tenant: string, pluginId: string) {
    const reg = await this.registry('work', true);
    const raw = await reg.coreSettings(tenant, CORE_PROFILE_SETTINGS_ID);
    const cfg = (await reg.callSlot<{ config: ProfileConfig }>(tenant, 'directory.default', 'directory.fields.parseConfig', { value: raw })).result.config;
    const fields = Object.fromEntries(Object.entries(cfg.fields).filter(([k]) => !k.startsWith(pluginId + '.')));
    const components = Object.fromEntries(Object.entries(cfg.components ?? {}).filter(([k]) => !k.startsWith(pluginId + ':')));
    const next: ProfileConfig = { ...cfg, fields, ...(Object.keys(components).length ? { components } : {}) };
    if (!Object.keys(components).length) delete next.components;
    await reg.putCoreSettings(tenant, CORE_PROFILE_SETTINGS_ID, next as unknown as Record<string, unknown>);
    return { purged: pluginId, fields: Object.keys(cfg.fields).length - Object.keys(fields).length };
  }
  /** Adopts the legacy generic-store values of a plugin's storage-mapped fields into its own tables. Idempotent; the install and enable endpoints call it. */
  async adoptPlugin(tenant: string, pluginId: string): Promise<number> {
    if (!this.store.adopt) return 0;
    const cat = await this.catalogue(tenant, 'live');
    const routes = cat.filter((f) => f.plugin === pluginId && f.storage === 'table').map((f) => ({ fullKey: f.fullKey, type: f.type, table: f.table!, column: f.column! }));
    return this.store.adopt(tenant, routes);
  }
  /** How much profile data a plugin holds (the uninstall confirmation shows this number). */
  async pluginValueCount(tenant: string, pluginId: string, ref: 'live' | 'work' = 'work'): Promise<number> {
    if (!this.store.countForPlugin) return 0;
    const cat = await this.catalogue(tenant, ref);
    const routes = cat.filter((f) => f.plugin === pluginId && f.storage === 'table').map((f) => ({ fullKey: f.fullKey, type: f.type, table: f.table!, column: f.column! }));
    return this.store.countForPlugin(tenant, `${pluginId}.`, routes, ref);
  }
}
