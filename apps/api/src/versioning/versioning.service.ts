import { applyContext, workspaceMode, currentBranch } from '../workspace/context.js';
import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { createConnection, Connection, FieldPacket } from 'mysql2/promise';
import { SOD_SQL } from '../dolt/dolt.service.js';
import { HASH, authorOf, branchName, checkSql, commitMessage, newBranchName, tableName, TAG } from './guards.js';

export type RefKind = 'branch' | 'tag' | 'commit';
export interface Ref { kind: RefKind; name: string }
export type Row = Record<string, unknown>;
export type EditOp = { op: 'insert'; values: Row } | { op: 'update'; key: Row; values: Row } | { op: 'delete'; key: Row };

const ROW_CAP = 500;
const PAGE_MAX = 200;

/**
 * Version-control operations on the Dolt database (branches, history, diffs, data, SQL console, revert/restore).
 *
 * Isolation rules, all enforced here and tested:
 *  - Every request uses its own connection; a branch is selected per connection (DOLT_CHECKOUT) or through a revision database
 *    (read only for commits and tags), so one request never changes what another one sees.
 *  - All operations that write run one at a time (in this process) and start from a CLEAN working set of the branch; on any failure
 *    the working set is reset, so a failed edit never leaves half a change behind.
 *  - Protected branches (default: main) refuse direct writes, restores and deletes. Changes reach them only through a pull request,
 *    which re-runs the merge checks (conflicts and Separation-of-Duties) before merging.
 */
@Injectable()
export class VersioningService {
  private chain: Promise<unknown> = Promise.resolve();

  get dbName() { return process.env.DOLT_DATABASE ?? 'iam'; }
  get defaultBranch() { return process.env.IAM_DEFAULT_BRANCH ?? 'main'; }
  private get protectedBranches() { return (process.env.IAM_PROTECTED_BRANCHES ?? this.defaultBranch).split(',').map((s) => s.trim()).filter(Boolean); }
  private get protectionOff() { return process.env.IAM_VERSIONING_ALLOW_PROTECTED_WRITE === '1'; }
  /** Set by BranchProtectionService: stored per-branch setting (true/false), undefined while nothing is stored for the branch. */
  protectionLookup?: (branch: string) => boolean | undefined;
  /** Set by BranchProtectionService: throws 403 when the caller may not merge into this protected branch. */
  mergeGate?: (target: string, sub: unknown, source?: string) => Promise<void>;
  isProtectedByEnv(b: string) { return this.protectedBranches.includes(b); }
  isProtected(b: string) { return !this.protectionOff && (this.protectionLookup?.(b) ?? this.isProtectedByEnv(b)); }

  /** Opens a connection; `database` is `<db>` or `<db>/<revision>` (a revision database is read only for commits and tags). */
  async connect(revision?: string, autocommit = true): Promise<Connection> {
    const c = await createConnection({
      host: process.env.DOLT_HOST ?? '127.0.0.1', port: Number(process.env.DOLT_PORT ?? 3307),
      user: process.env.DOLT_USER ?? 'root', password: process.env.DOLT_PASSWORD ?? '',
      database: revision ? `${this.dbName}/${revision}` : this.dbName, connectTimeout: 5000,
    });
    if (!autocommit) await c.query('SET @@autocommit = 0');
    return c;
  }

  /** Runs write operations one at a time. */
  lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Validates a branch, tag or commit and says which one it is. */
  async resolve(c: Connection, ref: string): Promise<Ref> {
    if (HASH.test(ref)) {
      const [r] = await c.query('select count(*) n from dolt_commits where commit_hash = ?', [ref]);
      if (Number((r as { n: number }[])[0].n) > 0) return { kind: 'commit', name: ref };
      throw new NotFoundException(`unknown commit ${ref}`);
    }
    const name = branchName(ref, 'ref');
    const [b] = await c.query('select count(*) n from dolt_branches where name = ?', [name]);
    if (Number((b as { n: number }[])[0].n) > 0) return { kind: 'branch', name };
    const [t] = await c.query('select count(*) n from dolt_tags where tag_name = ?', [name]);
    if (Number((t as { n: number }[])[0].n) > 0) return { kind: 'tag', name };
    throw new NotFoundException(`unknown branch, tag or commit "${name}"`);
  }

  /** Runs `fn` on a connection positioned at the ref: a branch is checked out, a tag or commit is opened read only. */
  async at<T>(ref: string, fn: (c: Connection, r: Ref) => Promise<T>, autocommit = true): Promise<T> {
    const probe = await this.connect();
    let r: Ref;
    try { r = await this.resolve(probe, ref); } finally { await probe.end(); }
    const c = await this.connect(r.kind === 'branch' ? undefined : r.name, autocommit);
    try {
      if (r.kind === 'branch') await c.query('CALL DOLT_CHECKOUT(?)', [r.name]);
      return await fn(c, r);
    } finally { await c.end(); }
  }

  private async cleanOrFail(c: Connection, branch: string) {
    const [s] = await c.query('select count(*) n from dolt_status');
    if (Number((s as { n: number }[])[0].n) > 0) throw new ConflictException(`branch ${branch} has uncommitted changes from another session; nothing was changed`);
  }
  private async discard(c: Connection) {
    try { await c.query('ROLLBACK'); } catch { /* nothing to roll back */ }
    try { await c.query("CALL DOLT_MERGE('--abort')"); } catch { /* no merge in progress */ }
    try { await c.query("CALL DOLT_RESET('--hard')"); await c.query('CALL DOLT_CLEAN()'); } catch { /* best effort */ }
  }
  /** Write guard: protected branch refused, working set must be clean, failure resets the branch working set. */
  async writeOn<T>(branch: string, fn: (c: Connection) => Promise<T>): Promise<T> {
    branchName(branch);
    if(workspaceMode() && !applyContext.getStore() && branch!==currentBranch(true))throw new ForbiddenException('Write must use globally selected branch');
    if (this.isProtected(branch)) throw new ForbiddenException(`branch ${branch} is protected: open a pull request instead`);
    return this.lock(() => this.at(branch, async (c, r) => {
      if (r.kind !== 'branch') throw new BadRequestException('only a branch can be changed');
      await this.cleanOrFail(c, branch);
      try { return await fn(c); } catch (e) { await this.discard(c); throw mapSqlError(e); }
    }));
  }

  private async commitAll(c: Connection, message: string, author: string): Promise<string> {
    await c.query("CALL DOLT_ADD('-A')");
    const [r] = await c.query("CALL DOLT_COMMIT('-m', ?, '--author', ?)", [message, author]);
    return String((r as { hash: string }[])[0].hash);
  }

