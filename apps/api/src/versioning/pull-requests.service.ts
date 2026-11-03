import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { createConnection, Connection } from 'mysql2/promise';
import { branchName, commitMessage } from './guards.js';
import { VersioningService, mapSqlError } from './versioning.service.js';

export interface PullRequest {
  id: number; tenant: string; title: string; body: string; source: string; target: string; status: 'open' | 'merged' | 'closed';
  author: string; createdAt: string; updatedAt: string; mergedAt: string | null; mergeCommit: string | null;
}
type Row = Record<string, unknown>;

/**
 * Pull requests between Dolt branches. Dolt has no pull request object of its own on a self-hosted server, so the review record
 * (title, status, comments, approvals) lives in a SEPARATE, unversioned database `<db>_meta` on the same server: it never mixes with
 * the versioned business data and is never part of a merge. The merge itself is a real Dolt merge commit, made only after the
 * checks pass again at merge time (conflicts, constraint violations, Separation of Duties) and, when configured, enough approvals.
 */
@Injectable()
export class PullRequestService {
  private ready?: Promise<void>;
  mainPublisher?: (tenant: string, source: string, sub: unknown) => Promise<{ commit: string }>;

  constructor(private readonly v: VersioningService) {}

  private get metaDb() { return `${this.v.dbName}_meta`; }
  private get requiredApprovals() { const n = Number(process.env.IAM_PR_APPROVALS ?? 0); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; }

  private async meta(): Promise<Connection> {
    if (!this.ready) {
      this.ready = (async () => {
        const c = await this.v.connect();
        try {
          await c.query(`CREATE DATABASE IF NOT EXISTS \`${this.metaDb.replace(/[^A-Za-z0-9_]/g, '')}\``);
        } finally { await c.end(); }
        const m = await this.open();
        try {
          await m.query('CREATE TABLE IF NOT EXISTS pull_requests (id BIGINT AUTO_INCREMENT PRIMARY KEY, tenant VARCHAR(32) NOT NULL, title VARCHAR(200) NOT NULL, body TEXT NOT NULL, source VARCHAR(63) NOT NULL, target VARCHAR(63) NOT NULL, status VARCHAR(10) NOT NULL DEFAULT \'open\', author VARCHAR(64) NOT NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL, merged_at DATETIME(3) NULL, merge_commit VARCHAR(40) NULL)');
          await m.query('CREATE TABLE IF NOT EXISTS pr_comments (id BIGINT AUTO_INCREMENT PRIMARY KEY, pr_id BIGINT NOT NULL, author VARCHAR(64) NOT NULL, kind VARCHAR(10) NOT NULL DEFAULT \'comment\', body TEXT NOT NULL, created_at DATETIME(3) NOT NULL)');
        } finally { await m.end(); }
      })().catch((e) => { this.ready = undefined; throw new HttpException(`pull request store unavailable: ${(e as Error).message}`, 503); });
    }
    await this.ready;
    return this.open();
  }
  private async open(): Promise<Connection> {
    return createConnection({
      host: process.env.DOLT_HOST ?? '127.0.0.1', port: Number(process.env.DOLT_PORT ?? 3307), user: process.env.DOLT_USER ?? 'root',
      password: process.env.DOLT_PASSWORD ?? '', database: this.metaDb.replace(/[^A-Za-z0-9_]/g, ''), connectTimeout: 5000, dateStrings: true,
    });
  }

  private shape(r: Row): PullRequest {
    return { id: Number(r.id), tenant: String(r.tenant), title: String(r.title), body: String(r.body), source: String(r.source), target: String(r.target), status: r.status as PullRequest['status'], author: String(r.author), createdAt: String(r.created_at), updatedAt: String(r.updated_at), mergedAt: r.merged_at ? String(r.merged_at) : null, mergeCommit: r.merge_commit ? String(r.merge_commit) : null };
  }
  private async row(m: Connection, tenant: string, id: number): Promise<PullRequest> {
    if (!Number.isInteger(id) || id < 1) throw new BadRequestException('invalid pull request id');
    const [r] = await m.query('select * from pull_requests where id = ? and tenant = ?', [id, tenant]);
    if (!(r as Row[]).length) throw new NotFoundException(`pull request #${id} not found`);
    return this.shape((r as Row[])[0]);
  }

  async hasOpen(branch: string): Promise<boolean> {
    let m: Connection | undefined;
    try { m = await this.meta(); } catch { return false; } // no store yet means no pull request exists
    try { const [r] = await m.query("select count(*) n from pull_requests where status = 'open' and (source = ? or target = ?)", [branch, branch]); return Number((r as { n: number }[])[0].n) > 0; } finally { await m.end(); }
  }

  async list(tenant: string, status?: string) {
    const m = await this.meta();
    try {
      const ok = status && ['open', 'merged', 'closed'].includes(status);
      const [r] = await m.query(`select * from pull_requests where tenant = ?${ok ? ' and status = ?' : ''} order by id desc limit 200`, ok ? [tenant, status] : [tenant]);
      return { pullRequests: (r as Row[]).map((x) => this.shape(x)) };
    } finally { await m.end(); }
  }

