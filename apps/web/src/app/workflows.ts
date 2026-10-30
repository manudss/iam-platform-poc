import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Connection, Edge, Node, Vflow } from 'ngx-vflow';
import { Session } from './session';
import { ApiClient } from './api';

// ---- Workflows: visual editor for IGA demo workflows (see docs/workflows.md) ----
// SIMULATED steps (wait/notify/fail) demonstrate orchestration only: a notification is never sent.
// REAL data steps (assign-role/revoke-role/set-department) write on the run's own Dolt branch only;
// publishing to main stays the human review/merge path.

export type StepType = 'wait' | 'notify' | 'fail' | 'assign-role' | 'revoke-role' | 'set-department';
export interface WfNode { id: string; type: StepType; name: string; config: Record<string, unknown> }
export interface WfEdge { from: string; to: string }
export interface DefinitionSummary { id: string; name: string; description: string; steps: number; simulatedSteps: number; dataSteps: number; createdBy: string; updatedAt: string }
export interface RunSummary { id: string; definitionId: string; name: string; branch: string | null; status: string; error: string | null; startedBy: string; startedAt: string; finishedAt: string | null; hasDataSteps: boolean }
export interface RunView { run: { id: string; name: string; branch: string | null; status: string; error: string | null; simulatedOnly: boolean; started_by: string; started_at: string; finished_at: string | null; order: string[] }; steps: { node_id: string; name: string; type: string; label: string; status: string; simulated: boolean; attempts: number; error: string | null; log: string[]; started_at: string | null; finished_at: string | null }[] }

export const STEP_TYPES: { type: StepType; label: string; simulated: boolean; hint: string }[] = [
  { type: 'wait', label: 'Wait', simulated: true, hint: 'Simulated delay (seconds)' },
  { type: 'notify', label: 'Notify', simulated: true, hint: 'Simulated: logged, never sent' },
  { type: 'fail', label: 'Fail on purpose', simulated: true, hint: 'Simulated error, to demo retry' },
  { type: 'assign-role', label: 'Assign role', simulated: false, hint: 'Real, on the run branch' },
  { type: 'revoke-role', label: 'Revoke role', simulated: false, hint: 'Real, on the run branch' },
  { type: 'set-department', label: 'Set department', simulated: false, hint: 'Real, on the run branch' },
];

class WorkflowClient {
  constructor(private readonly api: ApiClient, private readonly adminToken: () => string) {}
  private req<T>(method: string, path: string, body?: object) {
    return this.api.raw<T & { message?: string }>(method, path, body, { 'x-api-admin-token': this.adminToken() }).then((r) => {
      if (r.status >= 400) throw new Error((r.data as { message?: string }).message ?? `HTTP ${r.status}`);
      return r.data;
    });
  }
  list() { return this.req<{ definitions: DefinitionSummary[] }>('GET', '/workflows'); }
  get(id: string) { return this.req<{ definition: { id: string; name: string; description: string; graph: { nodes: WfNode[]; edges: WfEdge[] }; order: string[] } }>('GET', `/workflows/${id}`); }
  create(name: string, description: string, graph: { nodes: WfNode[]; edges: WfEdge[] }) { return this.req<{ definition: { id: string } }>('POST', '/workflows', { name, description, graph }); }
  update(id: string, name: string, description: string, graph: { nodes: WfNode[]; edges: WfEdge[] }) { return this.req('PUT', `/workflows/${id}`, { name, description, graph }); }
  remove(id: string) { return this.req('DELETE', `/workflows/${id}`); }
  start(id: string) { return this.req<RunView>('POST', `/workflows/${id}/runs`, {}); }
  runs(definition?: string) { return this.req<{ runs: RunSummary[] }>('GET', `/workflow-runs${definition ? `?definition=${definition}` : ''}`); }
  run(id: string) { return this.req<RunView>('GET', `/workflow-runs/${id}`); }
  retry(id: string) { return this.req<RunView>('POST', `/workflow-runs/${id}/retry`, {}); }
  cancel(id: string) { return this.req<RunView>('POST', `/workflow-runs/${id}/cancel`, {}); }
  review(id: string) { return this.req<{ pullRequest: { id: number }; reused: boolean }>('POST', `/workflow-runs/${id}/review`, {}); }
}

const clientOf = (s: Session) => new WorkflowClient(s.api, () => s.adminToken());

