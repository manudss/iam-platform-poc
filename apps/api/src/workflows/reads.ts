import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { VersioningService } from '../versioning/versioning.service.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { branchContext, workspaceMode } from '../workspace/context.js';
import { MailTemplatesService } from '../mail/mail-templates.js';
import { BrandingService } from '../branding/branding.service.js';
import { CORE_SETTINGS_ID, parseStored } from '../authn/config.js';

const clamp = (v: unknown, dflt: number, max: number) => Math.min(max, Math.max(1, Number.isFinite(Number(v)) ? Math.floor(Number(v)) : dflt));
const LIKE = (q: string) => `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;

/**
 * Business READS for workflow blocks (P0 "read and search the Lyam objects"). Everything here reads the
 * VERSIONED data through the same tables the admin services use, on an explicit ref (the run's base
 * branch or its own working branch) - never a free-form SQL string coming from a block config: the block
 * picks a read, the service owns the query. Outputs are typed and capped (pagination).
 */
@Injectable()
export class WorkflowReads {
  constructor(@Optional() private readonly v?: VersioningService, @Optional() private readonly reg?: PluginRegistry, @Optional() private readonly branches?: BranchRegistries, @Optional() private readonly mail?: MailTemplatesService, @Optional() private readonly branding?: BrandingService) {}

  private db<T>(ref: string, fn: (c: { query: (sql: string, p?: unknown[]) => Promise<[unknown, unknown]> }) => Promise<T>): Promise<T> {
    if (!this.v) throw new BadRequestException('no database');
    return this.v.at(ref, fn as never);
  }
  private static has(rows: unknown): boolean { return Number(((rows as { n: number }[])[0] ?? { n: 0 }).n) > 0; }

  /** Optional identity columns differ per schema (the demo has neither email nor login_enabled): probe once
   *  per call, never assume. */
  private async identityColumns(c: { query: (sql: string, params?: unknown[]) => Promise<[unknown, unknown]> }): Promise<Set<string>> {
    const [r] = await c.query("select column_name from information_schema.columns where table_schema = database() and table_name = 'identities'");
    return new Set((r as { column_name: string }[]).map((x) => x.column_name));
  }

  async readUser(tenant: string, ref: string, id: string) {
    return this.db(ref, async (c) => {
      const cols = await this.identityColumns(c);
      const opt = ['email', 'login_enabled'].filter((x) => cols.has(x));
      const [u] = await c.query(`select id, display_name, department, manager_id${opt.length ? ', ' + opt.join(', ') : ''} from identities where id = ?`, [id]);
      const user = (u as Record<string, unknown>[])[0];
      if (!user) throw new BadRequestException(`unknown identity "${id}"`);
      const [roles] = await c.query('select role_id from assignments where identity_id = ? order by role_id', [id]);
      let fields: Record<string, unknown> = {};
      try {
        const [fv] = await c.query('select field_key, value from profile_field_values where tenant = ? and subject = ? order by field_key limit 200', [tenant, id]);
        for (const r of fv as { field_key: string; value: unknown }[]) fields[r.field_key] = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
      } catch { /* profile values table absent on this branch: no values */ }
      return { id: String(user.id), displayName: String(user.display_name ?? ''), department: user.department === null ? null : String(user.department), manager: user.manager_id === null ? null : String(user.manager_id), email: !cols.has('email') || user.email === null ? null : String(user.email), loginEnabled: !cols.has('login_enabled') ? null : !!user.login_enabled, roles: (roles as { role_id: string }[]).map((r) => r.role_id), profileFields: fields };
    });
  }

  async listUsers(tenant: string, ref: string, f: { query?: string; department?: string; manager?: string; limit?: number; offset?: number }) {
    return this.db(ref, async (c) => {
      const cols = await this.identityColumns(c);
      const where = ['1=1'], vals: unknown[] = [];
      if (f.query) { const q = cols.has('email') ? '(id like ? escape \'\\\\\' or display_name like ? escape \'\\\\\' or email like ? escape \'\\\\\')' : '(id like ? escape \'\\\\\' or display_name like ? escape \'\\\\\')'; where.push(q); vals.push(LIKE(f.query), LIKE(f.query)); if (cols.has('email')) vals.push(LIKE(f.query)); }
      if (f.department) { where.push('department = ?'); vals.push(f.department); }
      if (f.manager) { where.push('manager_id = ?'); vals.push(f.manager); }
      const limit = clamp(f.limit, 50, 200), offset = Math.max(0, Number(f.offset) || 0);
      const opt = ['email', 'login_enabled'].filter((x) => cols.has(x));
      const [rows] = await c.query(`select id, display_name, department, manager_id${opt.length ? ', ' + opt.join(', ') : ''} from identities where ${where.join(' and ')} order by id limit ? offset ?`, [...vals, limit, offset]);
      const [cnt] = await c.query(`select count(*) n from identities where ${where.join(' and ')}`, vals);
      return { count: Number((cnt as { n: number }[])[0].n), users: (rows as Record<string, unknown>[]).map((u) => ({ id: String(u.id), displayName: String(u.display_name ?? ''), department: u.department === null ? null : String(u.department), manager: u.manager_id === null ? null : String(u.manager_id), email: !cols.has('email') || u.email === null ? null : String(u.email), loginEnabled: !cols.has('login_enabled') ? null : !!u.login_enabled })) };
    });
  }

  async listRoles(ref: string) {
    return this.db(ref, async (c) => {
      const [roles] = await c.query('select r.id, r.label, r.is_sensitive, (select count(*) from assignments a where a.role_id = r.id) as assigned from roles r order by r.id');
      const [sod] = await c.query('select role_a, role_b from sod_rules order by role_a, role_b');
      return { roles: (roles as Record<string, unknown>[]).map((r) => ({ id: String(r.id), label: String(r.label ?? ''), sensitive: !!r.is_sensitive, assigned: Number(r.assigned) })), sodRules: (sod as { role_a: string; role_b: string }[]).map((r) => ({ roleA: r.role_a, roleB: r.role_b })) };
    });
  }

  async listAssignments(ref: string, f: { identity?: string; role?: string; limit?: number; offset?: number }) {
    return this.db(ref, async (c) => {
      const where = ['1=1'], vals: unknown[] = [];
      if (f.identity) { where.push('identity_id = ?'); vals.push(f.identity); }
      if (f.role) { where.push('role_id = ?'); vals.push(f.role); }
      const limit = clamp(f.limit, 200, 1000), offset = Math.max(0, Number(f.offset) || 0);
      const [rows] = await c.query(`select identity_id, role_id from assignments where ${where.join(' and ')} order by identity_id, role_id limit ? offset ?`, [...vals, limit, offset]);
      const [cnt] = await c.query(`select count(*) n from assignments where ${where.join(' and ')}`, vals);
      return { count: Number((cnt as { n: number }[])[0].n), assignments: (rows as { identity_id: string; role_id: string }[]).map((a) => ({ identity: a.identity_id, role: a.role_id })) };
    });
  }

  /** The SoD conflicts a hypothetical assignment change would produce, computed on the ref (no write). */
  async simulateAssignments(ref: string, grant: { identity: string; role: string }[], revoke: { identity: string; role: string }[]) {
    return this.db(ref, async (c) => {
      const current = new Set(((await c.query('select identity_id, role_id from assignments'))[0] as { identity_id: string; role_id: string }[]).map((a) => `${a.identity_id}|${a.role_id}`));
      const [roles] = await c.query('select id from roles');
      const knownRoles = new Set((roles as { id: string }[]).map((r) => r.id));
      const [idents] = await c.query('select id from identities');
      const knownIds = new Set((idents as { id: string }[]).map((r) => r.id));
      for (const g of grant) {
        if (!knownIds.has(g.identity)) throw new BadRequestException(`simulate: unknown identity "${g.identity}"`);
        if (!knownRoles.has(g.role)) throw new BadRequestException(`simulate: unknown role "${g.role}"`);
        current.add(`${g.identity}|${g.role}`);
      }
      for (const r of revoke) current.delete(`${r.identity}|${r.role}`);
      const [sod] = await c.query('select role_a, role_b from sod_rules');
      const conflicts: { identity: string; roleA: string; roleB: string }[] = [];
      const byIdentity = new Map<string, string[]>();
      for (const key of current) { const [i, r] = key.split('|'); const l = byIdentity.get(i) ?? []; l.push(r); byIdentity.set(i, l); }
      for (const [identity, rs] of byIdentity) for (const rule of sod as { role_a: string; role_b: string }[]) if (rs.includes(rule.role_a) && rs.includes(rule.role_b)) conflicts.push({ identity, roleA: rule.role_a, roleB: rule.role_b });
      return { changes: { granted: grant.length, revoked: revoke.length }, conflicts, conflictsCount: conflicts.length };
    });
  }

  async listOrganizations(tenant: string, ref: string) {
    return this.db(ref, async (c) => {
      const [ex] = await c.query("select count(*) n from information_schema.tables where table_schema=database() and table_name in ('organizations','org_memberships')");
      if (!WorkflowReads.has(ex)) return { orgs: [], members: [] };
      const [o] = await c.query('select id, name, parent_id from organizations where tenant = ? order by id', [tenant]);
      const [m] = await c.query('select subject, org_id from org_memberships where tenant = ? order by subject, org_id', [tenant]);
      return { orgs: (o as Record<string, unknown>[]).map((x) => ({ id: String(x.id), name: String(x.name ?? ''), parent: x.parent_id === null ? null : String(x.parent_id) })), members: (m as { subject: string; org_id: string }[]).map((x) => ({ subject: x.subject, org: x.org_id })) };
    });
  }

  async listApplications(tenant: string, ref: string) {
    return this.db(ref, async (c) => {
      const [ex] = await c.query("select count(*) n from information_schema.tables where table_schema=database() and table_name = 'app_connectors'");
      if (!WorkflowReads.has(ex)) return { applications: [] };
      const [rows] = await c.query('select id, name, description, protocol, enabled, config from app_connectors where tenant = ? order by id', [tenant]);
      return { applications: (rows as Record<string, unknown>[]).map((a) => { const cfg = typeof a.config === 'string' ? JSON.parse(a.config) : (a.config ?? {}); return { id: String(a.id), name: String(a.name ?? ''), description: String(a.description ?? ''), protocol: String(a.protocol ?? ''), enabled: !!a.enabled, allowedRoles: Array.isArray(cfg.allowed_roles) ? cfg.allowed_roles.map(String) : [], launchUrl: cfg.launch_url ? String(cfg.launch_url) : null }; }) };
    });
  }

  /** The profile schema as configured (declared fields + their admin settings), never the values. */
  async profileSchema(tenant: string, ref: string) {
    return this.db(ref, async (c) => {
      let settings: Record<string, unknown> = {};
      try {
        const [rows] = await c.query('select settings from plugin_settings where tenant = ? and plugin = ?', [tenant, 'hr-attributes']);
        const row = (rows as { settings: unknown }[])[0];
        if (row) settings = typeof row.settings === 'string' ? JSON.parse(row.settings) : (row.settings as Record<string, unknown>) ?? {};
      } catch { /* settings table absent: the catalog defaults apply */ }
      let valueKeys: string[] = [];
      try { const [k] = await c.query('select distinct field_key from profile_field_values where tenant = ? order by field_key limit 500', [tenant]); valueKeys = (k as { field_key: string }[]).map((r) => r.field_key); } catch { /* none */ }
      return { settings, valueKeys };
    });
  }

  /** Plugin enablement and non-secret settings presence for the Plugins block (the registry is the authority). */
  async pluginStates(tenant: string, ref: string) {
    const registry = workspaceMode() && this.branches ? await this.branches.get(ref) : this.reg;
    if (!registry) return { plugins: [] };
    const out: { id: string; name: string; active: boolean; settingsKeys: string[] }[] = [];
    for (const p of registry.list(tenant)) {
      let keys: string[] = [];
      try { keys = Object.keys((await registry.settingsFor(tenant, p.id)) ?? {}).filter((k) => !/secret|password|token|key$/i.test(k)); } catch { /* unreadable: hidden */ }
      out.push({ id: p.id, name: p.name || p.id, active: p.enabled, settingsKeys: keys });
    }
    return { plugins: out };
  }

  /** The registry serving a ref (the branch registries in workspace mode, the live one otherwise). */
  private async branchRegistry(ref: string) {
    if (workspaceMode() && this.branches) return this.branches.get(ref);
    if (!this.reg) throw new BadRequestException('no plugin registry');
    return this.reg;
  }

  /** The authentication configuration on a ref, projected for a workflow: the structure of methods and
   *  chains with their levels, never a setting value (even masked secrets stay server-side). */
  async authnConfig(tenant: string, ref: string) {
    const reg = await this.branchRegistry(ref);
    const cfg = parseStored(await reg.coreSettings(tenant, CORE_SETTINGS_ID));
    return {
      methods: cfg.methods.map((m) => ({ id: m.id, type: m.type, name: m.name, enabled: m.enabled, level: m.level })),
      chains: cfg.chains.map((c) => ({ id: c.id, name: c.name, enabled: c.enabled, level: c.level, steps: c.steps })),
      defaultChain: cfg.defaultChain,
    };
  }

  /** The mail template catalogue with this tenant's customization state, read on a ref (never the bodies). */
  async listMailTemplates(tenant: string, ref: string) {
    if (!this.mail) throw new BadRequestException('mail templates unavailable on this server');
    const list = await branchContext.run({ branch: ref }, () => this.mail!.list(tenant));
    return { templates: list.map((t) => ({ key: t.key, plugin: t.plugin, name: t.name, layout: t.layout, customized: t.customized, variables: t.variables })) };
  }

  /** Renders a mail template WITHOUT saving (the editor's live preview), on a ref. Never sends a mail. */
  async previewMailTemplate(tenant: string, ref: string, key: string, data?: unknown, override?: unknown) {
    if (!this.mail) throw new BadRequestException('mail templates unavailable on this server');
    return branchContext.run({ branch: ref }, () => this.mail!.preview(tenant, { key, data, override }));
  }

  /** The branding provider id and its current settings on a ref. */
  async themeSettings(tenant: string, ref: string) {
    const reg = await this.branchRegistry(ref);
    const provider = reg.resolve(tenant, 'branding');
    return { provider: provider.manifest.id, settings: (await reg.settingsFor(tenant, provider.manifest.id)) ?? {} };
  }

  /** Validates a theme candidate against the branding module on a ref (contrast, SVG sanitization). Returns
   *  the validated values for a later write plus a display summary; never throws on an invalid candidate. */
  async validateTheme(tenant: string, ref: string, input: unknown) {
    if (!this.branding) throw new BadRequestException('branding unavailable on this server');
    const { provider } = await this.themeSettings(tenant, ref);
    try {
      const bundle = await this.branding.preview(tenant, (input ?? {}) as Record<string, unknown>, ref);
      const c = bundle.config as unknown as Record<string, unknown>;
      return { valid: true as const, provider, values: bundle.config as unknown as Record<string, unknown>, summary: { primaryColor: c.primaryColor ?? null, accentColor: c.accentColor ?? null, logoMode: c.logoMode ?? null }, version: bundle.version };
    } catch (e) {
      return { valid: false as const, provider, errors: [(e as Error).message] };
    }
  }
}
