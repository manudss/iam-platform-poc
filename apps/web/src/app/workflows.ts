import { Component, ElementRef, OnDestroy, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, CanActivateFn, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Connection, CustomNodeComponent, Edge, HandleComponent, Node, Vflow, VflowComponent, ViewportState } from 'ngx-vflow';
import { Session } from './session';
import { ApiClient } from './api';

// ---- Workflows: visual editor for IGA demo workflows (see docs/workflows.md) ----
// The whole feature is gated by the `workflows-iga` plugin: while disabled, the menu entry is hidden
// (shell.ts), these routes redirect to /plugins, and every API endpoint answers 403.

/** Route guard: the Workflows pages are inaccessible while the workflows-iga plugin is disabled. */
export const workflowsEnabledGuard: CanActivateFn = async () => {
  const s = inject(Session);
  const router = inject(Router);
  if (await s.refreshWorkflowsEnabled()) return true;
  s.say('The Workflows (IGA) plugin is disabled. Enable it from the Plugins page to use workflows.', 'info');
  return router.parseUrl('/plugins');
};
// SIMULATED steps (wait/notify/fail) demonstrate orchestration only: a notification is never sent.
// REAL data steps (assign-role/revoke-role/set-department) write on the run's own Dolt branch only;
// publishing to main stays the human review/merge path.

// Step types are OPEN: plugins contribute blocks on the workflows.blocks surface (GET /workflow-blocks),
// each with a family, form fields and documented outputs. The built-in types stay the Core family.
export type StepType = string;
export interface WfNode { id: string; type: StepType; name: string; config: Record<string, unknown> }
export interface WfEdge { from: string; to: string }
export interface WfTrigger { event: string; match?: Record<string, string>; config?: Record<string, unknown> }
export interface WfBlockField { key: string; label: string; type: 'string' | 'text' | 'number' | 'boolean' | 'select'; required?: boolean; default?: unknown; options?: string[]; help?: string }
export interface WfEvent { type: string; label: string; payload: string[]; configFields?: WfBlockField[] }
export interface WfBlock { type: string; family: string; label: string; simulated: boolean; description: string; fields?: WfBlockField[]; outputs?: { key: string; description: string }[]; provider: string | null; providerActive: boolean }
export interface DemoSheet { name: string; simulated: boolean; note: string; columns: string[]; rows: { rowNumber: number; values: Record<string, string> }[] }
export interface DefinitionSummary { id: string; name: string; description: string; trigger: WfTrigger | null; steps: number; simulatedSteps: number; dataSteps: number; createdBy: string; updatedAt: string }
export interface RunSummary { id: string; definitionId: string; name: string; branch: string | null; status: string; error: string | null; startedBy: string; startedAt: string; finishedAt: string | null; hasDataSteps: boolean }
export interface RunView { run: { id: string; name: string; branch: string | null; status: string; error: string | null; simulatedOnly: boolean; started_by: string; started_at: string; finished_at: string | null; order: string[] }; steps: { node_id: string; name: string; type: string; label: string; status: string; simulated: boolean; attempts: number; error: string | null; log: string[]; started_at: string | null; finished_at: string | null }[] }

export const STEP_TYPES: { type: StepType; label: string; simulated: boolean; hint: string }[] = [
  { type: 'wait', label: 'Wait', simulated: true, hint: 'Simulated delay (seconds)' },
  { type: 'notify', label: 'Notify', simulated: true, hint: 'Simulated: logged, never sent' },
  { type: 'fail', label: 'Fail on purpose', simulated: true, hint: 'Simulated error: fails once, recovers on retry' },
  { type: 'assign-role', label: 'Assign role', simulated: false, hint: 'Real, on the run branch' },
  { type: 'revoke-role', label: 'Revoke role', simulated: false, hint: 'Real, on the run branch' },
  { type: 'set-department', label: 'Set department', simulated: false, hint: 'Real, on the run branch' },
  { type: 'set-profile-field', label: 'Set profile field', simulated: false, hint: 'Real, on the run branch' },
];


// ---- Visual node for the workflow canvas: readable name, wrapped text, SIMULATED/REAL badge, side handles ----
export interface WfNodeData { name: string; simulated: boolean }

@Component({
  selector: 'app-wf-node',
  imports: [HandleComponent],
  template: `
    <div class="wf-node" [class.real]="!data()?.simulated" [class.selected]="selected()">
      <span class="wf-node-name">{{ data()?.name }}</span>
      <span class="wf-node-badge" [class.real]="!data()?.simulated">{{ data()?.simulated ? 'SIMULATED' : 'REAL' }}</span>
    </div>
    <handle type="target" position="left" />
    <handle type="source" position="right" />
  `,
  styles: [`
    :host { display: block; position: relative; }
    .wf-node {
      box-sizing: border-box; width: 190px; min-height: 64px; padding: 10px 12px;
      background: var(--card); border: 1.5px solid var(--field-line); border-left: 5px solid var(--accent); border-radius: 10px;
      box-shadow: 0 1px 3px var(--shadow-color); cursor: pointer;
      display: flex; flex-direction: column; gap: 6px;
    }
    .wf-node.real { border-left-color: var(--ok); }
    .wf-node.selected { border-color: var(--accent); box-shadow: 0 0 0 3px var(--shadow-color); }
    .wf-node-name {
      font-size: 14px; font-weight: 600; line-height: 1.35; color: var(--ink);
      overflow-wrap: anywhere; white-space: normal;
    }
    .wf-node-badge {
      align-self: flex-start; font-size: 11px; font-weight: 700; letter-spacing: .04em;
      padding: 2px 7px; border-radius: 999px; background: var(--accent-soft); color: var(--accent);
    }
    .wf-node-badge.real { background: var(--ok-soft); color: var(--ok); }
    handle { position: absolute; top: 50%; width: 12px; height: 12px; border-radius: 50%;
      background: var(--card); border: 2px solid var(--accent); transform: translateY(-50%); }
    handle[position="left"] { left: -6px; }
    handle[position="right"] { right: -6px; }
  `],
})
export class WfNodeComponent extends CustomNodeComponent<WfNodeData> {}

