import { JsonPipe } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Edge, Node, Vflow } from 'ngx-vflow';
import { Session } from '../session';
import {
  DefinitionSummary, RunSummary, RunStepView, RunView, WfNodeComponent, WfNodeData,
  categoryLabel, categoryOf, clientOf,
} from './wf-model';

// ---- Executions screen: every run with filters (workflow, status, test runs), durations, and a detail
// page that replays the graph colored by step status with per-step Input / Output / Log and re-run from
// any step. Test runs (editor) are hidden unless "test runs" is checked. ----

const duration = (r: { startedAt?: string; finishedAt?: string | null; started_at?: string | null; finished_at?: string | null }): string => {
  const a = r.startedAt ?? r.started_at, b = r.finishedAt ?? r.finished_at;
  if (!a) return '-';
  const ms = (b ? Date.parse(b) : Date.now()) - Date.parse(a);
  return ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
};

@Component({ selector: 'app-workflow-executions', imports: [FormsModule, RouterLink], styleUrl: '../pages.css', template: `
<p class="lead">Executions: every workflow run, newest first. Test runs from the editor are hidden unless asked for.</p>
@if (note()) { <p role="status" class="msg">{{note()}}</p> }
<section class="card"><div class="row">
<label>Workflow<select name="fDef" [(ngModel)]="fDefinition" (ngModelChange)="load()"><option value="">All</option>@for (d of defs(); track d.id) {<option [value]="d.id">{{d.name}}</option>}</select></label>
<label>Status<select name="fStatus" [(ngModel)]="fStatus" (ngModelChange)="load()"><option value="">All</option>@for (st of ['queued','running','completed','failed','canceled']; track st) {<option [value]="st">{{st}}</option>}</select></label>
<label><input type="checkbox" name="fTests" [(ngModel)]="fTests" (ngModelChange)="load()" /> test runs</label>
<span class="spacer"></span><button class="secondary" (click)="load()">Refresh</button>
</div>
<div class="scroll"><table><thead><tr><th>Run</th><th>Workflow</th><th>Status</th><th>Branch</th><th>Started</th><th>Duration</th><th></th></tr></thead><tbody>
@for (r of runs(); track r.id) {<tr><td>{{r.id}} @if (r.test) {<span class="chip" data-status="simulated">test</span>}</td><td>{{r.name}}</td><td><span class="chip" [attr.data-status]="r.status">{{r.status}}</span>@if (r.error) {<br /><small class="req">{{r.error}}</small>}</td><td>{{r.branch || '-'}}</td><td>{{r.startedAt}}</td><td>{{dur(r)}}</td><td><a class="btn secondary" [routerLink]="['/workflows/run', r.id]">Open</a></td></tr>}
@empty {<tr><td colspan="7">No run matches these filters.</td></tr>}
</tbody></table></div></section>
` })
export class WorkflowExecutionsPage implements OnInit {
  protected readonly s = inject(Session);
  protected defs = signal<DefinitionSummary[]>([]);
  protected runs = signal<RunSummary[]>([]);
  protected note = signal('');
  protected fDefinition = ''; protected fStatus = ''; protected fTests = false;
  protected readonly dur = duration;
  ngOnInit() {
    void clientOf(this.s).list().then((r) => this.defs.set(r.definitions)).catch(() => undefined);
    void this.load();
  }
  protected async load() {
    try { this.runs.set((await clientOf(this.s).runs({ definition: this.fDefinition || undefined, status: this.fStatus || undefined, tests: this.fTests })).runs); }
    catch (e) { this.note.set((e as Error).message); }
  }
}

@Component({ selector: 'app-workflow-run', imports: [RouterLink, JsonPipe, FormsModule, Vflow], styleUrl: '../pages.css', template: `
<p class="lead">Run {{view()?.run?.id}} — {{view()?.run?.name}} @if (view()?.run?.test) {<span class="chip" data-status="simulated">test run, disposable branch</span>}</p>
@if (note()) { <p role="status" class="msg">{{note()}}</p> }
@if (view(); as v) {<section class="card"><div class="row">
<span class="chip" [attr.data-status]="v.run.status">{{v.run.status}}</span>
@if (v.run.simulatedOnly) {<span class="chip" data-status="simulated">fully simulated</span>} @else {<span class="chip" data-status="real">writes on branch {{v.run.branch || '(created at first real step)'}}</span>}
<small>started by {{v.run.started_by}} — {{dur(v.run)}}</small><span class="spacer"></span>
<button class="secondary" (click)="refresh()">Refresh</button>
@if (v.run.status === 'running' || v.run.status === 'queued') {<button class="secondary" (click)="cancel()">Cancel</button>}
@if (v.run.status === 'failed' || v.run.status === 'canceled') {<button (click)="retry()">Retry from the failed step</button>}
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
</section>}
` })
export class WorkflowRunPage implements OnInit, OnDestroy {
  protected readonly s = inject(Session);
  private readonly route = inject(ActivatedRoute);
  protected readonly categoryLabel = categoryLabel;
  protected readonly categoryOf = categoryOf;
  protected readonly dur = duration;
  protected view = signal<RunView | null>(null);
  protected note = signal(''); protected prId = signal<number | null>(null);
  private id = ''; private timer?: ReturnType<typeof setInterval>;
  ngOnInit() {
    this.id = this.route.snapshot.paramMap.get('id') ?? '';
    void this.refresh();
    this.timer = setInterval(() => { const st = this.view()?.run.status; if (st === 'running' || st === 'queued') void this.refresh(); }, 1500);
  }
  ngOnDestroy() { clearInterval(this.timer); }
  protected noop(_e: unknown) {}
  protected async refresh() { try { this.view.set(await clientOf(this.s).run(this.id)); } catch (e) { this.note.set((e as Error).message); } }
  protected async retry() { try { this.view.set(await clientOf(this.s).retry(this.id)); } catch (e) { this.note.set((e as Error).message); } }
  protected async rerunFrom(nodeId: string) { try { this.view.set(await clientOf(this.s).rerunFrom(this.id, nodeId)); this.note.set(`Re-running from ${nodeId}.`); } catch (e) { this.note.set((e as Error).message); } }
  protected async cancel() { try { this.view.set(await clientOf(this.s).cancel(this.id)); } catch (e) { this.note.set((e as Error).message); } }
  protected async review() {
    try { const r = await clientOf(this.s).review(this.id); this.prId.set(r.pullRequest.id); this.note.set(r.reused ? 'A pull request already exists for this branch.' : 'Pull request opened.'); }
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
