import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DiffSummary, RowDiff, VersioningClient, cellText } from './api';
import { Session } from './session';

interface TableView { table: string; kind: string; rows: { added: number; modified: number; removed: number } | null; open: boolean; loading: boolean; columns: string[]; diffs: RowDiff[]; truncated: boolean; error: string }

/**
 * Review changes (docs/toolbar.md): every change of the working branch against main, like a pull request "Files changed" tab.
 * One block per table, one line per row, before (red) and after (green). It reads the same Dolt diff the Database > Compare page uses.
 */
@Component({
  selector: 'app-review',
  imports: [RouterLink],
  template: `
  <section class="card" id="review-page">
    <h2>Changes on <b>{{ branch() }}</b> compared with <b>main</b></h2>
    @if (!branch() || branch() === 'main') { <p>Choose your working branch in the top bar: main is read only, so it has no changes to review.</p> }
    @else if (error()) { <p class="bad" role="alert">{{ error() }}</p> }
    @else if (!summary()) { <p>Loading the changes…</p> }
    @else {
      <p id="review-total"><b>{{ total() }}</b> row{{ total() === 1 ? '' : 's' }} changed in <b>{{ views().length }}</b> table{{ views().length === 1 ? '' : 's' }}.
        @if (summary()!.rows) { <span class="add">+{{ summary()!.rows!.added }} added</span> <span class="mod">~{{ summary()!.rows!.modified }} modified</span> <span class="del">-{{ summary()!.rows!.removed }} removed</span> }</p>
      @if (!views().length) { <p>No data changes. Nothing to apply.</p> }
      @for (t of views(); track t.table) {
        <article class="tbl" [attr.data-table]="t.table">
          <h3><button type="button" class="secondary tog" (click)="toggle(t)" [attr.aria-expanded]="t.open">{{ t.open ? '▾' : '▸' }}</button> {{ t.table }}
            <small>{{ t.kind }}</small>
            @if (t.rows) { <span class="add">+{{ t.rows.added }}</span> <span class="mod">~{{ t.rows.modified }}</span> <span class="del">-{{ t.rows.removed }}</span> }</h3>
          @if (t.open) {
            @if (t.loading) { <p>Loading…</p> }
            @else if (t.error) { <p class="bad">{{ t.error }}</p> }
            @else {
              <div class="scroll"><table class="rows">
                <thead><tr><th></th>@for (c of t.columns; track c) { <th>{{ c }}</th> }</tr></thead>
                <tbody>
                  @for (r of t.diffs; track $index) {
                    @if (r.type !== 'added') { <tr class="del" [attr.data-row]="r.type"><td class="sign">-</td>@for (c of t.columns; track c) { <td [class.chg]="changed(r, c)">{{ cell(r.from?.[c]) }}</td> }</tr> }
                    @if (r.type !== 'removed') { <tr class="add" [attr.data-row]="r.type"><td class="sign">+</td>@for (c of t.columns; track c) { <td [class.chg]="changed(r, c)">{{ cell(r.to?.[c]) }}</td> }</tr> }
                  }
                </tbody>
              </table></div>
              @if (t.truncated) { <p class="hint">Only the first rows are shown. Use <a routerLink="/database/compare">Database > Compare</a> to page through all of them.</p> }
            }
          }
        </article>
      }
      @if (summary()!.schema.length) { <h3>Schema changes</h3>@for (x of summary()!.schema; track x.table) { <pre class="schema">{{ x.table }}
- {{ x.from ?? '(new table)' }}
+ {{ x.to ?? '(dropped)' }}</pre> } }
    }
  </section>`,
  styles: [`
    .add { color: var(--ok); } .del { color: var(--bad); } .mod { color: var(--warn-ink); } .bad { color: var(--bad); }
    .tbl { border: 1px solid var(--line); border-radius: .5rem; margin: .8rem 0; padding: .4rem .8rem; }
    .tbl h3 { margin: .3rem 0; display: flex; gap: .6rem; align-items: center; } .tbl h3 small { color: var(--muted); font-weight: 400; }
    .tog { padding: .1rem .5rem; } .scroll { overflow-x: auto; }
    table.rows { border-collapse: collapse; font-family: ui-monospace, monospace; font-size: .8rem; width: 100%; }
    table.rows td, table.rows th { padding: .2rem .5rem; border-bottom: 1px solid var(--bg); text-align: left; white-space: nowrap; }
    tr.add td { background: var(--ok-soft); color: var(--ok); } tr.del td { background: var(--bad-soft); color: var(--bad-ink); }
    td.chg { font-weight: 700; text-decoration: underline; } td.sign { width: 1.2rem; font-weight: 700; }
    .schema { background: var(--panel); padding: .6rem; overflow-x: auto; font-size: .8rem; }
  `],
})
export class ReviewPage {
  private readonly session = inject(Session);
  protected readonly cell = cellText;
  protected readonly branch = computed(() => this.session.branch());
  protected readonly summary = signal<DiffSummary | null>(null);
  protected readonly views = signal<TableView[]>([]);
  protected readonly error = signal('');
  protected readonly total = computed(() => this.summary()?.rows?.total ?? this.views().length);
  private get v() { const v = new VersioningClient(this.session.api); v.adminToken = this.session.adminToken(); return v; }

  async ngOnInit() {
    const b = this.branch(); if (!b || b === 'main') return;
    try {
      // Three-dot: changes made on the branch since it left main, exactly what Apply would publish.
      const d = await this.v.diff('main', b, true); this.summary.set(d);
      const vs = d.tables.filter((t) => t.dataChange || t.schemaChange).map((t): TableView => ({ table: t.table, kind: t.kind, rows: t.rows ?? null, open: false, loading: false, columns: [], diffs: [], truncated: false, error: '' }));
      this.views.set(vs); if (vs.length <= 4) for (const t of vs) await this.toggle(t);
    } catch (e) { this.error.set((e as Error).message); }
  }
  protected changed(r: RowDiff, col: string) { return r.type === 'modified' && cellText(r.from?.[col]) !== cellText(r.to?.[col]); }
  protected async toggle(t: TableView) {
    t.open = !t.open; this.views.update((x) => [...x]);
    if (!t.open || t.columns.length || t.loading) return;
    t.loading = true; this.views.update((x) => [...x]);
    try { const r = await this.v.diffTable(t.table, 'main', this.branch(), true); t.columns = r.columns; t.diffs = r.rows; t.truncated = r.truncated; }
    catch (e) { t.error = (e as Error).message; }
    t.loading = false; this.views.update((x) => [...x]);
  }
}
