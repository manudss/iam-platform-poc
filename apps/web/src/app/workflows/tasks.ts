import { JsonPipe } from '@angular/common';
import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Session } from '../session';
import { WfTask, clientOf, decisionChoices, justificationRequired, taskSummary } from './wf-model';
import { WbTabsBar } from './workbench-tabs';

// ---- Task inbox: the durable human tasks of the workflows (approvals, reviews, publication watches).
// Anyone sees THEIR OWN tasks (assigned or delegated); admins can switch to the whole tenant. Deciding a task
// resumes the waiting run; a refusal always needs a justification; anti-self-approval is enforced server-side
// (the starter of the run chain and the beneficiaries cannot decide) and surfaces here as an error message. ----

@Component({ selector: 'app-workflow-tasks', imports: [FormsModule, RouterLink, JsonPipe, WbTabsBar], styleUrl: '../pages.css', styles: [`
.wt-row.on td { background: var(--accent-soft); }
.wt-row td { cursor: pointer; }
.wt-detail textarea { width: 100%; min-height: 3.2rem; }
.wt-actions { display: flex; gap: .5rem; flex-wrap: wrap; align-items: flex-end; }
.wt-actions label { display: flex; flex-direction: column; gap: .2rem; font-size: .8rem; color: var(--muted); }
.wt-kind { text-transform: none; }
`], template: `
<app-wb-tabs />
<p class="lead">Task inbox: the approvals and reviews your workflows are waiting for. Deciding a task resumes its run. You see your own tasks; an administrator can see the whole tenant.</p>
@if (note()) { <p role="status" class="msg">{{note()}}</p> }
<section class="card"><div class="row" style="flex-wrap:wrap">
<span class="wlc-chips" style="display:inline-flex;gap:.3rem">
  @for (f of scopes; track f.value) {<button class="secondary" [style.background]="scope() === f.value ? 'var(--accent-soft)' : null" [style.color]="scope() === f.value ? 'var(--accent)' : null" [style.border-color]="scope() === f.value ? 'var(--accent)' : null" (click)="scope.set(f.value); load()">{{f.label}}</button>}
</span>
<span class="wlc-chips" style="display:inline-flex;gap:.3rem">
  @for (f of statusFilters; track f.value) {<button class="secondary" [style.background]="statusFilter() === f.value ? 'var(--accent-soft)' : null" [style.color]="statusFilter() === f.value ? 'var(--accent)' : null" [style.border-color]="statusFilter() === f.value ? 'var(--accent)' : null" (click)="statusFilter.set(f.value); load()">{{f.label}}</button>}
</span>
<span class="spacer"></span>
<label title="Reload the list every 5 seconds"><input type="checkbox" name="wtAuto" [ngModel]="autoRefresh()" (ngModelChange)="setAutoRefresh($event)" /> Auto-refresh 5 s</label>
<button class="secondary" (click)="load()">Refresh</button>
</div>
@if (truncated()) {<p class="hint" role="status">Showing the 200 most recent tasks only: older ones stay in the audit trail. Narrow with the status filter to see what matters.</p>}
<div class="scroll"><table><thead><tr><th>Task</th><th>Kind</th><th>Assigned to</th><th>Status</th><th>Created</th><th>Due</th></tr></thead><tbody>
@for (t of tasks(); track t.id) {<tr class="wt-row" [class.on]="selected() === t.id" (click)="toggle(t)"><td><b>{{t.title}}</b>@if (summary(t)) {<br /><small class="hint">{{summary(t)}}</small>}</td><td><span class="chip wt-kind">{{t.kind}}</span></td><td>{{t.assignee}}@if (t.delegated_to) {<br /><small class="hint">delegated to {{t.delegated_to}}</small>}</td><td><span class="chip" [attr.data-status]="t.status">{{t.status}}</span>@if (t.decision) {<br /><small>{{t.decision}} by {{t.decided_by}}</small>}</td><td>{{t.created_at}}</td><td>{{t.due_at || '-'}}@if (overdue(t)) {<br /><small class="req">overdue</small>}</td></tr>}
@empty {<tr><td colspan="6">No task here. Approvals and reviews created by running workflows will appear.</td></tr>}
</tbody></table></div></section>

@if (current(); as t) {<section class="card wt-detail"><div class="row" style="flex-wrap:wrap">
<span class="chip" [attr.data-status]="t.status">{{t.status}}</span><b>{{t.title}}</b><span class="chip wt-kind">{{t.kind}}</span>@if (t.prevent_self) {<span class="chip" data-status="real" title="The starter of the run and its beneficiaries cannot decide this task">anti-self-approval</span>}<small>{{t.id}}</small><span class="spacer"></span>
@if (t.run_id) {<a class="btn secondary" [routerLink]="['/workflows/runs']" [queryParams]="{ run: t.run_id }">Open the run</a>}
<button class="secondary" (click)="selected.set(null)" title="Close the detail">✕</button>
</div>
@if (t.status === 'open') {
  <div class="wt-actions">
    <label style="flex:1;min-width:260px">Justification @if (t.detail?.['requireJustification'] === true) {<span class="req">(required for every decision on this task)</span>} @else {<span>(required to refuse)</span>}
      <textarea name="wtJust" [(ngModel)]="justification" placeholder="Why this decision…"></textarea>
    </label>
    @for (d of choices(t); track d) {<button [class.secondary]="d !== 'approved'" [disabled]="busy() || (needsJustification(t, d) && !justification.trim())" (click)="decide(t, d)">{{d}}</button>}
  </div>
  <div class="wt-actions" style="margin-top:.5rem">
    <label>Delegate to
      <input type="text" name="wtDelegate" [(ngModel)]="delegateTo" placeholder="subject id" />
    </label>
    <button class="secondary" [disabled]="busy() || !delegateTo.trim()" (click)="delegate(t)">Delegate</button>
    <small class="hint">Delegation names any user id; the server does not verify the person exists.</small>
  </div>
  @if (t.detail?.['rescan'] === true) {<p class="hint">This decision <b>declares</b> the external state you observed (for example the pull request was merged or closed): the workflow re-reads the real state on its next check. The decision itself merges or closes nothing.</p>}
} @else {
  <p class="hint">Decided as <b>{{t.decision}}</b> by {{t.decided_by}} on {{t.decided_at}}.@if (t.justification) { Justification: {{t.justification}} }</p>
}
<details><summary>Detail</summary><pre class="wf-log">{{t.detail | json}}</pre></details>
</section>}
` })
export class WorkflowTasksPage implements OnInit, OnDestroy {
  protected readonly s = inject(Session);
  protected tasks = signal<WfTask[]>([]);
  protected note = signal('');
  protected busy = signal(false);
  protected scope = signal<'mine' | 'all'>('mine');
  protected statusFilter = signal<'open' | 'all'>('open');
  protected truncated = signal(false);
  protected selected = signal<string | null>(null);
  protected current = signal<WfTask | null>(null);
  protected justification = '';
  protected delegateTo = '';
  protected autoRefresh = signal(false);
  private timer?: ReturnType<typeof setInterval>;
  protected readonly scopes = [
    { value: 'mine' as const, label: 'My tasks' },
    { value: 'all' as const, label: 'All (admin)' },
  ];
  protected readonly statusFilters = [
    { value: 'open' as const, label: 'Open' },
    { value: 'all' as const, label: 'All statuses' },
  ];