export class WorkflowClient {
  constructor(private readonly api: ApiClient, private readonly adminToken: () => string) {}
  private req<T>(method: string, path: string, body?: object) {
    return this.api.raw<T & { message?: string }>(method, path, body, { 'x-api-admin-token': this.adminToken() }).then((r) => {
      if (r.status >= 400) throw new Error((r.data as { message?: string }).message ?? `HTTP ${r.status}`);
      return r.data;
    });
  }
  list() { return this.req<{ definitions: DefinitionSummary[] }>('GET', '/workflows'); }
  get(id: string) { return this.req<{ definition: { id: string; name: string; description: string; trigger: WfTrigger | null; graph: { nodes: WfNode[]; edges: WfEdge[] }; order: string[] } }>('GET', `/workflows/${id}`); }
  events() { return this.req<{ events: WfEvent[] }>('GET', '/workflows-events'); }
  blocks() { return this.req<{ blocks: WfBlock[] }>('GET', '/workflow-blocks'); }
  demoSheet() { return this.req<DemoSheet>('GET', '/plugins/workflow-connectors/demo-sheet'); }
  demoSheetAdd(values: Record<string, string>) { return this.req('POST', '/plugins/workflow-connectors/demo-sheet/rows', values); }
  demoSheetUpdate(row: number, column: string, value: string) { return this.req('PUT', `/plugins/workflow-connectors/demo-sheet/rows/${row}`, { column, value }); }
  create(name: string, description: string, graph: { nodes: WfNode[]; edges: WfEdge[] }, trigger: WfTrigger | null) { return this.req<{ definition: { id: string } }>('POST', '/workflows', trigger ? { name, description, graph, trigger } : { name, description, graph }); }
  update(id: string, name: string, description: string, graph: { nodes: WfNode[]; edges: WfEdge[] }, trigger: WfTrigger | null) { return this.req('PUT', `/workflows/${id}`, trigger ? { name, description, graph, trigger } : { name, description, graph }); }
  remove(id: string) { return this.req('DELETE', `/workflows/${id}`); }
  start(id: string) { return this.req<RunView>('POST', `/workflows/${id}/runs`, {}); }
  runs(definition?: string) { return this.req<{ runs: RunSummary[] }>('GET', `/workflow-runs${definition ? `?definition=${definition}` : ''}`); }
  run(id: string) { return this.req<RunView>('GET', `/workflow-runs/${id}`); }
  retry(id: string) { return this.req<RunView>('POST', `/workflow-runs/${id}/retry`, {}); }
  cancel(id: string) { return this.req<RunView>('POST', `/workflow-runs/${id}/cancel`, {}); }
  review(id: string) { return this.req<{ pullRequest: { id: number }; reused: boolean }>('POST', `/workflow-runs/${id}/review`, {}); }
}

// ---- Initial canvas framing ----
// Custom component nodes only report their real size after Angular renders them, so fitting the view on a
// fixed timer races the node measurement and sometimes frames the graph half-clipped or tiny. These helpers
// keep the framing deterministic: wait for real readiness, fit, verify the visible result, retry if wrong.

/** Leftmost node of the graph: the stable anchor the initial framing zooms back to. */
export const leftmostNode = (nodes: Node[]): Node | null =>
  nodes.reduce<Node | null>((a, n) => (!a || n.point().x < a.point().x ? n : a), null);

/** Viewport that anchors the leftmost node near the top-left corner at a comfortable reading zoom. */
export const anchorViewport = (nodes: Node[], zoom = 0.9, margin = 24): ViewportState | null => {
  const first = leftmostNode(nodes);
  return first ? { zoom, x: margin - first.point().x * zoom, y: margin - first.point().y * zoom } : null;
};

export interface FrameRect { left: number; top: number; right: number; bottom: number }

/** True when every inner rect is fully visible inside the outer rect (small tolerance for sub-pixel rounding). */
export const rectsWithin = (inner: FrameRect[], outer: FrameRect, tolerance = 2): boolean =>
  inner.every((r) => r.left >= outer.left - tolerance && r.top >= outer.top - tolerance && r.right <= outer.right + tolerance && r.bottom <= outer.bottom + tolerance);

const clientOf = (s: Session) => new WorkflowClient(s.api, () => s.adminToken());

