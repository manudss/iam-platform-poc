import { BadRequestException, ForbiddenException, HttpException, Injectable, OnModuleInit } from '@nestjs/common';
import { createConnection, Connection } from 'mysql2/promise';
import { branchName } from './guards.js';
import { VersioningService } from './versioning.service.js';

/** Who may merge into a protected branch: `policy` asks the policy engine (Cedar action branch:merge), `anyone` skips that check. */
export type MergeRule = 'policy' | 'anyone';
export interface BranchProtection {
  branch: string; protected: boolean; requirePullRequest: boolean; minReviews: number; requireChecks: boolean; mergeRule: MergeRule;
  /** `default` while nobody changed it (the built-in rule for the default branch), `custom` once stored. */
  source: 'default' | 'custom';
}
export interface MergeDecision { allowed: boolean; reasons: string[]; checked: boolean; message?: string }
type Decide = (input: { tenant: string; sub: string; branch: string }) => Promise<{ allow: boolean; reasons: string[] }>;
type Row = Record<string, unknown>;

/**
 * Branch protection as a visible, per-branch setting (first slice) and the policy check for merging into a protected branch.
 *
 * Settings live in the UNVERSIONED `<db>_meta` database (same place as pull requests): they are never merged and never business data.
 * Without a stored row, the built-in rule applies to the branches named by IAM_PROTECTED_BRANCHES (default: main): protected, pull
 * request only, checks required, merge decided by policy. "Who can merge" is NOT a list of people: with `policy` the merge is allowed
 * only if the policy engine answers yes to `branch:merge` for the caller, using the roles of the ACTIVE version (main) - a role granted
 * on a working branch changes nothing until a human merges it. Fails closed: engine unreachable means refused.
 */
@Injectable()
export class BranchProtectionService implements OnModuleInit {
  private ready?: Promise<void>;
  private overrides = new Map<string, BranchProtection>();
  /** Replaceable in tests that run without the Rust core. */
  decide: Decide = (i) => this.askCore(i);

  constructor(private readonly v: VersioningService) {}

  private get metaDb() { return `${this.v.dbName}_meta`.replace(/[^A-Za-z0-9_]/g, ''); }
  private get tenant() { return process.env.IAM_TENANT ?? 'acme-demo'; }
  private get policyOff() { return process.env.IAM_MERGE_POLICY === 'off'; }

  async onModuleInit() {
    this.v.protectionLookup = (b) => this.overrides.get(b)?.protected;
    this.v.mergeGate = (target, sub) => this.assertMayMerge(target, sub);
    try { await this.load(); } catch { /* store not reachable yet: built-in rules apply until the first successful read */ }
  }

  private async open(): Promise<Connection> {
    return createConnection({ host: process.env.DOLT_HOST ?? '127.0.0.1', port: Number(process.env.DOLT_PORT ?? 3307), user: process.env.DOLT_USER ?? 'root', password: process.env.DOLT_PASSWORD ?? '', database: this.metaDb, connectTimeout: 5000 });
  }
  private async store(): Promise<Connection> {
    if (!this.ready) {
      this.ready = (async () => {
        const c = await this.v.connect();
        try { await c.query(`CREATE DATABASE IF NOT EXISTS \`${this.metaDb}\``); } finally { await c.end(); }
        const m = await this.open();
        try { await m.query("CREATE TABLE IF NOT EXISTS branch_protection (branch VARCHAR(63) PRIMARY KEY, protected BOOLEAN NOT NULL, require_pr BOOLEAN NOT NULL, min_reviews INT NOT NULL, require_checks BOOLEAN NOT NULL, merge_rule VARCHAR(10) NOT NULL, updated_by VARCHAR(64) NOT NULL, updated_at DATETIME(3) NOT NULL)"); } finally { await m.end(); }
      })().catch((e) => { this.ready = undefined; throw new HttpException(`branch protection store unavailable: ${(e as Error).message}`, 503); });
    }
    await this.ready;
    return this.open();
  }
  private shape(r: Row): BranchProtection {
    return { branch: String(r.branch), protected: Boolean(r.protected), requirePullRequest: Boolean(r.require_pr), minReviews: Number(r.min_reviews), requireChecks: Boolean(r.require_checks), mergeRule: r.merge_rule === 'anyone' ? 'anyone' : 'policy', source: 'custom' };
  }
  private async load() {
    const m = await this.store();
    try { const [r] = await m.query('select * from branch_protection'); this.overrides = new Map((r as Row[]).map((x) => { const s = this.shape(x); return [s.branch, s]; })); } finally { await m.end(); }
  }

  private builtIn(branch: string): BranchProtection {
    const n = Number(process.env.IAM_PR_APPROVALS ?? 0);
    const on = this.v.isProtectedByEnv(branch);
    return { branch, protected: on, requirePullRequest: on, minReviews: on && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0, requireChecks: on, mergeRule: 'policy', source: 'default' };
  }
  /** Effective settings of one branch (stored row first, then the built-in rule). */
  effective(branch: string): BranchProtection { return this.overrides.get(branch) ?? this.builtIn(branch); }

  async list(): Promise<{ protections: BranchProtection[]; policyAction: string }> {
    await this.load().catch(() => undefined);
    const names = new Set<string>([...this.overrides.keys()]);
    for (const b of (await this.v.branches()).branches) names.add(b.name);
    const all = [...names].map((b) => this.effective(b)).sort((a, b) => Number(b.protected) - Number(a.protected) || a.branch.localeCompare(b.branch));
    return { protections: all, policyAction: 'branch:merge' };
  }