  // ---------------------------------------------------------------------------------------- branches and tags

  async branches() {
    const c = await this.connect();
    try {
      const [rows] = await c.query('select name, hash, latest_committer, latest_commit_date, latest_commit_message from dolt_branches order by name limit 100');
      const def = this.defaultBranch;
      const out = [];
      for (const b of rows as { name: string; hash: string; latest_committer: string; latest_commit_date: string; latest_commit_message: string }[]) {
        let ahead = 0, behind = 0;
        if (b.name !== def) {
          const [a] = await c.query('select count(*) n from dolt_log(?)', [`${def}..${b.name}`]);
          const [d] = await c.query('select count(*) n from dolt_log(?)', [`${b.name}..${def}`]);
          ahead = Number((a as { n: number }[])[0].n); behind = Number((d as { n: number }[])[0].n);
        }
        out.push({ name: b.name, commit: b.hash, committer: b.latest_committer, date: b.latest_commit_date, message: b.latest_commit_message, protected: this.isProtected(b.name), default: b.name === def, aheadOfDefault: ahead, behindDefault: behind });
      }
      return { default: def, branches: out };
    } finally { await c.end(); }
  }

  createBranch(name: string, from: string) {
    newBranchName(name);
    return this.lock(async () => {
      const c = await this.connect();
      try {
        const r = await this.resolve(c, from);
        const [e] = await c.query('select count(*) n from dolt_branches where name = ?', [name]);
        if (Number((e as { n: number }[])[0].n) > 0) throw new ConflictException(`branch ${name} already exists`);
        await c.query('CALL DOLT_BRANCH(?, ?)', [name, r.name]);
        const [h] = await c.query('select hashof(?) h', [name]);
        return { branch: name, commit: (h as { h: string }[])[0].h, from: r.name };
      } catch (e) { throw mapSqlError(e); } finally { await c.end(); }
    });
  }

  deleteBranch(name: string, hasOpenPr: (b: string) => Promise<boolean>) {
    branchName(name);
    if (name === this.defaultBranch || this.isProtected(name)) throw new ForbiddenException(`branch ${name} is protected and cannot be deleted`);
    return this.lock(async () => {
      if (await hasOpenPr(name)) throw new ConflictException(`branch ${name} is used by an open pull request: close or merge it first`);
      const c = await this.connect();
      try {
        await this.resolve(c, name);
        await c.query("CALL DOLT_BRANCH('-D', ?)", [name]);
        return { deleted: name };
      } catch (e) { throw mapSqlError(e); } finally { await c.end(); }
    });
  }

  /** Moves a branch back to an earlier commit. The commits after it stay reachable by hash (and from other branches) but leave the branch history. */
  resetBranch(name: string, commit: string, confirm: boolean) {
    branchName(name);
    if(workspaceMode() && name!==currentBranch(true))throw new ForbiddenException('Restore must use globally selected branch');
    if (!confirm) throw new ConflictException({ code: 'confirmation-required', message: 'restoring a branch drops the later commits from its history: send confirm=true' });
    if (this.isProtected(name)) throw new ForbiddenException(`branch ${name} is protected: use "revert" on a new branch and a pull request`);
    return this.lock(async () => {
      const c = await this.connect();
      try {
        const b = await this.resolve(c, name);
        if (b.kind !== 'branch') throw new BadRequestException('not a branch');
        const t = await this.resolve(c, commit);
        if (t.kind !== 'commit') throw new BadRequestException('a commit hash is required');
        const [before] = await c.query('select hashof(?) h', [name]);
        await c.query("CALL DOLT_BRANCH('-f', ?, ?)", [name, commit]);
        return { branch: name, now: commit, was: (before as { h: string }[])[0].h };
      } catch (e) { throw mapSqlError(e); } finally { await c.end(); }
    });
  }

  async tags() {
    const c = await this.connect();
    try {
      const [rows] = await c.query('select tag_name, tag_hash, tagger, date, message from dolt_tags order by date desc limit 200');
      return { tags: (rows as Row[]).map((t) => ({ name: t.tag_name, commit: t.tag_hash, tagger: t.tagger, date: t.date, message: t.message })) };
    } finally { await c.end(); }
  }
  createTag(name: string, commit: string, message: string | undefined, author: string) {
    if (typeof name !== 'string' || !TAG.test(name) || name.startsWith('act-')) throw new BadRequestException('invalid tag name ("act-" is reserved for activations)');
    return this.lock(async () => {
      const c = await this.connect();
      try {
        const r = await this.resolve(c, commit);
        if (r.kind !== 'commit') throw new BadRequestException('a commit hash is required');
        await c.query("CALL DOLT_TAG('-m', ?, '--author', ?, ?, ?)", [commitMessage(message, `tag ${name}`), author, name, commit]);
        return { tag: name, commit };
      } catch (e) { throw mapSqlError(e); } finally { await c.end(); }
    });
  }
  deleteTag(name: string) {
    if (typeof name !== 'string' || !TAG.test(name)) throw new BadRequestException('invalid tag name');
    if (name.startsWith('act-')) throw new ForbiddenException('activation tags cannot be deleted');
    return this.lock(async () => {
      const c = await this.connect();
      try { await c.query("CALL DOLT_TAG('-d', ?)", [name]); return { deleted: name }; } catch (e) { throw mapSqlError(e); } finally { await c.end(); }
    });
  }

  // ---------------------------------------------------------------------------------------- history

  async log(ref: string, limit = 50, offset = 0) {
    const lim = clamp(limit, 1, PAGE_MAX), off = Math.max(0, Math.floor(Number(offset) || 0));
    return this.at(ref, async (c, r) => {
      const [rows] = await c.query('select commit_hash, committer, email, date, message from dolt_log(?) limit ? offset ?', [r.name, lim + 1, off]);
      const page = (rows as Row[]).slice(0, lim);
      const hashes = page.map((x) => x.commit_hash as string);
      const parents = new Map<string, string[]>();
      if (hashes.length) {
        const [p] = await c.query('select commit_hash, parent_hash, parent_index from dolt_commit_ancestors where commit_hash in (?) order by parent_index', [hashes]);
        for (const x of p as { commit_hash: string; parent_hash: string | null }[]) if (x.parent_hash) parents.set(x.commit_hash, [...(parents.get(x.commit_hash) ?? []), x.parent_hash]);
      }
      const [bs] = await c.query('select name, hash from dolt_branches');
      const [ts] = await c.query('select tag_name, tag_hash from dolt_tags');
      const marks = new Map<string, string[]>();
      for (const b of bs as { name: string; hash: string }[]) marks.set(b.hash, [...(marks.get(b.hash) ?? []), b.name]);
      for (const t of ts as { tag_name: string; tag_hash: string }[]) marks.set(t.tag_hash, [...(marks.get(t.tag_hash) ?? []), `tag:${t.tag_name}`]);
      return {
        ref: r.name, kind: r.kind, offset: off, hasMore: (rows as Row[]).length > lim,
        commits: page.map((x) => ({ commit: x.commit_hash, author: x.committer, date: x.date, message: x.message, parents: parents.get(x.commit_hash as string) ?? [], refs: marks.get(x.commit_hash as string) ?? [], merge: (parents.get(x.commit_hash as string) ?? []).length > 1 })),
      };
    });
  }