@Component({ selector: 'app-workflows', imports: [FormsModule, RouterLink], styleUrl: './pages.css', template: `
<p class="lead">IGA workflows: build a scenario as a graph of steps, run it, follow every step, retry after an error.
<b>Simulated</b> steps never touch anything (a notification is only logged, never sent). <b>Real</b> steps write business data on the run's own Dolt branch, which a human then reviews and merges.</p>
@if (note()) { <p role="status" class="msg">{{note()}}</p> }
<section class="card"><div class="row"><h3 style="flex:1">Definitions</h3><a class="btn" routerLink="/workflows/edit/new">New workflow</a><button class="secondary" (click)="load()">Refresh</button></div>
<div class="scroll"><table><thead><tr><th>Name</th><th>Steps</th><th>Simulated</th><th>Real</th><th>By</th><th></th></tr></thead><tbody>
@for (d of defs(); track d.id) {<tr><td><a [routerLink]="['/workflows/edit', d.id]">{{d.name}}</a><br /><small>{{d.description}}</small></td><td>{{d.steps}}</td><td>{{d.simulatedSteps}}</td><td>{{d.dataSteps}}</td><td>{{d.createdBy}}</td>
<td><button (click)="start(d)" [disabled]="busy()">Run</button> <a class="btn secondary" [routerLink]="['/workflows/edit', d.id]">Edit</a> <button class="secondary" (click)="remove(d)" [disabled]="busy()">Delete</button></td></tr>}
@empty {<tr><td colspan="6">No workflow yet. Create one, or open the editor and load a sample.</td></tr>}
</tbody></table></div></section>
<section class="card"><h3>Recent runs</h3>
<div class="scroll"><table><thead><tr><th>Run</th><th>Workflow</th><th>Status</th><th>Branch</th><th>Started</th><th></th></tr></thead><tbody>
@for (r of runs(); track r.id) {<tr><td>{{r.id}}</td><td>{{r.name}}</td><td><span class="chip" [attr.data-status]="r.status">{{r.status}}</span></td><td>{{r.branch || '-'}}</td><td>{{r.startedAt}}</td><td><a class="btn secondary" [routerLink]="['/workflows/run', r.id]">Open</a></td></tr>}
@empty {<tr><td colspan="6">No run yet.</td></tr>}
</tbody></table></div></section>
` })
export class WorkflowsPage implements OnInit {
  protected readonly s = inject(Session);
  private readonly router = inject(Router);
  protected defs = signal<DefinitionSummary[]>([]);
  protected runs = signal<RunSummary[]>([]);
  protected note = signal(''); protected busy = signal(false);
  ngOnInit() { void this.load(); }
  protected async load() {
    try { const c = clientOf(this.s); this.defs.set((await c.list()).definitions); this.runs.set((await c.runs()).runs.slice(0, 15)); }
    catch (e) { this.note.set((e as Error).message); }
  }
  protected async start(d: DefinitionSummary) {
    this.busy.set(true);
    try { const v = await clientOf(this.s).start(d.id); void this.router.navigateByUrl(`/workflows/run/${v.run.id}`); }
    catch (e) { this.note.set((e as Error).message); this.busy.set(false); }
  }
  protected async remove(d: DefinitionSummary) {
    this.busy.set(true);
    try { await clientOf(this.s).remove(d.id); await this.load(); this.note.set(`Deleted ${d.name}.`); }
    catch (e) { this.note.set((e as Error).message); } finally { this.busy.set(false); }
  }
}

interface NodeState { type: StepType; name: string; config: Record<string, unknown> }

