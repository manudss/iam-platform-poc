import { Component, EventEmitter, Input, Output, inject, signal, computed } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Session } from './session';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiClient, BranchInfo, CommitInfo, DiffSummary, PullRequestDetail, PullRequestInfo, RowDiff, SqlResult, TableData, VersioningClient, cellText, shortHash } from './api';

export type Tab = 'home' | 'branches' | 'history' | 'compare' | 'data' | 'sql' | 'pulls';
interface RowDiffView { table: string; columns: string[]; rows: RowDiff[]; truncated: boolean }

/**
 * Database explorer for the Dolt data: branches, history (with the commit graph as parent links), comparisons between any two
 * refs, tables and rows at any ref, a guarded SQL console and pull requests. Everything is read from the API; nothing here
 * decides what is allowed (the server enforces protected branches, SQL limits and merge checks).
 */
@Component({ selector: 'app-dolt-explorer', imports: [FormsModule, NgTemplateOutlet, RouterLink], templateUrl: './dolt-explorer.html', styleUrls: ['./dolt-explorer.css', './dolt-explorer-data.css', './dolt-explorer-home.css'] })
export class DoltExplorer {
  @Input({ required: true }) api!: ApiClient;
  /** The section shown, driven by the route (/database/:tab). Internal jumps (e.g. branch -> compare) are announced through `navigate`. */
  @Input() set section(t: Tab) { this.wanted = t; if (this.ready && t !== this.tab()) void this.open(t); }
  @Output() navigate = new EventEmitter<Tab>();
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  private wanted: Tab = 'home'; private ready = false;
  protected v!: VersioningClient;
  protected readonly tab = signal<Tab>('home');

  // home: database overview (stat cards, workspace strip and the Latest pull requests / Latest changes / Recently active branches widgets). Read only: it only assembles what the other sections use.
  protected readonly homeStats = signal<{ branches: number; protectedCount: number; defaultBranch: string; openPulls: number; prsToFix: number; commitsThisWeek: number; tables: number; tableRows: number; onRef: string } | null>(null);
  protected readonly workspace = signal<{ branch: string; protected: boolean; ahead: number; behind: number; changedRows: number | null; openPr: number | null } | null>(null);
  protected readonly homeLimit = signal(5);
  protected readonly changesRef = signal('');
  protected readonly widgetMenu = signal(false);
  protected readonly hiddenWidgets = signal<ReadonlySet<string>>(new Set());
  protected readonly homePrs = signal<{ p: PullRequestInfo; line: string; ok: boolean; ko: boolean }[]>([]);
  protected readonly homeChanges = signal<{ c: CommitInfo; branch: string; summary: string }[]>([]);
  protected readonly homeBranches = signal<BranchInfo[]>([]);
  protected readonly branchRows = signal<Record<string, number | null>>({});
  protected readonly homeLoadedAt = signal<Date | null>(null);
  protected readonly widgetDefs = [
    { key: 'stats', label: 'Numbers' }, { key: 'workspace', label: 'Your workspace' },
    { key: 'prs', label: 'Latest pull requests' }, { key: 'changes', label: 'Latest changes' }, { key: 'branches', label: 'Recently active branches' }];
  private allHomePrs: PullRequestInfo[] = [];
  private allHomeChanges: { c: CommitInfo; branch: string }[] = [];
  private allHomeBranches: BranchInfo[] = [];
  private prLines = new Map<number, { line: string; ok: boolean; ko: boolean }>();
  private commitSummaries = new Map<string, string>();
  protected readonly note = signal('');
  protected readonly busy = signal(false);
  protected readonly short = shortHash;
  protected readonly cell = cellText;

  protected readonly branches = signal<BranchInfo[]>([]);
  protected readonly tags = signal<{ name: string; commit: string }[]>([]);
  protected readonly defaultBranch = signal('main');
  protected readonly refs = computed(() => [...this.branches().map((b) => b.name), ...this.tags().map((t) => t.name)]);
  protected newBranch = ''; protected newBranchFrom = 'main';
  protected readonly branchSearch = signal(''); protected createOpen = false;
  protected readonly menuFor = signal('');
  /** Changed rows vs the default branch, loaded lazily for the working branch only (one diff call). */
  protected readonly rowsChangedOn = signal<Record<string, number>>({});

