import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { createConnection, Connection } from 'mysql2/promise';
import { branchName } from '../versioning/guards.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { workspaceMode } from './context.js';

/** Branch test is a hosted workspace-mode feature; IAM_BRANCH_TEST=0 turns it off everywhere (console route, gate, sign-in options). */
export const branchTestEnabled = () => workspaceMode() && process.env.IAM_BRANCH_TEST !== '0';
const TTL_MS = 10 * 60_000;

/**
 * Short-lived tickets that open a sign-in test on one Dolt data branch (see docs/branch-test.md).
 * A ticket is issued to an administrator from the console's branch bar and authorizes the PUBLIC sign-in entry points
 * (options and the core's gate) to reveal and use that branch's configuration: knowing a branch name is never enough.
 * In memory on purpose: tickets die with the API process, like the sign-in sessions they protect.
 */
export type StableLink = { id: string; branch: string; label: string; createdBy: string; createdAt: string };
/** Where stable links live; the Dolt implementation sits in the unversioned meta database, the memory one in tests. */
export interface StableLinkStore {
  put(link: { id: string; branch: string; tokenHash: string; label: string; createdBy: string }): Promise<void>;
  find(tokenHash: string, branch: string): Promise<boolean>;
  list(): Promise<StableLink[]>;
  remove(id: string): Promise<boolean>;
}
export class MemoryStableLinkStore implements StableLinkStore {
  rows: ({ tokenHash: string } & StableLink)[] = [];
  async put(l: { id: string; branch: string; tokenHash: string; label: string; createdBy: string }) { this.rows.push({ ...l, createdAt: new Date().toISOString() }); }
  async find(h: string, branch: string) { return this.rows.some((r) => r.tokenHash === h && r.branch === branch); }
  async list() { return this.rows.map(({ id, branch, label, createdBy, createdAt }) => ({ id, branch, label, createdBy, createdAt })); }
  async remove(id: string) { const n = this.rows.length; this.rows = this.rows.filter((r) => r.id !== id); return this.rows.length < n; }
}
/** Stable links in the unversioned `<db>_meta` database (same place as personal-branch and pull request records): never merged, never business data. */
export class DoltStableLinkStore implements StableLinkStore {
  constructor(private readonly v: VersioningService) {}
  private get metaDb() { return `${this.v.dbName}_meta`.replace(/[^A-Za-z0-9_]/g, ''); }
  private async meta(): Promise<Connection> {
    const c = await createConnection({ host: process.env.DOLT_HOST ?? '127.0.0.1', port: Number(process.env.DOLT_PORT ?? 3307), user: process.env.DOLT_USER ?? 'root', password: process.env.DOLT_PASSWORD ?? '', connectTimeout: 5000, dateStrings: true });
    try { await c.query(`CREATE DATABASE IF NOT EXISTS \`${this.metaDb}\``); } finally { await c.end(); }
    const m = await createConnection({ host: process.env.DOLT_HOST ?? '127.0.0.1', port: Number(process.env.DOLT_PORT ?? 3307), user: process.env.DOLT_USER ?? 'root', password: process.env.DOLT_PASSWORD ?? '', database: this.metaDb, connectTimeout: 5000, dateStrings: true });
    try { await m.query('CREATE TABLE IF NOT EXISTS branch_test_links (id VARCHAR(26) NOT NULL PRIMARY KEY, branch VARCHAR(63) NOT NULL, token_hash CHAR(64) NOT NULL, label VARCHAR(80) NOT NULL, created_by VARCHAR(64) NOT NULL, created_at DATETIME(3) NOT NULL, KEY branch_test_lookup (token_hash, branch))'); } catch { return m; }
    return m;
  }
  async put(l: { id: string; branch: string; tokenHash: string; label: string; createdBy: string }) { const m = await this.meta(); try { await m.query('insert into branch_test_links (id, branch, token_hash, label, created_by, created_at) values (?,?,?,?,?,NOW(3))', [l.id, l.branch, l.tokenHash, l.label, l.createdBy]); } finally { await m.end(); } }
  async find(h: string, branch: string) { const m = await this.meta(); try { const [r] = await m.query('select 1 from branch_test_links where token_hash = ? and branch = ? limit 1', [h, branch]); return (r as unknown[]).length > 0; } finally { await m.end(); } }
  async list() { const m = await this.meta(); try { const [r] = await m.query('select id, branch, label, created_by as createdBy, created_at as createdAt from branch_test_links order by created_at desc'); return r as StableLink[]; } finally { await m.end(); } }
  async remove(id: string) { const m = await this.meta(); try { const [r] = await m.query('delete from branch_test_links where id = ?', [id]); return (r as { affectedRows: number }).affectedRows > 0; } finally { await m.end(); } }
}

@Injectable()
export class BranchTestService {
  private tickets = new Map<string, { branch: string; subject: string; exp: number }>();
  now = () => Date.now();
  private stable: StableLinkStore;
  constructor(private readonly v: VersioningService, @Optional() stable?: StableLinkStore) { this.stable = stable ?? new DoltStableLinkStore(v); }

  private async validBranch(branch: string) {
    branchName(branch);
    if (branch === 'main') throw new BadRequestException('main is the live sign-in already: nothing to test');
    if (!(await this.v.branches()).branches.some((b) => b.name === branch)) throw new NotFoundException('unknown branch');
  }

  async create(subject: string, branch: string, opts: { stable?: boolean; label?: string } = {}): Promise<{ ticket: string; branch: string; expiresIn: number | null; stable: boolean; id?: string }> {
    if (!branchTestEnabled()) throw new ForbiddenException('branch test is disabled');
    await this.validBranch(branch);
    const ticket = randomBytes(24).toString('base64url');
    if (opts.stable) {
      const id = randomBytes(13).toString('hex');
      await this.stable.put({ id, branch, tokenHash: createHash('sha256').update(ticket).digest('hex'), label: String(opts.label ?? '').slice(0, 80), createdBy: subject });
      return { ticket, branch, expiresIn: null, stable: true, id };
    }
    this.sweep();
    this.tickets.set(ticket, { branch, subject, exp: this.now() + TTL_MS });
    return { ticket, branch, expiresIn: TTL_MS / 1000, stable: false };
  }

  /** True only when the ticket exists, names exactly this branch and is still valid (10-minute ticket or unrevoked stable link). No detail leaks through a refusal. */
  async check(ticket: unknown, branch: unknown): Promise<boolean> {
    if (!branchTestEnabled() || typeof ticket !== 'string' || typeof branch !== 'string') return false;
    const t = this.tickets.get(ticket);
    if (t && t.branch === branch && t.exp > this.now()) return true;
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(ticket)) return false;
    try { return await this.stable.find(createHash('sha256').update(ticket).digest('hex'), branch); } catch { return false; } // meta unreachable: fail closed
  }

  /** Administrator view: every stable link (never its token), so it can be revoked. */
  list(): Promise<StableLink[]> { return this.stable.list(); }
  async revoke(id: string): Promise<{ revoked: boolean }> { return { revoked: await this.stable.remove(String(id ?? '').slice(0, 26)) }; }

  private sweep() { const n = this.now(); for (const [k, t] of this.tickets) if (t.exp < n) this.tickets.delete(k); }
}