  async set(branch: unknown, input: { protected?: unknown; minReviews?: unknown; mergeRule?: unknown; requireChecks?: unknown; requirePullRequest?: unknown }, sub: unknown) {
    const name = branchName(branch, 'branch');
    if (!(await this.v.branches()).branches.some((b) => b.name === name)) throw new BadRequestException(`unknown branch ${name}`);
    const cur = this.effective(name);
    const next: BranchProtection = { ...cur, source: 'custom' };
    if (input.protected !== undefined) { if (typeof input.protected !== 'boolean') throw new BadRequestException('protected must be true or false'); next.protected = input.protected; }
    if (input.mergeRule !== undefined) { if (input.mergeRule !== 'policy' && input.mergeRule !== 'anyone') throw new BadRequestException('mergeRule must be "policy" or "anyone"'); next.mergeRule = input.mergeRule; }
    if (input.minReviews !== undefined) { if (!Number.isInteger(input.minReviews) || (input.minReviews as number) < 0 || (input.minReviews as number) > 10) throw new BadRequestException('minReviews must be an integer from 0 to 10'); next.minReviews = input.minReviews as number; }
    if (input.requireChecks !== undefined) { if (typeof input.requireChecks !== 'boolean') throw new BadRequestException('requireChecks must be true or false'); next.requireChecks = input.requireChecks; }
    if (input.requirePullRequest !== undefined) { if (typeof input.requirePullRequest !== 'boolean') throw new BadRequestException('requirePullRequest must be true or false'); next.requirePullRequest = input.requirePullRequest; }
    // Lowering protection of the default branch or the merge rule of a protected branch is itself a merge-level act: it needs the same policy.
    if (cur.protected && (!next.protected || next.mergeRule !== cur.mergeRule || next.minReviews < cur.minReviews || (cur.requireChecks && !next.requireChecks))) await this.assertMayMerge(name, sub, 'change the protection of');
    if (name === this.v.defaultBranch && !next.protected && !this.policyOff) await this.assertMayMerge(name, sub, 'unprotect');
    const by = String(sub ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'unknown';
    const m = await this.store();
    try {
      await m.query('replace into branch_protection (branch, protected, require_pr, min_reviews, require_checks, merge_rule, updated_by, updated_at) values (?,?,?,?,?,?,?,now(3))', [name, next.protected, next.requirePullRequest, next.minReviews, next.requireChecks, next.mergeRule, by]);
    } finally { await m.end(); }
    this.overrides.set(name, next);
    return next;
  }

  /** Same answer the merge itself will get, for the UI (a disabled button with the reason). Does not throw for a refusal. */
  async mayMerge(branch: string, sub: unknown): Promise<MergeDecision> {
    const e = this.effective(branch);
    const checked = e.protected && e.mergeRule === 'policy' && !this.policyOff;
    try { await this.assertMayMerge(branch, sub); return { allowed: true, reasons: [], checked }; }
    catch (err) {
      if (!(err instanceof HttpException)) throw err;
      const body = err.getResponse() as { reasons?: string[]; message?: string };
      return { allowed: false, reasons: body.reasons ?? [], checked: true, message: body.message };
    }
  }

  /** Throws 403 `merge-not-permitted` unless the caller may merge into `branch`. No-op for unprotected branches and for the `anyone` rule. */
  async assertMayMerge(branch: string, sub: unknown, verb = 'merge into'): Promise<void> {
    const s = this.effective(branch);
    if (!s.protected || s.mergeRule === 'anyone' || this.policyOff) return;
    const who = typeof sub === 'string' ? sub.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) : '';
    if (!who) throw this.refusal(branch, verb, ['no-identity']);
    let out: { allow: boolean; reasons: string[] };
    try { out = await this.decide({ tenant: this.tenant, sub: who, branch }); }
    catch (e) { throw this.refusal(branch, verb, ['policy-engine-unreachable'], `the policy engine could not be reached (${(e as Error).message}); refused to stay on the safe side`); }
    // Bootstrap: before the very first activation no policy exists anywhere, and that first Apply is what creates the active version.
    if (!out.allow && out.reasons.length === 1 && out.reasons[0] === 'no-active-version') return;
    if (!out.allow) throw this.refusal(branch, verb, out.reasons);
  }
  private refusal(branch: string, verb: string, reasons: string[], detail?: string) {
    const why = detail ?? (reasons.length ? `no rule allows it (${reasons.join(', ')})` : 'no policy rule allows it: you need a role that the policy "merge-into-protected-needs-branch-merger" accepts (branch-merger)');
    return new ForbiddenException({ code: 'merge-not-permitted', message: `You are not allowed to ${verb} protected branch ${branch}: ${why}`, branch, action: 'branch:merge', reasons });
  }

  private async askCore(i: { tenant: string; sub: string; branch: string }) {
    const core = process.env.IAM_CORE_URL;
    if (!core) throw new Error('IAM_CORE_URL is not set');
    const res = await fetch(`${core}/v1/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(4000),
      body: JSON.stringify({ tenant: i.tenant, principal: `User::"${i.sub}"`, action: 'Action::"branch:merge"', resource: `Branch::"${i.branch}"`, context: {}, audit: { source: 'http', subject: i.sub, note: `merge permission for protected branch ${i.branch}` } }) });
    if (!res.ok) throw new Error(`core answered ${res.status}`);
    const out = (await res.json()) as { allow?: boolean; reasons?: string[]; errors?: string[] };
    return { allow: out.allow === true, reasons: [...(out.reasons ?? []), ...(out.errors ?? [])] };
  }
}