  async create(tenant: string, input: { title?: unknown; body?: unknown; source?: unknown; target?: unknown }, sub: unknown) {
    const source = branchName(input.source, 'source branch'), target = branchName(input.target, 'target branch');
    if (source === target) throw new BadRequestException('source and target must be different branches');
    const title = commitMessage(input.title, '');
    if (!title) throw new BadRequestException('title required');
    const body = typeof input.body === 'string' ? input.body.slice(0, 5000) : '';
    const author = String(sub ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'unknown';
    const probe = await this.v.connect();
    try {
      const s = await this.v.resolve(probe, source), t = await this.v.resolve(probe, target);
      if (s.kind !== 'branch' || t.kind !== 'branch') throw new BadRequestException('source and target must be branches');
    } finally { await probe.end(); }
    const m = await this.meta();
    try {
      const [dup] = await m.query("select id from pull_requests where tenant = ? and status = 'open' and source = ? and target = ?", [tenant, source, target]);
      if ((dup as Row[]).length) throw new ConflictException(`pull request #${(dup as { id: number }[])[0].id} is already open for ${source} into ${target}`);
      const [res] = await m.query('insert into pull_requests (tenant, title, body, source, target, author, created_at, updated_at) values (?,?,?,?,?,?,now(3),now(3))', [tenant, title, body, source, target, author]);
      return this.row(m, tenant, Number((res as { insertId: number }).insertId));
    } finally { await m.end(); }
  }

  async get(tenant: string, id: number, sub?: unknown) {
    const m = await this.meta();
    let pr: PullRequest, comments: Row[];
    try {
      pr = await this.row(m, tenant, id);
      const [c] = await m.query('select id, author, kind, body, created_at from pr_comments where pr_id = ? order by id', [id]);
      comments = c as Row[];
    } finally { await m.end(); }
    const approvals = new Set(comments.filter((x) => x.kind === 'approve' && x.author !== pr.author).map((x) => x.author));
    let commits: unknown = [], summary: unknown = null, checks: unknown = null;
    if (pr.status === 'open') {
      try {
        const log = await this.v.at(pr.source, async (c) => { const [r] = await c.query('select commit_hash, committer, date, message from dolt_log(?) limit 100', [`${pr.target}..${pr.source}`]); return r as Row[]; });
        commits = log.map((x) => ({ commit: x.commit_hash, author: x.committer, date: x.date, message: x.message }));
        summary = await this.v.diffSummary(pr.target, pr.source, true);
        checks = await this.v.trialMerge(pr.source, pr.target);
      } catch (e) { checks = { mergeable: false, reasons: [`cannot be evaluated: ${(e as Error).message}`], conflicts: 0, violations: [] }; }
    }
    return { viewer: sub === undefined ? undefined : String(sub).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64), pullRequest: pr, comments: comments.map((x) => ({ id: Number(x.id), author: x.author, kind: x.kind, body: x.body, createdAt: String(x.created_at) })), approvals: [...approvals], requiredApprovals: this.requiredApprovals, commits, diff: summary, checks };
  }

  async comment(tenant: string, id: number, input: { body?: unknown; kind?: unknown }, sub: unknown) {
    const kind = input.kind === 'approve' ? 'approve' : 'comment';
    const body = typeof input.body === 'string' ? input.body.trim().slice(0, 2000) : '';
    if (!body && kind === 'comment') throw new BadRequestException('comment text required');
    const author = String(sub ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'unknown';
    const m = await this.meta();
    try {
      const pr = await this.row(m, tenant, id);
      if (pr.status !== 'open') throw new ConflictException(`pull request #${id} is ${pr.status}`);
      if (kind === 'approve' && author === pr.author) throw new ConflictException('the author cannot approve their own pull request');
      await m.query('insert into pr_comments (pr_id, author, kind, body, created_at) values (?,?,?,?,now(3))', [id, author, kind, body || 'approved']);
      return { ok: true };
    } finally { await m.end(); }
  }

  async close(tenant: string, id: number) {
    const m = await this.meta();
    try {
      const pr = await this.row(m, tenant, id);
      if (pr.status !== 'open') throw new ConflictException(`pull request #${id} is already ${pr.status}`);
      await m.query("update pull_requests set status = 'closed', updated_at = now(3) where id = ?", [id]);
      return this.row(m, tenant, id);
    } finally { await m.end(); }
  }

  /** Merge: re-checks everything now (the branches may have moved since the page was opened), then makes the merge commit. */
  async merge(tenant: string, id: number, sub: unknown) {
    const m = await this.meta();
    try {
      const pr = await this.row(m, tenant, id);
      if (pr.status !== 'open') throw new ConflictException(`pull request #${id} is already ${pr.status}`);
      const need = this.requiredApprovals;
      if (need > 0) {
        const [a] = await m.query("select count(distinct author) n from pr_comments where pr_id = ? and kind = 'approve' and author <> ?", [id, pr.author]);
        if (Number((a as { n: number }[])[0].n) < need) throw new ConflictException({ code: 'approvals-required', message: `${need} approval(s) from someone other than the author are required before merging` });
      }
      let res;
      try {
        if (pr.target === 'main' && process.env.IAM_AUTO_ACTIVATE_MAIN !== '0' && this.mainPublisher) {
          const published = await this.mainPublisher(tenant, pr.source, sub);
          res = { mergeable: true, commit: published.commit, reasons: [], violations: [] };
        } else res = await this.v.mergeInto(pr.source, pr.target, commitMessage(`Merge pull request #${id}: ${pr.title}`, ''), sub);
      } catch (e) { throw mapSqlError(e); }
      if (!res.mergeable || !res.commit) throw new ConflictException({ code: 'merge-refused', message: `merge refused: ${res.reasons.join('; ')}`, reasons: res.reasons, violations: res.violations });
      await m.query("update pull_requests set status = 'merged', merged_at = now(3), updated_at = now(3), merge_commit = ? where id = ?", [res.commit, id]);
      return { pullRequest: await this.row(m, tenant, id), commit: res.commit };
    } finally { await m.end(); }
  }
}
