import { JsonPipe } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Edge, Node, Vflow } from 'ngx-vflow';
import { Session } from '../session';
import {
  DefinitionSummary, RunSummary, RunView, WfNodeComponent, WfNodeData,
  categoryLabel, categoryOf, clientOf,
} from './wf-model';
import { WbTabs, WbTabsBar } from './workbench-tabs';

// ---- Executions screen (phase 3): list and detail on ONE screen. Desktop shows the list on the left and
// the selected run on the right; mobile stacks (selecting a run swaps the list for the detail, with a back
// link). The selected run lives in the URL (?run=<id>): a link is shareable and /workflows/run/:id
// redirects here. Test runs (editor) are hidden unless "test runs" is checked. ----

const duration = (r: { startedAt?: string; finishedAt?: string | null; started_at?: string | null; finished_at?: string | null }): string => {
  const a = r.startedAt ?? r.started_at, b = r.finishedAt ?? r.finished_at;
  if (!a) return '-';
  const ms = (b ? Date.parse(b) : Date.now()) - Date.parse(a);
  return ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
};

@Component({ selector: 'app-workflow-executions', imports: [FormsModule, RouterLink, JsonPipe, Vflow, WbTabsBar], styleUrl: '../pages.css', styles: [`
.xc { display: flex; gap: .8rem; align-items: flex-start; }
.xc-list { flex: 0 0 460px; min-width: 0; }
.xc-detail { flex: 1; min-width: 0; }
.xc-row.on td { background: var(--accent-soft); }
.xc-row td { cursor: pointer; }
.xc-empty { display: flex; align-items: center; justify-content: center; min-height: 240px; color: var(--muted); }
.xc-back { display: none; }
@media (max-width: 960px) {
  .xc { flex-direction: column; }
  .xc-list, .xc-detail { flex: 1 1 auto; width: 100%; }
  .xc.has-run .xc-list { display: none; }
  .xc.has-run .xc-back { display: inline-flex; }
}
`], template: `
<app-wb-tabs />
<p class="lead">Executions: every workflow run, newest first. Click a run to open it next to the list - the URL is shareable. Test runs from the editor are hidden unless asked for.</p>
@if (note()) { <p role="status" class="msg">{{note()}}</p> }
<div class="xc" [class.has-run]="!!selected()">
<section class="card xc-list"><div class="row" style="flex-wrap:wrap">
<span class="wlc-chips" style="display:inline-flex;gap:.3rem">
  @for (f of statusChips; track f.value) {<button class="secondary" [style.background]="fStatus === f.value ? 'var(--accent-soft)' : null" [style.color]="fStatus === f.value ? 'var(--accent)' : null" [style.border-color]="fStatus === f.value ? 'var(--accent)' : null" (click)="fStatus = f.value; load()">{{f.label}}</button>}
</span>
<label>Workflow<select name="fDef" [(ngModel)]="fDefinition" (ngModelChange)="load()"><option value="">All</option>@for (d of defs(); track d.id) {<option [value]="d.id">{{d.name}}</option>}</select></label>
<label><input type="checkbox" name="fTests" [(ngModel)]="fTests" (ngModelChange)="load()" /> test runs</label>
<span class="spacer"></span>
<label title="Reload the list every 5 seconds"><input type="checkbox" name="fAuto" [ngModel]="autoRefresh()" (ngModelChange)="setAutoRefresh($event)" /> Auto-refresh 5 s</label>
<button class="secondary" (click)="load()">Refresh</button>
</div>
<div class="scroll"><table><thead><tr><th>Run</th><th>Workflow</th><th>Status</th><th>Branch</th><th>Started</th><th>Duration</th></tr></thead><tbody>
@for (r of runs(); track r.id) {<tr class="xc-row" [class.on]="selected() === r.id" (click)="select(r)"><td>{{r.id}} @if (r.test) {<span class="chip" data-status="simulated">test</span>}</td><td>{{r.name}}</td><td><span class="chip" [attr.data-status]="r.status">{{r.status}}</span>@if (r.error) {<br /><small class="req">{{r.error}}</small>}</td><td>{{r.branch || '-'}}</td><td>{{r.startedAt}}</td><td>{{dur(r)}}</td></tr>}
@empty {<tr><td colspan="6">No run matches these filters.</td></tr>}
</tbody></table></div></section>

@if (selected()) {
<section class="xc-detail">
  @if (view(); as v) {<section class="card"><div class="row" style="flex-wrap:wrap">
  <a class="btn secondary xc-back" [routerLink]="['/workflows/runs']" [queryParams]="{ definition: fDefinition || null }">← All executions</a>
  <span class="chip" [attr.data-status]="v.run.status">{{v.run.status}}</span>
  <b>{{v.run.name}}</b>
  @if (v.run.test) {<span class="chip" data-status="simulated">test run, disposable branch</span>}
  @if (v.run.simulatedOnly) {<span class="chip" data-status="simulated">fully simulated</span>} @else {<span class="chip" data-status="real">writes on branch {{v.run.branch || '(created at first real step)'}}</span>}
  <small>started by {{v.run.started_by}} — {{dur(v.run)}}</small><span class="spacer"></span>
  <button class="secondary" (click)="refreshRun()">Refresh</button>
  <button class="secondary" (click)="close()" title="Close the detail">✕</button>
  @if (v.run.status === 'running' || v.run.status === 'queued') {<button class="secondary" (click)="cancel()">Cancel</button>}
  @if (v.run.status !== 'running' && v.run.status !== 'queued') {
    @if (v.run.status === 'failed' || v.run.status === 'canceled') {<button (click)="retry()">Retry from the failed step</button>}
    <button class="secondary" (click)="rerun()" title="Start a fresh run of the same workflow">Re-run</button>
    <button class="secondary" (click)="exportLog()" title="Download the run view as JSON">Export log</button>
    <button class="secondary" style="color:var(--bad);border-color:var(--bad-line)" (click)="removeRun()">Delete run</button>
  }
  @if (v.run.status === 'completed' && v.run.branch && !v.run.test) {<button (click)="review()">Review &amp; open a pull request</button>}
  </div>
  @if (v.run.error) {<p class="msg error">{{v.run.error}}</p>}
  @if (prId()) {<p class="msg">Pull request #{{prId()}} open for branch {{v.run.branch}}: <a [routerLink]="['/database/pulls']">review and merge it</a>. The merge stays a human action.</p>}
  </section>
  <section class="card wf-canvas wb-replay"><h3>Replay</h3>
  <vflow [nodes]="replayNodes()" [edges]="replayEdges()" [view]="'auto'" [minZoom]="0.3" [maxZoom]="1.6" [background]="'var(--bg)'" [entitiesSelectable]="false" (componentNodeEvent)="noop($event)" />
  </section>
  <section class="card"><h3>Steps</h3>
  @for (st of v.steps; track st.node_id) {<div class="wf-step" [attr.data-status]="st.status">
  <div class="row"><span class="chip" [attr.data-status]="st.status">{{st.status}}</span><b>{{st.name}}</b><span class="chip" [attr.data-status]="categoryOf(st)">{{categoryLabel(categoryOf(st))}}</span><small>attempts: {{st.attempts}} — {{dur(st)}}</small><span class="spacer"></span>
  @if ((v.run.status === 'completed' || v.run.status === 'failed' || v.run.status === 'canceled') && st.status !== 'skipped') {<button class="secondary" (click)="rerunFrom(st.node_id)" title="Re-run the workflow from this step">Re-run from here</button>}</div>
  @if (st.error) {<p class="msg error">{{st.error}}</p>}
  <details><summary>Input</summary><pre class="wf-log">{{st.input | json}}</pre></details>
  <details open><summary>Output</summary><pre class="wf-log">{{st.output | json}}</pre></details>
  <details><summary>Log</summary><pre class="wf-log">@for (l of st.log; track l) {{{l}}
}</pre></details>
  </div>}
  </section>} @else {<section class="card xc-empty"><p class="hint">Loading the run…</p></section>}
</section>
} @else {<section class="card xc-detail xc-empty"><p class="hint">Select a run on the left to see its replay, steps and logs here.</p></section>}
</div>
` })
export class WorkflowExecutionsPage implements OnInit, OnDestroy {
  protected readonly s = inject(Session);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly tabs = inject(WbTabs);
  protected readonly categoryLabel = categoryLabel;
  protected readonly categoryOf = categoryOf;
  protected defs = signal<DefinitionSummary[]>([]);
  protected runs = signal<RunSummary[]>([]);
  protected note = signal('');
  protected fDefinition = ''; protected fStatus = ''; protected fTests = false;
  protected autoRefresh = signal(false);
  /** The run shown in the detail pane, from the ?run= query param (shareable URL). */
  protected selected = signal<string | null>(null);
  protected view = signal<RunView | null>(null);
  protected prId = signal<number | null>(null);
  private timer?: ReturnType<typeof setInterval>;
  private poll?: ReturnType<typeof setInterval>;
  protected readonly dur = duration;
  protected readonly statusChips = [
    { value: '', label: 'All' }, { value: 'completed', label: 'Completed' }, { value: 'failed', label: 'Failed' },
    { value: 'running', label: 'Running' }, { value: 'canceled', label: 'Canceled' },
  ];