  async commit(hash: string) {
    if (!HASH.test(hash)) throw new BadRequestException('invalid commit hash');
    const c = await this.connect();
    try {
      await this.resolve(c, hash);
      const [m] = await c.query('select commit_hash, committer, date, message from dolt_commits where commit_hash = ?', [hash]);
      const [p] = await c.query('select parent_hash from dolt_commit_ancestors where commit_hash = ? and parent_hash is not null order by parent_index', [hash]);
      const parents = (p as { parent_hash: string }[]).map((x) => x.parent_hash);
      let changes: unknown[] = [];
      if (parents.length) { const [s] = await c.query('select * from dolt_diff_summary(?, ?)', [parents[0], hash]); changes = (s as Row[]).map(summaryRow); }
      const row = (m as Row[])[0];
      return { commit: hash, author: row.committer, date: row.date, message: row.message, parents, changes, firstParentDiff: parents.length > 0 };
    } finally { await c.end(); }
  }

  // ---------------------------------------------------------------------------------------- diff

  /** `three` compares from the common ancestor (like a pull request); otherwise the two refs are compared directly. */
  async diffSummary(from: string, to: string, three = false) {
    const c = await this.connect();
    try {
      const f = await this.resolve(c, from), t = await this.resolve(c, to);
      const [s] = await c.query(three ? 'select * from dolt_diff_summary(?)' : 'select * from dolt_diff_summary(?, ?)', three ? [`${f.name}...${t.name}`] : [f.name, t.name]);
      const [sc] = await c.query(three ? 'select * from dolt_schema_diff(?)' : 'select * from dolt_schema_diff(?, ?)', three ? [`${f.name}...${t.name}`] : [f.name, t.name]);
      let stat: Row[] = [];
      try { [stat] = (await c.query(three ? 'select * from dolt_diff_stat(?)' : 'select * from dolt_diff_stat(?, ?)', three ? [`${f.name}...${t.name}`] : [f.name, t.name])) as unknown as [Row[]]; } catch { /* older Dolt: counts stay absent, the table list still works */ }
      const counts = rowCounts(stat);
      return { from: f.name, to: t.name, three, rows: sumRows(counts), tables: (s as Row[]).map((x) => { const r = summaryRow(x); return { ...r, rows: counts.get(String(r.table)) ?? null }; }), schema: (sc as Row[]).filter((x) => x.from_create_statement !== x.to_create_statement).map((x) => ({ table: x.to_table_name ?? x.from_table_name, from: x.from_create_statement ?? null, to: x.to_create_statement ?? null })) };
    } finally { await c.end(); }
  }

  async diffTable(from: string, to: string, table: string, three = false, limit = 100) {
    tableName(table);
    const lim = clamp(limit, 1, PAGE_MAX);
    const c = await this.connect();
    try {
      const f = await this.resolve(c, from), t = await this.resolve(c, to);
      const [rows] = await c.query(three ? 'select * from dolt_diff(?, ?) limit ?' : 'select * from dolt_diff(?, ?, ?) limit ?', three ? [`${f.name}...${t.name}`, table, lim + 1] : [f.name, t.name, table, lim + 1]);
      let primaryKey: string[] = [];
      if (t.kind === 'branch') { try { primaryKey = await this.at(t.name, async (cc) => (await this.columns(cc, table)).filter((x) => x.key === 'PRI').map((x) => x.name)); } catch { /* table absent on that branch: no key, no row actions */ } }
      return { table, truncated: (rows as Row[]).length > lim, primaryKey, ...shapeDiff((rows as Row[]).slice(0, lim)) };
    } catch (e) { throw mapSqlError(e); } finally { await c.end(); }
  }

  // ---------------------------------------------------------------------------------------- tables and data

  async tables(ref: string) {
    return this.at(ref, async (c, r) => {
      const [t] = await c.query('show tables');
      const names = (t as Row[]).map((x) => String(Object.values(x)[0])).filter((n) => !n.startsWith('dolt_')).sort();
      const out = [];
      for (const n of names) { const [k] = await c.query('select count(*) n from ??', [n]); out.push({ name: n, rows: Number((k as { n: number }[])[0].n) }); }
      return { ref: r.name, kind: r.kind, tables: out };
    });
  }

  private async columns(c: Connection, table: string) {
    const [t] = await c.query('show tables');
    if (!(t as Row[]).some((x) => Object.values(x)[0] === table) || table.startsWith('dolt_')) throw new NotFoundException(`unknown table ${table}`);
    const [cols] = await c.query('show full columns from ??', [table]);
    return (cols as Row[]).map((x) => ({ name: String(x.Field), type: String(x.Type), nullable: x.Null === 'YES', key: String(x.Key ?? ''), default: x.Default ?? null }));
  }

  async tableRows(ref: string, table: string, limit = 50, offset = 0) {
    tableName(table);
    const lim = clamp(limit, 1, PAGE_MAX), off = Math.max(0, Math.floor(Number(offset) || 0));
    return this.at(ref, async (c, r) => {
      const cols = await this.columns(c, table);
      const pk = cols.filter((x) => x.key === 'PRI').map((x) => x.name);
      const [rows] = await c.query(`select * from ??${pk.length ? ' order by ' + pk.map(() => '??').join(', ') : ''} limit ? offset ?`, [table, ...pk, lim + 1, off]);
      const [n] = await c.query('select count(*) n from ??', [table]);
      const [ddl] = await c.query('show create table ??', [table]);
      return { ref: r.name, kind: r.kind, table, columns: cols, primaryKey: pk, total: Number((n as { n: number }[])[0].n), offset: off, hasMore: (rows as Row[]).length > lim, rows: (rows as Row[]).slice(0, lim), createStatement: String((ddl as Row[])[0]['Create Table'] ?? '') };
    });
  }

