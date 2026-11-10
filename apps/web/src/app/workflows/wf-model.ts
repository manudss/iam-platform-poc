import { Component, inject, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { CustomNodeComponent, HandleComponent, Node, SelectableDirective, ViewportState } from 'ngx-vflow';
import { Session } from '../session';
import { ApiClient } from '../api';

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
export interface WfEdge { from: string; to: string; label?: string }
export interface WfTrigger { event: string; match?: Record<string, string>; config?: Record<string, unknown> }
export interface WfBlockField { key: string; label: string; type: 'string' | 'text' | 'number' | 'boolean' | 'select'; required?: boolean; default?: unknown; options?: string[]; help?: string }
export interface WfEvent { type: string; label: string; payload: string[]; configFields?: WfBlockField[] }
export type StepCategory = 'simulated' | 'computed' | 'real';
/** Badge text of a step category: SIMULATED (nothing really happens) | COMPUTED (really runs, no external effect) | REAL. */
export const categoryLabel = (c: StepCategory): string => (c === 'computed' ? 'COMPUTED' : c === 'real' ? 'REAL' : 'SIMULATED');
export const categoryOf = (x: { simulated: boolean; category?: StepCategory }): StepCategory => x.category ?? (x.simulated ? 'simulated' : 'real');
export interface WfBlock { type: string; family: string; label: string; simulated: boolean; category?: StepCategory; description: string; fields?: WfBlockField[]; outputs?: { key: string; description: string }[]; provider: string | null; providerActive: boolean }
export interface DemoSheet { name: string; simulated: boolean; note: string; columns: string[]; rows: { rowNumber: number; values: Record<string, string> }[] }
export interface DefinitionSummary { id: string; name: string; description: string; trigger: WfTrigger | null; steps: number; simulatedSteps: number; computedSteps: number; dataSteps: number; createdBy: string; updatedAt: string }
export interface RunSummary { id: string; definitionId: string; name: string; branch: string | null; status: string; error: string | null; startedBy: string; startedAt: string; finishedAt: string | null; hasDataSteps: boolean; test?: boolean }
export interface RunStepView { node_id: string; name: string; type: string; label: string; status: string; simulated: boolean; category?: StepCategory; attempts: number; error: string | null; log: string[]; started_at: string | null; finished_at: string | null; input?: Record<string, unknown> | null; output?: Record<string, unknown> | null }
export interface RunView { run: { id: string; name: string; branch: string | null; status: string; error: string | null; simulatedOnly: boolean; started_by: string; started_at: string; finished_at: string | null; order: string[]; edges: WfEdge[]; test?: boolean }; steps: RunStepView[] }

export const STEP_TYPES: { type: StepType; label: string; simulated: boolean; category: StepCategory; hint: string }[] = [
  { type: 'wait', label: 'Wait', simulated: true, category: 'simulated', hint: 'Simulated delay (seconds)' },
  { type: 'notify', label: 'Notify', simulated: true, category: 'simulated', hint: 'Simulated: logged, never sent' },
  { type: 'fail', label: 'Fail on purpose', simulated: true, category: 'simulated', hint: 'Simulated error: fails once, recovers on retry' },
  { type: 'assign-role', label: 'Assign role', simulated: false, category: 'real', hint: 'Real, on the run branch' },
  { type: 'revoke-role', label: 'Revoke role', simulated: false, category: 'real', hint: 'Real, on the run branch' },
  { type: 'set-department', label: 'Set department', simulated: false, category: 'real', hint: 'Real, on the run branch' },
  { type: 'set-profile-field', label: 'Set profile field', simulated: false, category: 'real', hint: 'Real, on the run branch' },
];


// ---- Visual node for the workflow canvas: readable name, wrapped text, SIMULATED/COMPUTED/REAL badge, side handles.
// `runStatus` (editor test run / executions replay) tints the frame with the step outcome. ----
export interface WfNodeData { name: string; category: StepCategory; runStatus?: string | null }

@Component({
  selector: 'app-wf-node',
  imports: [HandleComponent, SelectableDirective],
  template: `
    <div selectable class="wf-node" [class.real]="data()?.category === 'real'" [class.computed]="data()?.category === 'computed'" [class.selected]="selected()" [attr.data-run]="data()?.runStatus ?? null">
      <span class="wf-node-name">{{ data()?.name }}</span>
      <span class="wf-node-badge" [class.real]="data()?.category === 'real'" [class.computed]="data()?.category === 'computed'">{{ badgeLabel() }}</span>
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
    .wf-node.computed { border-left-color: var(--warn-line); }
    .wf-node.selected { border-color: var(--accent); box-shadow: 0 0 0 3px var(--shadow-color); }
    .wf-node[data-run="done"] { border-color: var(--ok); }
    .wf-node[data-run="failed"] { border-color: var(--err, var(--warn-line)); }
    .wf-node[data-run="running"] { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .wf-node[data-run="skipped"] { opacity: .55; }
    .wf-node-name {
      font-size: 14px; font-weight: 600; line-height: 1.35; color: var(--ink);
      overflow-wrap: anywhere; white-space: normal;
    }
    .wf-node-badge {
      align-self: flex-start; font-size: 11px; font-weight: 700; letter-spacing: .04em;
      padding: 2px 7px; border-radius: 999px; background: var(--accent-soft); color: var(--accent);
    }
    .wf-node-badge.real { background: var(--ok-soft); color: var(--ok); }
    .wf-node-badge.computed { background: var(--warn-soft); color: var(--warn-ink); }
    handle { position: absolute; top: 50%; width: 12px; height: 12px; border-radius: 50%;
      background: var(--card); border: 2px solid var(--accent); transform: translateY(-50%); }
    handle[position="left"] { left: -6px; }
    handle[position="right"] { right: -6px; }
  `],
})
export class WfNodeComponent extends CustomNodeComponent<WfNodeData> {
  protected badgeLabel() { return categoryLabel(this.data()?.category ?? 'simulated'); }
}