  ngOnInit() {
    this.fDefinition = this.route.snapshot.queryParamMap.get('definition') ?? '';
    void clientOf(this.s).list().then((r) => this.defs.set(r.definitions)).catch(() => undefined);
    void this.load();
    // The selected run is URL-driven: list clicks, tab clicks, back/forward and /workflows/run/:id
    // redirects all land here.
    this.route.queryParamMap.subscribe((q) => {
      const run = q.get('run');
      if (run === this.selected()) return;
      this.selected.set(run);
      this.view.set(null); this.prId.set(null);
      if (run) void this.refreshRun();
    });
    // Live runs poll their detail; the list itself refreshes only on demand (or the opt-in timer).
    this.poll = setInterval(() => { const st = this.view()?.run.status; if (st === 'running' || st === 'queued') void this.refreshRun(); }, 1500);
  }
  ngOnDestroy() { clearInterval(this.timer); clearInterval(this.poll); }

  protected setAutoRefresh(on: boolean) {
    this.autoRefresh.set(on);
    clearInterval(this.timer);
    this.timer = on ? setInterval(() => void this.load(), 5000) : undefined;
  }
  protected async load() {
    try { this.runs.set((await clientOf(this.s).runs({ definition: this.fDefinition || undefined, status: this.fStatus || undefined, tests: this.fTests })).runs); }
    catch (e) { this.note.set((e as Error).message); }
  }