  /** Row edits on a branch, committed together in ONE commit (author = the signed-in user). */
  editRows(branch: string, table: string, ops: EditOp[], message: string | undefined, sub: unknown) {
    if (workspaceMode() && branch !== currentBranch(true)) throw new ForbiddenException('Edit must use the selected working branch');
    if (ops?.some(o=>'values' in o && Object.keys(o.values).some(k=>k.toLowerCase()==='workflow_creation_ref'))) throw new ForbiddenException('Workflow creation provenance is managed by workflow creation only');
    if (ops?.some(o=>'values' in o && Object.keys(o.values).some(k=>k.toLowerCase()==='credential_revision'))) throw new ForbiddenException('Credential revisions are managed by Users only');
    if (table.toLowerCase().startsWith('plugin_runtime_')) throw new ForbiddenException('Use Plugins to change runtime settings, grants and state');
    tableName(table);
    if (!Array.isArray(ops) || ops.length < 1 || ops.length > 100) throw new BadRequestException('1 to 100 operations expected');
    return this.writeOn(branch, async (c) => {
      const cols = await this.columns(c, table);
      const names = new Set(cols.map((x) => x.name));
      const pk = cols.filter((x) => x.key === 'PRI').map((x) => x.name);
      const own = (o: unknown, what: string): Row => {
        if (!o || typeof o !== 'object' || Array.isArray(o)) throw new BadRequestException(`${what} must be an object`);
        for (const k of Object.keys(o)) if (!names.has(k)) throw new BadRequestException(`unknown column ${k}`);
        return o as Row;
      };
      const val = (v: unknown) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
      for (const o of ops) {
        if (o?.op === 'insert') {
          const v = own(o.values, 'values'); const keys = Object.keys(v);
          if (!keys.length) throw new BadRequestException('values is empty');
          await c.query('insert into ?? (??) values (?)', [table, keys, keys.map((k) => val(v[k]))]);
        } else if (o?.op === 'update' || o?.op === 'delete') {
          if (!pk.length) throw new BadRequestException(`table ${table} has no primary key: edit it in the SQL console`);
          const k = own(o.key, 'key');
          if (Object.keys(k).length !== pk.length || !pk.every((p) => k[p] !== undefined && k[p] !== null)) throw new BadRequestException(`key must contain exactly the primary key columns: ${pk.join(', ')}`);
          const where = pk.map(() => '?? = ?').join(' and '), wp = pk.flatMap((p) => [p, val(k[p])]);
          let affected: number;
          if (o.op === 'update') {
            const v = own(o.values, 'values'); const keys = Object.keys(v);
            if (!keys.length) throw new BadRequestException('values is empty');
            const [res] = await c.query(`update ?? set ${keys.map(() => '?? = ?').join(', ')} where ${where}`, [table, ...keys.flatMap((x) => [x, val(v[x])]), ...wp]);
            affected = (res as { affectedRows: number; changedRows?: number }).affectedRows;
          } else {
            const [res] = await c.query(`delete from ?? where ${where}`, [table, ...wp]);
            affected = (res as { affectedRows: number }).affectedRows;
          }
          if (affected !== 1) throw new NotFoundException(`no row with key ${JSON.stringify(k)} in ${table}`);
        } else throw new BadRequestException('op must be insert, update or delete');
      }
      const hash = await this.commitAll(c, commitMessage(message, `edit ${table}: ${ops.length} change(s)`), authorOf(sub));
      return { branch, table, commit: hash, operations: ops.length };
    });
  }

  // ---------------------------------------------------------------------------------------- one-row changes of a working branch (pull request diff)

  /**
   * Runs ONE single-row change on a working branch in one session, in one explicit transaction, and commits it. Stricter than writeOn,
   * because these routes act on someone else's branch while it may be in use:
   *  - `expectedHead` is REQUIRED and must still be the branch head (otherwise 409, nothing touched);
   *  - the working set must be clean before, and exactly ONE row of ONE table may differ before the commit (otherwise rollback, 409);
   *  - only that table is staged (never an "add all"), and the commit's parent must be `expectedHead`;
   *  - on ANY failure only this session's transaction is rolled back. There is no reset --hard and no clean: another session's work is never erased.
   */
  private branchTx(branch: string, expectedHead: unknown, fn: (c: Connection) => Promise<{ table: string; info: Row; noop?: boolean }>, message: string, sub: unknown): Promise<Row & { branch: string; table: string; commit: string | null }> {
    branchName(branch);
    if (typeof expectedHead !== 'string' || !HASH.test(expectedHead)) throw new BadRequestException('expectedHead (the 32-character head of the branch you reviewed) is required');
    if (workspaceMode() && !applyContext.getStore() && branch !== currentBranch(true)) throw new ForbiddenException('Write must use globally selected branch');
    if (this.isProtected(branch)) throw new ForbiddenException(`branch ${branch} is protected: open a pull request instead`);
    return this.lock(async () => {
      const c = await this.connect(undefined, false);
      try {
        const [bh] = await c.query('select count(*) n from dolt_branches where name = ?', [branch]);
        if (Number((bh as { n: number }[])[0].n) !== 1) throw new NotFoundException(`unknown branch ${branch}`);
        await c.query('CALL DOLT_CHECKOUT(?)', [branch]);
        const [h] = await c.query('select hashof(?) h', [branch]);
        if ((h as { h: string }[])[0].h !== expectedHead) throw new ConflictException('Working branch changed. Review again before changing it.');
        await this.cleanOrFail(c, branch);
        const { table, info, noop } = await fn(c);
        if (noop) { await c.query('ROLLBACK'); return { ...info, branch, table, commit: null, noChange: true }; }
        await c.query('CALL DOLT_ADD(?)', [table]);
        const [sum] = await c.query("select * from dolt_diff_summary('HEAD', 'STAGED')");
        const tables = (sum as Row[]).map((x) => String(x.to_table_name ?? x.from_table_name));
        const [st] = await c.query("select * from dolt_diff_stat('HEAD', 'STAGED', ?)", [table]);
        const changed = (st as Row[]).reduce((n, x) => n + Number(x.rows_added ?? 0) + Number(x.rows_modified ?? 0) + Number(x.rows_deleted ?? 0), 0);
        const [un] = await c.query('select count(*) n from dolt_status where staged = 0');
        // The write changed nothing: the row already had the target value. That is not a stale head, so report it as a no-op.
        if (tables.length === 0 && changed === 0 && Number((un as { n: number }[])[0].n) === 0) { await c.query('ROLLBACK'); return { ...info, branch, table, commit: null, noChange: true }; }
        if (tables.length !== 1 || tables[0] !== table || changed !== 1 || Number((un as { n: number }[])[0].n) !== 0) throw new ConflictException('The branch changed while this was prepared. Nothing was changed; review again.');
        const [r] = await c.query("CALL DOLT_COMMIT('-m', ?, '--author', ?)", [commitMessage(message, 'change one row'), authorOf(sub)]);
        const hash = String((r as { hash: string }[])[0].hash);
        const [p] = await c.query('select parent_hash from dolt_commit_ancestors where commit_hash = ? and parent_index = 0', [hash]);
        if ((p as { parent_hash: string }[])[0]?.parent_hash !== expectedHead) throw new ConflictException('The branch moved while committing. Nothing was kept.');
        await c.query('COMMIT');
        // Verify through a DIFFERENT connection that the commit really is on the branch with the reviewed head as parent. A mismatch is reported, never auto-undone.
        const v2 = await this.connect();
        try {
          const [seen] = await v2.query('select count(*) n from dolt_log(?) where commit_hash = ?', [branch, hash]);
          const [par] = await v2.query('select parent_hash from dolt_commit_ancestors where commit_hash = ? and parent_index = 0', [hash]);
          if (Number((seen as { n: number }[])[0].n) !== 1 || (par as { parent_hash: string }[])[0]?.parent_hash !== expectedHead) throw new ConflictException(`Commit ${hash} was written but could not be confirmed on ${branch} with the reviewed head as its parent (the branch may have moved at the same time). Nothing was undone: review the branch history.`);
        } finally { await v2.end(); }
        return { ...info, branch, table, commit: hash };
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch { /* the session is closed below anyway */ }
        throw mapSqlError(e);
      } finally { await c.end(); }
    });
  }