  ngOnInit() { void this.load(); }
  ngOnDestroy() { clearInterval(this.timer); }
  protected setAutoRefresh(on: boolean) {
    this.autoRefresh.set(on);
    clearInterval(this.timer);
    this.timer = on ? setInterval(() => void this.load(true), 5000) : undefined;
  }

  protected async load(quiet = false) {
    try {
      const r = await clientOf(this.s).tasks(this.scope(), this.statusFilter());
      this.tasks.set(r.tasks);
      this.truncated.set(r.truncated === true);
      const cur = this.current();
      if (cur) this.current.set(r.tasks.find((t) => t.id === cur.id) ?? null);
      if (!quiet) this.note.set('');
    } catch (e) { this.note.set((e as Error).message); }
  }

  protected toggle(t: WfTask) {
    this.justification = ''; this.delegateTo = '';
    this.selected.set(this.selected() === t.id ? null : t.id);
    this.current.set(this.selected() ? t : null);
  }
  protected choices = decisionChoices;
  protected summary = taskSummary;
  protected needsJustification = justificationRequired;
  protected overdue(t: WfTask) { return t.status === 'open' && !!t.due_at && Date.parse(t.due_at) <= Date.now(); }

  protected async decide(t: WfTask, decision: string) {
    this.busy.set(true); this.note.set('');
    try {
      await clientOf(this.s).decideTask(t.id, decision, this.justification.trim());
      this.note.set(`Task decided: ${decision}. The run resumes.`);
      this.selected.set(null); this.current.set(null);
      await this.load(true);
    } catch (e) { this.note.set((e as Error).message); }
    finally { this.busy.set(false); }
  }
  protected async delegate(t: WfTask) {
    this.busy.set(true); this.note.set('');
    try {
      await clientOf(this.s).delegateTask(t.id, this.delegateTo.trim());
      this.note.set(`Task delegated to ${this.delegateTo.trim()}.`);
      this.delegateTo = '';
      await this.load(true);
    } catch (e) { this.note.set((e as Error).message); }
    finally { this.busy.set(false); }
  }
}
