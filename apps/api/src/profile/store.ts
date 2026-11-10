import type { Connection } from 'mysql2/promise';
import { ConflictException } from '@nestjs/common';
import { VersioningService } from '../versioning/versioning.service.js';
import { applyContext } from '../workspace/context.js';

export type Values = Record<string, string | number | boolean>;
/** Routing of one field to a plugin-owned table (the plugin's install migrations create it; uninstall drops it). */
export interface FieldRoute { fullKey: string; type: string; table: string; column: string }
export interface ProfileValueStore {
  get(tenant: string, subject: string, ref: 'live' | 'work'): Promise<Values>;
  /** `null` deletes the value. Live writes are the user's own edits; work writes are an administrator's, on the working branch until Apply. */
  put(tenant: string, subject: string, changes: Record<string, string | number | boolean | null>, ref: 'live' | 'work', actor: string): Promise<void>;
  /** Personal-branch review mode: one pending change set per person and base branch, kept apart from it until a validator accepts it. base is 'main' normally, the tested branch in a branch test. */
  putPending(tenant: string, subject: string, changes: Record<string, string | number | boolean | null>, actor: string, base?: string): Promise<void>;
  /** Values a person has proposed against a base (key -> new value, null = removal). Empty when nothing is pending. */
  pending(tenant: string, subject: string, base?: string): Promise<Record<string, string | number | boolean | null>>;
  listPending(tenant: string): Promise<{ subject: string; base: string }[]>;
  /** Accepts: merges the personal change set into its base and removes it. Refuses: removes it. */
  resolvePending(tenant: string, subject: string, accept: boolean, actor: string, base?: string): Promise<void>;
  /** How much profile data a plugin holds for a tenant (legacy rows under its key prefix plus filled columns of its tables). Feeds the uninstall confirmation. */
  countForPlugin?(tenant: string, keyPrefix: string, routes: FieldRoute[], ref: 'live' | 'work'): Promise<number>;
  /** Moves legacy generic-store rows into a plugin's own tables (declared storage adopted at install/enable). Returns the number of moved values. */
  adopt?(tenant: string, routes: FieldRoute[]): Promise<number>;
}
/** Dolt branch of one person's pending profile edits. Reversible encoding: [a-z0-9-] kept, every other character becomes _hh (hex). */
/** Pending change set of one person against one base branch: 'main' keeps the historical name, any other base is encoded after a ';'. */
/** New pending branches are profile/<subject>; a pending branch created before the folder convention (profile-<subject>) keeps being used while it exists. */
export const pendingBranch = (subject: string, base = 'main', existing?: ReadonlySet<string>) => { const key = base === 'main' ? subject : subject + ';' + base; const b = 'profile/' + [...key].map((c) => (/[a-z0-9-]/.test(c) ? c : '_' + c.charCodeAt(0).toString(16).padStart(2, '0'))).join(''); if (b.length > 63) throw new Error('subject too long for a personal branch'); return existing && !existing.has(b) && existing.has('profile-' + b.slice('profile/'.length)) ? 'profile-' + b.slice('profile/'.length) : b; };
export const subjectOfBranch = (b: string) => b.slice('profile-'.length).replace(/_([0-9a-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));

export class MemoryProfileStore implements ProfileValueStore {
  private rows = new Map<string, Values>();
  private k = (t: string, s: string, ref: string) => `${ref === 'live' ? 'live' : 'work'}/${t}/${s}`;
  async get(t: string, s: string, ref: 'live' | 'work') { return { ...(this.rows.get(this.k(t, s, ref)) ?? this.rows.get(this.k(t, s, 'live')) ?? {}) }; }
  async put(t: string, s: string, changes: Record<string, string | number | boolean | null>, ref: 'live' | 'work') {
    const cur = await this.get(t, s, ref);
    for (const [k, v] of Object.entries(changes)) { if (v === null) delete cur[k]; else cur[k] = v; }
    this.rows.set(this.k(t, s, ref), cur);
  }
  private pend = new Map<string, Record<string, string | number | boolean | null>>();
  private pk = (t: string, s: string, base: string) => `${base}/${t}/${s}`;
  async putPending(t: string, s: string, changes: Record<string, string | number | boolean | null>, actor: string, base = 'main') { this.pend.set(this.pk(t, s, base), { ...(this.pend.get(this.pk(t, s, base)) ?? {}), ...changes }); }
  async pending(t: string, s: string, base = 'main') { return { ...(this.pend.get(this.pk(t, s, base)) ?? {}) }; }
  async listPending(t: string) { return [...this.pend.keys()].filter((k) => k.split('/')[1] === t).map((k) => { const [base, , ...rest] = k.split('/'); return { subject: rest.join('/'), base }; }); }
  async resolvePending(t: string, s: string, accept: boolean, actor: string, base = 'main') { const ch = this.pend.get(this.pk(t, s, base)) ?? {}; this.pend.delete(this.pk(t, s, base)); if (accept) await this.put(t, s, ch, base === 'main' ? 'live' : 'work'); void actor; }
  async countForPlugin(t: string, keyPrefix: string): Promise<number> {
    let n = 0;
    for (const [k, vals] of this.rows) if (k.split('/')[1] === t) for (const key of Object.keys(vals)) if (key.startsWith(keyPrefix)) n++;
    return n;
  }
  async adopt(): Promise<number> { return 0; }
}

/**
 * Dolt-backed values (the POC choice, see docs/profile-fields.md decision 1). Dolt history keeps every value, so this is for FICTIONAL data only.
 * Live edits (a user's own) are committed straight to main; an administrator's edits go to the working branch and reach main at Apply.
 * Fields whose declaration maps storage to a plugin-owned table are routed there (one row per tenant+subject, one
 * column per field); everything else keeps the generic row store. The routing comes from the live catalogue, wired
 * by the module (setCatalogue) so the store never imports the registry.
 */
export class DoltProfileStore implements ProfileValueStore {
  private catalogueFn?: (tenant: string, ref: 'live' | 'work') => Promise<FieldRoute[]>;
  constructor(private readonly v: VersioningService, private readonly workBranch: (write: boolean) => string) {}
  /** The module wires the catalogue AFTER construction (ProfileService needs the store, the catalogue needs the registry). */
  setCatalogue(fn: (tenant: string, ref: 'live' | 'work') => Promise<FieldRoute[]>) { this.catalogueFn = fn; }
  private async routes(t: string, ref: 'live' | 'work'): Promise<FieldRoute[]> { return (await this.catalogueFn?.(t, ref)) ?? []; }
  private async ensure(c: Connection) {
    await c.query('create table if not exists profile_field_values (tenant varchar(32) not null, subject varchar(32) not null, field_key varchar(80) not null, value json not null, primary key (tenant, subject, field_key))');
  }
  private async commit(c: Connection, msg: string, tables: string[] = ['profile_field_values']) {
    const names = tables.map((x) => `'${x}'`).join(',');
    const [d] = await c.query(`select table_name from dolt_status where table_name in (${names})`);
    for (const t of (d as { table_name: string }[])) { await c.query('call dolt_add(?)', [t.table_name]); }
    if ((d as unknown[]).length) await c.query("call dolt_commit('-m', ?)", [msg]);
  }
  /** value <-> SQL cell (booleans as 0/1, numbers as numbers, strings - incl. image data URLs - as text). */
  private cell(route: FieldRoute, v: string | number | boolean | null): unknown {
    if (v === null) return null;
    if (route.type === 'boolean') return v ? 1 : 0;
    return v;
  }
  private fromCell(route: FieldRoute, v: unknown): string | number | boolean {
    if (route.type === 'boolean') return v === 1 || v === true || v === '1';
    if (route.type === 'number') return Number(v);
    return String(v);
  }
  private async tableExists(c: Connection, table: string): Promise<boolean> {
    const [ex] = await c.query('select count(*) n from information_schema.tables where table_schema=database() and table_name=?', [table]);
    return !!Number((ex as { n: number }[])[0].n);
  }
  async get(t: string, s: string, ref: 'live' | 'work'): Promise<Values> {
    const routes = await this.routes(t, ref);
    return this.v.at(ref === 'live' ? 'main' : this.workBranch(false), async (c) => {
      const out: Values = {};
      if (await this.tableExists(c, 'profile_field_values')) {
        const [r] = await c.query('select field_key, value from profile_field_values where tenant=? and subject=?', [t, s]);
        for (const x of r as { field_key: string; value: unknown }[]) out[x.field_key] = x.value as string | number | boolean;
      }
      const byTable = new Map<string, FieldRoute[]>();
      for (const r of routes) byTable.set(r.table, [...(byTable.get(r.table) ?? []), r]);
      for (const [table, rs] of byTable) {
        if (!(await this.tableExists(c, table))) continue; // not installed on this branch yet: nothing to read
        const [rows] = await c.query(`select ${rs.map((r) => `\`${r.column}\``).join(', ')} from \`${table}\` where tenant=? and subject=?`, [t, s]);
        const row = (rows as Record<string, unknown>[])[0];
        if (!row) continue;
        for (const r of rs) if (row[r.column] !== null && row[r.column] !== undefined) out[r.fullKey] = this.fromCell(r, row[r.column]);
      }
      return out;
    });
  }
  async put(t: string, s: string, changes: Record<string, string | number | boolean | null>, ref: 'live' | 'work', actor: string) {
    const routes = await this.routes(t, ref);
    const run = async (c: Connection) => {
      await this.ensure(c);
      const touched = new Set<string>();
      const mapped = new Map<string, { route: FieldRoute; val: string | number | boolean | null }[]>();
      for (const [k, val] of Object.entries(changes)) {
        const route = routes.find((r) => r.fullKey === k);
        if (route) mapped.set(route.table, [...(mapped.get(route.table) ?? []), { route, val }]);
        else {
          if (val === null) await c.query('delete from profile_field_values where tenant=? and subject=? and field_key=?', [t, s, k]);
          else await c.query('insert into profile_field_values values (?,?,?,?) on duplicate key update value=values(value)', [t, s, k, JSON.stringify(val)]);
          touched.add('profile_field_values');
        }
      }
      for (const [table, entries] of mapped) {
        if (!(await this.tableExists(c, table))) throw new ConflictException(`profile storage table ${table} is missing: install the owning plugin on this branch first`);
        const cols = entries.map((e) => `\`${e.route.column}\``);
        await c.query(
          `insert into \`${table}\` (tenant, subject, ${cols.join(', ')}) values (?,?,${entries.map(() => '?').join(',')}) on duplicate key update ${entries.map((e) => `\`${e.route.column}\`=values(\`${e.route.column}\`)`).join(', ')}`,
          [t, s, ...entries.map((e) => this.cell(e.route, e.val))]);
        touched.add(table);
      }
      // profile_field_values is always in the commit set: ensure() may have just created it on this branch, and
      // leaving the CREATE uncommitted would block the next Apply ("uncommitted changes from another session").
      // commit() only stages tables that actually appear in dolt_status, so an unchanged legacy table is a no-op.
      await this.commit(c, `profile: ${actor} edited ${s} (${Object.keys(changes).join(', ')})`, [...new Set(['profile_field_values', ...touched])]);
    };
    if (ref === 'live') await this.v.lock(() => this.v.at('main', run));
    else await this.v.writeOn(this.workBranch(true), run);
  }
  async adopt(t: string, routes: FieldRoute[]): Promise<number> {
    if (!routes.length) return 0;
    return this.v.lock(() => this.v.at('main', async (c) => {
      if (!(await this.tableExists(c, 'profile_field_values'))) return 0;
      const [rows] = await c.query(`select subject, field_key, value from profile_field_values where tenant=? and field_key in (${routes.map(() => '?').join(',')})`, [t, ...routes.map((r) => r.fullKey)]);
      let moved = 0;
      const touched = new Set<string>(['profile_field_values']);
      for (const row of rows as { subject: string; field_key: string; value: unknown }[]) {
        const route = routes.find((r) => r.fullKey === row.field_key)!;
        if (!(await this.tableExists(c, route.table))) continue; // the owning plugin is not installed on main yet
        // mysql2 usually returns a JSON column already parsed; some setups hand back the raw text. Accept both.
        const val = typeof row.value === 'string' ? (() => { try { return JSON.parse(row.value); } catch { return row.value; } })() : row.value;
        await c.query(`insert into \`${route.table}\` (tenant, subject, \`${route.column}\`) values (?,?,?) on duplicate key update \`${route.column}\`=values(\`${route.column}\`)`, [t, row.subject, this.cell(route, val as string | number | boolean)]);
        await c.query('delete from profile_field_values where tenant=? and subject=? and field_key=?', [t, row.subject, row.field_key]);
        touched.add(route.table);
        moved++;
      }
      if (moved) await this.commit(c, `profile: adopted ${moved} legacy values into plugin tables`, [...touched]);
      return moved;
    }));
  }
  async countForPlugin(t: string, keyPrefix: string, routes: FieldRoute[], ref: 'live' | 'work'): Promise<number> {
    return this.v.at(ref === 'live' ? 'main' : this.workBranch(false), async (c) => {
      let n = 0;
      if (await this.tableExists(c, 'profile_field_values')) {
        const [r] = await c.query('select count(*) n from profile_field_values where tenant=? and field_key like ?', [t, `${keyPrefix}%`]);
        n += Number((r as { n: number }[])[0].n);
      }
      const byTable = new Map<string, FieldRoute[]>();
      for (const r of routes) byTable.set(r.table, [...(byTable.get(r.table) ?? []), r]);
      for (const [table, rs] of byTable) {
        if (!(await this.tableExists(c, table))) continue;
        const anyFilled = rs.map((r) => `\`${r.column}\` is not null`).join(' or ');
        const [rows] = await c.query(`select count(*) n from \`${table}\` where tenant=? and (${anyFilled})`, [t]);
        n += Number((rows as { n: number }[])[0].n);
      }
      return n;
    });
  }
  /** The personal branch is cut from the base (main, or the tested branch in a branch test) on first use and reused for later edits against the same base. */
  async putPending(t: string, s: string, changes: Record<string, string | number | boolean | null>, actor: string, base = 'main') {
    const b = pendingBranch(s, base, new Set((await this.v.branches()).branches.map((x) => x.name)));
    await this.v.lock(() => this.v.at('main', async (c) => { await this.ensure(c); await this.commit(c, 'profile: values table'); }));
    const have = (await this.v.branches()).branches.some((x) => x.name === b);
    if (!have) await this.v.createBranch(b, base);
    await this.v.lock(() => this.v.at(b, async (c) => {
      await this.ensure(c);
      for (const [k, val] of Object.entries(changes)) {
        if (val === null) await c.query('delete from profile_field_values where tenant=? and subject=? and field_key=?', [t, s, k]);
        else await c.query('insert into profile_field_values values (?,?,?,?) on duplicate key update value=values(value)', [t, s, k, JSON.stringify(val)]);
      }
      await this.commit(c, `profile (pending review): ${actor} proposed ${Object.keys(changes).join(', ')}`);
    }));
  }
  async pending(t: string, s: string, base = 'main') {
    const b = pendingBranch(s, base, new Set((await this.v.branches()).branches.map((x) => x.name)));
    if (!(await this.v.branches()).branches.some((x) => x.name === b)) return {};
    const read = (ref: string) => this.v.at(ref, async (c) => { const [r] = await c.query('select field_key, value from profile_field_values where tenant=? and subject=?', [t, s]); return Object.fromEntries((r as { field_key: string; value: unknown }[]).map((x) => [x.field_key, x.value])) as Values; });
    const [main, mine] = [await read(base), await read(b)];
    const out: Record<string, string | number | boolean | null> = {};
    for (const k of new Set([...Object.keys(main), ...Object.keys(mine)])) if (JSON.stringify(main[k]) !== JSON.stringify(mine[k])) out[k] = k in mine ? mine[k] : null;
    return out;
  }
  async listPending(_t: string) {
    return (await this.v.branches()).branches.filter((x) => (x.name.startsWith('profile-') || x.name.startsWith('profile/'))).map((x) => { const d = subjectOfBranch(x.name); const i = d.lastIndexOf(';'); return i < 0 ? { subject: d, base: 'main' } : { subject: d.slice(0, i), base: d.slice(i + 1) }; });
  }
  async resolvePending(t: string, s: string, accept: boolean, actor: string, base = 'main') {
    const b = pendingBranch(s, base, new Set((await this.v.branches()).branches.map((x) => x.name)));
    if (accept) {
      const r = await applyContext.run(true, () => this.v.mergeInto(b, base, `profile: ${actor} accepted the pending edits of ${s}`, actor));
      if (!r.mergeable || !r.commit) throw new ConflictException(`cannot merge: ${r.reasons.join('; ')}`);
    }
    await this.v.deleteBranch(b, async () => false);
  }
}
