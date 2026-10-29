import type { Connection } from 'mysql2/promise';
import { VersioningService } from '../versioning/versioning.service.js';

export type Values = Record<string, string | number | boolean>;
/** Where the values people enter live. `ref` is 'live' (what sign-in and self-service use) or 'work' (the selected working branch). */
export interface ProfileValueStore {
  get(tenant: string, subject: string, ref: 'live' | 'work'): Promise<Values>;
  /** `null` deletes the value. Live writes are the user's own edits; work writes are an administrator's, on the working branch until Apply. */
  put(tenant: string, subject: string, changes: Record<string, string | number | boolean | null>, ref: 'live' | 'work', actor: string): Promise<void>;
}

export class MemoryProfileStore implements ProfileValueStore {
  private rows = new Map<string, Values>();
  private k = (t: string, s: string, ref: string) => `${ref === 'live' ? 'live' : 'work'}/${t}/${s}`;
  async get(t: string, s: string, ref: 'live' | 'work') { return { ...(this.rows.get(this.k(t, s, ref)) ?? this.rows.get(this.k(t, s, 'live')) ?? {}) }; }
  async put(t: string, s: string, changes: Record<string, string | number | boolean | null>, ref: 'live' | 'work') {
    const cur = await this.get(t, s, ref);
    for (const [k, v] of Object.entries(changes)) { if (v === null) delete cur[k]; else cur[k] = v; }
    this.rows.set(this.k(t, s, ref), cur);
  }
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
}
