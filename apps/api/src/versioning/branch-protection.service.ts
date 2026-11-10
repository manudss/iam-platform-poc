import { BadRequestException, ForbiddenException, HttpException, Injectable, OnModuleInit } from '@nestjs/common';
import { createConnection, Connection } from 'mysql2/promise';
import { SOURCE_ENTRY, branchFolder, branchKind, describeEntry, sourceAllowed } from './branch-kinds.js';
import { branchName } from './guards.js';
import { VersioningService } from './versioning.service.js';

/** Who may merge into a protected branch: `policy` asks the policy engine (Cedar action branch:merge), `anyone` skips that check. */
export type MergeRule = 'policy' | 'anyone';
export interface BranchProtection {
  branch: string; protected: boolean; requirePullRequest: boolean; minReviews: number; requireChecks: boolean; mergeRule: MergeRule;
  /** May the author of a pull request merge it themselves? (checked when a pull request is merged) */
  selfMerge: boolean;
  /** Folders of the branches that may be merged here (personal, profile, ai, workflow, feature, other), `custom` (every custom folder) or `custom:<folder>`; empty = every kind. */
  sourceKinds: string[];
  /** `default` while nobody changed it (the built-in rule for the default branch), `custom` once stored. */
  source: 'default' | 'custom';
}
export interface MergeDecision { allowed: boolean; reasons: string[]; checked: boolean; message?: string }
type Decide = (input: { tenant: string; sub: string; branch: string; source?: string; sourceKind?: string; changeScope?: string }) => Promise<{ allow: boolean; reasons: string[] }>;
type Row = Record<string, unknown>;
/** Roles a manager or an organisation admin can never give (same list as the Cedar rule assignment-no-escalation). */
const ROLE_ONLY_ADMIN = new Set(['iam-admin', 'main-merger', 'branch-merger', 'manager', 'org-admin', 'payment-approver', 'mcp-operator']);

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
    this.v.mergeGate = (target, sub, source) => this.assertMayMerge(target, sub, 'merge into', source);
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
        try { await m.query("CREATE TABLE IF NOT EXISTS branch_protection (branch VARCHAR(63) PRIMARY KEY, protected BOOLEAN NOT NULL, require_pr BOOLEAN NOT NULL, min_reviews INT NOT NULL, require_checks BOOLEAN NOT NULL, merge_rule VARCHAR(10) NOT NULL, updated_by VARCHAR(64) NOT NULL, updated_at DATETIME(3) NOT NULL)");
          const [cols] = await m.query("select column_name c from information_schema.columns where table_schema = ? and table_name = 'branch_protection'", [this.metaDb]);
          const have = new Set((cols as { c: string }[]).map((x) => x.c));
          if (!have.has('self_merge')) await m.query('alter table branch_protection add column self_merge BOOLEAN NOT NULL DEFAULT TRUE');
          if (!have.has('source_kinds')) await m.query("alter table branch_protection add column source_kinds VARCHAR(120) NOT NULL DEFAULT ''");
        } finally { await m.end(); }
      })().catch((e) => { this.ready = undefined; throw new HttpException(`branch protection store unavailable: ${(e as Error).message}`, 503); });
    }
    await this.ready;
    return this.open();
  }
  private shape(r: Row): BranchProtection {
    return { branch: String(r.branch), protected: Boolean(r.protected), requirePullRequest: Boolean(r.require_pr), minReviews: Number(r.min_reviews), requireChecks: Boolean(r.require_checks), mergeRule: r.merge_rule === 'anyone' ? 'anyone' : 'policy', selfMerge: r.self_merge === undefined ? true : Boolean(r.self_merge), sourceKinds: String(r.source_kinds ?? '').split(',').filter(Boolean), source: 'custom' };
  }
  private async load() {
    const m = await this.store();
    try { const [r] = await m.query('select * from branch_protection'); this.overrides = new Map((r as Row[]).map((x) => { const s = this.shape(x); return [s.branch, s]; })); } finally { await m.end(); }
  }

  private builtIn(branch: string): BranchProtection {
    const n = Number(process.env.IAM_PR_APPROVALS ?? 0);
    const on = this.v.isProtectedByEnv(branch);
    return { branch, protected: on, requirePullRequest: on, minReviews: on && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0, requireChecks: on, mergeRule: 'policy', selfMerge: true, sourceKinds: [], source: 'default' };
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

  async set(branch: unknown, input: { protected?: unknown; minReviews?: unknown; mergeRule?: unknown; requireChecks?: unknown; requirePullRequest?: unknown; selfMerge?: unknown; sourceKinds?: unknown }, sub: unknown) {
    const name = branchName(branch, 'branch');
    if (!(await this.v.branches()).branches.some((b) => b.name === name)) throw new BadRequestException(`unknown branch ${name}`);
    const cur = this.effective(name);
    const next: BranchProtection = { ...cur, source: 'custom' };
    if (input.protected !== undefined) { if (typeof input.protected !== 'boolean') throw new BadRequestException('protected must be true or false'); next.protected = input.protected; }
    if (input.mergeRule !== undefined) { if (input.mergeRule !== 'policy' && input.mergeRule !== 'anyone') throw new BadRequestException('mergeRule must be "policy" or "anyone"'); next.mergeRule = input.mergeRule; }
    if (input.minReviews !== undefined) { if (!Number.isInteger(input.minReviews) || (input.minReviews as number) < 0 || (input.minReviews as number) > 10) throw new BadRequestException('minReviews must be an integer from 0 to 10'); next.minReviews = input.minReviews as number; }
    if (input.requireChecks !== undefined) { if (typeof input.requireChecks !== 'boolean') throw new BadRequestException('requireChecks must be true or false'); next.requireChecks = input.requireChecks; }
    if (input.requirePullRequest !== undefined) { if (typeof input.requirePullRequest !== 'boolean') throw new BadRequestException('requirePullRequest must be true or false'); next.requirePullRequest = input.requirePullRequest; }
    if (input.selfMerge !== undefined) { if (typeof input.selfMerge !== 'boolean') throw new BadRequestException('selfMerge must be true or false'); next.selfMerge = input.selfMerge; }
    if (input.sourceKinds !== undefined) {
      const k = input.sourceKinds;
      if (!Array.isArray(k) || k.some((x) => typeof x !== 'string' || !SOURCE_ENTRY.test(x))) throw new BadRequestException('sourceKinds must be a list of: personal, profile, ai, workflow, feature, other, custom, or custom:<folder> (for example custom:team)');
      if (k.join(',').length > 120) throw new BadRequestException('sourceKinds is too long (120 characters at most)');
      next.sourceKinds = [...new Set(k as string[])];
    }
    // Lowering protection of the default branch or the merge rule of a protected branch is itself a merge-level act: it needs the same policy.
    if (cur.protected && (!next.protected || next.mergeRule !== cur.mergeRule || next.minReviews < cur.minReviews || (cur.requireChecks && !next.requireChecks) || (cur.selfMerge === false && next.selfMerge) || (cur.sourceKinds.length > 0 && (next.sourceKinds.length === 0 || next.sourceKinds.some((x) => !cur.sourceKinds.includes(x)))))) await this.assertMayMerge(name, sub, 'change the protection of');
    if (name === this.v.defaultBranch && !next.protected && !this.policyOff) await this.assertMayMerge(name, sub, 'unprotect');
    const by = String(sub ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'unknown';
    const m = await this.store();
    try {
      await m.query('replace into branch_protection (branch, protected, require_pr, min_reviews, require_checks, merge_rule, self_merge, source_kinds, updated_by, updated_at) values (?,?,?,?,?,?,?,?,?,now(3))', [name, next.protected, next.requirePullRequest, next.minReviews, next.requireChecks, next.mergeRule, next.selfMerge, next.sourceKinds.join(','), by]);
    } finally { await m.end(); }
    this.overrides.set(name, next);
    return next;
  }

  /** Same answer the merge itself will get, for the UI (a disabled button with the reason). Does not throw for a refusal. */
  async mayMerge(branch: string, sub: unknown, source?: string, author?: string): Promise<MergeDecision> {
    const e = this.effective(branch);
    const checked = e.protected && e.mergeRule === 'policy' && !this.policyOff;
    try { await this.assertMayMerge(branch, sub, 'merge into', source, author); return { allowed: true, reasons: [], checked }; }
    catch (err) {
      if (!(err instanceof HttpException)) throw err;
      const body = err.getResponse() as { reasons?: string[]; message?: string };
      return { allowed: false, reasons: body.reasons ?? [], checked: true, message: body.message };
    }
  }

  /** Throws 403 `self-merge-not-allowed` when the branch forbids authors from merging their own pull request. */
  assertSelfMerge(branch: string, sub: unknown, author: string): void {
    const s = this.effective(branch);
    if (s.protected && !s.selfMerge && !this.policyOff && typeof sub === 'string' && sub === author) {
      throw new ForbiddenException({ code: 'self-merge-not-allowed', message: `${branch} does not let the author merge their own pull request: ask someone else with merge rights`, branch, reasons: ['self-merge-not-allowed'] });
    }
  }

  /** Throws 403 `merge-not-permitted` unless the caller may merge into `branch`. No-op for unprotected branches and for the `anyone` rule. */
  async assertMayMerge(branch: string, sub: unknown, verb = 'merge into', source?: string, author?: string): Promise<void> {
    const s = this.effective(branch);
    if (!s.protected) return;
    const kind = source ? branchKind(source) : undefined;
    // Branch-level rules that do not depend on roles: they hold whatever the merge rule is.
    if (source && !sourceAllowed(s.sourceKinds, source)) {
      throw new ForbiddenException({ code: 'source-kind-not-allowed', message: `${branch} accepts merges only from ${s.sourceKinds.map(describeEntry).join(', ')}; ${source} is ${kind === 'custom' ? `in the custom folder ${branchFolder(source)}/` : kind === 'other' ? 'a branch without folder' : `a ${kind}/ branch`}`, branch, source, sourceKind: kind, reasons: ['source-kind-not-allowed'] });
    }
    if (author !== undefined && !s.selfMerge && typeof sub === 'string' && sub === author) {
      throw new ForbiddenException({ code: 'self-merge-not-allowed', message: `${branch} does not let the author merge their own pull request: ask someone else with merge rights`, branch, reasons: ['self-merge-not-allowed'] });
    }
    if (s.mergeRule === 'anyone' || this.policyOff) return;
    const who = typeof sub === 'string' ? sub.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) : '';
    if (!who) throw this.refusal(branch, verb, ['no-identity']);
    let out: { allow: boolean; reasons: string[] };
    // Scoped assignments merge: computed from the REAL diff main...source, never from what the caller says.
    let scope: { scope?: string; offending?: string; rows?: { identity: string; role: string; change: string; why: string }[] } = {};
    if (source && branch === this.v.defaultBranch && process.env.IAM_SCREEN_ACCESS === '1') { try { scope = await this.assignmentsScope(branch, source, who); } catch { scope = {}; } }
    try { out = await this.decide({ tenant: this.tenant, sub: who, branch, source, sourceKind: kind, changeScope: scope.scope }); }
    catch (e) { throw this.refusal(branch, verb, ['policy-engine-unreachable'], `the policy engine could not be reached (${(e as Error).message}); refused to stay on the safe side`); }
    // Bootstrap: before the very first activation no policy exists anywhere, and that first Apply is what creates the active version.
    if (!out.allow && out.reasons.length === 1 && out.reasons[0] === 'no-active-version') return;
    if (!out.allow && scope.offending) throw this.refusal(branch, verb, out.reasons, scope.offending, undefined, undefined, scope.rows);
    if (!out.allow) throw this.refusal(branch, verb, out.reasons, undefined, source, kind);
  }

  /** Only the `assignments` table changed and every added or removed row passes assignment:change for the caller: scope `assignments-in-scope`. A foreign row is named. */
  private async assignmentsScope(target: string, source: string, who: string): Promise<{ scope?: string; offending?: string; rows?: { identity: string; role: string; change: string; why: string }[] }> {
    const sum = await this.v.diffSummary(target, source, true);
    const names = sum.tables.map((t) => String((t as Row).table));
    if (!names.length || names.some((n) => n !== 'assignments')) return names.length ? { offending: `this change also touches ${names.filter((n) => n !== 'assignments').join(', ')}: only a change limited to role assignments can be merged by a manager` } : {};
    const d = await this.v.diffTable(target, source, 'assignments', true, 1000);
    const { readHierarchy, askPerson } = await import('../access/scope.js');
    const hMain = await readHierarchy(this.tenant, target);
    const rows = (d as unknown as { rows?: { type?: string; from?: Row; to?: Row }[] }).rows ?? [];
    const bad: string[] = []; const badRows: { identity: string; role: string; change: string; why: string }[] = [];
    for (const r of rows) {
      const row = (r.to ?? r.from ?? {}) as Row; const who2 = String(row.identity_id ?? ''), role = String(row.role_id ?? '');
      if (!who2 || !role) { bad.push('an assignment row could not be read'); continue; }
      const gone = r.type === 'removed' || r.type === 'delete';
      const a = await askPerson(this.tenant, hMain, who, 'assignment:change', who2, role);
      if (!a.allow) badRows.push({ identity: who2, role, change: gone ? 'removed' : 'added', why: ROLE_ONLY_ADMIN.has(role) ? `only an administrator can give the role ${role}` : `${who2} is not one of the people you manage` });
      if (!a.allow) bad.push(`${gone ? 'removing' : 'giving'} the role ${role} ${gone ? 'from' : 'to'} ${who2} is outside what you may change (either ${who2} is not one of the people you manage, or ${role} can only be given by an administrator)`);
    }
    if (bad.length) return { offending: `${bad.length} row${bad.length > 1 ? 's are' : ' is'} outside your scope: ${bad.slice(0, 10).join('; ')}. Remove them from your branch and merge again`, rows: badRows };
    return { scope: 'assignments-in-scope' };
  }
  private refusal(branch: string, verb: string, reasons: string[], detail?: string, source?: string, kind?: string, offending?: unknown[]) {
    const why = detail ?? (reasons.length ? `no rule allows it (${reasons.join(', ')})` : 'no policy rule allows it' + (source ? ` for a ${kind}/ branch (${source})` : '') + ': you need a role that a branch:merge policy accepts (for example iam-admin or branch-merger)');
    return new ForbiddenException({ code: 'merge-not-permitted', message: `You are not allowed to ${verb} protected branch ${branch}: ${why}`, branch, action: 'branch:merge', reasons, ...(offending ? { offending } : {}) });
  }

  private async askCore(i: { tenant: string; sub: string; branch: string; source?: string; sourceKind?: string; changeScope?: string }) {
    const core = process.env.IAM_CORE_URL;
    if (!core) throw new Error('IAM_CORE_URL is not set');
    const res = await fetch(`${core}/v1/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(4000),
      body: JSON.stringify({ tenant: i.tenant, principal: `User::"${i.sub}"`, action: 'Action::"branch:merge"', resource: `Branch::"${i.branch}"`, context: i.source ? { ...(i.changeScope ? { change_scope: i.changeScope } : {}), source: i.source, source_kind: i.sourceKind ?? 'other', source_folder: branchFolder(i.source) } : {}, audit: { source: 'http', subject: i.sub, note: `merge permission for protected branch ${i.branch}` } }) });
    if (!res.ok) throw new Error(`core answered ${res.status}`);
    const out = (await res.json()) as { allow?: boolean; reasons?: string[]; errors?: string[] };
    return { allow: out.allow === true, reasons: [...(out.reasons ?? []), ...(out.errors ?? [])] };
  }
}
