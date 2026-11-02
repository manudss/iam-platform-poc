import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { UsersService } from '../users/users.service.js';
import { currentBranch, workspaceMode } from '../workspace/context.js';
import { BASE_FIELDS, CORE_PROFILE_SETTINGS_ID, CatalogField, Context, EffectiveField, ProfileConfig, checkValue, effectiveSchema, parseProfileConfig, settingFor, toCatalog, validateProfileConfig } from './fields.js';
import { ProfileValueStore, Values } from './store.js';
import { AppEvents } from '../events/app-events.service.js';

export const PROFILE_STORE = 'PROFILE_VALUE_STORE';
/** Public sign-up may only exist in the hosted workspace mode, where every administration route is guarded. Provided as a function so tests can exercise the open path without a Dolt-backed workspace. */
export const SIGNUP_ALLOWED = 'SIGNUP_ALLOWED';
export const defaultSignupAllowed = () => workspaceMode();
const SUBJECT = /^[A-Za-z0-9._@-]{1,64}$/;

@Injectable()
export class ProfileService {
  constructor(@Inject(PluginRegistry) private readonly reg: PluginRegistry, @Inject(PROFILE_STORE) private readonly store: ProfileValueStore, @Optional() private readonly branches?: BranchRegistries, @Optional() private readonly users?: UsersService, @Optional() @Inject(SIGNUP_ALLOWED) private readonly signupAllowed: () => boolean = defaultSignupAllowed, @Optional() private readonly events?: AppEvents) {}

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
  async config(tenant: string, ref: 'live' | 'work'): Promise<ProfileConfig> { return parseProfileConfig(await (await this.registry(ref)).coreSettings(tenant, CORE_PROFILE_SETTINGS_ID)); }
  async saveConfig(tenant: string, input: unknown): Promise<ProfileConfig> {
    const cfg = validateProfileConfig(input, await this.catalogue(tenant, 'work'));
    if (cfg.signup?.open && !this.signupAllowed()) throw new BadRequestException('public sign-up can only be opened in the hosted workspace mode (it is refused here, whatever the setting)');
    await (await this.registry('work', true)).putCoreSettings(tenant, CORE_PROFILE_SETTINGS_ID, cfg as unknown as Record<string, unknown>);
    return cfg;
  }
  async schema(tenant: string, ctx: Context, ref: 'live' | 'work'): Promise<EffectiveField[]> { return effectiveSchema(await this.catalogue(tenant, ref), await this.config(tenant, ref), ctx); }

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
    const live = await this.store.get(tenant, sub, ref), pending = ref === 'live' && policy === 'review' ? await this.store.pending(tenant, sub) : {};
    const shown = { ...(await this.baseValues(sub, ref)), ...live } as Record<string, unknown>; for (const [k, v] of Object.entries(pending)) { if (v === null) delete shown[k]; else shown[k] = v; }
    return { ...(await this.visible(tenant, 'self', ref, shown as Values)), policy, pending: Object.keys(pending), ...(ref === 'work' ? { branchTest: true as const } : {}) };
  }
  /** Immediate policy: live at once (main). Review policy: the edits wait on the person's own branch until a validator accepts them. */
  async patchSelf(tenant: string, sub: string, input: unknown, ref: 'live' | 'work' = 'live') {
    await this.subject(tenant, sub, ref);
    const changes = await this.check(tenant, ref, 'self', input);
    if (ref === 'work') {
      // Branch test: the edit is committed to the TESTED branch only, immediately. It never touches main or the shared
      // pending-review flow, whatever the configured policy; Apply remains the only way to publish anything.
      await this.store.put(tenant, sub, changes, 'work', sub);
      this.events?.emit({ type: 'profile.updated', tenant, branch: currentBranch(), at: new Date().toISOString(), payload: { subject: sub, keys: Object.keys(changes).join(','), actor: sub } });
      return { ...(await this.self(tenant, sub, ref)), note: 'branch test: written to the tested branch only; the review flow does not apply here' };
    }
    if (await this.selfEditPolicy(tenant) === 'review') await this.store.putPending(tenant, sub, changes, sub);
    else {
      await this.store.put(tenant, sub, changes, 'live', sub);
      this.events?.emit({ type: 'profile.updated', tenant, branch: 'main', at: new Date().toISOString(), payload: { subject: sub, keys: Object.keys(changes).join(','), actor: sub } });
    }
    return this.self(tenant, sub);
  }
  /** Validator view: who has pending edits and what would change (current live value next to the proposed one). Profile values only: no authority field can be in a pending set. */
  async reviews(tenant: string) {
    const out = [];
    for (const s of await this.store.listPending(tenant)) {
      const pend = await this.store.pending(tenant, s); if (!Object.keys(pend).length) continue;
      const live = await this.store.get(tenant, s, 'live'), cat = await this.catalogue(tenant, 'live');
      out.push({ subject: s, changes: Object.entries(pend).map(([k, to]) => ({ key: k, label: cat.find((c) => c.fullKey === k)?.label ?? k, from: live[k] ?? null, to })) });
    }
    return { policy: await this.selfEditPolicy(tenant), reviews: out };
  }
  /** A validator cannot accept their own edits (separation of duties). Accepting merges the personal branch into main, refusing deletes it. */
  async resolveReview(tenant: string, subject: string, accept: boolean, actor: string) {
    if (!SUBJECT.test(subject)) throw new BadRequestException('invalid user id');
    if (accept && subject === actor) throw new ForbiddenException('you cannot accept your own pending edits: another validator must');
    if (!Object.keys(await this.store.pending(tenant, subject)).length) throw new NotFoundException('nothing pending for this user');
    await this.store.resolvePending(tenant, subject, accept, actor);
    this.events?.emit({ type: 'profile.review-resolved', tenant, branch: 'main', at: new Date().toISOString(), payload: { subject, decision: accept ? 'accepted' : 'refused', actor } });
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
      const allowed = s.enabled && f.storage === 'values' && (ctx === 'self' ? s.selfEdit && f.klass === 'profile' : s.adminEdit);
      if (!allowed) throw new ForbiddenException(`${k} cannot be changed here`);
      out[k] = checkValue(f, v);
    }
    return out;
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
      out[k] = checkValue(cat.find((c) => c.fullKey === k)!, v);
    }
    for (const f of schema) if (f.required && (out[f.key] === undefined || out[f.key] === null || out[f.key] === '')) throw new BadRequestException(`${f.label} is required`);
    return out;
  }
  async putWorking(tenant: string, id: string, values: Record<string, string | number | boolean | null>, actor: string) { if (Object.keys(values).length) await this.store.put(tenant, id, values, 'work', actor); }
}
