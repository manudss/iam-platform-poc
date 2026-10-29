import { Component, EventEmitter, Input, Output, inject, signal, computed } from '@angular/core';
import { Session } from './session';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiClient, BranchInfo, CommitInfo, DiffSummary, PullRequestDetail, PullRequestInfo, RowDiff, SqlResult, TableData, VersioningClient, cellText, shortHash } from './api';

export type Tab = 'branches' | 'history' | 'compare' | 'data' | 'sql' | 'pulls';
interface RowDiffView { table: string; columns: string[]; rows: RowDiff[]; truncated: boolean }

/**
 * Database explorer for the Dolt data: branches, history (with the commit graph as parent links), comparisons between any two
 * refs, tables and rows at any ref, a guarded SQL console and pull requests. Everything is read from the API; nothing here
 * decides what is allowed (the server enforces protected branches, SQL limits and merge checks).
 */
@Component({ selector: 'app-dolt-explorer', imports: [FormsModule, NgTemplateOutlet], templateUrl: './dolt-explorer.html', styleUrl: './dolt-explorer.css' })
export class DoltExplorer {
  @Input({ required: true }) api!: ApiClient;
  /** The section shown, driven by the route (/database/:tab). Internal jumps (e.g. branch -> compare) are announced through `navigate`. */
  @Input() set section(t: Tab) { this.wanted = t; if (this.ready && t !== this.tab()) void this.open(t); }
  @Output() navigate = new EventEmitter<Tab>();
  private readonly session = inject(Session);
  private wanted: Tab = 'branches'; private ready = false;
  protected v!: VersioningClient;
  protected readonly tab = signal<Tab>('branches');
  protected readonly note = signal('');
  protected readonly busy = signal(false);
  protected readonly short = shortHash;
  protected readonly cell = cellText;

  protected readonly branches = signal<BranchInfo[]>([]);
  protected readonly tags = signal<{ name: string; commit: string }[]>([]);
  protected readonly defaultBranch = signal('main');
  protected readonly refs = computed(() => [...this.branches().map((b) => b.name), ...this.tags().map((t) => t.name)]);
  protected newBranch = ''; protected newBranchFrom = 'main';

  protected histRef = 'main';
  protected readonly commits = signal<CommitInfo[]>([]);
  protected readonly hasMore = signal(false);
  protected readonly selected = signal<{ commit: string; message: string; author: string; date: string; parents: string[]; changes: DiffSummary['tables'] } | null>(null);
  protected actionName = '';

  protected from = 'main'; protected to = 'main'; protected three = true;
  protected readonly diff = signal<DiffSummary | null>(null);
  protected readonly rowDiff = signal<RowDiffView | null>(null);

  protected dataRef = 'main';
  protected readonly tableList = signal<{ name: string; rows: number }[]>([]);
  protected readonly data = signal<TableData | null>(null);
  protected editJson = ''; protected editKey: Record<string, unknown> | null = null; protected editMessage = '';
  protected readonly editable = computed(() => { const d = this.data(); const b = this.branches().find((x) => x.name === d?.ref); return !!d && d.kind === 'branch' && !!b && !b.protected; });

  protected sqlRef = 'main'; protected sqlMode: 'read' | 'write' = 'read';
  protected sqlText = 'select * from assignments';
  protected sqlMessage = ''; protected confirmDestructive = false;
  protected readonly sqlResult = signal<SqlResult | null>(null);

  protected prFilter = 'open';
  protected readonly prs = signal<PullRequestInfo[]>([]);
  protected readonly pr = signal<PullRequestDetail | null>(null);
  protected prForm = { title: '', body: '', source: '', target: 'main' };
  protected prComment = '';

  async ngOnInit() {
    this.v = new VersioningClient(this.api);
    // one admin capability token for the whole console (shell sidebar); read at each call, never stored anywhere else
    Object.defineProperty(this.v, 'adminToken', { get: () => this.session.adminToken(), set: () => {}, configurable: true });
    this.ready = true; await this.open(this.wanted); if (this.wanted !== 'branches') await this.refreshRefs();
  }
  protected go(t: Tab) { this.tab.set(t); this.navigate.emit(t); }
  /** Runs an API call with the busy flag. `keepNote` is for follow-up reloads, so they do not wipe the message of the action that triggered them. */
  protected async run<T>(fn: () => Promise<T>, keepNote = false): Promise<T | undefined> {
    this.busy.set(true); if (!keepNote) this.note.set('');
    try { return await fn(); } catch (e) { this.note.set((e as Error).message); return undefined; } finally { this.busy.set(false); }
  }
  protected async open(t: Tab) {
    this.go(t); this.note.set('');
    if (t === 'branches') await this.refreshRefs();
    if (t === 'history') await this.loadLog(true);
    if (t === 'data') await this.loadTables();
    if (t === 'pulls') { await this.refreshRefs(); await this.loadPulls(); }
  }

