import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createConnection, Connection } from 'mysql2/promise';
import { autoBranchName } from '../versioning/branch-kinds.js';
import { newBranchName } from '../versioning/guards.js';
import { PullRequestService } from '../versioning/pull-requests.service.js';
import { VersioningService } from '../versioning/versioning.service.js';

export type PersonalStatus = 'created' | 'reused' | 'refreshed' | 'recreated';
export interface PersonalBranch { branch: string; status: PersonalStatus; empty: boolean; aheadOfMain: number; behindMain: number }

/**
 * One automatic personal Dolt branch per signed-in administrator, so the console opens on a branch that is ready to work in.
 *
 * Rules (all tested against a real Dolt server):
 *  - The branch is named after the user (the token subject) and the user can rename it. The name is remembered per user in the
 *    UNVERSIONED `<db>_meta` database (same place as pull request records), never in business data and never part of a merge.
 *  - No proliferation: at most ONE automatic branch per user. Signing in again REUSES it (work in progress is kept as it is).
 *  - Only EMPTY branches are ever deleted: no commit beyond main, which includes a branch whose work was already applied to main.
 *    A branch with work, or one used by an open pull request, is never deleted, renamed away from its PR, moved or reset.
 *  - An empty branch that is behind main is moved to main's head so the user starts from current data; a branch with work is not touched.
 *  - Empty branches are released on sign-out and swept after an idle time. The remembered name lets the next sign-in recreate it.
 *  - Everything is scoped to the caller's own subject: nobody can rename or release someone else's branch through these routes.
 */