@Component({ selector: 'app-workflow-edit', imports: [FormsModule, RouterLink, Vflow], styleUrl: './pages.css', template: `
<p class="lead">{{id === 'new' ? 'New workflow' : 'Edit workflow'}} — add steps, drag them, connect them in order. The graph must be acyclic; steps run in topological order.</p>
@if (note()) { <p role="status" class="msg">{{note()}}</p> }
<section class="card"><div class="row">
<label>Name<input name="wfName" [(ngModel)]="name" maxlength="80" /></label>
<label>Description<input name="wfDesc" [(ngModel)]="description" maxlength="500" /></label>
<button (click)="save()" [disabled]="busy()">Save</button>
<a class="btn secondary" routerLink="/workflows">Back</a>
@for (sm of samples; track sm.name) {<button class="secondary" (click)="loadSample(sm)">{{sm.name}}</button>}
</div></section>
<div class="wf-grid">
<section class="card"><h3>Steps</h3>
<p class="hint">Click to add a step. Connect handles in the canvas. Select a step to edit it.</p>
@for (t of types; track t.type) {<button class="secondary wf-pal" (click)="addNode(t.type)">+ {{t.label}} <small>{{t.simulated ? 'SIMULATED' : 'REAL'}}</small><br /><small>{{t.hint}}</small></button>}
</section>
<section class="card wf-canvas">
<vflow [nodes]="vfNodes()" [edges]="vfEdges()" [view]="'auto'" (connect)="onConnect($event)" (componentNodeEvent)="noop($event)" />
</section>
<section class="card"><h3>Selected</h3>
@if (selectedNode(); as nid) {@if (state.get(nid); as st) {
<label>Step name<input name="stepName" [ngModel]="st.name" (ngModelChange)="rename(nid, $event)" maxlength="80" /></label>
<p class="hint">{{typeOf(st.type).label}} — {{typeOf(st.type).simulated ? 'SIMULATED: demonstrates the flow, no external effect' : 'REAL: writes on the run branch only'}}</p>
@switch (st.type) {
@case ('wait') {<label>Seconds (0-60)<input name="waitSecs" type="number" min="0" max="60" [ngModel]="st.config['seconds']" (ngModelChange)="setCfg(nid,'seconds',$event)" /></label>}
@case ('notify') {<label>Recipient (label only)<input name="notifTo" [ngModel]="st.config['recipient']" (ngModelChange)="setCfg(nid,'recipient',$event)" maxlength="80" /></label><label>Message<input name="notifMsg" [ngModel]="st.config['message']" (ngModelChange)="setCfg(nid,'message',$event)" maxlength="200" /></label>}
@case ('fail') {<label>Error message<input name="failMsg" [ngModel]="st.config['message']" (ngModelChange)="setCfg(nid,'message',$event)" maxlength="200" /></label>}
@case ('assign-role') {<label>Identity<input name="arId" [ngModel]="st.config['identity']" (ngModelChange)="setCfg(nid,'identity',$event)" maxlength="32" /></label><label>Role<input name="arRole" [ngModel]="st.config['role']" (ngModelChange)="setCfg(nid,'role',$event)" maxlength="32" /></label>}
@case ('revoke-role') {<label>Identity<input name="rrId" [ngModel]="st.config['identity']" (ngModelChange)="setCfg(nid,'identity',$event)" maxlength="32" /></label><label>Role<input name="rrRole" [ngModel]="st.config['role']" (ngModelChange)="setCfg(nid,'role',$event)" maxlength="32" /></label>}
@case ('set-department') {<label>Identity<input name="sdId" [ngModel]="st.config['identity']" (ngModelChange)="setCfg(nid,'identity',$event)" maxlength="32" /></label><label>Department<input name="sdDept" [ngModel]="st.config['department']" (ngModelChange)="setCfg(nid,'department',$event)" maxlength="40" /></label>}
}
<button class="secondary" (click)="deleteNode(nid)">Delete step</button>
}} @else if (selectedEdge(); as eid) {<p>Link {{eid}}</p><button class="secondary" (click)="deleteEdge(eid)">Delete link</button>}
@else {<p class="hint">Nothing selected.</p>}
</section>
</div>
` })
export class WorkflowEditPage implements OnInit {
  protected readonly s = inject(Session);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected id = 'new';
  protected name = ''; protected description = '';
  protected note = signal(''); protected busy = signal(false);
  protected readonly types = STEP_TYPES;
  protected vfNodes = signal<Node[]>([]);
  protected vfEdges = signal<Edge[]>([]);
  protected state = new Map<string, NodeState>();
  /** Selection is tracked by the library on each entity's own `selected` signal. */
  protected selectedNode = computed(() => this.vfNodes().find((n) => n.selected?.())?.id ?? null);
  protected selectedEdge = computed(() => (this.selectedNode() ? null : this.vfEdges().find((e) => e.selected?.())?.id ?? null));
  private seq = 0;
  protected readonly samples: { name: string; description: string; nodes: WfNode[]; edges: WfEdge[] }[] = [
    { name: 'Sample: onboarding', description: 'Joiner: account ready, then access, manager informed (simulated)', nodes: [
      { id: 'prepare', type: 'wait', name: 'Prepare (simulated)', config: { seconds: 2 } },
      { id: 'grant', type: 'assign-role', name: 'Grant accountant to demo-bob', config: { identity: 'demo-bob', role: 'accountant' } },
      { id: 'tell', type: 'notify', name: 'Inform the manager (simulated)', config: { recipient: 'manager-of:demo-bob', message: 'Bob is now accountant' } },
    ], edges: [{ from: 'prepare', to: 'grant' }, { from: 'grant', to: 'tell' }] },
    { name: 'Sample: offboarding', description: 'Leaver: access removed, then confirmation (simulated)', nodes: [
      { id: 'revoke', type: 'revoke-role', name: 'Revoke payment-creator from demo-bob', config: { identity: 'demo-bob', role: 'payment-creator' } },
      { id: 'move', type: 'set-department', name: 'Move demo-bob to alumni', config: { identity: 'demo-bob', department: 'alumni' } },
      { id: 'tell', type: 'notify', name: 'Confirm to HR (simulated)', config: { recipient: 'hr', message: 'Offboarding done' } },
    ], edges: [{ from: 'revoke', to: 'move' }, { from: 'move', to: 'tell' }] },
    { name: 'Sample: SoD blocked', description: 'A grant that breaks segregation of duties: run completes, merge is refused at review', nodes: [
      { id: 'grant', type: 'assign-role', name: 'Give payment-approver to demo-bob', config: { identity: 'demo-bob', role: 'payment-approver' } },
      { id: 'oops', type: 'fail', name: 'External ticket fails (simulated)', config: { message: 'ticket system unreachable (demo)' } },
    ], edges: [{ from: 'grant', to: 'oops' }] },
  ];

