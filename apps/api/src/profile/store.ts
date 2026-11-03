import type { Connection } from 'mysql2/promise';
import { ConflictException } from '@nestjs/common';
import { VersioningService } from '../versioning/versioning.service.js';
import { applyContext } from '../workspace/context.js';

export type Values = Record<string, string | number | boolean>;
/** Where the values people enter live. `ref` is 'live' (what sign-in and self-service use) or 'work' (the selected working branch). */
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
}
/** Dolt branch of one person's pending profile edits. Reversible encoding: [a-z0-9-] kept, every other character becomes _hh (hex). */
/** Pending change set of one person against one base branch: 'main' keeps the historical name, any other base is encoded after a ';'. */
export const pendingBranch = (subject: string, base = 'main') => { const key = base === 'main' ? subject : subject + ';' + base; const b = 'profile-' + [...key].map((c) => (/[a-z0-9-]/.test(c) ? c : '_' + c.charCodeAt(0).toString(16).padStart(2, '0'))).join(''); if (b.length > 63) throw new Error('subject too long for a personal branch'); return b; };
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
}

/**
 * Dolt-backed values (the POC choice, see docs/profile-fields.md decision 1). Dolt history keeps every value, so this is for FICTIONAL data only.
 * Live edits (a user's own) are committed straight to main; an administrator's edits go to the working branch and reach main at Apply.
 */
export class DoltProfileStore implements ProfileValueStore {
  constructor(private readonly v: VersioningService, private readonly workBranch: (write: boolean) => string) {}
  private async ensure(c: Connection) {
    await c.query('create table if not exists profile_field_values (tenant varchar(32) not null, subject varchar(32) not null, field_key varchar(80) not null, value json not null, primary key (tenant, subject, field_key))');
  }
  private async commit(c: Connection, msg: string) {
    const [d] = await c.query("select table_name from dolt_status where table_name='profile_field_values'");
    if ((d as unknown[]).length) { await c.query("call dolt_add('profile_field_values')"); await c.query("call dolt_commit('-m', ?)", [msg]); }
  }
  async get(t: string, s: string, ref: 'live' | 'work'): Promise<Values> {
    return this.v.at(ref === 'live' ? 'main' : this.workBranch(false), async (c) => {
      const [ex] = await c.query("select count(*) n from information_schema.tables where table_schema=database() and table_name='profile_field_values'");
      if (!Number((ex as { n: number }[])[0].n)) return {};
      const [r] = await c.query('select field_key, value from profile_field_values where tenant=? and subject=?', [t, s]);
      return Object.fromEntries((r as { field_key: string; value: unknown }[]).map((x) => [x.field_key, x.value])) as Values;
    });
  }
  async put(t: string, s: string, changes: Record<string, string | number | boolean | null>, ref: 'live' | 'work', actor: string) {
    const run = async (c: Connection) => {
      await this.ensure(c);
      for (const [k, val] of Object.entries(changes)) {
        if (val === null) await c.query('delete from profile_field_values where tenant=? and subject=? and field_key=?', [t, s, k]);
        else await c.query('insert into profile_field_values values (?,?,?,?) on duplicate key update value=values(value)', [t, s, k, JSON.stringify(val)]);
      }
      await this.commit(c, `profile: ${actor} edited ${s} (${Object.keys(changes).join(', ')})`);
    };
    if (ref === 'live') await this.v.lock(() => this.v.at('main', run));
    else await this.v.writeOn(this.workBranch(true), run);
  }
  /** The personal branch is cut from the base (main, or the tested branch in a branch test) on first use and reused for later edits against the same base. */
  async putPending(t: string, s: string, changes: Record<string, string | number | boolean | null>, actor: string, base = 'main') {
    const b = pendingBranch(s, base);
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
    const b = pendingBranch(s, base);
    if (!(await this.v.branches()).branches.some((x) => x.name === b)) return {};
    const read = (ref: string) => this.v.at(ref, async (c) => { const [r] = await c.query('select field_key, value from profile_field_values where tenant=? and subject=?', [t, s]); return Object.fromEntries((r as { field_key: string; value: unknown }[]).map((x) => [x.field_key, x.value])) as Values; });
    const [main, mine] = [await read(base), await read(b)];
    const out: Record<string, string | number | boolean | null> = {};
    for (const k of new Set([...Object.keys(main), ...Object.keys(mine)])) if (JSON.stringify(main[k]) !== JSON.stringify(mine[k])) out[k] = k in mine ? mine[k] : null;
    return out;
  }
  async listPending(_t: string) {
    return (await this.v.branches()).branches.filter((x) => x.name.startsWith('profile-')).map((x) => { const d = subjectOfBranch(x.name); const i = d.lastIndexOf(';'); return i < 0 ? { subject: d, base: 'main' } : { subject: d.slice(0, i), base: d.slice(i + 1) }; });
  }
  async resolvePending(t: string, s: string, accept: boolean, actor: string, base = 'main') {
    const b = pendingBranch(s, base);
    if (accept) {
      const r = await applyContext.run(true, () => this.v.mergeInto(b, base, `profile: ${actor} accepted the pending edits of ${s}`, actor));
      if (!r.mergeable || !r.commit) throw new ConflictException(`cannot merge: ${r.reasons.join('; ')}`);
    }
    await this.v.deleteBranch(b, async () => false);
  }
}