  protected histRef = 'main';
  protected readonly histSearch = signal('');
  protected readonly commits = signal<CommitInfo[]>([]);
  /** Commits of the log, filtered by the search and grouped by day (Today / Yesterday / dated). */
  protected readonly commitGroups = computed(() => {
    const q = this.histSearch().trim().toLowerCase();
    const list = this.commits().filter((c) => !q || c.message.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.commit.toLowerCase().startsWith(q));
    const day = (t: number) => new Date(t).toDateString();
    const today = day(Date.now()), yest = day(Date.now() - 864e5);
    const groups: { label: string; commits: CommitInfo[] }[] = [];
    for (const c of list) {
      const t = Date.parse(c.date);
      const label = !Number.isFinite(t) ? 'Earlier' : day(t) === today ? 'Today' : day(t) === yest ? 'Yesterday' : new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      (groups.find((x) => x.label === label) ?? groups[groups.push({ label, commits: [] }) - 1]).commits.push(c);
    }
    return groups;
  });
  protected readonly hasMore = signal(false);
  protected readonly selected = signal<{ commit: string; message: string; author: string; date: string; parents: string[]; changes: DiffSummary['tables'] } | null>(null);
  /** Row-level diff per table of the inspected commit (two-dot diff against its first parent). */
  protected readonly histRowDiffs = signal<Record<string, RowDiffView | undefined>>({});
  protected readonly histExpandedDiffs = signal<ReadonlySet<string>>(new Set());
  protected actionName = '';
  protected readonly actionNameErr = signal('');
  /** Inline confirmation after a branch/tag action in the history inspector, with the natural next steps. */
  protected readonly actionDone = signal<{ kind: 'branch' | 'tag'; name: string } | null>(null);
  protected readonly newBranchErr = signal('');
  protected readonly prTitleErr = signal('');
  /** Types a branch or tag name: whitespace becomes _, characters the API refuses are dropped, 63 max (guards.ts NEW_BRANCH/TAG). */
  protected sanitizeRefName(v: string): string { return v.replace(/^\s+/, '').replace(/\s/g, '_').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 63); }
  /** Client copy of the API rule so the exact reason shows next to the field instead of a generic banner after a round trip. */
  protected refNameError(name: string): string {
    if (!name) return 'A name is required.';
    if (!/^[A-Za-z0-9]/.test(name)) return 'Start with a letter or a digit.';
    if (name.length > 63) return '63 characters max.';
    if (/[^A-Za-z0-9._-]/.test(name)) return 'Only letters, digits, dots, underscores and dashes.';
    if (name.includes('..')) return 'No two dots in a row.';
    if (name.endsWith('.lock')) return 'The name cannot end with .lock.';
    return '';
  }

  protected from = 'main'; protected to = 'main'; protected three = true;
  protected readonly diff = signal<DiffSummary | null>(null);
  protected readonly rowDiff = signal<RowDiffView | null>(null);
  protected readonly compareTab = signal<'commits' | 'rows' | 'schema'>('rows');
  /** Commits of the compare side that the base does not have (walked from the logs, newest first). */
  protected readonly compareAhead = signal<CommitInfo[] | null>(null);
  /** Commits the base ref has that the compare ref does not (drives the "base has moved ahead" banner). */
  protected readonly compareBehind = signal<number>(0);
  /** Row-level diff per expanded table of the compare view. */
  protected readonly rowDiffs = signal<Record<string, RowDiffView | undefined>>({});
  protected readonly expandedDiffs = signal<ReadonlySet<string>>(new Set());

  protected dataRef = this.session.branch() || 'main';
  protected readonly tableList = signal<{ name: string; rows: number }[]>([]);
  protected readonly data = signal<TableData | null>(null);
  protected tableSearch = ''; protected rowView = signal<Record<string, unknown> | null>(null);
  protected readonly openTables = signal<string[]>([]);
  protected readonly systemTables = ['dolt_log', 'dolt_branches', 'dolt_diff_*', 'dolt_history_*'];
  protected readonly savedQueries = signal<{ name: string; sql: string }[]>([]);
  protected readonly rowFilter = signal('');
  protected readonly sortCol = signal('');
  protected readonly sortDir = signal<1 | -1>(1);
  protected readonly hiddenCols = signal<Set<string>>(new Set()); protected formFields: Record<string, string> = {}; protected nullFields: Record<string, boolean> = {}; protected editorOpen = false; protected jsonMode = false;
  protected editJson = ''; protected editKey: Record<string, unknown> | null = null; protected editMessage = '';
  protected readonly editable = computed(() => { const d = this.data(); const b = this.branches().find((x) => x.name === d?.ref); return !!d && d.kind === 'branch' && !!b && !b.protected && !d.table.startsWith('plugin_runtime_'); });

  protected sqlRef = this.session.branch() || 'main'; protected sqlMode: 'read' | 'write' = 'read';
  protected readonly sqlTabs = signal<{ name: string; text: string; ref: string; mode: 'read' | 'write'; result: SqlResult | null }[]>([
    { name: 'Query 1', text: 'select * from assignments', ref: this.sqlRef, mode: 'read', result: null }]);
  protected readonly sqlActiveTab = signal(0);
  private stashSqlTab() { const tabs = [...this.sqlTabs()]; const cur = this.sqlActiveTab(); if (tabs[cur]) { tabs[cur] = { ...tabs[cur], text: this.sqlText, ref: this.sqlRef, mode: this.sqlMode, result: this.sqlResult() }; this.sqlTabs.set(tabs); } }
  private restoreSqlTab(i: number) { const t = this.sqlTabs()[i]; if (!t) return; this.sqlText = t.text; this.sqlRef = t.ref; this.sqlMode = t.mode; this.sqlResult.set(t.result); }
  protected switchSqlTab(i: number) { if (i === this.sqlActiveTab()) return; this.stashSqlTab(); this.sqlActiveTab.set(i); this.restoreSqlTab(i); }
  protected addSqlTab() { this.stashSqlTab(); this.sqlTabs.update((t) => [...t, { name: `Query ${t.length + 1}`, text: '', ref: this.sqlRef, mode: this.sqlMode, result: null }]); this.sqlActiveTab.set(this.sqlTabs().length - 1); this.sqlText = ''; this.sqlResult.set(null); }
  protected closeSqlTab(i: number) {
    if (this.sqlTabs().length <= 1) return;
    const wasActive = this.sqlActiveTab() === i;
    this.sqlTabs.update((t) => t.filter((_, j) => j !== i));
    if (wasActive) { this.sqlActiveTab.set(0); this.restoreSqlTab(0); } else if (this.sqlActiveTab() > i) this.sqlActiveTab.update((x) => x - 1);
  }
  protected sqlLineNos() { return this.sqlText.split('\n').map((_, i) => i + 1); }
  protected saveQuery() {
    const name = prompt('Name this query'); if (!name) return;
    const list = [...this.savedQueries(), { name, sql: this.sqlText }];
    this.savedQueries.set(list); localStorage.setItem('dolt-saved-queries', JSON.stringify(list));
  }
  protected sampleTables(r: SqlResult) { return Object.keys(r.samples ?? {}); }
  protected sampleView(r: SqlResult, k: string) { const s = r.samples?.[k]; return { table: k, columns: s?.columns ?? [], rows: s?.rows ?? [], truncated: false }; }
  protected sqlText = 'select * from assignments';
  protected sqlMessage = ''; protected confirmDestructive = false;
  protected readonly sqlResult = signal<SqlResult | null>(null);

  protected prCreateOpen = false;
  protected readonly prs = signal<PullRequestInfo[]>([]);
  protected readonly pr = signal<PullRequestDetail | null>(null);
  protected prForm = { title: '', body: '', source: '', target: 'main' };
  protected prComment = '';
  protected readonly prStatuses = ['open', 'merged', 'closed', 'all'] as const;
  protected readonly prStatus = signal<'open' | 'merged' | 'closed' | 'all'>('open');
  protected readonly prSearch = signal('');
  protected readonly prSort = signal<'new' | 'old'>('new');
  protected readonly prBadges = signal<Record<number, { checks: boolean | null; approved: boolean; rows: string }>>({});
  protected readonly prTab = signal<'conversation' | 'commits' | 'checks' | 'rows'>('conversation');
  protected readonly prRowDiffs = signal<Record<string, RowDiffView | undefined>>({});
  protected readonly prExpandedDiffs = signal<Set<string>>(new Set());
  protected readonly prShown = computed(() => {
    const q = this.prSearch().trim().toLowerCase();
    const st = this.prStatus();
    const list = this.prs().filter((p) => (st === 'all' || p.status === st) && (!q || [p.title, p.author, p.source, p.target].some((x) => x.toLowerCase().includes(q))));
    return list.sort((a, b) => (this.prSort() === 'new' ? -1 : 1) * (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id));
  });
  protected prCount(s: 'open' | 'merged' | 'closed' | 'all') { return s === 'all' ? this.prs().length : this.prs().filter((p) => p.status === s).length; }
  protected prStatusLabel(s: string) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

  async ngOnInit() {
    try { this.savedQueries.set(JSON.parse(localStorage.getItem('dolt-saved-queries') ?? '[]')); } catch { this.savedQueries.set([]); }
    try { this.hiddenWidgets.set(new Set(JSON.parse(localStorage.getItem('dolt-home-widgets') ?? '[]'))); } catch { this.hiddenWidgets.set(new Set()); }
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
    if (t === 'home') await this.loadHome();
    if (t === 'branches') { await this.refreshRefs(); await this.loadRowsChanged(); }
    if (t === 'history') await this.loadLog(true);
    if (t === 'data' || t === 'sql') await this.loadTables();
    if (t === 'compare' && this.from !== this.to) await this.compare();
    if (t === 'pulls') { await this.refreshRefs(); await this.loadPulls(); }
  }

  // ---- home ----
  /** Assembles the overview: counts, workspace state, and the three widgets (pull requests, committed changes, active branches), newest first. */
  protected async loadHome() {
    await this.run(async () => {
      await this.refreshRefs();
      const def = this.defaultBranch(), current = this.session.branch() || def;
      const bs = this.branches();
      const [pulls, tbl, ...logs] = await Promise.all([this.v.pulls(), this.v.tables(current), ...bs.map((b) => this.v.log(b.name, 0))]);
      const weekAgo = Date.now() - 7 * 864e5;
      // one union of every branch log, each commit tagged with the first (newest) branch that contains it
      const seen = new Map<string, { c: CommitInfo; branch: string }>();
      bs.forEach((b, i) => { for (const c of logs[i]?.commits ?? []) if (!seen.has(c.commit)) seen.set(c.commit, { c, branch: b.name }); });
      this.allHomeChanges = [...seen.values()].sort((x, y) => Date.parse(y.c.date) - Date.parse(x.c.date));
      const updated = (p: PullRequestInfo) => p.mergedAt ?? p.createdAt;
      this.allHomePrs = [...pulls.pullRequests].sort((a, b) => Date.parse(updated(b)) - Date.parse(updated(a)));
      this.allHomeBranches = [...bs].sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
      // review state of every open pull request (drives the KPI sub-line and the widget status line)
      this.prLines = new Map();
      let prsToFix = 0;
      for (const p of pulls.pullRequests.filter((x) => x.status === 'open')) {
        const d = await this.v.pull(p.id);
        const good = !!d.checks?.mergeable && !d.checks.violations.length;
        if (!good) prsToFix++;
        this.prLines.set(p.id, { line: `${good ? '\u2713 Checks passed' : '\u26A0 Checks to fix'} · ${d.approvals.length} of ${d.requiredApprovals} approval${d.requiredApprovals === 1 ? '' : 's'} · ${this.rel(p.createdAt)}`, ok: good, ko: !good });
      }
      this.homeStats.set({
        branches: bs.length, protectedCount: bs.filter((b) => b.protected).length, defaultBranch: def,
        openPulls: pulls.pullRequests.filter((p) => p.status === 'open').length, prsToFix,
        commitsThisWeek: this.allHomeChanges.filter((x) => Date.parse(x.c.date) >= weekAgo).length,
        tables: tbl.tables.length, tableRows: tbl.tables.reduce((n, t) => n + t.rows, 0), onRef: current,
      });
      const wb = bs.find((x) => x.name === current);
      let changedRows: number | null = null;
      if (wb && !wb.default && wb.aheadOfDefault > 0) changedRows = (await this.v.diff(def, current, true)).rows?.total ?? null;
      this.workspace.set({ branch: current, protected: !!wb?.protected, ahead: wb?.aheadOfDefault ?? 0, behind: wb?.behindDefault ?? 0, changedRows, openPr: pulls.pullRequests.find((p) => p.status === 'open' && p.source === current)?.id ?? null });
      await this.enrichHome();
      this.homeLoadedAt.set(new Date());
    });
  }
  /** (Re)builds the visible slice of the three widgets after a limit/filter change; per-item details are cached. */
  protected async enrichHome() {
    const n = this.homeLimit(), def = this.defaultBranch();
    this.homePrs.set(this.allHomePrs.slice(0, n).map((p) => {
      const d = this.prLines.get(p.id);
      const line = p.status === 'merged' ? `Merged · ${this.rel(p.mergedAt ?? p.createdAt)}` : p.status === 'closed' ? `Closed · ${this.rel(p.createdAt)}` : (d?.line ?? this.rel(p.createdAt));
      return { p, line, ok: p.status === 'open' && (d?.ok ?? false), ko: p.status === 'open' && (d?.ko ?? false) };
    }));
    const changes = this.allHomeChanges.filter((x) => !this.changesRef() || x.branch === this.changesRef()).slice(0, n);
    for (const x of changes) if (!this.commitSummaries.has(x.c.commit)) this.commitSummaries.set(x.c.commit, this.changeSummary(await this.v.commit(x.c.commit)));
    this.homeChanges.set(changes.map((x) => ({ ...x, summary: this.commitSummaries.get(x.c.commit) ?? '' })));
    const shown = this.allHomeBranches.slice(0, n);
    for (const b of shown.filter((b) => !b.default && b.aheadOfDefault > 0 && this.branchRows()[b.name] === undefined)) {
      this.branchRows.update((m) => ({ ...m, [b.name]: null }));
      const d = await this.v.diff(def, b.name, true);
      this.branchRows.update((m) => ({ ...m, [b.name]: d.rows?.total ?? 0 }));
    }
    this.homeBranches.set(shown);
  }
  /** "roles · 1 modified row +2 more" for a commit; "no data change" when it only carries schema or metadata. */
  private changeSummary(d: { changes: DiffSummary['tables'] }): string {
    const data = d.changes.filter((t) => t.dataChange);
    if (!data.length) return d.changes.length ? 'schema change only' : 'no data change';
    const t = data[0];
    const parts = [t.rows?.added ? `+${t.rows.added}` : '', t.rows?.removed ? `\u2212${t.rows.removed}` : '', t.rows?.modified ? `${t.rows.modified} modified` : ''].filter(Boolean).join(', ');
    return `${t.table} · ${parts || 'rows changed'}${data.length > 1 ? ` · +${data.length - 1} more table${data.length > 2 ? 's' : ''}` : ''}`;
  }
  protected shown(key: string) { return !this.hiddenWidgets().has(key); }
  protected toggleWidget(key: string) {
    const s = new Set(this.hiddenWidgets());
    if (s.has(key)) s.delete(key); else s.add(key);
    this.hiddenWidgets.set(s); localStorage.setItem('dolt-home-widgets', JSON.stringify([...s]));
  }
  protected async setHomeLimit(n: number) { this.homeLimit.set(n); await this.enrichHome(); }
  protected async setChangesRef(r: string) { this.changesRef.set(r); await this.enrichHome(); }
  /** Opens a committed change in the History inspector. */
  protected openChange(x: { c: CommitInfo; branch: string }) { this.histRef = x.branch; void this.open('history').then(() => this.showCommit(x.c)); }
  protected browseData(ref: string) { this.dataRef = ref; void this.open('data'); }
  protected branchNote(b: BranchInfo): string {
    if (b.name === this.sessionBranch()) { const pr = this.allHomePrs.find((p) => p.status === 'open' && p.source === b.name); return pr ? `Your workspace · PR #${pr.id} open` : 'Your workspace'; }
    if (b.default) return `${b.protected ? 'Protected · ' : ''}default`;
    const pr = this.allHomePrs.find((p) => p.status === 'open' && p.source === b.name);
    return pr ? `PR #${pr.id} open` : 'No pull request';
  }
  protected goReview() { void this.router.navigateByUrl('/review'); }
  /** "2 h ago", "yesterday", "5 d ago": short relative dates for the activity feed and the cards. */
  protected rel(when: string): string {
    const t = Date.parse(when);
    if (!Number.isFinite(t)) return when;
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return 'just now';
    const m = s / 60;
    if (m < 60) return `${Math.round(m)} min ago`;
    const h = m / 60;
    if (h < 24) return `${Math.round(h)} h ago`;
    const d = h / 24;
    if (d < 2) return 'yesterday';
    if (d < 30) return `${Math.round(d)} d ago`;
    return new Date(t).toLocaleDateString();
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
  /** Server-side name failures belong next to the field, not only in the top banner. */
  private mirrorNameError(setter: (m: string) => void, match: RegExp): void {
    const m = this.note();
    if (match.test(m)) { setter(m); this.note.set(''); }
  }
  protected async createBranch() {
    this.newBranchErr.set(this.refNameError(this.newBranch));
    if (this.newBranchErr()) return;
    const r = await this.run(() => this.v.createBranch(this.newBranch, this.newBranchFrom));
    if (!r) { this.mirrorNameError(m => (this.newBranchErr.set(m)), /name|exist|taken|invalid/i); return; }
    if (r) { this.note.set(`Branch ${r.branch} created at ${shortHash(r.commit)}.`); this.newBranch = ''; this.newBranchErr.set(''); this.createOpen = false; await this.refreshRefs(); }
  }
  /** The signed-in user's working branch (the shell selection), or the default branch when none is selected. */
  protected sessionBranch() { return this.session.branch() || this.defaultBranch(); }
  /** Branch cards: the default branch first, then the ones matching the search (name or last commit message). */
  protected filteredBranches() {
    const q = this.branchSearch().trim().toLowerCase();
    const list = this.branches().filter((b) => !q || b.name.toLowerCase().includes(q) || b.message.toLowerCase().includes(q));
    return [...list.filter((b) => b.default), ...list.filter((b) => !b.default)];
  }
  /** Ahead/behind gauge shares, in percent of the larger side (both visible, GitHub style). */
  protected gaugePct(b: BranchInfo, ahead: boolean) {
    const max = Math.max(b.aheadOfDefault, b.behindDefault, 1);
    return Math.round(((ahead ? b.aheadOfDefault : b.behindDefault) / max) * 100);
  }
  /** Rows changed vs the default branch, for the working branch card (skip when nothing is ahead). */
  private async loadRowsChanged() {
    const cur = this.session.branch();
    if (!cur) return;
    const wb = this.branches().find((x) => x.name === cur);
    if (!wb || wb.default || wb.aheadOfDefault === 0 || this.rowsChangedOn()[cur] !== undefined) return;
    const d = await this.run(() => this.v.diff(this.defaultBranch(), cur, true), true);
    if (d) this.rowsChangedOn.update((m) => ({ ...m, [cur]: d.rows?.total ?? 0 }));
  }
  /** Shortcut from a branch card to a prefilled pull-request form. */
  protected newPullFrom(source: string) {
    this.prForm = { title: '', body: '', source, target: this.defaultBranch() };
    this.prCreateOpen = true;
    this.go('pulls');
  }
  protected async deleteBranch(b: BranchInfo) {
    if (!confirm(`Delete branch ${b.name}? Its commits stay reachable only by hash.`)) return;
    if (await this.run(() => this.v.deleteBranch(b.name)) !== undefined) { this.note.set(`Branch ${b.name} deleted.`); await this.refreshRefs(); }
  }
  protected showHistory(ref: string) { this.histRef = ref; void this.open('history'); }
  protected compareWithDefault(ref: string) { this.from = this.defaultBranch(); this.to = ref; this.three = true; this.go('compare'); void this.compare(); }
  /** Follow-up offered after creating a branch from a commit: look at that branch's history. */
  protected switchHistTo(name: string) { this.actionDone.set(null); this.histRef = name; void this.loadLog(true); }
  /** Follow-up offered after creating a branch: prefill the pull-request form with it. */
  protected pullFor(name: string) { this.actionDone.set(null); this.newPullFrom(name); }

  // history
  protected async loadLog(reset: boolean) {
    const r = await this.run(() => this.v.log(this.histRef, reset ? 0 : this.commits().length), true);
    if (r) { this.commits.set(reset ? r.commits : [...this.commits(), ...r.commits]); this.hasMore.set(r.hasMore); if (reset) { this.selected.set(null); this.histRowDiffs.set({}); } }
  }
  /** Opens the commit inspector beside the log and loads the row changes of every touched table (two-dot diff against the first parent). */
  protected async showCommit(c: CommitInfo) {
    this.actionDone.set(null); this.actionNameErr.set('');
    const r = await this.run(() => this.v.commit(c.commit));
    if (!r) return;
    this.selected.set(r); this.histRowDiffs.set({}); this.histExpandedDiffs.set(new Set());
    // on narrow screens the inspector stacks below the log: scroll to it so the button never looks dead
    setTimeout(() => { if (window.matchMedia?.('(max-width: 900px)')?.matches) document.getElementById('hist-inspector')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); });
    if (!r.parents.length) return;
    for (const t of r.changes.filter((x) => x.dataChange)) { this.histExpandedDiffs.update((s) => new Set(s).add(t.table)); await this.loadHistRowDiff(t.table); }
  }
  protected closeCommit() { this.selected.set(null); }
  protected async toggleHistTableDiff(table: string) {
    const s = new Set(this.histExpandedDiffs());
    if (s.has(table)) { s.delete(table); this.histExpandedDiffs.set(s); return; }
    s.add(table); this.histExpandedDiffs.set(s);
    if (!this.histRowDiffs()[table]) await this.loadHistRowDiff(table);
  }
  private async loadHistRowDiff(table: string) {
    const s = this.selected(); if (!s || !s.parents.length) return;
    const r = await this.run(() => this.v.diffTable(table, s.parents[0], s.commit, false), true);
    if (r) this.histRowDiffs.update((m) => ({ ...m, [table]: r }));
  }
  protected initials(name: string) { return name.split(/[-\s_]/).map((x) => x[0] ?? '').join('').slice(0, 2).toUpperCase(); }
  protected timeOf(d: string) { const t = Date.parse(d); return Number.isFinite(t) ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : d; }
  protected async branchFrom(hash: string) {
    this.actionNameErr.set(this.refNameError(this.actionName));
    if (this.actionNameErr()) return;
    const r = await this.run(() => this.v.createBranch(this.actionName, hash));
    if (!r) { this.mirrorNameError(m => (this.actionNameErr.set(m)), /name|exist|taken|invalid/i); return; }
    if (r) { this.actionDone.set({ kind: 'branch', name: r.branch }); this.actionName = ''; this.actionNameErr.set(''); await this.refreshRefs(); }
  }
  protected async tagCommit(hash: string) {
    this.actionNameErr.set(this.refNameError(this.actionName));
    if (this.actionNameErr()) return;
    const ok = (await this.run(() => this.v.createTag(this.actionName, hash))) !== undefined;
    if (!ok) { this.mirrorNameError(m => (this.actionNameErr.set(m)), /name|exist|taken|invalid/i); return; }
    this.actionDone.set({ kind: 'tag', name: this.actionName }); this.actionName = ''; this.actionNameErr.set(''); await this.refreshRefs(); await this.loadLog(true);
  }
  protected async revertOnBranch(hash: string) {
    this.actionNameErr.set(this.refNameError(this.actionName));
    if (this.actionNameErr()) return;
    const r = await this.run(() => this.v.revert(hash, this.actionName));
    if (!r) { this.mirrorNameError(m => (this.actionNameErr.set(m)), /name|exist|taken|invalid/i); return; }
    if (r) { this.note.set(`Reverted on new branch ${r.branch}. Open a pull request to bring it to ${this.defaultBranch()}.`); this.prForm = { title: `Revert ${shortHash(hash)}`, body: '', source: r.branch, target: this.defaultBranch() }; this.actionDone.set({ kind: 'branch', name: r.branch }); this.actionName = ''; this.actionNameErr.set(''); await this.refreshRefs(); }
  }
  protected async restoreBranch(hash: string) {
    const b = this.histRef;
    if (!confirm(`Move branch ${b} back to ${shortHash(hash)}? Later commits leave its history (they stay reachable by hash).`)) return;
    if (await this.run(() => this.v.restoreBranch(b, hash)) !== undefined) { this.note.set(`Branch ${b} restored to ${shortHash(hash)}.`); await this.loadLog(true); }
  }
  protected canRestore() { const b = this.branches().find((x) => x.name === this.histRef); return !!b && !b.protected; }

  // compare
  protected async compare() {
    if (this.from === this.to) { this.diff.set(null); this.compareAhead.set(null); this.compareBehind.set(0); return; }
    this.rowDiff.set(null); this.rowDiffs.set({}); this.expandedDiffs.set(new Set()); this.compareAhead.set(null);
    const r = await this.run(() => this.v.diff(this.from, this.to, this.three)); if (!r) return;
    this.diff.set(r);
    for (const t of r.tables.filter((x) => x.dataChange)) { this.expandedDiffs.update((s) => new Set(s).add(t.table)); await this.loadTableDiff(t.table); }
    await this.loadCompareAhead();
  }
  protected swapRefs() { const f = this.from; this.from = this.to; this.to = f; void this.compare(); }
  protected async toggleTableDiff(table: string) {
    const s = new Set(this.expandedDiffs());
    if (s.has(table)) { s.delete(table); this.expandedDiffs.set(s); return; }
    s.add(table); this.expandedDiffs.set(s);
    if (!this.rowDiffs()[table]) await this.loadTableDiff(table);
  }
  private async loadTableDiff(table: string) {
    const r = await this.run(() => this.v.diffTable(table, this.from, this.to, this.three), true);
    if (r) this.rowDiffs.update((m) => ({ ...m, [table]: r }));
  }
  /** The commits of `to` that `from` does not have: walk both logs and stop at the first shared commit. */
  private async loadCompareAhead() {
    const [fromLog, toLog] = await Promise.all([this.v.log(this.from, 0, 100), this.v.log(this.to, 0, 100)]);
    const base = new Set(fromLog.commits.map((c) => c.commit));
    const ahead: CommitInfo[] = [];
    for (const c of toLog.commits) { if (base.has(c.commit)) break; ahead.push(c); }
    this.compareAhead.set(ahead);
    const toSet = new Set(toLog.commits.map((c) => c.commit));
    let behind = 0;
    for (const c of fromLog.commits) { if (toSet.has(c.commit)) break; behind++; }
    this.compareBehind.set(behind);
  }
  protected canCreatePrFromCompare() {
    const names = this.branches().map((b) => b.name);
    return this.from !== this.to && names.includes(this.from) && names.includes(this.to);
  }
  protected createPullFromCompare() {
    this.prForm = { title: '', body: '', source: this.to, target: this.from };
    this.prCreateOpen = true;
    this.go('pulls');
  }
  /** Column definitions of a CREATE TABLE statement, keyed by column name (best effort; the raw statement shows when empty). */
  protected schemaRows(s: { table: string; from: string | null; to: string | null }) {
    const cols = (stmt: string | null) => {
      const out: Record<string, string> = {};
      for (const line of (stmt ?? '').split('\n')) {
        const m = line.trim().match(/^`([^`]+)`\s+(.+?)$/);
        if (m) out[m[1]] = m[2].replace(/,$/, '');
      }
      return out;
    };
    const a = cols(s.from), b = cols(s.to);
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].map((col) => ({ col, from: a[col] ?? null, to: b[col] ?? null, changed: (a[col] ?? null) !== (b[col] ?? null) }));
  }
  protected async showRowDiff(table: string, from = this.from, to = this.to, three = this.three) {
    const r = await this.run(() => this.v.diffTable(table, from, to, three)); if (r) this.rowDiff.set(r);
  }
  protected diffClass(t: string) { return t === 'added' ? 'add' : t === 'removed' ? 'del' : 'mod'; }
  protected changed(r: RowDiff, col: string) { return r.type === 'modified' && this.cell(r.from?.[col]) !== this.cell(r.to?.[col]); }

  // data
  protected async loadTables() { const r = await this.run(() => this.v.tables(this.dataRef), true); if (r) { this.tableList.set(r.tables); this.data.set(null); this.openTables.set([]); this.hiddenCols.set(new Set()); this.rowFilter.set(''); this.sortCol.set(''); } }
  protected async openTable(name: string, offset = 0) {
    const r = await this.run(() => this.v.rows(this.dataRef, name, offset), true);
    if (r) { this.data.set(r); this.editJson = ''; this.editKey = null; this.editorOpen = false; this.rowView.set(null); this.hiddenCols.set(new Set()); this.rowFilter.set(''); this.sortCol.set(''); if (!this.openTables().includes(name)) this.openTables.update((t) => [...t, name]); }
  }
  protected closeTableTab(name: string) { this.openTables.update((t) => t.filter((x) => x !== name)); if (this.data()?.table === name) this.data.set(null); }
  /** Tree click on an application table: on the SQL console it becomes a ready-to-run select, like the Dolt system tables; elsewhere it opens the data grid. */
  protected treeTableClick(name: string) {
    if (this.tab() === 'sql') { this.sqlRef = this.dataRef; this.sqlMode = 'read'; this.sqlText = `select * from ${name} limit 50`; return; }
    void this.openTable(name);
  }
  protected openSystemTable(name: string) {
    this.sqlRef = this.dataRef; this.sqlMode = 'read';
    this.sqlText = name.endsWith('*') ? `-- ${name} is a family of tables, one per user table\nselect * from dolt_log limit 50` : `select * from ${name} limit 50`;
    this.go('sql');
  }
  protected openSavedQuery(q: { name: string; sql: string }) { this.sqlRef = this.dataRef; this.sqlMode = 'read'; this.sqlText = q.sql; this.go('sql'); }
  protected editableRef() { const b = this.branches().find((x) => x.name === this.dataRef); return !!b && !b.protected; }
  protected displayRows(d: TableData) {
    const q = this.rowFilter().trim().toLowerCase();
    let rows = q ? d.rows.filter((r) => d.columns.some((c) => cellText(r[c.name] as never).toLowerCase().includes(q))) : [...d.rows];
    const col = this.sortCol();
    if (col) rows = rows.sort((a, b) => cellText(a[col] as never).localeCompare(cellText(b[col] as never), undefined, { numeric: true }) * this.sortDir());
    return rows;
  }
  protected toggleCol(name: string) { const s = new Set(this.hiddenCols()); if (s.has(name)) s.delete(name); else s.add(name); this.hiddenCols.set(s); }
  protected exportCsv(d: TableData) {
    const cols = this.visibleColumns().map((c) => c.name);
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = [cols.join(','), ...this.displayRows(d).map((r) => cols.map((c) => esc(cellText(r[c] as never))).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `${d.table}-${d.ref}.csv`; a.click(); URL.revokeObjectURL(a.href);
  }
  protected startEdit(row: Record<string, unknown>) {
    const d = this.data()!; this.editKey = Object.fromEntries(d.primaryKey.map((k) => [k, row[k]])); this.editJson = JSON.stringify(row, null, 2); this.editMessage = ''; this.prepareFields(row); void this.loadRowHistory(row);
  }
  protected readonly rowHistory = signal<{ commit: string; author: string; date: string; changes: { col: string; from: unknown; to: unknown }[]; created: boolean; values: Record<string, unknown> }[]>([]);
  protected openRow(row: Record<string, unknown>) { this.rowView.set(row); void this.loadRowHistory(row); }
  protected pkLabel() {
    const d = this.data(); if (!d) return '';
    const src = this.rowView() ?? this.editKey;
    return src ? d.primaryKey.map((k) => (src as Record<string, unknown>)[k]).join(', ') : '';
  }
  /** Every past version of the selected row, newest first, from the dolt_history_<table> system table. */
  protected async loadRowHistory(row: Record<string, unknown>) {
    this.rowHistory.set([]);
    const d = this.data(); if (!d || !d.primaryKey.length) return;
    const where = d.primaryKey.map((k) => `\`${k}\` = '${String(row[k]).replace(/'/g, "''")}'`).join(' and ');
    const r = await this.run(() => this.v.sql({ ref: d.ref, sql: `select * from \`dolt_history_${d.table}\` where ${where} order by commit_date desc limit 50`, mode: 'read' }), true);
    if (!r?.rows) return;
    const cols = d.columns.map((c) => c.name);
    this.rowHistory.set(r.rows.map((v, i) => {
      const older = r.rows![i + 1];
      const changes = cols.filter((c) => JSON.stringify(v[c] ?? null) !== JSON.stringify(older?.[c] ?? null)).map((c) => ({ col: c, from: older?.[c] ?? null, to: v[c] ?? null }));
      return { commit: String(v['commit_hash'] ?? ''), author: String(v['committer'] ?? ''), date: String(v['commit_date'] ?? ''), changes, created: !older, values: v };
    }));
  }
  /** Restore fills the editor with an old version: saving it is a new commit, nothing is rewritten. */
  protected restoreVersion(h: { commit: string; values: Record<string, unknown> }) {
    const d = this.data(); if (!d) return;
    const row = Object.fromEntries(d.columns.map((c) => [c.name, h.values[c.name] ?? null]));
    this.editKey = Object.fromEntries(d.primaryKey.map((k) => [k, row[k]]));
    this.editMessage = `restore ${d.primaryKey.map((k) => row[k]).join(', ')} to ${shortHash(h.commit)}`;
    this.prepareFields(row);
  }
  protected startInsert() { const d = this.data()!; this.editKey = null; this.editJson = JSON.stringify(Object.fromEntries(d.columns.map((c) => [c.name, ''])), null, 2); this.editMessage = ''; this.prepareFields(Object.fromEntries(d.columns.filter(c=>c.name!=='credential_revision').map(c=>[c.name,c.nullable?null:'']))); }
  protected visibleTables() { return this.tableList().filter(t=>t.name.toLowerCase().includes(this.tableSearch.toLowerCase())); }
  protected visibleColumns() { return this.data()?.columns.filter((c) => !this.hiddenCols().has(c.name)) ?? []; }
  private prepareFields(row: Record<string,unknown>) { this.editorOpen=true;this.jsonMode=false;this.formFields={};this.nullFields={}; for(const c of this.data()!.columns.filter(c=>c.name!=='credential_revision')){this.nullFields[c.name]=row[c.name]===null; this.formFields[c.name]=row[c.name]===null?'':typeof row[c.name]==='object'?JSON.stringify(row[c.name]):String(row[c.name]??'');} }
  protected cancelEdit(){this.editorOpen=false;this.editJson='';}
  protected async saveEdit() {
    const d = this.data()!; let values: Record<string, unknown>;
    try { values = this.jsonMode ? JSON.parse(this.editJson) : Object.fromEntries(this.data()!.columns.filter(c=>c.name!=='credential_revision').map(c=>{let value:unknown=this.formFields[c.name]; if(this.nullFields[c.name]) value=null;else if(/json/i.test(c.type))value=JSON.parse(String(value));else if(/^(int|bigint|tinyint|smallint|mediumint|float|double|decimal|boolean)/i.test(c.type)){if(String(value).trim()===''||!Number.isFinite(Number(value)))throw new Error('invalid number');value=Number(value);} return [c.name,value];})); } catch { this.note.set('Check the row values: numbers and JSON must be valid.'); return; }
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
  protected async loadPulls() {
    const r = await this.run(() => this.v.pulls(), true);
    if (!r) return;
    this.prs.set(r.pullRequests);
    // the list endpoint carries no checks/approvals/rows: fetch each detail for the badges (a demo has a handful of PRs)
    for (const p of r.pullRequests) {
      const d = await this.run(() => this.v.pull(p.id), true);
      if (!d) continue;
      const rows = d.diff?.rows ? `+${d.diff.rows.added} \u2212${d.diff.rows.removed}` : '';
      this.prBadges.update((m) => ({ ...m, [p.id]: { checks: d.checks ? d.checks.mergeable && !d.checks.violations.length : null, approved: this.prReviewed(d), rows } }));
    }
  }
  protected prReviewed(d: PullRequestDetail) { return d.approvals.length > 0 && d.approvals.length >= d.requiredApprovals; }
  protected prReady(d: PullRequestDetail) { return !!d.checks?.mergeable && !d.checks.violations.length && d.approvals.length >= d.requiredApprovals; }
  protected approvalNames(d: PullRequestDetail) { return d.approvals.join(', '); }
  protected async openPull() {
    this.prTitleErr.set(this.prForm.title.trim() ? '' : 'A title is required.');
    if (this.prTitleErr()) return;
    const r = await this.run(() => this.v.openPull(this.prForm.title, this.prForm.body, this.prForm.source, this.prForm.target));
    if (!r) { this.mirrorNameError(m => (this.prTitleErr.set(m)), /title/i); return; }
    if (r) { this.prForm = { title: '', body: '', source: '', target: this.defaultBranch() }; this.prTitleErr.set(''); await this.refreshRefs(); await this.loadPulls(); await this.showPull(r.id); }
  }
  protected async showPull(id: number) {
    const r = await this.run(() => this.v.pull(id), true);
    if (!r) return;
    this.prCreateOpen = false;
    this.pr.set(r); this.rowDiff.set(null);
    this.prTab.set('conversation'); this.prRowDiffs.set({}); this.prExpandedDiffs.set(new Set());
    for (const t of (r.diff?.tables ?? []).filter((x) => x.dataChange)) { this.prExpandedDiffs.update((s) => new Set(s).add(t.table)); await this.loadPrRowDiff(t.table); }
  }
  protected async togglePrTableDiff(table: string) {
    const s = new Set(this.prExpandedDiffs());
    if (s.has(table)) { s.delete(table); this.prExpandedDiffs.set(s); return; }
    s.add(table); this.prExpandedDiffs.set(s);
    if (!this.prRowDiffs()[table]) await this.loadPrRowDiff(table);
  }
  private async loadPrRowDiff(table: string) {
    const p = this.pr()?.pullRequest; if (!p) return;
    const r = await this.run(() => this.v.diffTable(table, p.target, p.source, true), true);
    if (r) this.prRowDiffs.update((m) => ({ ...m, [table]: r }));
  }
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