  ngOnInit() {
    this.id = this.route.snapshot.paramMap.get('id') ?? 'new';
    if (this.id !== 'new') void this.load();
  }
  protected typeOf(t: StepType) { return STEP_TYPES.find((x) => x.type === t)!; }

  private makeNode(id: string, st: NodeState, i: number): Node {
    return { id, type: 'default', text: signal(`${st.name}\n[${this.typeOf(st.type).simulated ? 'SIMULATED' : 'REAL'}]`), point: signal({ x: 40 + (i % 3) * 260, y: 40 + Math.floor(i / 3) * 120 }), selected: signal(false) } as Node;
  }

  protected addNode(type: StepType) {
    const id = `step-${++this.seq}`;
    const defaults: Record<StepType, Record<string, unknown>> = {
      wait: { seconds: 2 }, notify: { recipient: '', message: '' }, fail: { message: 'step configured to fail' },
      'assign-role': { identity: 'demo-bob', role: 'accountant' }, 'revoke-role': { identity: 'demo-bob', role: 'payment-creator' }, 'set-department': { identity: 'demo-bob', department: '' },
    };
    const st: NodeState = { type, name: this.typeOf(type).label, config: { ...defaults[type] } };
    this.state.set(id, st);
    for (const n of this.vfNodes()) n.selected?.set(false);
    const node = this.makeNode(id, st, this.vfNodes().length);
    node.selected?.set(true);
    this.vfNodes.update((ns) => [...ns, node]);
  }
  protected rename(id: string, v: string) {
    const st = this.state.get(id)!; st.name = v;
    const n = this.vfNodes().find((x) => x.id === id);
    if (n && n.type === 'default') n.text?.set(`${v}\n[${this.typeOf(st.type).simulated ? 'SIMULATED' : 'REAL'}]`);
  }
  protected setCfg(id: string, k: string, v: unknown) { this.state.get(id)!.config[k] = k === 'seconds' ? Number(v) : v; }
  protected noop(_e: unknown) {}
  protected onConnect(c: Connection) {
    if (!c.source || !c.target) return;
    const id = `${c.source}->${c.target}`;
    if (this.vfEdges().some((e) => e.id === id)) return;
    this.vfEdges.update((es) => [...es, { id, source: c.source, target: c.target, selected: signal(false) } as Edge]);
  }
  protected deleteNode(id: string) {
    this.state.delete(id);
    this.vfNodes.set(this.vfNodes().filter((n) => n.id !== id));
    this.vfEdges.set(this.vfEdges().filter((e) => e.source !== id && e.target !== id));
  }
  protected deleteEdge(id: string) { this.vfEdges.set(this.vfEdges().filter((e) => e.id !== id)); }

  protected loadSample(sm: (typeof this.samples)[number]) {
    this.name = sm.name.replace('Sample: ', 'Demo: ');
    this.description = sm.description;
    this.state.clear();
    const nodes: Node[] = [];
    sm.nodes.forEach((n, i) => { const st = { type: n.type, name: n.name, config: { ...n.config } }; this.state.set(n.id, st); nodes.push(this.makeNode(n.id, st, i)); });
    this.vfNodes.set(nodes);
    this.vfEdges.set(sm.edges.map((e) => ({ id: `${e.from}->${e.to}`, source: e.from, target: e.to, selected: signal(false) }) as Edge));
  }

  private async load() {
    try {
      const { definition } = await clientOf(this.s).get(this.id);
      this.name = definition.name; this.description = definition.description;
      this.state.clear();
      const nodes: Node[] = [];
      definition.graph.nodes.forEach((n, i) => { const st = { type: n.type, name: n.name, config: { ...n.config } }; this.state.set(n.id, st); nodes.push(this.makeNode(n.id, st, i)); this.seq = Math.max(this.seq, Number(n.id.replace(/\D/g, '')) || 0); });
      this.vfNodes.set(nodes);
      this.vfEdges.set(definition.graph.edges.map((e) => ({ id: `${e.from}->${e.to}`, source: e.from, target: e.to, selected: signal(false) }) as Edge));
    } catch (e) { this.note.set((e as Error).message); }
  }