  /** Opens a run in the detail pane: the selection is the ?run= query param. */
  protected select(r: RunSummary) {
    void this.router.navigate(['/workflows/runs'], { queryParams: { run: r.id, definition: this.fDefinition || null } });
  }
  protected close() {
    void this.router.navigate(['/workflows/runs'], { queryParams: { definition: this.fDefinition || null } });
  }
  protected noop(_e: unknown) {}

  protected async refreshRun() {
    const id = this.selected(); if (!id) return;
    try {
      const v = await clientOf(this.s).run(id);
      this.view.set(v);
      this.tabs.open('run', id, v.run.name || id);
    } catch (e) {
      this.note.set((e as Error).message);
      if ((e as Error).message.includes('unknown run')) { this.tabs.drop('run', id); this.close(); }
    }
  }
  protected async retry() { try { this.view.set(await clientOf(this.s).retry(this.selected()!)); } catch (e) { this.note.set((e as Error).message); } }
  protected async rerunFrom(nodeId: string) { try { this.view.set(await clientOf(this.s).rerunFrom(this.selected()!, nodeId)); this.note.set(`Re-running from ${nodeId}.`); } catch (e) { this.note.set((e as Error).message); } }
  protected async cancel() { try { this.view.set(await clientOf(this.s).cancel(this.selected()!)); } catch (e) { this.note.set((e as Error).message); } }
  protected async rerun() {
    const v = this.view();
    if (!v) return;
    try {
      const r = await clientOf(this.s).start(v.run.definition_id);
      this.note.set('New run started.');
      void this.load();
      void this.router.navigate(['/workflows/runs'], { queryParams: { run: r.run.id, definition: this.fDefinition || null } });
    } catch (e) { this.note.set((e as Error).message); }
  }
  protected exportLog() {
    const v = this.view();
    if (!v) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(v, null, 2), ], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = `run-${v.run.id}.json`; a.click();
    URL.revokeObjectURL(url);
  }
  protected async removeRun() {
    const v = this.view();
    if (!v || !confirm(`Delete run ${v.run.id}? This cannot be undone.`)) return;
    try {
      await clientOf(this.s).removeRun(v.run.id);
      this.tabs.drop('run', v.run.id);
      this.close();
      void this.load();
    } catch (e) { this.note.set((e as Error).message); }
  }
  protected async review() {
    try { const r = await clientOf(this.s).review(this.selected()!); this.prId.set(r.pullRequest.id); this.note.set(r.reused ? 'A pull request already exists for this branch.' : 'Pull request opened.'); }
    catch (e) { this.note.set((e as Error).message); }
  }

  // ---- Graph replay: the run's graph, nodes tinted by step status, laid out left to right. ----
  private stepById = computed(() => new Map((this.view()?.steps ?? []).map((s) => [s.node_id, s])));
  protected replayNodes = computed<Node[]>(() => {
    const v = this.view(); if (!v) return [];
    const steps = v.run.order.length ? v.run.order : v.steps.map((s) => s.node_id);
    const depth = this.depths(v);
    const perLayer = new Map<number, number>();
    return steps.map((id) => {
      const st = this.stepById().get(id);
      const d = depth.get(id) ?? 0;
      const i = perLayer.get(d) ?? 0; perLayer.set(d, i + 1);
      return {
        id, type: WfNodeComponent,
        data: signal<WfNodeData>({ name: st?.name ?? id, category: st ? categoryOf(st) : 'simulated', runStatus: st?.status ?? null }),
        point: signal({ x: 40 + d * 260, y: 30 + i * 120 }),
        selected: signal(false),
      } as Node;
    });
  });
  protected replayEdges = computed<Edge[]>(() => {
    const v = this.view(); if (!v) return [];
    return (v.run.edges ?? []).map((e) => ({
      id: `${e.from}->${e.to}${e.label ? `#${e.label}` : ''}`, source: e.from, target: e.to,
      edgeLabels: signal(e.label ? { center: { type: 'default' as const, text: e.label } } : {}),
      markers: signal({ end: { type: 'arrow-closed' as const, width: 16, height: 16, color: e.label === 'error' ? 'var(--warn-line)' : e.label ? 'var(--accent)' : 'var(--muted)' } }),
    } as Edge));
  });
  private depths(v: RunView): Map<string, number> {
    const edges = v.run.edges ?? [];
    const incoming = new Map<string, string[]>();
    for (const e of edges) { const g = incoming.get(e.to) ?? []; g.push(e.from); incoming.set(e.to, g); }
    const depth = new Map<string, number>();
    const compute = (id: string, seen: Set<string>): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const parents = incoming.get(id) ?? [];
      const d = parents.length ? Math.max(...parents.map((p) => compute(p, seen))) + 1 : 0;
      depth.set(id, d); return d;
    };
    for (const s of v.steps) compute(s.node_id, new Set());
    return depth;
  }
}

/** Compatibility redirect (phase 3): the run detail moved into the executions screen (?run=<id>). */
@Component({ selector: 'app-workflow-run', template: '' })
export class WorkflowRunPage implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  ngOnInit() {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    void this.router.navigate(['/workflows/runs'], { queryParams: { run: id }, replaceUrl: true });
  }
}