  private rowKey(cols: { name: string; key: string }[], key: Row) {
    const pk = cols.filter((x) => x.key === 'PRI').map((x) => x.name);
    if (!pk.length) throw new BadRequestException('this table has no primary key: use the SQL console');
    if (!key || typeof key !== 'object' || Array.isArray(key) || Object.keys(key).length !== pk.length || !pk.every((p) => key[p] !== undefined && key[p] !== null)) throw new BadRequestException(`key must contain exactly the primary key columns: ${pk.join(', ')}`);
    return pk;
  }
  private static val(v: unknown) { return v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v) ? JSON.stringify(v) : v; }
  /** Credential references and plugin runtime state: never typed in by hand, never put back to an old value. */
  private static sensitiveCol(table: string, n: string) { return ['credential_revision', 'workflow_creation_ref'].includes(n.toLowerCase()) || table.toLowerCase().startsWith('plugin_runtime_'); }

  /**
   * Abandons ONE change of a working branch (a pull request source), keeping every other change: the row (or only the named columns of a
   * modified row) goes back to what it was where the branch diverged from `target` (the three-dot base). Added row: deleted. Removed row: put back.
   * Sensitive data (credential_revision, plugin_runtime_*) is never put back to the OLD base value: it is set to what `target` holds NOW
   * (read through its own connection, never a join across revisions), and a plugin runtime row is restored whole. If the target no longer
   * has that row, the discard is refused. Nothing new is ever written: only a value that exists on the base or on the target.
   * The caller (the pull request) supplies source and target; the client never chooses them. See branchTx for the isolation rules.
   */
  async discardChange(branch: string, target: string, table: string, key: Row, opts: { columns?: string[]; expectedHead?: unknown; message?: string }, sub: unknown) {
    tableName(table); branchName(target, 'target');
    if (branch === target) throw new ForbiddenException(`${target} has no changes of its own to discard`);
    return this.branchTx(branch, opts.expectedHead, async (c) => {
      const cols = await this.columns(c, table);
      const names = new Set(cols.map((x) => x.name));
      const pk = this.rowKey(cols, key);
      const val = VersioningService.val, sens = (n: string) => VersioningService.sensitiveCol(table, n);
      let only: string[] | undefined;
      if (opts.columns !== undefined) {
        if (!Array.isArray(opts.columns) || !opts.columns.length || opts.columns.length > 50 || opts.columns.some((x) => typeof x !== 'string' || !names.has(x))) throw new BadRequestException('columns must name existing columns');
        if (opts.columns.some((x) => pk.includes(x))) throw new BadRequestException('a key column cannot be discarded on its own: discard the whole row');
        only = opts.columns;
      }
      // Base and branch values are read from the diff in a SEPARATE query.
      const where = '(' + pk.map(() => '?? = ?').join(' and ') + ') or (' + pk.map(() => '?? = ?').join(' and ') + ')';
      const wp = [...pk.flatMap((p) => [`to_${p}`, val(key[p])]), ...pk.flatMap((p) => [`from_${p}`, val(key[p])])];
      const [d] = await c.query(`select * from dolt_diff(?, ?) where ${where} limit 2`, [`${target}...${(await this.headName(c))}`, table, ...wp]);
      const rows = d as Row[];
      if (rows.length !== 1) {
        // No change since the divergence. If the row already equals the target's, that is a harmless no-op, not an error and not a stale head.
        const mineRows = (await c.query(`select * from ?? where ${pk.map(() => '?? = ?').join(' and ')}`, [table, ...pk.flatMap((p) => [p, val(key[p])])]))[0] as Row[];
        const theirs = await this.at(target, async (tc) => (await tc.query(`select * from ?? where ${pk.map(() => '?? = ?').join(' and ')}`, [table, ...pk.flatMap((p) => [p, val(key[p])])]))[0] as Row[]);
        const same = mineRows.length === theirs.length && (mineRows.length === 0 || JSON.stringify(Object.entries(mineRows[0]).map(([k, x]) => [k, val(x)])) === JSON.stringify(Object.entries(theirs[0]).map(([k, x]) => [k, val(x)])));
        if (same) return { table, info: { key, change: 'none', action: `already identical to ${target}: nothing to discard` }, noop: true };
        throw new NotFoundException(`no change to ${table} ${JSON.stringify(key)} on ${branch} since it diverged from ${target}`);
      }
      const r = rows[0], type = String(r.diff_type);
      const base = (n: string) => r[`from_${n}`], mine = (n: string) => r[`to_${n}`];
      const kw = pk.flatMap((p) => [p, val(key[p])]), kwhere = pk.map(() => '?? = ?').join(' and ');
      const targetRow = async (): Promise<Row> => {
        if (target !== this.defaultBranch) throw new ForbiddenException(`credential and plugin state can only be discarded toward ${this.defaultBranch}, not ${target}`);
        const t = await this.at(target, async (tc) => (await tc.query(`select * from ?? where ${kwhere}`, [table, ...kw]))[0] as Row[]);
        if (t.length !== 1) throw new ConflictException(`${target} no longer has this row: its credential or plugin state cannot be discarded to a known value. Nothing was changed.`);
        return t[0];
      };
      let what: string;
      if (type === 'added') {
        if (only) throw new BadRequestException('an added row has no earlier value: discard the whole row');
        const [res] = await c.query(`delete from ?? where ${kwhere}`, [table, ...kw]);
        if ((res as { affectedRows: number }).affectedRows !== 1) throw new ConflictException('the row is not on the branch any more');
        what = 'removed the added row';
      } else if (type === 'removed') {
        if (only) throw new BadRequestException('a removed row is put back whole: discard the whole row');
        const keys = cols.map((x) => x.name).filter((n) => `from_${n}` in r);
        const tr = keys.some(sens) ? await targetRow() : null;
        await c.query('insert into ?? (??) values (?)', [table, keys, keys.map((k) => val(sens(k) ? tr![k] : base(k)))]);
        what = 'put the removed row back';
      } else if (type === 'modified') {
        const differing = cols.map((x) => x.name).filter((n) => !pk.includes(n) && `from_${n}` in r && `to_${n}` in r && JSON.stringify(val(base(n))) !== JSON.stringify(val(mine(n))));
        const wholeRow = !only && table.toLowerCase().startsWith('plugin_runtime_');
        const use = wholeRow ? cols.map((x) => x.name).filter((n) => !pk.includes(n)) : only ? only.filter((n) => differing.includes(n)) : differing;
        if (!use.length) throw new NotFoundException('none of those columns changed on the branch');
        const tr = use.some(sens) ? await targetRow() : null;
        const restored = (n: string) => (sens(n) ? tr![n] : base(n));
        const [res] = await c.query(`update ?? set ${use.map(() => '?? = ?').join(', ')} where ${kwhere}`, [table, ...use.flatMap((n) => [n, val(restored(n))]), ...kw]);
        if ((res as { affectedRows: number }).affectedRows !== 1) throw new ConflictException('the row is not on the branch any more');
        what = `restored ${use.join(', ')} (${use.some(sens) ? `sensitive fields to the current ${target} value, the others to the base value` : 'base value'})`;
      } else throw new BadRequestException('unsupported change type');
      return { table, info: { key, change: type, action: what } };
    }, opts.message ?? '', sub).then((out) => out);
  }

  /** A typed edit of ONE row of a working branch (pull request source). Credential references and plugin runtime state cannot be typed in. Same isolation as discardChange. */
  async editRowChecked(branch: string, table: string, key: Row, values: Row, expectedHead: unknown, message: string | undefined, sub: unknown) {
    tableName(table);
    if (table.toLowerCase().startsWith('plugin_runtime_')) throw new ForbiddenException('Use Plugins to change runtime settings, grants and state');
    if (!values || typeof values !== 'object' || Array.isArray(values) || !Object.keys(values).length || Object.keys(values).length > 50) throw new BadRequestException('values must be a non-empty object');
    if (Object.keys(values).some((k) => k.toLowerCase() === 'workflow_creation_ref')) throw new ForbiddenException('Workflow creation provenance is managed by workflow creation only');
    if (Object.keys(values).some((k) => k.toLowerCase() === 'credential_revision')) throw new ForbiddenException('Credential revisions are managed by Users only');
    return this.branchTx(branch, expectedHead, async (c) => {
      const cols = await this.columns(c, table);
      const names = new Set(cols.map((x) => x.name));
      const pk = this.rowKey(cols, key);
      for (const k of Object.keys(values)) { if (!names.has(k)) throw new BadRequestException(`unknown column ${k}`); if (pk.includes(k)) throw new BadRequestException('a key column cannot be edited here'); }
      const val = VersioningService.val, keys = Object.keys(values);
      const [res] = await c.query(`update ?? set ${keys.map(() => '?? = ?').join(', ')} where ${pk.map(() => '?? = ?').join(' and ')}`, [table, ...keys.flatMap((k) => [k, val(values[k])]), ...pk.flatMap((p) => [p, val(key[p])])]);
      if ((res as { affectedRows: number }).affectedRows !== 1) throw new NotFoundException(`no row with key ${JSON.stringify(key)} in ${table}`);
      return { table, info: { key, change: 'edited', action: `edited ${keys.join(', ')}` } };
    }, message ?? `edit ${table}: ${Object.keys(values).join(', ')}`, sub);
  }

  /** Name of the branch the connection is on (after DOLT_CHECKOUT). */
  private async headName(c: Connection): Promise<string> {
    const [r] = await c.query('select active_branch() b');
    return String((r as { b: string }[])[0].b);
  }

  // ---------------------------------------------------------------------------------------- SQL console

  /** Other databases on the same server (the pull request store, mysql, ...): refused as qualified names in console SQL. */
  private async otherDatabases(): Promise<string[]> {
    const c = await this.connect();
    try { const [r] = await c.query('show databases'); return (r as Row[]).map((x) => String(Object.values(x)[0])).filter((d) => d !== this.dbName && d !== 'information_schema'); } finally { await c.end(); }
  }

  async sqlRead(ref: string, sql: string) {
    const { statements } = checkSql(sql, 'read', await this.otherDatabases());
    const started = Date.now();
    return this.at(ref, async (c, r) => {
      try {
        await c.query('SET SESSION max_execution_time = 10000');
        await c.query('START TRANSACTION READ ONLY');
        const [rows, fields] = await c.query(statements[0]);
        await c.query('ROLLBACK');
        const arr = Array.isArray(rows) ? (rows as Row[]) : [];
        return { mode: 'read', ref: r.name, kind: r.kind, columns: ((fields as FieldPacket[] | undefined) ?? []).map((f) => f.name), rows: arr.slice(0, ROW_CAP), truncated: arr.length > ROW_CAP, rowCount: arr.length, ms: Date.now() - started };
      } catch (e) { try { await c.query('ROLLBACK'); } catch { /* ignore */ } throw mapSqlError(e); }
    });
  }

  /**
   * Write mode runs on a branch only. `dryRun` shows the exact diff and then discards everything.
   * Destructive statements (DROP, TRUNCATE, ALTER ... DROP, UPDATE/DELETE without WHERE) need `confirmDestructive`.
   */
  sqlWrite(branch: string, sql: string, opts: { message?: string; dryRun?: boolean; confirmDestructive?: boolean }, sub: unknown) {
    if (workspaceMode() && branch !== currentBranch(true)) throw new ForbiddenException('SQL writes must use selected working branch');
    return this.otherDatabases().then((others) => this.sqlWriteChecked(branch, sql, opts, sub, others));
  }
  private sqlWriteChecked(branch: string, sql: string, opts: { message?: string; dryRun?: boolean; confirmDestructive?: boolean }, sub: unknown, others: string[]) {
    const { statements, destructive } = checkSql(sql, 'write', others);
    return this.writeOn(branch, async (c) => {
      let affectedRows = 0;
      for (const s of statements) {
        const [res] = await c.query(s);
        affectedRows += Number((res as { affectedRows?: number }).affectedRows ?? 0);
      }
      await c.query("CALL DOLT_ADD('-A')");
      const [sum] = await c.query("select * from dolt_diff_summary('HEAD', 'STAGED')");
      const changes = (sum as Row[]).map(summaryRow);
      const samples: Record<string, unknown> = {};
      for (const ch of changes.slice(0, 10)) {
        const name = String(ch.table);
        try { const [d] = await c.query('select * from dolt_diff(?, ?, ?) limit 20', ['HEAD', 'STAGED', name]); samples[name] = shapeDiff(d as Row[]); } catch { /* dropped table: no row sample */ }
      }
      const base = { mode: 'write', branch, statements: statements.length, affectedRows, destructive, changes, samples };
      if (!changes.length) { await this.discard(c); return { ...base, committed: null, note: 'The statements changed nothing.' }; }
      if (opts.dryRun) { await this.discard(c); return { ...base, committed: null, dryRun: true }; }
      if (destructive && !opts.confirmDestructive) { await this.discard(c); throw new ConflictException({ code: 'destructive-confirmation-required', message: 'destructive statement: preview it, then send confirmDestructive=true', ...base }); }
      const hash = await this.commitAll(c, commitMessage(opts.message, `sql: ${statements[0].slice(0, 80)}`), authorOf(sub));
      return { ...base, committed: hash };
    });
  }

  // ---------------------------------------------------------------------------------------- revert

  /**
   * Undoes one commit by adding a NEW commit (history is kept). Onto an existing unprotected branch, or onto a new branch
   * created from `base` (default: the default branch), which is the way to revert something on main: then open a pull request.
   */
  async revert(commit: string, target: { onto?: string; newBranch?: string; base?: string }, message: string | undefined, sub: unknown) {
    if (!HASH.test(commit)) throw new BadRequestException('invalid commit hash');
    let branch = target.onto;
    if (target.newBranch) {
      newBranchName(target.newBranch);
      await this.createBranch(target.newBranch, target.base ?? this.defaultBranch);
      branch = target.newBranch;
    }
    if (!branch) throw new BadRequestException('give "onto" (an existing branch) or "newBranch"');
    return this.writeOn(branch, async (c) => {
      const [res] = await c.query('CALL DOLT_REVERT(?)', [commit]);
      const r = (res as { hash: string; data_conflicts: number; schema_conflicts: number; constraint_violations: number }[])[0];
      if (Number(r.data_conflicts) + Number(r.schema_conflicts) + Number(r.constraint_violations) > 0) throw new ConflictException(`reverting ${commit} conflicts with later changes on ${branch}; nothing was changed`);
      if (message) {
        const [h] = await c.query("CALL DOLT_COMMIT('--amend', '-m', ?, '--author', ?)", [commitMessage(message, ''), authorOf(sub)]);
        return { branch, revertedCommit: commit, commit: String((h as { hash: string }[])[0].hash), createdBranch: !!target.newBranch };
      }
      return { branch, revertedCommit: commit, commit: String(r.hash), createdBranch: !!target.newBranch };
    });
  }

  // ---------------------------------------------------------------------------------------- merge checks (used by pull requests)

  /** Trial merge of source into target in a throw-away transaction: reports conflicts and SoD violations, then aborts. Nothing is kept. */
  async trialMerge(source: string, target: string) {
    return this.lock(() => this.at(target, async (c) => {
      await this.cleanOrFail(c, target);
      try { return await this.mergeChecks(c, source, false, ''); } finally { await this.discard(c); }
    }, false));
  }

  /** Performs the merge (merge commit) when every check passes. Called under the lock by the pull request service. */
  async mergeInto(source: string, target: string, message: string, sub: unknown, expectedHead?: string) {
    if (workspaceMode() && target === 'main' && !applyContext.getStore()) throw new ForbiddenException('Use the global Apply action to merge into main');
    if (this.isProtected(target) && this.mergeGate) await this.mergeGate(target, sub, source);
    return this.lock(() => this.at(target, async (c) => {
      await this.cleanOrFail(c, target);
      if(expectedHead){const [heads]=await c.query('select hash from dolt_branches where name=?',[source]);if((heads as {hash:string}[])[0]?.hash!==expectedHead)throw new ConflictException('Working branch changed. Review again before Apply.');}
      try {
        const checks = await this.mergeChecks(c, source, true, message);
        if (!checks.mergeable) return { ...checks, commit: null };
        const [h] = await c.query("CALL DOLT_COMMIT('-m', ?, '--author', ?)", [message, authorOf(sub)]);
        await c.query('COMMIT');
        return { ...checks, commit: String((h as { hash: string }[])[0].hash) };
      } catch (e) { await this.discard(c); throw mapSqlError(e); }
    }, false));
  }

  /**
   * Rebases a working branch on top of the default branch (CALL DOLT_REBASE): the branch's own commits are replayed on the latest main,
   * so the branch gets what changed there while keeping its work. History of THIS branch is rewritten (new commit ids); main is never touched.
   * Safe by construction: refused on main, on protected branches and with uncommitted changes; a stale expectedHead is refused; plugin runtime
   * state is never replayed (same rule as a merge); a conflict aborts the rebase (Dolt restores the branch) and nothing changes.
   * A branch with no commit of its own is simply moved forward (fast-forward); a branch already containing main is reported as up to date.
   */
  async rebaseOnDefault(branch: string, expectedHead?: string) {
    const base = this.defaultBranch;
    branchName(branch);
    if (branch === base) throw new ForbiddenException(`${base} cannot be rebased: it is the branch the others are rebased on`);
    if (this.isProtected(branch)) throw new ForbiddenException(`branch ${branch} is protected: it cannot be rebased`);
    return this.lock(() => this.at(branch, async (c, r) => {
      if (r.kind !== 'branch') throw new BadRequestException('only a branch can be rebased');
      await this.cleanOrFail(c, branch);
      const head = async () => String(((await c.query('select hashof(?) h', [branch]))[0] as { h: string }[])[0].h);
      const count = async (range: string) => Number(((await c.query('select count(*) n from dolt_log(?)', [range]))[0] as { n: number }[])[0].n);
      const before = await head();
      if (expectedHead && expectedHead !== before) throw new ConflictException('Working branch changed. Review again before rebasing.');
      const behind = await count(`${branch}..${base}`), ahead = await count(`${base}..${branch}`);
      if (behind === 0) return { branch, base, rebased: false, upToDate: true, behind, ahead, before, commit: before };
      const [rt] = await c.query('select * from dolt_diff_summary(?)', [`${base}...${branch}`]);
      if ((rt as { from_table_name?: string; to_table_name?: string }[]).some((x) => [x.from_table_name, x.to_table_name].some((n) => n?.toLowerCase().startsWith('plugin_runtime_')))) throw new ForbiddenException('This branch changes plugin runtime state. Use Plugins, not a rebase, to change grants or enablement.');
      try {
        if (ahead === 0) await c.query('CALL DOLT_MERGE(?, ?)', ['--ff-only', base]);
        else await c.query('CALL DOLT_REBASE(?)', [base]);
      } catch (e) {
        await this.discard(c);
        const msg = String((e as { message?: string })?.message ?? e);
        if (/conflict/i.test(msg)) throw new ConflictException({ message: `Rebase refused: the branch conflicts with main. Nothing was changed.`, reasons: [msg.split('\n')[0]] });
        throw mapSqlError(e);
      }
      const after = await head();
      return { branch, base, rebased: true, upToDate: false, behind, ahead, before, commit: after };
    }));
  }

  private async mergeChecks(c: Connection, source: string, keep: boolean, _message: string) {
    const [runtimeDiff] = await c.query('select * from dolt_diff_summary(?)', [`HEAD...${source}`]);
    if (!applyContext.getStore() && (runtimeDiff as {from_table_name:string;to_table_name:string}[]).some(x=>[x.from_table_name,x.to_table_name].some(n=>n?.toLowerCase().startsWith('plugin_runtime_')))) throw new ForbiddenException('Plugin runtime state differs. Use Plugins, not a database merge, to change grants or enablement.');
    const [m] = await c.query("CALL DOLT_MERGE('--no-ff', '--no-commit', ?)", [source]);
    const r = (m as { conflicts: number; message: string }[])[0];
    const reasons: string[] = [];
    let violations: unknown[] = [];
    const conflicts = Number(r?.conflicts ?? 0);
    if (conflicts > 0) reasons.push(`${conflicts} data conflict(s): resolve them on the source branch`);
    if (!conflicts) {
      try { const [cv] = await c.query('select * from dolt_constraint_violations'); const n = (cv as { violations: number }[]).reduce((a, x) => a + Number(x.violations ?? 0), 0); if (n) reasons.push(`${n} constraint violation(s)`); } catch { /* table absent: no violations */ }
      try { const [v] = await c.query(SOD_SQL); violations = v as unknown[]; if (violations.length) reasons.push(`${violations.length} Separation-of-Duties violation(s)`); } catch { /* no assignments table on this database */ }
    }
    const [st] = await c.query('select count(*) n from dolt_status');
    const changed = Number((st as { n: number }[])[0].n) > 0;
    if (!conflicts && !changed) reasons.push('nothing to merge: the target already contains the source');
    const mergeable = reasons.length === 0;
    if (!keep || !mergeable) { await this.discard(c); }
    return { mergeable, reasons, conflicts, violations };
  }
}