@Injectable()
export class PersonalBranchService {
  private ready?: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly v: VersioningService, private readonly prs: PullRequestService) {}

  private get metaDb() { return `${this.v.dbName}_meta`.replace(/[^A-Za-z0-9_]/g, ''); }
  private get idleMinutes() { const n = Number(process.env.IAM_PERSONAL_BRANCH_IDLE_MINUTES ?? 60); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 60; }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const run = this.chain.then(fn); this.chain = run.catch(() => undefined); return run; }

  private async open(withDb = true): Promise<Connection> {
    return createConnection({ host: process.env.DOLT_HOST ?? '127.0.0.1', port: Number(process.env.DOLT_PORT ?? 3307), user: process.env.DOLT_USER ?? 'root', password: process.env.DOLT_PASSWORD ?? '', ...(withDb ? { database: this.metaDb } : {}), connectTimeout: 5000, dateStrings: true });
  }
  private async meta(): Promise<Connection> {
    if (!this.ready) {
      this.ready = (async () => {
        const c = await this.open(false);
        try { await c.query(`CREATE DATABASE IF NOT EXISTS \`${this.metaDb}\``); } finally { await c.end(); }
        const m = await this.open();
        try { await m.query('CREATE TABLE IF NOT EXISTS personal_branches (tenant VARCHAR(32) NOT NULL, sub VARCHAR(64) NOT NULL, branch VARCHAR(63) NOT NULL, created_at DATETIME(3) NOT NULL, last_seen_at DATETIME(3) NOT NULL, PRIMARY KEY (tenant, sub), UNIQUE KEY personal_branch_name (tenant, branch))'); } finally { await m.end(); }
      })().catch((e) => { this.ready = undefined; throw e; });
    }
    await this.ready;
    return this.open();
  }

  /** `demo-alice` -> `demo-alice`; anything outside [a-z0-9-] becomes `-`; never empty, never starts with a dash. */
  static slug(sub: string): string {
    const s = String(sub ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return s || 'user';
  }
  private subject(sub: unknown): string {
    if (typeof sub !== 'string' || !sub.trim() || sub.length > 64) throw new ForbiddenException('a signed-in user is required');
    return sub;
  }

  private async state() {
    const all = (await this.v.branches()).branches;
    return new Map(all.map((b) => [b.name, b]));
  }
  private isEmpty(b: { aheadOfDefault: number }) { return b.aheadOfDefault === 0; }
  private free(name: string, taken: Set<string>) {
    if (!taken.has(name) && !this.v.isProtected(name) && name !== this.v.defaultBranch) return name;
    for (let i = 2; i < 100; i++) { const n = `${name.slice(0, 58)}-${i}`; if (!taken.has(n)) return n; }
    throw new ConflictException('could not find a free personal branch name');
  }

  async ensure(tenant: string, subIn: unknown): Promise<PersonalBranch> {
    const sub = this.subject(subIn);
    return this.serial(async () => {
      const m = await this.meta();
      try {
        await this.sweep(m, tenant, sub);
        const [rows] = await m.query('select branch from personal_branches where tenant = ? and sub = ?', [tenant, sub]);
        const known = (rows as { branch: string }[])[0]?.branch;
        let branches = await this.state();
        let status: PersonalStatus;
        let name: string;
        if (known && branches.has(known)) {
          name = known; status = 'reused';
          const b = branches.get(known)!;
          if (this.isEmpty(b) && b.behindDefault > 0 && !(await this.prs.hasOpen(known))) {
            const c = await this.v.connect();
            try { await c.query("CALL DOLT_BRANCH('-f', ?, ?)", [known, this.v.defaultBranch]); } finally { await c.end(); }
            status = 'refreshed';
          }
        } else {
          const taken = new Set(branches.keys());
          name = this.free(known ?? autoBranchName('personal', PersonalBranchService.slug(sub)), taken);
          await this.v.createBranch(name, this.v.defaultBranch);
          status = known ? 'recreated' : 'created';
        }
        if (name !== known) {
          if (known) await m.query('update personal_branches set branch = ?, last_seen_at = NOW(3) where tenant = ? and sub = ?', [name, tenant, sub]);
          else await m.query('insert into personal_branches (tenant, sub, branch, created_at, last_seen_at) values (?,?,?,NOW(3),NOW(3))', [tenant, sub, name]);
        } else await m.query('update personal_branches set last_seen_at = NOW(3) where tenant = ? and sub = ?', [tenant, sub]);
        branches = await this.state();
        const b = branches.get(name)!;
        return { branch: name, status, empty: this.isEmpty(b), aheadOfMain: b.aheadOfDefault, behindMain: b.behindDefault };
      } finally { await m.end(); }
    });
  }

  async rename(tenant: string, subIn: unknown, to: unknown): Promise<{ branch: string; was: string }> {
    const sub = this.subject(subIn);
    // A renamed personal branch stays a personal/ branch (policies target the folder): the folder is added when missing, any other folder is refused.
    const name = newBranchName(`personal/${newBranchName(typeof to === 'string' ? to.replace(/^personal\//, '') : to)}`);
    return this.serial(async () => {
      const m = await this.meta();
      try {
        const [rows] = await m.query('select branch from personal_branches where tenant = ? and sub = ?', [tenant, sub]);
        const old = (rows as { branch: string }[])[0]?.branch;
        if (!old) throw new NotFoundException('no personal branch yet: open the administration first');
        const branches = await this.state();
        if (!branches.has(old)) throw new NotFoundException('your personal branch is not open right now: open the administration again');
        if (old === name) return { branch: name, was: old };
        if (name === this.v.defaultBranch || this.v.isProtected(name)) throw new ForbiddenException(`${name} is a protected branch name`);
        if (branches.has(name)) throw new ConflictException(`branch ${name} already exists`);
        const [taken] = await m.query('select count(*) n from personal_branches where tenant = ? and branch = ?', [tenant, name]);
        if (Number((taken as { n: number }[])[0].n) > 0) throw new ConflictException(`branch name ${name} is reserved by another user`);
        if (await this.prs.hasOpen(old)) throw new ConflictException(`branch ${old} is used by an open pull request: close or merge it before renaming`);
        const c = await this.v.connect();
        try { await c.query("CALL DOLT_BRANCH('-m', ?, ?)", [old, name]); } finally { await c.end(); }
        await m.query('update personal_branches set branch = ?, last_seen_at = NOW(3) where tenant = ? and sub = ?', [name, tenant, sub]);
        return { branch: name, was: old };
      } finally { await m.end(); }
    });
  }

  /** Called on sign-out: deletes the caller's branch only when it is empty and unused; the name is kept for the next sign-in. */
  async release(tenant: string, subIn: unknown): Promise<{ released: boolean; branch?: string; reason?: string }> {
    const sub = this.subject(subIn);
    return this.serial(async () => {
      const m = await this.meta();
      try {
        const [rows] = await m.query('select branch from personal_branches where tenant = ? and sub = ?', [tenant, sub]);
        const name = (rows as { branch: string }[])[0]?.branch;
        if (!name) return { released: false, reason: 'no personal branch' };
        return this.dropIfEmpty(name);
      } finally { await m.end(); }
    });
  }

  private async dropIfEmpty(name: string) {
    const b = (await this.state()).get(name);
    if (!b) return { released: false, branch: name, reason: 'already closed' };
    if (!this.isEmpty(b)) return { released: false, branch: name, reason: 'has changes: kept' };
    try { await this.v.deleteBranch(name, (x) => this.prs.hasOpen(x)); } catch (e) {
      if (e instanceof ConflictException) return { released: false, branch: name, reason: 'used by an open pull request: kept' };
      throw e;
    }
    return { released: true, branch: name };
  }

  /** Other users' EMPTY branches, idle for a while (or all of them when `idle` is 0): deleted. Branches with work are never touched. */
  private async sweep(m: Connection, tenant: string, except: string) {
    const [rows] = await m.query('select branch from personal_branches where tenant = ? and sub <> ? and last_seen_at < NOW(3) - INTERVAL ? MINUTE', [tenant, except, this.idleMinutes]);
    for (const r of rows as { branch: string }[]) { try { await this.dropIfEmpty(r.branch); } catch { /* best effort: a failed cleanup never blocks sign-in */ } }
  }
}