// ---- Visual trigger node: shown as the first node when the workflow starts on an event. Distinct dashed
// amber look, no target handle (nothing points into it), not selectable or editable on the canvas: the
// trigger itself is edited with the Start trigger field above the canvas.
export const TRIGGER_NODE_ID = '__trigger';
export interface WfTriggerNodeData { name: string }

@Component({
  selector: 'app-wf-trigger-node',
  imports: [HandleComponent],
  template: `
    <div class="wf-node wf-trigger">
      <span class="wf-node-badge trigger">TRIGGER</span>
      <span class="wf-node-name">{{ data()?.name }}</span>
      <span class="wf-trigger-hint">starts the first steps</span>
    </div>
    <handle type="source" position="right" />
  `,
  styles: [`
    :host { display: block; position: relative; }
    .wf-node {
      box-sizing: border-box; width: 190px; min-height: 64px; padding: 10px 12px;
      background: var(--warn-soft); border: 1.5px dashed var(--warn-line); border-left: 5px solid var(--warn-line); border-radius: 10px;
      box-shadow: 0 1px 3px var(--shadow-color);
      display: flex; flex-direction: column; gap: 6px;
    }
    .wf-node-name {
      font-size: 14px; font-weight: 600; line-height: 1.35; color: var(--warn-ink);
      overflow-wrap: anywhere; white-space: normal;
    }
    .wf-node-badge.trigger {
      align-self: flex-start; font-size: 11px; font-weight: 700; letter-spacing: .04em;
      padding: 2px 7px; border-radius: 999px; background: var(--warn-soft); color: var(--warn-ink); border: 1px solid var(--warn-line);
    }
    .wf-trigger-hint { font-size: 11px; color: var(--muted); }
    handle { position: absolute; top: 50%; width: 12px; height: 12px; border-radius: 50%;
      background: var(--card); border: 2px solid var(--warn-line); transform: translateY(-50%); }
    handle[position="right"] { right: -6px; }
  `],
})
export class WfTriggerNodeComponent extends CustomNodeComponent<WfTriggerNodeData> {}

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
  duplicate(id: string) { return this.req<{ definition: { id: string; name: string } }>('POST', `/workflows/${id}/duplicate`, {}); }
  start(id: string) { return this.req<RunView>('POST', `/workflows/${id}/runs`, {}); }
  testRun(graph: { nodes: WfNode[]; edges: WfEdge[] }, trigger: WfTrigger | null, payload: Record<string, unknown>) { return this.req<RunView>('POST', '/workflows/test-run', { graph, ...(trigger ? { trigger } : {}), payload }); }
  runs(filter: { definition?: string; status?: string; tests?: boolean } = {}) {
    const q = [filter.definition ? `definition=${filter.definition}` : '', filter.status ? `status=${filter.status}` : '', filter.tests ? 'tests=1' : ''].filter(Boolean).join('&');
    return this.req<{ runs: RunSummary[] }>('GET', `/workflow-runs${q ? `?${q}` : ''}`);
  }
  run(id: string) { return this.req<RunView>('GET', `/workflow-runs/${id}`); }
  retry(id: string) { return this.req<RunView>('POST', `/workflow-runs/${id}/retry`, {}); }
  rerunFrom(id: string, nodeId: string) { return this.req<RunView>('POST', `/workflow-runs/${id}/rerun-from/${nodeId}`, {}); }
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

export const clientOf = (s: Session) => new WorkflowClient(s.api, () => s.adminToken());

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
    { name: 'Sample: branch by department', trigger: { event: 'user.department-changed' }, description: 'If/Switch branching: finance movers take the payment path, others the standard one; both merge before the notification', nodes: [
      { id: 'cond', type: 'if', name: 'Moving to finance?', config: { left: '{{event.to}}', op: 'equals', right: 'finance' } },
      { id: 'fin', type: 'assign-role', name: 'Grant payment-creator', config: { identity: '{{event.subject}}', role: 'payment-creator' } },
      { id: 'std', type: 'notify', name: 'Standard move (simulated)', config: { recipient: 'hr', message: '{{event.subject}} moved to {{event.to}}' } },
      { id: 'join', type: 'merge', name: 'Continue in all cases', config: {} },
      { id: 'tell', type: 'notify', name: 'Confirm to HR (simulated)', config: { recipient: 'hr', message: 'Department change handled' } },
    ], edges: [{ from: 'cond', to: 'fin', label: 'true' }, { from: 'cond', to: 'std', label: 'false' }, { from: 'fin', to: 'join' }, { from: 'std', to: 'join' }, { from: 'join', to: 'tell' }] },
    { name: 'Sample: loop over rows', trigger: { event: 'google-sheets.row-ready' }, description: 'Loop: for each role of the row, grant it on the run branch; the loop output carries item/index/count', nodes: [
      { id: 'each', type: 'loop', name: 'For each requested role', config: { items: '{{event.roles}}', maxItems: 10 } },
      { id: 'grant', type: 'assign-role', name: 'Grant the role', config: { identity: '{{event.subject}}', role: '{{steps.each.item}}' } },
      { id: 'tell', type: 'notify', name: 'Summary to HR (simulated)', config: { recipient: 'hr', message: '{{steps.each.count}} role(s) processed' } },
    ], edges: [{ from: 'each', to: 'grant', label: 'each' }, { from: 'each', to: 'tell', label: 'done' }] },
  ];
