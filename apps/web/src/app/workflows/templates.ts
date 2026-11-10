import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Session } from '../session';
import { WF_TEMPLATES, WfTemplate, clientOf } from './wf-model';
import { miniGraph } from './graph-utils';
import { WbTabs } from './workbench-tabs';

// ---- Workflow templates gallery (direction C): categories on the left, searchable cards with a graph
// thumbnail, "Use template" opens a modal (name + blocks created) that instantiates a PAUSED workflow and
// opens it in the editor. The catalog is the official samples of the product; nothing runs until activated. ----

/** Sidebar categories with their template counts, in first-seen order. */
export function templateCategories(templates: WfTemplate[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of templates) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => ({ name, count }));
}
/** Gallery cards: category + free-text filter over name, description and node types. */
export function filterTemplates(templates: WfTemplate[], category: string, query: string): WfTemplate[] {
  const q = query.trim().toLowerCase();
  return templates.filter((t) => (category === 'all' || t.category === category) && (!q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.nodes.some((n) => n.type.includes(q))));
}

@Component({ selector: 'app-workflow-templates', imports: [FormsModule, RouterLink], styleUrl: '../pages.css', styles: [`
.tpl { display: flex; gap: 1rem; align-items: flex-start; }
.tpl-cats { flex: 0 0 200px; display: flex; flex-direction: column; gap: 2px; }
.tpl-cats button { display: flex; justify-content: space-between; background: none; border: 0; border-radius: .4rem; padding: .4rem .6rem; min-height: 0; text-align: left; color: var(--muted); cursor: pointer; }
.tpl-cats button.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.tpl-main { flex: 1; min-width: 0; }
.tpl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: .8rem; margin-top: .8rem; }
.tpl-card { display: flex; flex-direction: column; gap: .35rem; padding: .8rem .9rem; height: 100%; }
.tpl-grid > .tpl-card { margin: 0; }
.tpl-card h4 { margin: 0; }
.tpl-card p { margin: 0; font-size: .85rem; color: var(--muted); }
.tpl-badges { display: flex; gap: .4rem; font-size: .75rem; color: var(--muted); align-items: center; flex-wrap: wrap; }
.tpl-badges .chip { flex: none; white-space: nowrap; }
.tpl-actions { display: flex; gap: .35rem; margin-top: auto; padding-top: .3rem; }
.tpl-actions button { flex: 1; margin: 0; }
.tpl-modal { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; background: var(--scrim); }
.tpl-dialog { width: min(560px, 92vw); max-height: 86vh; overflow: auto; background: var(--card); border-radius: .8rem; padding: 1.1rem 1.3rem; box-shadow: 0 20px 60px var(--shadow-color); }
.tpl-dialog h3 { margin-top: 0; }
.tpl-blocks { display: flex; flex-wrap: wrap; gap: .3rem; margin: .3rem 0 .8rem; }
`], template: `
<p class="lead">Start from a template. A template instantiates into an editable workflow on your branch - <b>nothing runs until you activate it</b>.</p>
@if (note()) { <p role="status" class="msg">{{note()}}</p> }
<div class="tpl">
  <div class="tpl-cats card" style="padding:.5rem">
    <b style="padding:.3rem .6rem; font-size:.8rem; text-transform:uppercase; letter-spacing:.05em; color:var(--muted)">Categories</b>
    <button [class.on]="category() === 'all'" (click)="category.set('all')">All <b>{{templates.length}}</b></button>
    @for (c of categories(); track c.name) {<button [class.on]="category() === c.name" (click)="category.set(c.name)">{{c.name}} <b>{{c.count}}</b></button>}
    <a class="btn secondary" routerLink="/workflows" style="margin-top:.5rem">← Back to workflows</a>
  </div>
  <div class="tpl-main">
    <input type="search" name="tplSearch" [(ngModel)]="query" placeholder="Search templates…" aria-label="Search templates" style="width:100%; max-width:420px" />
    <div class="tpl-grid">
      @for (t of visible(); track t.id) {
        <section class="card tpl-card">
          <h4>{{t.name}}</h4>
          <p>{{t.description}}</p>
          <svg class="wlc-mini" [attr.viewBox]="mini(t).viewBox" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
            @for (e of mini(t).edges; track $index) {<line [attr.x1]="e.x1" [attr.y1]="e.y1" [attr.x2]="e.x2" [attr.y2]="e.y2" stroke="var(--line)" stroke-width="1.5" />}
            @for (n of mini(t).nodes; track $index) {<rect [attr.x]="n.x - 13" [attr.y]="n.y - 8" width="26" height="16" rx="5" [attr.fill]="n.cat === 'real' ? 'var(--ok-soft)' : n.cat === 'computed' ? 'var(--accent-soft)' : 'var(--warn-soft)'" [attr.stroke]="n.cat === 'real' ? 'var(--ok-line)' : n.cat === 'computed' ? 'var(--accent)' : 'var(--warn-line)'" />}
          </svg>
          <div class="tpl-badges"><span class="chip" data-status="real">◆ OFFICIAL</span><span>{{t.nodes.length}} blocks</span>@if (t.trigger) {<span>· trigger {{t.trigger.event}}</span>} @else {<span>· manual</span>}</div>
          <div class="tpl-actions"><button class="secondary" (click)="open(t)">Preview</button><button (click)="open(t)">Use template</button></div>
        </section>
      }
      @empty {<p class="hint">No template matches.</p>}
    </div>
  </div>
</div>
@if (using(); as t) {
  <div class="tpl-modal" (click)="close()">
    <div class="tpl-dialog" (click)="$event.stopPropagation()" role="dialog" aria-modal="true" [attr.aria-label]="'Use template ' + t.name">
      <h3>Use template "{{t.name}}"</h3>
      <p class="hint">Creates a new workflow on your branch, <b>paused</b>: it stays inactive until you switch it on.</p>
      <label>Workflow name<input name="tplName" [(ngModel)]="newName" maxlength="80" /></label>
      @if (t.trigger) {<p class="hint" style="margin-top:.5rem">Trigger: <b>{{t.trigger.event}}</b>@if (t.trigger.match) { · only if @for (kv of matchPairs(t); track kv) {<code>{{kv}}</code> }}</p>}
      <h4>{{t.nodes.length}} blocks will be created</h4>
      <div class="tpl-blocks">@for (n of t.nodes; track n.id) {<span class="chip" [attr.data-status]="catOf(n.type)">{{n.name}}</span>}</div>
      <svg class="wlc-mini" [attr.viewBox]="mini(t).viewBox" preserveAspectRatio="xMidYMid meet" aria-hidden="true" style="margin-bottom:.6rem">
        @for (e of mini(t).edges; track $index) {<line [attr.x1]="e.x1" [attr.y1]="e.y1" [attr.x2]="e.x2" [attr.y2]="e.y2" stroke="var(--line)" stroke-width="1.5" />}
        @for (n of mini(t).nodes; track $index) {<rect [attr.x]="n.x - 13" [attr.y]="n.y - 8" width="26" height="16" rx="5" [attr.fill]="n.cat === 'real' ? 'var(--ok-soft)' : n.cat === 'computed' ? 'var(--accent-soft)' : 'var(--warn-soft)'" [attr.stroke]="n.cat === 'real' ? 'var(--ok-line)' : n.cat === 'computed' ? 'var(--accent)' : 'var(--warn-line)'" />}
      </svg>
      <div class="row"><span class="spacer"></span><button class="secondary" (click)="close()">Cancel</button><button (click)="create()" [disabled]="busy() || !newName.trim()">Create the workflow</button></div>
    </div>
  </div>
}
` })
export class WorkflowTemplatesPage {
  protected readonly s = inject(Session);
  private readonly router = inject(Router);
  private readonly tabs = inject(WbTabs);
  protected readonly templates = WF_TEMPLATES;
  protected note = signal(''); protected busy = signal(false);
  protected query = '';
  protected category = signal('all');
  protected using = signal<WfTemplate | null>(null);
  protected newName = '';

  protected categories = computed(() => templateCategories(this.templates));
  protected visible = computed(() => filterTemplates(this.templates, this.category(), this.query));

  protected mini(t: WfTemplate) { return miniGraph(t.nodes, t.edges); }
  protected catOf = (type: string) => miniGraph([{ id: 'x', type }], []).nodes[0]?.cat ?? 'simulated';
  protected matchPairs(t: WfTemplate): string[] { return Object.entries(t.trigger?.match ?? {}).map(([k, v]) => `${k} = ${v}`); }

  protected open(t: WfTemplate) { this.using.set(t); this.newName = t.name; }
  protected close() { this.using.set(null); }

  protected async create() {
    const t = this.using(); if (!t) return;
    this.busy.set(true);
    try {
      const graph = { nodes: t.nodes.map((n) => ({ ...n, config: { ...n.config } })), edges: t.edges.map((e) => ({ ...e })) };
      const r = await clientOf(this.s).create(this.newName.trim(), t.description, graph, t.trigger ?? null, false);
      this.tabs.open('workflow', r.definition.id, this.newName.trim());
      void this.router.navigateByUrl(`/workflows/edit/${r.definition.id}`);
    } catch (e) { this.note.set((e as Error).message); this.busy.set(false); }
  }
}
