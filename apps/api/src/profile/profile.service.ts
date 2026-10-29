import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { UsersService } from '../users/users.service.js';
import { currentBranch, workspaceMode } from '../workspace/context.js';
import { BASE_FIELDS, CORE_PROFILE_SETTINGS_ID, CatalogField, Context, EffectiveField, ProfileConfig, checkValue, effectiveSchema, parseProfileConfig, settingFor, toCatalog, validateProfileConfig } from './fields.js';
import { ProfileValueStore, Values } from './store.js';

export const PROFILE_STORE = 'PROFILE_VALUE_STORE';
const SUBJECT = /^[A-Za-z0-9._@-]{1,64}$/;

@Injectable()
export class ProfileService {
  constructor(@Inject(PluginRegistry) private readonly reg: PluginRegistry, @Inject(PROFILE_STORE) private readonly store: ProfileValueStore, @Optional() private readonly branches?: BranchRegistries, @Optional() private readonly users?: UsersService) {}

  private async registry(ref: 'live' | 'work', write = false): Promise<PluginRegistry> {
    if (!workspaceMode()) return this.reg;
    return this.branches!.get(ref === 'live' ? 'main' : currentBranch(write));
  }
  /** Base fields plus the fields of the plugins that are active in that registry. */
  async catalogue(tenant: string, ref: 'live' | 'work'): Promise<CatalogField[]> {
    const r = await this.registry(ref);
    return [...BASE_FIELDS, ...r.profileFields(tenant).flatMap((p) => toCatalog(p.plugin, p.fields))];
  }
  async config(tenant: string, ref: 'live' | 'work'): Promise<ProfileConfig> { return parseProfileConfig(await (await this.registry(ref)).coreSettings(tenant, CORE_PROFILE_SETTINGS_ID)); }
  async saveConfig(tenant: string, input: unknown): Promise<ProfileConfig> {
    const cfg = validateProfileConfig(input, await this.catalogue(tenant, 'work'));
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
  /** The user's own profile, as the LIVE configuration shows it. The subject always comes from the token. */
  async self(tenant: string, sub: string) { await this.subject(tenant, sub, 'live'); return this.visible(tenant, 'self', 'live', await this.store.get(tenant, sub, 'live')); }
  async patchSelf(tenant: string, sub: string, input: unknown) {
    await this.subject(tenant, sub, 'live');
    const changes = await this.check(tenant, 'live', 'self', input);
    await this.store.put(tenant, sub, changes, 'live', sub);
    return this.self(tenant, sub);
  }
  async admin(tenant: string, id: string) { await this.subject(tenant, id, 'work'); return this.visible(tenant, 'admin', 'work', await this.store.get(tenant, id, 'work')); }
  async patchAdmin(tenant: string, id: string, input: unknown, actor: string) {
    await this.subject(tenant, id, 'work');
    const changes = await this.check(tenant, 'work', 'admin', input);
    await this.store.put(tenant, id, changes, 'work', actor);
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
}