  protected async save() {
    this.busy.set(true);
    try {
      const graph = {
        nodes: [...this.state.entries()].map(([id, st]) => ({ id, type: st.type, name: st.name, config: st.config })),
        edges: this.vfEdges().map((e) => ({ from: e.source, to: e.target })),
      };
      const c = clientOf(this.s);
      if (this.id === 'new') { const r = await c.create(this.name, this.description, graph); this.note.set('Workflow saved.'); void this.router.navigateByUrl(`/workflows/edit/${r.definition.id}`); }
      else { await c.update(this.id, this.name, this.description, graph); this.note.set('Workflow saved.'); }
    } catch (e) { this.note.set((e as Error).message); } finally { this.busy.set(false); }
  }
}

@Component({ selector: 'app-workflow-run', imports: [RouterLink], styleUrl: './pages.css', template: `
<p class="lead">Run {{view()?.run?.id}} — {{view()?.run?.name}}</p>
@if (note()) { <p role="status" class="msg">{{note()}}</p> }
@if (view(); as v) {<section class="card"><div class="row">
<span class="chip" [attr.data-status]="v.run.status">{{v.run.status}}</span>
@if (v.run.simulatedOnly) {<span class="chip" data-status="simulated">fully simulated</span>} @else {<span class="chip" data-status="real">writes on branch {{v.run.branch || '(created at first real step)'}}</span>}
<span class="spacer"></span>
<button class="secondary" (click)="refresh()">Refresh</button>
@if (v.run.status === 'running' || v.run.status === 'queued') {<button class="secondary" (click)="cancel()">Cancel</button>}
@if (v.run.status === 'failed' || v.run.status === 'canceled') {<button (click)="retry()">Retry from the failed step</button>}
@if (v.run.status === 'completed' && v.run.branch) {<button (click)="review()">Review &amp; open a pull request</button>}
</div>
@if (v.run.error) {<p class="msg error">{{v.run.error}}</p>}
@if (prId()) {<p class="msg">Pull request #{{prId()}} open for branch {{v.run.branch}}: <a [routerLink]="['/database/pulls']">review and merge it</a>. The merge stays a human action.</p>}
</section>
<section class="card"><h3>Steps</h3>
@for (st of v.steps; track st.node_id) {<div class="wf-step" [attr.data-status]="st.status">
<div class="row"><span class="chip" [attr.data-status]="st.status">{{st.status}}</span><b>{{st.name}}</b><span class="chip" [attr.data-status]="st.simulated ? 'simulated' : 'real'">{{st.simulated ? 'SIMULATED' : 'REAL'}}</span><small>attempts: {{st.attempts}}</small></div>
@if (st.error) {<p class="msg error">{{st.error}}</p>}
<details><summary>Log</summary><pre class="wf-log">@for (l of st.log; track l) {{{l}}
}</pre></details>
</div>}
</section>}
` })
export class WorkflowRunPage implements OnInit, OnDestroy {
  protected readonly s = inject(Session);
  private readonly route = inject(ActivatedRoute);
  protected view = signal<RunView | null>(null);
  protected note = signal(''); protected prId = signal<number | null>(null);
  private id = ''; private timer?: ReturnType<typeof setInterval>;
  ngOnInit() {
    this.id = this.route.snapshot.paramMap.get('id') ?? '';
    void this.refresh();
    this.timer = setInterval(() => { const st = this.view()?.run.status; if (st === 'running' || st === 'queued') void this.refresh(); }, 1500);
  }
  ngOnDestroy() { clearInterval(this.timer); }
  protected async refresh() { try { this.view.set(await clientOf(this.s).run(this.id)); } catch (e) { this.note.set((e as Error).message); } }
  protected async retry() { try { this.view.set(await clientOf(this.s).retry(this.id)); } catch (e) { this.note.set((e as Error).message); } }
  protected async cancel() { try { this.view.set(await clientOf(this.s).cancel(this.id)); } catch (e) { this.note.set((e as Error).message); } }
  protected async review() {
    try { const r = await clientOf(this.s).review(this.id); this.prId.set(r.pullRequest.id); this.note.set(r.reused ? 'A pull request already exists for this branch.' : 'Pull request opened.'); }
    catch (e) { this.note.set((e as Error).message); }
  }
}