  // branches and tags
  protected async refreshRefs() {
    await this.run(async () => {
      const b = await this.v.branches(); this.branches.set(b.branches); this.defaultBranch.set(b.default);
      this.tags.set((await this.v.tags()).tags);
      // pre-select a source branch for a new pull request (the first branch that is not the target)
      if (!b.branches.some((x) => x.name === this.prForm.source)) this.prForm.source = b.branches.find((x) => x.name !== b.default)?.name ?? '';
      if (!b.branches.some((x) => x.name === this.prForm.target)) this.prForm.target = b.default;
    }, true);
  }
  protected async createBranch() {
    const r = await this.run(() => this.v.createBranch(this.newBranch, this.newBranchFrom));
    if (r) { this.note.set(`Branch ${r.branch} created at ${shortHash(r.commit)}.`); this.newBranch = ''; await this.refreshRefs(); }
  }
  protected async deleteBranch(b: BranchInfo) {
    if (!confirm(`Delete branch ${b.name}? Its commits stay reachable only by hash.`)) return;
    if (await this.run(() => this.v.deleteBranch(b.name)) !== undefined) { this.note.set(`Branch ${b.name} deleted.`); await this.refreshRefs(); }
  }
  protected showHistory(ref: string) { this.histRef = ref; void this.open('history'); }
  protected compareWithDefault(ref: string) { this.from = this.defaultBranch(); this.to = ref; this.three = true; this.go('compare'); void this.compare(); }

  // history
  protected async loadLog(reset: boolean) {
    const r = await this.run(() => this.v.log(this.histRef, reset ? 0 : this.commits().length), true);
    if (r) { this.commits.set(reset ? r.commits : [...this.commits(), ...r.commits]); this.hasMore.set(r.hasMore); if (reset) this.selected.set(null); }
  }
  protected async showCommit(c: CommitInfo) { const r = await this.run(() => this.v.commit(c.commit)); if (r) this.selected.set(r); }
  protected async branchFrom(hash: string) {
    const r = await this.run(() => this.v.createBranch(this.actionName, hash));
    if (r) { this.note.set(`Branch ${r.branch} created from ${shortHash(hash)}.`); this.actionName = ''; await this.refreshRefs(); }
  }
  protected async tagCommit(hash: string) {
    if (await this.run(() => this.v.createTag(this.actionName, hash)) !== undefined) { this.note.set(`Tag ${this.actionName} created.`); this.actionName = ''; await this.refreshRefs(); await this.loadLog(true); }
  }
  protected async revertOnBranch(hash: string) {
    const r = await this.run(() => this.v.revert(hash, this.actionName));
    if (r) { this.note.set(`Reverted on new branch ${r.branch}. Open a pull request to bring it to ${this.defaultBranch()}.`); this.prForm = { title: `Revert ${shortHash(hash)}`, body: '', source: r.branch, target: this.defaultBranch() }; this.actionName = ''; await this.refreshRefs(); }
  }
  protected async restoreBranch(hash: string) {
    const b = this.histRef;
    if (!confirm(`Move branch ${b} back to ${shortHash(hash)}? Later commits leave its history (they stay reachable by hash).`)) return;
    if (await this.run(() => this.v.restoreBranch(b, hash)) !== undefined) { this.note.set(`Branch ${b} restored to ${shortHash(hash)}.`); await this.loadLog(true); }
  }
  protected canRestore() { const b = this.branches().find((x) => x.name === this.histRef); return !!b && !b.protected; }

  // compare
  protected async compare() {
    this.rowDiff.set(null);
    const r = await this.run(() => this.v.diff(this.from, this.to, this.three)); if (r) this.diff.set(r);
  }
  protected async showRowDiff(table: string, from = this.from, to = this.to, three = this.three) {
    const r = await this.run(() => this.v.diffTable(table, from, to, three)); if (r) this.rowDiff.set(r);
  }
  protected diffClass(t: string) { return t === 'added' ? 'add' : t === 'removed' ? 'del' : 'mod'; }
  protected changed(r: RowDiff, col: string) { return r.type === 'modified' && this.cell(r.from?.[col]) !== this.cell(r.to?.[col]); }

