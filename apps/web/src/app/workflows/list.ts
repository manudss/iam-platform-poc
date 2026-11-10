import { Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Session } from '../session';
import { DefinitionSummary, DemoSheet, RunSummary, clientOf } from './wf-model';

// ---- Workflows list: definitions, the simulated demo sheet, recent runs. The canvas redesign of these
// cards is P1; P0 adds the duplicate action and the Executions screen link. ----

@Component({ selector: 'app-workflows', imports: [FormsModule, RouterLink], styleUrl: '../pages.css', template: `
<p class="lead">IGA workflows: build a scenario as a graph of steps, run it, follow every step, retry after an error.
<b>Simulated</b> steps never touch anything (a notification is only logged, never sent). <b>Real</b> steps write business data on the run's own Dolt branch, which a human then reviews and merges.</p>
@if (note()) { <p role="status" class="msg">{{note()}}</p> }
<section class="card"><div class="row"><h3 style="flex:1">Definitions</h3><a class="btn secondary" routerLink="/workflows/runs">Executions</a><a class="btn" routerLink="/workflows/edit/new">New workflow</a><button class="secondary" (click)="load()">Refresh</button></div>
<div class="scroll"><table><thead><tr><th>Name</th><th>Trigger</th><th>Steps</th><th>Simulated</th><th>Computed</th><th>Real</th><th>By</th><th></th></tr></thead><tbody>
@for (d of defs(); track d.id) {<tr><td><a [routerLink]="['/workflows/edit', d.id]">{{d.name}}</a><br /><small>{{d.description}}</small></td><td>@if (d.trigger) {<span class="chip" data-status="real">auto: {{d.trigger.event}}</span>} @else {<small>manual</small>}</td><td>{{d.steps}}</td><td>{{d.simulatedSteps}}</td><td>{{d.computedSteps}}</td><td>{{d.dataSteps}}</td><td>{{d.createdBy}}</td>
<td><button (click)="start(d)" [disabled]="busy()">Run</button> <a class="btn secondary" [routerLink]="['/workflows/edit', d.id]">Edit</a> <button class="secondary" (click)="duplicate(d)" [disabled]="busy()">Duplicate</button> <button class="secondary" (click)="remove(d)" [disabled]="busy()">Delete</button></td></tr>}
@empty {<tr><td colspan="8">No workflow yet. Create one, or open the editor and load a sample.</td></tr>}
</tbody></table></div></section>
@if (sheet(); as sh) {<section class="card"><h3>Demo sheet - {{sh.name}} <span class="chip" data-status="simulated">SIMULATED</span></h3>
<p class="hint">{{sh.note}}</p>
<div class="scroll"><table><thead><tr><th>#</th>@for (c of sh.columns; track c) {<th>{{c}}</th>}</tr></thead><tbody>
@for (r of sh.rows; track r.rowNumber) {<tr><td>{{r.rowNumber}}</td>@for (c of sh.columns; track c) {<td><input [attr.name]="'sh-'+r.rowNumber+'-'+c" [(ngModel)]="r.values[c]" /></td>}</tr>}
</tbody></table></div>
<div class="row" style="margin-top:.5rem"><button class="secondary" (click)="sheetAdd()" [disabled]="busy()">+ Add a candidate row</button><button (click)="sheetSave()" [disabled]="busy()">Save changes</button>@if (sheetNote()) {<span class="hint">{{sheetNote()}}</span>}</div>
</section>}
<section class="card"><h3>Recent runs <a class="btn secondary" routerLink="/workflows/runs">All executions</a></h3>
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
  protected async duplicate(d: DefinitionSummary) {
    this.busy.set(true);
    try { const r = await clientOf(this.s).duplicate(d.id); this.note.set(`Created ${r.definition.name}.`); await this.load(); }
    catch (e) { this.note.set((e as Error).message); } finally { this.busy.set(false); }
  }
  protected async remove(d: DefinitionSummary) {
    this.busy.set(true);
    try { await clientOf(this.s).remove(d.id); await this.load(); this.note.set(`Deleted ${d.name}.`); }
    catch (e) { this.note.set((e as Error).message); } finally { this.busy.set(false); }
  }
}