@Component({ selector: 'app-workflows', imports: [FormsModule, RouterLink], styleUrl: './pages.css', template: `
<p class="lead">IGA workflows: build a scenario as a graph of steps, run it, follow every step, retry after an error.
<b>Simulated</b> steps never touch anything (a notification is only logged, never sent). <b>Real</b> steps write business data on the run's own Dolt branch, which a human then reviews and merges.</p>
@if (note()) { <p role="status" class="msg">{{note()}}</p> }
<section class="card"><div class="row"><h3 style="flex:1">Definitions</h3><a class="btn" routerLink="/workflows/edit/new">New workflow</a><button class="secondary" (click)="load()">Refresh</button></div>
<div class="scroll"><table><thead><tr><th>Name</th><th>Trigger</th><th>Steps</th><th>Simulated</th><th>Real</th><th>By</th><th></th></tr></thead><tbody>
@for (d of defs(); track d.id) {<tr><td><a [routerLink]="['/workflows/edit', d.id]">{{d.name}}</a><br /><small>{{d.description}}</small></td><td>@if (d.trigger) {<span class="chip" data-status="real">auto: {{d.trigger.event}}</span>} @else {<small>manual</small>}</td><td>{{d.steps}}</td><td>{{d.simulatedSteps}}</td><td>{{d.dataSteps}}</td><td>{{d.createdBy}}</td>
<td><button (click)="start(d)" [disabled]="busy()">Run</button> <a class="btn secondary" [routerLink]="['/workflows/edit', d.id]">Edit</a> <button class="secondary" (click)="remove(d)" [disabled]="busy()">Delete</button></td></tr>}
@empty {<tr><td colspan="7">No workflow yet. Create one, or open the editor and load a sample.</td></tr>}
</tbody></table></div></section>
@if (sheet(); as sh) {<section class="card"><h3>Demo sheet - {{sh.name}} <span class="chip" data-status="simulated">SIMULATED</span></h3>
<p class="hint">{{sh.note}}</p>
<div class="scroll"><table><thead><tr><th>#</th>@for (c of sh.columns; track c) {<th>{{c}}</th>}</tr></thead><tbody>
@for (r of sh.rows; track r.rowNumber) {<tr><td>{{r.rowNumber}}</td>@for (c of sh.columns; track c) {<td><input [attr.name]="'sh-'+r.rowNumber+'-'+c" [(ngModel)]="r.values[c]" /></td>}</tr>}
</tbody></table></div>
<div class="row" style="margin-top:.5rem"><button class="secondary" (click)="sheetAdd()" [disabled]="busy()">+ Add a candidate row</button><button (click)="sheetSave()" [disabled]="busy()">Save changes</button>@if (sheetNote()) {<span class="hint">{{sheetNote()}}</span>}</div>
</section>}
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
  protected sheet = signal<DemoSheet | null>(null);
  protected sheetNote = signal('');
  private sheetSaved = '[]';
  ngOnInit() { void this.load(); }
  protected async load() {
    try { const c = clientOf(this.s); this.defs.set((await c.list()).definitions); this.runs.set((await c.runs()).runs.slice(0, 15)); }
    catch (e) { this.note.set((e as Error).message); }
    try { const sh = await clientOf(this.s).demoSheet(); this.sheet.set(sh); this.sheetSaved = JSON.stringify(sh.rows.map((r) => r.values)); }
    catch { this.sheet.set(null); } // the workflow-connectors plugin is disabled: no demo sheet section
  }
  protected async sheetSave() {
    const sh = this.sheet(); if (!sh) return;
    this.busy.set(true);
    try {
      const before1 = JSON.parse(this.sheetSaved) as Record<string, string>[];
      let n = 0;
      for (let i = 0; i < sh.rows.length; i++)
        for (const col of sh.columns)
          if ((before1[i]?.[col] ?? '') !== (sh.rows[i].values[col] ?? '')) { await clientOf(this.s).demoSheetUpdate(sh.rows[i].rowNumber, col, sh.rows[i].values[col] ?? ''); n++; }
      this.sheetSaved = JSON.stringify(sh.rows.map((r) => r.values));
      this.sheetNote.set(n ? `${n} cell(s) saved. A row with process = OK is picked up by the watcher within a minute.` : 'No change.');
    } catch (e) { this.sheetNote.set((e as Error).message); } finally { this.busy.set(false); }
  }
  protected async sheetAdd() {
    this.busy.set(true);
    try { await clientOf(this.s).demoSheetAdd({ nom: 'Nouveau', prenom: 'Candidat', departement: 'engineering', role: 'employee', process: 'En cours', cree: '' }); await this.load(); }
    catch (e) { this.sheetNote.set((e as Error).message); } finally { this.busy.set(false); }
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

export const SAMPLE_WORKFLOWS: { name: string; description: string; trigger?: WfTrigger; nodes: WfNode[]; edges: WfEdge[] }[] = [
    { name: 'Sample: joiner on user.created', trigger: { event: 'user.created' }, description: 'Starts BY ITSELF when a user is created: baseline role for the newcomer, manager informed (simulated)', nodes: [
      { id: 'grant', type: 'assign-role', name: 'Grant employee to the newcomer', config: { identity: '{{event.subject}}', role: 'employee' } },
      { id: 'tell', type: 'notify', name: 'Inform the manager (simulated)', config: { recipient: 'hr', message: '{{event.displayName}} joined {{event.department}}' } },
    ], edges: [{ from: 'grant', to: 'tell' }] },
    { name: 'Sample: mover into finance', trigger: { event: 'user.department-changed', match: { to: 'finance' } }, description: 'Starts when someone moves INTO finance (match: to = finance): payment access granted, reviewed by a human', nodes: [
      { id: 'grant', type: 'assign-role', name: 'Grant payment-creator', config: { identity: '{{event.subject}}', role: 'payment-creator' } },
      { id: 'tell', type: 'notify', name: 'Inform the finance admin (simulated)', config: { recipient: 'finance-admin', message: '{{event.subject}} moved to finance' } },
    ], edges: [{ from: 'grant', to: 'tell' }] },
    { name: 'Sample: leaver on user.disabled', trigger: { event: 'user.disabled' }, description: 'Starts when an account is disabled: access removed for real, on the run branch', nodes: [
      { id: 'revoke', type: 'revoke-role', name: 'Revoke employee', config: { identity: '{{event.subject}}', role: 'employee' } },
      { id: 'move', type: 'set-department', name: 'Move the account to alumni', config: { identity: '{{event.subject}}', department: 'alumni' } },
    ], edges: [{ from: 'revoke', to: 'move' }] },

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
    { name: 'Sample: HR onboarding (demo sheet)', trigger: { event: 'google-sheets.row-ready', config: { source: 'demo-sheet', watchColumn: 'process', watchValue: 'OK', doneColumn: 'cree', doneValue: 'ok' } }, description: 'The watcher polls the SIMULATED candidates sheet: a row with process = OK builds nom.prenom@lyam.demo, creates the user (run branch), grants the row role, marks cree=ok', nodes: [
      { id: 'join', type: 'text-transform', name: 'Join nom.prenom', config: { operation: 'concat', values: '{{event.nom}}\n.\n{{event.prenom}}', separator: '' } },
      { id: 'clean', type: 'text-transform', name: 'Strip accents', config: { operation: 'unaccent', text: '{{steps.join.value}}' } },
      { id: 'lower', type: 'text-transform', name: 'Lowercase the login', config: { operation: 'lower', text: '{{steps.clean.value}}' } },
      { id: 'email', type: 'text-transform', name: 'Build the e-mail', config: { operation: 'concat', values: '{{steps.lower.value}}\n@lyam.demo', separator: '' } },
      { id: 'create', type: 'lyam-create-user', name: 'Create the user (lyam connector)', config: { identity: '{{steps.lower.value}}', displayName: '{{event.prenom}} {{event.nom}}', email: '{{steps.email.value}}', department: '{{event.departement}}' } },
      { id: 'role', type: 'assign-role', name: 'Grant the row role', config: { identity: '{{steps.lower.value}}', role: '{{event.role}}' } },
      { id: 'mark', type: 'google-sheets-update', name: 'Mark cree=ok', config: { source: 'demo-sheet', rowNumber: '{{event.rownumber}}', column: 'cree', value: 'ok' } },
      { id: 'tell', type: 'notify', name: 'Inform HR (simulated)', config: { recipient: 'hr', message: '{{event.prenom}} {{event.nom}} onboarded: user {{steps.lower.value}} created with role {{event.role}}, pending branch review' } },
    ], edges: [{ from: 'join', to: 'clean' }, { from: 'clean', to: 'lower' }, { from: 'lower', to: 'email' }, { from: 'email', to: 'create' }, { from: 'create', to: 'role' }, { from: 'role', to: 'mark' }, { from: 'mark', to: 'tell' }] },
    { name: 'Sample: SoD blocked', description: 'A grant that breaks segregation of duties: run completes, merge is refused at review', nodes: [
      { id: 'grant', type: 'assign-role', name: 'Give payment-approver to demo-bob', config: { identity: 'demo-bob', role: 'payment-approver' } },
      { id: 'oops', type: 'fail', name: 'External ticket fails (simulated)', config: { message: 'ticket system unreachable (demo)' } },
    ], edges: [{ from: 'grant', to: 'oops' }] },
  ];

interface NodeState { type: StepType; name: string; config: Record<string, unknown> }

@Component({ selector: 'app-workflow-edit', imports: [FormsModule, RouterLink, Vflow], styleUrl: './pages.css', template: `
<p class="lead">{{id === 'new' ? 'New workflow' : 'Edit workflow'}} — add steps, drag them, connect them in order. The graph must be acyclic; steps run in topological order.</p>
@if (note()) { <p role="status" class="msg">{{note()}}</p> }
<section class="card"><div class="row wf-head">
<label>Name<input name="wfName" [(ngModel)]="name" maxlength="80" /></label>
<label>Description<input name="wfDesc" [(ngModel)]="description" maxlength="500" /></label>
<label>Start trigger<select name="wfTrigger" [(ngModel)]="triggerEvent" (ngModelChange)="match.set({}); triggerCfg.set({})">
<option value="">Manual start only</option>
@for (ev of events(); track ev.type) {<option [value]="ev.type">{{ev.label}}</option>}
</select></label>
@if (triggerEvent) {<span class="hint">Starts by itself on this event. Step fields may use placeholders: {{placeholderHint()}}</span>
@for (k of payloadKeys(); track k) {@if (k !== '*') {<label>only if {{k}} =<input [attr.name]="'match-'+k" [ngModel]="match()[k] ?? ''" (ngModelChange)="setMatch(k, $event)" maxlength="40" placeholder="(any value)" /></label>}}
@for (f of triggerFields(); track f.key) {
@switch (f.type) {
@case ('boolean') {<label><input type="checkbox" [attr.name]="'tc-'+f.key" [ngModel]="triggerCfg()[f.key] ?? f.default ?? false" (ngModelChange)="setTriggerCfg(f.key, $event)" /> {{f.label}}</label>}
@case ('number') {<label>{{f.label}}<input type="number" [attr.name]="'tc-'+f.key" [ngModel]="triggerCfg()[f.key] ?? f.default" (ngModelChange)="setTriggerCfg(f.key, +$event)" /></label>}
@case ('select') {<label>{{f.label}}<select [attr.name]="'tc-'+f.key" [ngModel]="triggerCfg()[f.key] ?? f.default ?? ''" (ngModelChange)="setTriggerCfg(f.key, $event)">@for (o of f.options ?? []; track o) {<option [value]="o">{{o}}</option>}</select>@if (f.help) {<span class="hint">{{f.help}}</span>}</label>}
@default {<label>{{f.label}} @if (f.required) {<b class="req">*</b>}<input [attr.name]="'tc-'+f.key" [ngModel]="triggerCfg()[f.key] ?? f.default ?? ''" (ngModelChange)="setTriggerCfg(f.key, $event)" maxlength="200" />@if (f.help) {<span class="hint">{{f.help}}</span>}</label>}
}
}
}
<button (click)="save()" [disabled]="busy()">Save</button>
<a class="btn secondary" routerLink="/workflows">Back</a>
@for (sm of samples; track sm.name) {<button class="secondary" (click)="loadSample(sm)">{{sm.name}}</button>}
</div></section>
<div class="wf-grid">
<section class="card"><h3>Steps</h3>
<p class="hint">Click to add a step. Connect handles in the canvas. Select a step to edit it.</p>
@for (g of palette(); track g.family) {<div class="wf-family">{{g.family}}</div>
@for (t of g.blocks; track t.type) {<button class="secondary wf-pal" (click)="addNode(t.type)">+ {{t.label}} <small>{{t.simulated ? 'SIMULATED' : 'REAL'}}</small>@if (t.provider && !t.providerActive) { <small class="req">(plugin disabled)</small>}<br /><small>{{t.description}}</small></button>}}
</section>
<section class="card wf-canvas">
<vflow [nodes]="vfNodes()" [edges]="vfEdges()" [view]="'auto'" [minZoom]="0.4" [maxZoom]="1.6" [background]="'var(--bg)'" (connect)="onConnect($event)" (componentNodeEvent)="noop($event)" />
</section>
<section class="card"><h3>Selected</h3>
@if (selectedNode(); as nid) {@if (state.get(nid); as st) {
<label>Step name<input name="stepName" [ngModel]="st.name" (ngModelChange)="rename(nid, $event)" maxlength="80" /></label>
<p class="hint">{{typeOf(st.type).label}} — {{typeOf(st.type).simulated ? 'SIMULATED: demonstrates the flow, no external effect' : 'REAL: writes on the run branch only'}}</p>
@if (blockOf(st.type)?.description) {<p class="hint">{{blockOf(st.type)!.description}}</p>}
@if ((blockOf(st.type)?.fields?.length ?? 0) > 0) {
@for (f of blockOf(st.type)!.fields!; track f.key) {
@switch (f.type) {
@case ('text') {<label>{{f.label}} @if (f.required) {<b class="req">*</b>}<textarea rows="3" [attr.name]="'g-'+f.key" [ngModel]="st.config[f.key] ?? f.default ?? ''" (ngModelChange)="setCfg(nid, f.key, $event)"></textarea>@if (f.help) {<span class="hint">{{f.help}}</span>}</label>}
@case ('boolean') {<label><input type="checkbox" [attr.name]="'g-'+f.key" [ngModel]="st.config[f.key] ?? f.default ?? false" (ngModelChange)="setCfg(nid, f.key, $event)" /> {{f.label}}</label>}
@case ('number') {<label>{{f.label}}<input type="number" [attr.name]="'g-'+f.key" [ngModel]="st.config[f.key] ?? f.default" (ngModelChange)="setCfg(nid, f.key, +$event)" />@if (f.help) {<span class="hint">{{f.help}}</span>}</label>}
@case ('select') {<label>{{f.label}}<select [attr.name]="'g-'+f.key" [ngModel]="st.config[f.key] ?? f.default ?? ''" (ngModelChange)="setCfg(nid, f.key, $event)">@for (o of f.options ?? []; track o) {<option [value]="o">{{o}}</option>}</select>@if (f.help) {<span class="hint">{{f.help}}</span>}</label>}
@default {<label>{{f.label}} @if (f.required) {<b class="req">*</b>}<input [attr.name]="'g-'+f.key" [ngModel]="st.config[f.key] ?? f.default ?? ''" (ngModelChange)="setCfg(nid, f.key, $event)" maxlength="500" />@if (f.help) {<span class="hint">{{f.help}}</span>}</label>}
}
}
<p class="hint">Placeholders you can use here:</p>
<div>@for (ph of placeholdersFor(nid); track ph) {<code class="ph-chip">{{ph}}</code>}@if (!placeholdersFor(nid).length) {<span class="hint">none yet: add a start trigger, or link an upstream step that has outputs</span>}</div>
} @else {
@switch (st.type) {
@case ('wait') {<label>Seconds (0-60)<input name="waitSecs" type="number" min="0" max="60" [ngModel]="st.config['seconds']" (ngModelChange)="setCfg(nid,'seconds',$event)" /></label>}
@case ('notify') {<label>Recipient (label only)<input name="notifTo" [ngModel]="st.config['recipient']" (ngModelChange)="setCfg(nid,'recipient',$event)" maxlength="80" /></label><label>Message<input name="notifMsg" [ngModel]="st.config['message']" (ngModelChange)="setCfg(nid,'message',$event)" maxlength="200" /></label>}
@case ('fail') {<label>Error message<input name="failMsg" [ngModel]="st.config['message']" (ngModelChange)="setCfg(nid,'message',$event)" maxlength="200" /></label>}
@case ('assign-role') {<label>Identity<input name="arId" [ngModel]="st.config['identity']" (ngModelChange)="setCfg(nid,'identity',$event)" maxlength="32" /></label><label>Role<input name="arRole" [ngModel]="st.config['role']" (ngModelChange)="setCfg(nid,'role',$event)" maxlength="32" /></label>}
@case ('revoke-role') {<label>Identity<input name="rrId" [ngModel]="st.config['identity']" (ngModelChange)="setCfg(nid,'identity',$event)" maxlength="32" /></label><label>Role<input name="rrRole" [ngModel]="st.config['role']" (ngModelChange)="setCfg(nid,'role',$event)" maxlength="32" /></label>}
@case ('set-department') {<label>Identity<input name="sdId" [ngModel]="st.config['identity']" (ngModelChange)="setCfg(nid,'identity',$event)" maxlength="32" /></label><label>Department<input name="sdDept" [ngModel]="st.config['department']" (ngModelChange)="setCfg(nid,'department',$event)" maxlength="40" /></label>}
@case ('set-profile-field') {<label>Identity<input name="spfId" [ngModel]="st.config['identity']" (ngModelChange)="setCfg(nid,'identity',$event)" maxlength="32" /></label><label>Profile field<input name="spfField" [ngModel]="st.config['field']" (ngModelChange)="setCfg(nid,'field',$event)" maxlength="80" placeholder="hr-attributes.employee_grade" /></label><label>Value<input name="spfValue" [ngModel]="st.config['value']" (ngModelChange)="setCfg(nid,'value',$event)" maxlength="200" /></label>}
}
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
  protected readonly samples = SAMPLE_WORKFLOWS;
  protected events = signal<WfEvent[]>([]);
  protected blocks = signal<WfBlock[]>([]);
  protected triggerEvent = '';
  protected match = signal<Record<string, string>>({});
  protected triggerCfg = signal<Record<string, unknown>>({});
  protected payloadKeys() { return this.events().find((e) => e.type === this.triggerEvent)?.payload ?? []; }
  protected placeholderHint() { return this.payloadKeys().includes('*') ? '{{event.<any key of the row/call>}}' : this.payloadKeys().map((k) => `{{event.${k}}}`).join('  '); }
  protected triggerFields(): WfBlockField[] { return this.events().find((e) => e.type === this.triggerEvent)?.configFields ?? []; }
  protected setTriggerCfg(k: string, v: unknown) { this.triggerCfg.update((c) => ({ ...c, [k]: v })); }
  protected setMatch(k: string, v: string) { this.match.update((m) => { const n = { ...m }; if (v) n[k] = v; else delete n[k]; return n; }); }
  private triggerPayload(): WfTrigger | null {
    if (!this.triggerEvent) return null;
    const cfg = Object.fromEntries(Object.entries(this.triggerCfg()).filter(([, v]) => v !== '' && v !== undefined));
    return { event: this.triggerEvent, ...(Object.keys(this.match()).length ? { match: this.match() } : {}), ...(Object.keys(cfg).length ? { config: cfg } : {}) };
  }
  /** The editor palette: the API block catalogue grouped by family (Core first), built-ins last-resort fallback. */
  protected palette(): { family: string; blocks: WfBlock[] }[] {
    const src: WfBlock[] = this.blocks().length ? this.blocks() : STEP_TYPES.map((t) => ({ type: t.type, family: 'Core', label: t.label, simulated: t.simulated, description: t.hint, provider: null, providerActive: true }));
    const byFamily = new Map<string, WfBlock[]>();
    for (const b of src) { const g = byFamily.get(b.family) ?? []; g.push(b); byFamily.set(b.family, g); }
    return [...byFamily.entries()].sort((a, b) => (a[0] === 'Core' ? -1 : b[0] === 'Core' ? 1 : a[0].localeCompare(b[0]))).map(([family, blocks]) => ({ family, blocks }));
  }
  protected blockOf(t: string): WfBlock | undefined { return this.blocks().find((b) => b.type === t); }
  /** Upstream steps of a node (transitive over the drawn links): their outputs are usable as placeholders. */
  protected ancestorsOf(id: string): string[] {
    const rev = new Map<string, string[]>();
    for (const e of this.vfEdges()) { const g = rev.get(e.target) ?? []; g.push(e.source); rev.set(e.target, g); }
    const out: string[] = []; const seen = new Set([id]); const queue = [id];
    while (queue.length) { const c = queue.shift()!; for (const p of rev.get(c) ?? []) if (!seen.has(p)) { seen.add(p); out.push(p); queue.push(p); } }
    return out;
  }
  protected placeholdersFor(nid: string): string[] {
    const ev = this.events().find((e) => e.type === this.triggerEvent);
    const out: string[] = (ev?.payload ?? []).filter((k) => k !== '*').map((k) => `{{event.${k}}}`);
    if (ev?.payload?.includes('*')) out.push('{{event.<any key of the row/call>}}');
    for (const aid of this.ancestorsOf(nid)) {
      const st = this.state.get(aid); if (!st) continue;
      for (const o of this.blockOf(st.type)?.outputs ?? []) out.push(`{{steps.${aid}.${o.key}}}`);
    }
    return out;
  }
  protected vfNodes = signal<Node[]>([]);
  protected vfEdges = signal<Edge[]>([]);
  private readonly vflow = viewChild(VflowComponent);
  private readonly host = inject(ElementRef<HTMLElement>);

  private fitCanvas() {
    // Deterministic initial framing (no blind fixed timeouts): wait until the canvas is initialized and
    // every node is really measured in the DOM, fit the whole graph, then verify the visible result.
    this.frameWhenReady(1, 0);
  }

  private nodeRects(): DOMRect[] {
    return [...this.host.nativeElement.querySelectorAll('.wf-node')].map((el) => el.getBoundingClientRect());
  }

  private frameWhenReady(attempt: number, waitedFrames: number) {
    const v = this.vflow();
    const canvas = this.host.nativeElement.querySelector('vflow');
    if (!v || !canvas) return; // the page was left before the framing finished
    const rects = this.nodeRects();
    const ready = v.initialized() && canvas.clientWidth > 0 && rects.length === this.vfNodes().length && rects.every((r) => r.width > 0 && r.height > 0);
    if (!ready) {
      if (waitedFrames < 600) requestAnimationFrame(() => requestAnimationFrame(() => this.frameWhenReady(attempt, waitedFrames + 1)));
      else v.fitView({ padding: 0.14, duration: 120 }); // last-resort best effort, same as the old behavior
      return;
    }
    v.fitView({ padding: 0.14, duration: 120 });
    this.verifyFraming(attempt, performance.now());
  }

  private verifyFraming(attempt: number, fitAt: number) {
    const v = this.vflow();
    const canvas = this.host.nativeElement.querySelector('vflow');
    if (!v || !canvas) return;
    if (performance.now() - fitAt < 200) { requestAnimationFrame(() => this.verifyFraming(attempt, fitAt)); return; } // let the fit animation finish and the DOM catch up
    if (!rectsWithin(this.nodeRects(), canvas.getBoundingClientRect())) {
      // The fit ran on stale sizes: retry from the readiness gate, bounded, until the framing is right.
      if (attempt < 12) requestAnimationFrame(() => requestAnimationFrame(() => this.frameWhenReady(attempt + 1, 0)));
      return;
    }
    // Fit everything first so the shape of the graph is visible; if the fit had to shrink the nodes
    // below comfortable reading size, zoom back toward 1:1 anchored on the leftmost node (the user pans).
    const anchor = v.viewport().zoom < 0.9 ? anchorViewport(this.vfNodes()) : null;
    if (anchor) v.viewportTo(anchor);
  }
  protected state = new Map<string, NodeState>();
  /** Selection is tracked by the library on each entity's own `selected` signal. */
  protected selectedNode = computed(() => this.vfNodes().find((n) => n.selected?.())?.id ?? null);
  protected selectedEdge = computed(() => (this.selectedNode() ? null : this.vfEdges().find((e) => e.selected?.())?.id ?? null));
  private seq = 0;

  ngOnInit() {
    this.id = this.route.snapshot.paramMap.get('id') ?? 'new';
    void clientOf(this.s).events().then((r) => this.events.set(r.events)).catch(() => this.events.set([]));
    void clientOf(this.s).blocks().then((r) => this.blocks.set(r.blocks)).catch(() => this.blocks.set([]));
    if (this.id !== 'new') void this.load();
  }
  protected typeOf(t: StepType): { type: string; label: string; simulated: boolean; hint: string } {
    const b = this.blockOf(t);
    if (b) return { type: b.type, label: b.label, simulated: b.simulated, hint: b.description };
    return STEP_TYPES.find((x) => x.type === t) ?? { type: t, label: t, simulated: true, hint: '' };
  }

  private makeNode(id: string, st: NodeState, i: number): Node {
    return {
      id, type: WfNodeComponent,
      data: signal<WfNodeData>({ name: st.name, simulated: this.typeOf(st.type).simulated }),
      point: signal({ x: 40 + (i % 3) * 260, y: 40 + Math.floor(i / 3) * 130 }),
      selected: signal(false),
    } as Node;
  }
  private makeEdge(id: string, source: string, target: string): Edge {
    return {
      id, source, target, selected: signal(false),
      markers: signal({ end: { type: 'arrow-closed', width: 16, height: 16, color: 'var(--muted)' } }),
    } as Edge;
  }

  protected addNode(type: StepType) {
    const id = `step-${++this.seq}`;
    const defaults: Record<string, Record<string, unknown>> = {
      wait: { seconds: 2 }, notify: { recipient: '', message: '' }, fail: { message: 'step configured to fail' },
      'assign-role': { identity: 'demo-bob', role: 'accountant' }, 'revoke-role': { identity: 'demo-bob', role: 'payment-creator' }, 'set-department': { identity: 'demo-bob', department: '' }, 'set-profile-field': { identity: 'demo-bob', field: 'hr-attributes.employee_grade', value: '' },
    };
    const blk = this.blockOf(type);
    const fieldDefaults = Object.fromEntries((blk?.fields ?? []).filter((f) => f.default !== undefined).map((f) => [f.key, f.default as unknown]));
    const st: NodeState = { type, name: this.typeOf(type).label, config: { ...fieldDefaults, ...defaults[type] } };
    this.state.set(id, st);
    for (const n of this.vfNodes()) n.selected?.set(false);
    const node = this.makeNode(id, st, this.vfNodes().length);
    node.selected?.set(true);
    this.vfNodes.update((ns) => [...ns, node]);
  }
  protected rename(id: string, v: string) {
    const st = this.state.get(id)!; st.name = v;
    const n = this.vfNodes().find((x) => x.id === id);
    if (n?.type === WfNodeComponent) n.data?.set({ name: v, simulated: this.typeOf(st.type).simulated });
  }
  protected setCfg(id: string, k: string, v: unknown) { this.state.get(id)!.config[k] = k === 'seconds' ? Number(v) : v; }
  protected noop(_e: unknown) {}
  protected onConnect(c: Connection) {
    if (!c.source || !c.target) return;
    const id = `${c.source}->${c.target}`;
    if (this.vfEdges().some((e) => e.id === id)) return;
    this.vfEdges.update((es) => [...es, this.makeEdge(id, c.source!, c.target!)]);
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
    this.triggerEvent = sm.trigger?.event ?? ''; this.match.set({ ...(sm.trigger?.match ?? {}) }); this.triggerCfg.set({ ...(sm.trigger?.config ?? {}) });
    this.state.clear();
    const nodes: Node[] = [];
    sm.nodes.forEach((n, i) => { const st = { type: n.type, name: n.name, config: { ...n.config } }; this.state.set(n.id, st); nodes.push(this.makeNode(n.id, st, i)); });
    this.vfNodes.set(nodes);
    this.vfEdges.set(sm.edges.map((e) => this.makeEdge(`${e.from}->${e.to}`, e.from, e.to)));
    this.fitCanvas();
  }

  private async load() {
    try {
      const { definition } = await clientOf(this.s).get(this.id);
      this.name = definition.name; this.description = definition.description;
      this.triggerEvent = definition.trigger?.event ?? ''; this.match.set({ ...(definition.trigger?.match ?? {}) }); this.triggerCfg.set({ ...(definition.trigger?.config ?? {}) });
      this.state.clear();
      const nodes: Node[] = [];
      definition.graph.nodes.forEach((n, i) => { const st = { type: n.type, name: n.name, config: { ...n.config } }; this.state.set(n.id, st); nodes.push(this.makeNode(n.id, st, i)); this.seq = Math.max(this.seq, Number(n.id.replace(/\D/g, '')) || 0); });
      this.vfNodes.set(nodes);
      this.vfEdges.set(definition.graph.edges.map((e) => this.makeEdge(`${e.from}->${e.to}`, e.from, e.to)));
      this.fitCanvas();
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
      const trigger = this.triggerPayload();
      if (this.id === 'new') { const r = await c.create(this.name, this.description, graph, trigger); this.note.set('Workflow saved.'); void this.router.navigateByUrl(`/workflows/edit/${r.definition.id}`); }
      else { await c.update(this.id, this.name, this.description, graph, trigger); this.note.set('Workflow saved.'); }
    } catch (e) { this.note.set((e as Error).message); } finally { this.busy.set(false); }
  }
}

@Component({ selector: 'app-workflow-run', imports: [RouterLink], styleUrl: './pages.css', template: `
<p class="lead">Run {{view()?.run?.id}} — {{view()?.run?.name}}</p>
@if (note()) { <p role="status" class="msg">{{note()}}</p> }
@if (view(); as v) {<section class="card"><div class="row">
<span class="chip" [attr.data-status]="v.run.status">{{v.run.status}}</span>
@if (v.run.simulatedOnly) {<span class="chip" data-status="simulated">fully simulated</span>} @else {<span class="chip" data-status="real">writes on branch {{v.run.branch || '(created at first real step)'}}</span>}
<small>started by {{v.run.started_by}}</small><span class="spacer"></span>
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