function clamp(n: unknown, lo: number, hi: number) { const v = Math.floor(Number(n)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo; }

function summaryRow(x: Row) {
  return { table: x.to_table_name ?? x.from_table_name, from: x.from_table_name ?? null, kind: x.diff_type, dataChange: Number(x.data_change ?? 0) === 1, schemaChange: Number(x.schema_change ?? 0) === 1 };
}

const DIFF_META = new Set(['diff_type', 'to_commit', 'to_commit_date', 'from_commit', 'from_commit_date']);
/** Turns dolt_diff rows (from_x / to_x columns) into { type, from:{...}, to:{...} } plus the union of column names. */
export function shapeDiff(rows: Row[]) {
  const columns: string[] = [];
  const out = rows.map((r) => {
    const from: Row = {}, to: Row = {};
    for (const [k, v] of Object.entries(r)) {
      if (DIFF_META.has(k)) continue;
      const side = k.startsWith('from_') ? from : k.startsWith('to_') ? to : undefined;
      if (!side) continue;
      const name = k.slice(k.indexOf('_') + 1);
      if (!columns.includes(name)) columns.push(name);
      side[name] = v;
    }
    const type = String(r.diff_type);
    return { type, from: type === 'added' ? null : from, to: type === 'removed' ? null : to };
  });
  return { columns, rows: out };
}

/** MySQL errors are the operator's own SQL mistakes or conflicts: show the message as a 400/409 instead of a 500. */
export function mapSqlError(e: unknown): Error {
  if (e instanceof HttpException) return e;
  const err = e as { code?: string; sqlMessage?: string; message?: string };
  const msg = (err.sqlMessage ?? err.message ?? 'database error').slice(0, 400);
  if (/conflict/i.test(msg)) return new ConflictException(msg);
  if (err.code === 'ECONNREFUSED' || err.code === 'PROTOCOL_CONNECTION_LOST') return new HttpException('database unavailable', 503);
  return new BadRequestException(msg);
}

export interface RowCounts { added: number; modified: number; removed: number }
/** Rows changed per table, from dolt_diff_stat (rows_added / rows_modified / rows_deleted). The badge in the console counts these ROWS. */
export function rowCounts(stat: Row[]): Map<string, RowCounts> {
  const m = new Map<string, RowCounts>();
  for (const x of stat) m.set(String(x.table_name), { added: Number(x.rows_added ?? 0), modified: Number(x.rows_modified ?? 0), removed: Number(x.rows_deleted ?? 0) });
  return m;
}
export function sumRows(m: Map<string, RowCounts>): RowCounts & { total: number } {
  let added = 0, modified = 0, removed = 0;
  for (const r of m.values()) { added += r.added; modified += r.modified; removed += r.removed; }
  return { added, modified, removed, total: added + modified + removed };
}
