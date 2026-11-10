import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Session } from '../session';
import { DefinitionSummary, DemoSheet, RunSummary, WfTrigger, clientOf } from './wf-model';
import { MiniGraph, miniGraph } from './graph-utils';

// ---- Workflows list, direction C: one card per workflow (trigger chip, graph thumbnail, run stats,
// pause switch, Run/Edit/Runs + menu), search + status filter chips + sort. The demo sheet and the
// recent runs table stay below. ----

const triggerLabel = (t: WfTrigger | null): string => (t ? t.event : 'manual');
const ago = (iso: string | null): string => {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso.replace(' ', 'T'));
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))} s ago`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} min ago`;
  if (ms < 86400000) return `${Math.round(ms / 3600000)} h ago`;
  return `${Math.round(ms / 86400000)} d ago`;
};
const dur = (ms: number | null): string => (ms === null ? '' : ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min`);

export type WfListFilter = 'all' | 'active' | 'paused' | 'failed';
export type WfListSort = 'lastRun' | 'name' | 'updated';
/** Cards' search + chip filter + sort, kept pure so the list stays testable. */
export function filterWorkflows(defs: DefinitionSummary[], query: string, filter: WfListFilter, sort: WfListSort): DefinitionSummary[] {
  const q = query.trim().toLowerCase();
  let out = defs.filter((d) =>
    (filter === 'all' || (filter === 'active' ? d.active : filter === 'paused' ? !d.active : d.stats?.lastStatus === 'failed')) &&
    (!q || d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q) || (d.trigger?.event ?? '').includes(q) || d.graph.nodes.some((n) => n.type.includes(q))));
  const lastAt = (d: DefinitionSummary) => d.stats?.lastAt ?? '';
  if (sort === 'name') out = [...out].sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === 'updated') out = [...out].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  else out = [...out].sort((a, b) => (lastAt(b) || '0').localeCompare(lastAt(a) || '0'));
  return out;
}

@Component({ selector: 'app-workflows', imports: [FormsModule, RouterLink], styleUrl: '../pages.css', styles: [`
.wlc-head { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; margin-bottom: .6rem; }
.wlc-head h3 { flex: 1; margin: 0; }
.wlc-tools { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; margin-bottom: .8rem; }
.wlc-tools input[type='search'] { width: 240px; }
.wlc-chips { display: flex; gap: .3rem; flex-wrap: wrap; }
.wlc-fchip { border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 1rem; padding: .2rem .8rem; cursor: pointer; min-height: 0; }
.wlc-fchip.on { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
.wlc-fchip b { margin-left: .25rem; font-weight: 600; }
.wlc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: .8rem; margin-bottom: 1rem; }
.wlc-card { display: flex; flex-direction: column; gap: .35rem; padding: .8rem .9rem; }
.wlc-card.paused { opacity: .72; }
.wlc-title { display: flex; align-items: flex-start; gap: .5rem; }
.wlc-title a { flex: 1; font-weight: 600; color: var(--ink); text-decoration: none; }
.wlc-title a:hover { color: var(--accent); }
.wlc-switch { position: relative; width: 34px; height: 19px; flex: none; }
.wlc-switch input { opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.wlc-switch i { position: absolute; inset: 0; border-radius: 1rem; background: var(--bar-off); pointer-events: none; transition: background .15s; }
.wlc-switch i::after { content: ''; position: absolute; top: 2px; left: 2px; width: 15px; height: 15px; border-radius: 50%; background: var(--card); transition: left .15s; }
.wlc-switch input:checked + i { background: var(--ok-line); }
.wlc-switch input:checked + i::after { left: 17px; }
.wlc-trigger { align-self: flex-start; }
.wlc-mini { width: 100%; height: 74px; background: var(--panel); border: 1px solid var(--line); border-radius: .5rem; }
.wlc-stats { display: flex; gap: .8rem; font-size: .85rem; color: var(--muted); flex-wrap: wrap; }
.wlc-stats b { color: var(--ink); font-weight: 600; }
.wlc-stats .ok b { color: var(--ok); }
.wlc-stats .ko b { color: var(--bad); }
.wlc-last { font-size: .82rem; color: var(--muted); }
.wlc-actions { display: flex; gap: .35rem; margin-top: .25rem; }
.wlc-actions .btn, .wlc-actions button { flex: 1; text-align: center; }
.wlc-menu { position: relative; flex: 0 0 auto; }
.wlc-menu summary { list-style: none; cursor: pointer; padding: .45rem .7rem; border: 1px solid var(--line); border-radius: var(--radius); color: var(--muted); }
.wlc-menu[open] summary { color: var(--ink); }
.wlc-menu div { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; display: flex; flex-direction: column; background: var(--card); border: 1px solid var(--line); border-radius: .5rem; box-shadow: 0 6px 24px var(--shadow-color); min-width: 150px; }
.wlc-menu div button { background: none; border: 0; border-radius: 0; text-align: left; padding: .45rem .8rem; min-height: 0; color: var(--ink); cursor: pointer; }
.wlc-menu div button:hover { background: var(--row-hover); }
`], template: `
<p class="lead">IGA workflows: build a scenario as a graph of steps, run it, follow every step, retry after an error.
<b>Simulated</b> steps never touch anything; <b>real</b> steps write business data on the run's own Dolt branch, which a human then reviews and merges.</p>
@if (note()) { <p role="status" class="msg">{{note()}}</p> }
<div class="wlc-head"><h3>Workflows</h3>
  <label class="btn secondary" title="Load a definition JSON">⇑ Import JSON<input type="file" accept="application/json" (change)="importDef($event)" hidden /></label>
  <a class="btn secondary" routerLink="/workflows/templates" title="Start from a template">+ Templates</a>
  <a class="btn" routerLink="/workflows/edit/new">+ New workflow</a>
  <a class="btn secondary" routerLink="/workflows/runs">Executions</a>
</div>
<div class="wlc-tools">
  <input type="search" name="wlcSearch" [(ngModel)]="query" placeholder="Search name, block, trigger…" aria-label="Search workflows" />
  <span class="wlc-chips">
    @for (f of filters; track f.key) {<button class="wlc-fchip" [class.on]="filter() === f.key" (click)="filter.set(f.key)">{{f.label}} <b>{{f.count()}}</b></button>}
  </span>
  <span class="spacer"></span>
  <label class="hint">Sort: <select name="wlcSort" [(ngModel)]="sort">
    <option value="lastRun">last run</option><option value="name">name</option><option value="updated">updated</option>
  </select></label>
</div>
<div class="wlc-grid">
  @for (d of visible(); track d.id) {
    <section class="card wlc-card" [class.paused]="!d.active">
      <div class="wlc-title"><a [routerLink]="['/workflows/edit', d.id]" [title]="d.description">{{d.name}}</a>
        <label class="wlc-switch" [title]="d.active ? 'Active: its triggers start runs' : 'Paused: triggers never start a run'"><input type="checkbox" [attr.name]="'on-'+d.id" [checked]="d.active" [disabled]="busy()" (change)="toggleActive(d)" /><i></i></label>
      </div>
      <span class="chip wlc-trigger" [attr.data-status]="d.trigger ? 'real' : null">{{triggerOf(d)}}</span>
      <svg class="wlc-mini" [attr.viewBox]="miniOf(d).viewBox" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        @for (e of miniOf(d).edges; track $index) {<line [attr.x1]="e.x1" [attr.y1]="e.y1" [attr.x2]="e.x2" [attr.y2]="e.y2" stroke="var(--line)" stroke-width="1.5" />}
        @for (n of miniOf(d).nodes; track $index) {<rect [attr.x]="n.x - 13" [attr.y]="n.y - 8" width="26" height="16" rx="5" [attr.fill]="n.cat === 'real' ? 'var(--ok-soft)' : n.cat === 'computed' ? 'var(--accent-soft)' : 'var(--warn-soft)'" [attr.stroke]="n.cat === 'real' ? 'var(--ok-line)' : n.cat === 'computed' ? 'var(--accent)' : 'var(--warn-line)'" />}
      </svg>
      <div class="wlc-stats"><span><b>{{d.steps}}</b> steps</span>@if (d.stats) {<span><b>{{d.stats.runs}}</b> runs</span><span [class.ok]="d.stats.okPct === 100" [class.ko]="(d.stats.okPct ?? 100) < 100"><b>{{d.stats.okPct}}%</b> ok</span>} @else {<span>never run</span>}</div>
      @if (d.stats?.lastStatus) {<div class="wlc-last">Last run <span class="chip" [attr.data-status]="d.stats!.lastStatus">{{d.stats!.lastStatus}}</span> · {{agoOf(d)}}@if (d.stats!.lastDurationMs !== null) { · {{durOf(d)}}}</div>}
      <div class="wlc-actions">
        <button (click)="start(d)" [disabled]="busy()">▶ Run</button>
        <a class="btn secondary" [routerLink]="['/workflows/edit', d.id]">Edit</a>
        <a class="btn secondary" [routerLink]="['/workflows/runs']" [queryParams]="{ definition: d.id }">Runs</a>
        <details class="wlc-menu"><summary title="More">⋯</summary><div>
          <button (click)="duplicate(d); $event.stopPropagation()">Duplicate</button>
          <button (click)="exportDef(d)">Export JSON</button>
          <button (click)="remove(d)">Delete</button>
        </div></details>
      </div>
    </section>
  }
  @empty {<p class="hint">No workflow matches. Create one, import a JSON definition, or start from a template.</p>}
</div>
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

  // ---- Search / filter / sort (direction C toolbar) ----
  protected query = '';
  protected sort: 'lastRun' | 'name' | 'updated' = 'lastRun';
  protected filter = signal<'all' | 'active' | 'paused' | 'failed'>('all');
  protected readonly filters = [
    { key: 'all' as const, label: 'All', count: () => this.defs().length },
    { key: 'active' as const, label: 'Active', count: () => this.defs().filter((d) => d.active).length },
    { key: 'paused' as const, label: 'Paused', count: () => this.defs().filter((d) => !d.active).length },
    { key: 'failed' as const, label: 'Failed last run', count: () => this.defs().filter((d) => d.stats?.lastStatus === 'failed').length },
  ];

  protected visible = computed(() => filterWorkflows(this.defs(), this.query, this.filter(), this.sort));

  ngOnInit() { void this.load(); }
  protected async load() {
    try { const c = clientOf(this.s); this.defs.set((await c.list()).definitions); this.runs.set((await c.runs()).runs.slice(0, 15)); }
    catch (e) { this.note.set((e as Error).message); }
    try { const sh = await clientOf(this.s).demoSheet(); this.sheet.set(sh); this.sheetSaved = JSON.stringify(sh.rows.map((r) => r.values)); }
    catch { this.sheet.set(null); } // the workflow-connectors plugin is disabled: no demo sheet section
  }

  // ---- Card helpers ----
  protected triggerOf = (d: DefinitionSummary) => triggerLabel(d.trigger);
  protected agoOf = (d: DefinitionSummary) => ago(d.stats?.lastAt ?? null);
  protected durOf = (d: DefinitionSummary) => dur(d.stats?.lastDurationMs ?? null);

  /** Scaled-down graph thumbnail (shared with the template cards). */
  protected miniOf(d: DefinitionSummary): MiniGraph { return miniGraph(d.graph.nodes, d.graph.edges); }

  // ---- Card actions ----
  protected async toggleActive(d: DefinitionSummary) {
    this.busy.set(true);
    try { const r = await clientOf(this.s).setActive(d.id, !d.active); this.defs.update((l) => l.map((x) => (x.id === d.id ? { ...x, active: r.definition.active } : x))); this.note.set(r.definition.active ? `${d.name} is active again.` : `${d.name} paused: its triggers will not start runs.`); }
    catch (e) { this.note.set((e as Error).message); } finally { this.busy.set(false); }
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
  protected async exportDef(d: DefinitionSummary) {
    try {
      const { definition } = await clientOf(this.s).get(d.id);
      const json = JSON.stringify({ name: definition.name, description: definition.description, trigger: definition.trigger, active: definition.active, graph: definition.graph }, null, 2);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      a.download = `${(d.name || 'workflow').replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}.json`;
      a.click(); URL.revokeObjectURL(a.href);
    } catch (e) { this.note.set((e as Error).message); }
  }
  protected importDef(ev: Event) {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    void file.text().then(async (text) => {
      this.busy.set(true);
      try {
        const j = JSON.parse(text) as { name?: string; description?: string; trigger?: WfTrigger; active?: boolean; graph?: { nodes: never[]; edges: never[] } };
        if (!j.name || !j.graph) throw new Error('the JSON must carry name + graph (an export of the editor)');
        await clientOf(this.s).create(j.name, j.description ?? '', j.graph, j.trigger ?? null, j.active !== false);
        this.note.set(`Imported ${j.name}.`); await this.load();
      } catch (e) { this.note.set((e as Error).message); } finally { this.busy.set(false); }
    });
  }

  // ---- Demo sheet (unchanged) ----
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
}