  // data
  protected async loadTables() { const r = await this.run(() => this.v.tables(this.dataRef), true); if (r) { this.tableList.set(r.tables); this.data.set(null); } }
  protected async openTable(name: string, offset = 0) { const r = await this.run(() => this.v.rows(this.dataRef, name, offset), true); if (r) { this.data.set(r); this.editJson = ''; this.editKey = null; } }
  protected startEdit(row: Record<string, unknown>) {
    const d = this.data()!; this.editKey = Object.fromEntries(d.primaryKey.map((k) => [k, row[k]])); this.editJson = JSON.stringify(row, null, 2); this.editMessage = '';
  }
  protected startInsert() { const d = this.data()!; this.editKey = null; this.editJson = JSON.stringify(Object.fromEntries(d.columns.map((c) => [c.name, ''])), null, 2); this.editMessage = ''; }
  protected async saveEdit() {
    const d = this.data()!; let values: Record<string, unknown>;
    try { values = JSON.parse(this.editJson); } catch { this.note.set('The row is not valid JSON.'); return; }
    const op = this.editKey ? { op: 'update', key: this.editKey, values } : { op: 'insert', values };
    const r = await this.run(() => this.v.edit(d.ref, d.table, [op], this.editMessage));
    if (r) { this.note.set(`Committed ${shortHash(r.commit)} on ${d.ref}.`); await this.openTable(d.table, d.offset); }
  }
  protected async deleteRow(row: Record<string, unknown>) {
    const d = this.data()!; const key = Object.fromEntries(d.primaryKey.map((k) => [k, row[k]]));
    if (!confirm(`Delete this row from ${d.table} on ${d.ref}? It is committed on the branch and can be reverted.`)) return;
    const r = await this.run(() => this.v.edit(d.ref, d.table, [{ op: 'delete', key }], ''));
    if (r) { this.note.set(`Committed ${shortHash(r.commit)} on ${d.ref}.`); await this.openTable(d.table, d.offset); }
  }

  // SQL
  protected async runSql(dryRun = false) {
    this.sqlResult.set(null);
    const r = await this.run(() => this.v.sql({ ref: this.sqlRef, sql: this.sqlText, mode: this.sqlMode, message: this.sqlMessage, dryRun, confirmDestructive: this.confirmDestructive }));
    if (r) { this.sqlResult.set(r); if (r.committed) { this.note.set(`Committed ${shortHash(r.committed)} on ${this.sqlRef}.`); this.confirmDestructive = false; } }
  }
  protected sqlColumns(): string[] { return this.sqlResult()?.columns ?? []; }

  // pull requests
  protected async loadPulls() { const r = await this.run(() => this.v.pulls(this.prFilter === 'all' ? undefined : this.prFilter), true); if (r) this.prs.set(r.pullRequests); }
  protected async openPull() {
    const r = await this.run(() => this.v.openPull(this.prForm.title, this.prForm.body, this.prForm.source, this.prForm.target));
    if (r) { this.prForm = { title: '', body: '', source: '', target: this.defaultBranch() }; await this.refreshRefs(); await this.loadPulls(); await this.showPull(r.id); }
  }
  protected async showPull(id: number) { const r = await this.run(() => this.v.pull(id), true); if (r) { this.pr.set(r); this.rowDiff.set(null); } }
  protected async prDiff(table: string) { const p = this.pr()!.pullRequest; await this.showRowDiff(table, p.target, p.source, true); }
  protected async sendComment(kind: 'comment' | 'approve') {
    const p = this.pr()!.pullRequest;
    if (await this.run(() => this.v.comment(p.id, this.prComment, kind)) !== undefined) { this.prComment = ''; await this.showPull(p.id); }
  }
  protected async mergePull() {
    const p = this.pr()!.pullRequest;
    if (!confirm(`Merge #${p.id} (${p.source} into ${p.target})? This creates a merge commit on ${p.target}.`)) return;
    const r = await this.run(() => this.v.mergePull(p.id));
    if (r) { this.note.set(`Merged as ${shortHash(r.commit)}.`); await this.loadPulls(); await this.showPull(p.id); }
  }
  protected async closePull() { const p = this.pr()!.pullRequest; if (await this.run(() => this.v.closePull(p.id)) !== undefined) { await this.loadPulls(); await this.showPull(p.id); } }
}
