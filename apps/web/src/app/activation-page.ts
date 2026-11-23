import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Session } from './session';
import { ActivationRecord, ActivationStatus, DiffSummary, VersioningClient } from './api';

@Component({
  selector: 'app-activation', imports: [DatePipe, FormsModule], styleUrl: './activation-page.css',
  template: `
  <header class="activation-head"><div><h2>Activation</h2><p class="hint">The permission engine's live version and the recorded publication history.</p></div>
    <button type="button" (click)="load()" [disabled]="loading()">{{ loading() ? 'Refreshing…' : 'Refresh' }}</button></header>
  @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
  <section class="card" aria-labelledby="live-title"><h3 id="live-title">Live permission engine</h3>
    @if (status(); as st) {
      @if (st.status === 'confirmed' && st.core; as live) {
        <p><span class="state applied">Confirmed live</span> <b>Activation #{{ live.seq }}</b></p>
        <dl class="facts"><div><dt>Active Dolt commit</dt><dd><code>{{ live.commit }}</code></dd></div>
          <div><dt>Compared with main</dt><dd>{{ st.matchesMain === true ? 'Up to date with main' : st.matchesMain === false ? 'Main differs from the active version' : 'Main could not be read' }}</dd></div>
          <div><dt>Last checked</dt><dd>{{ st.checkedAt | date:'medium' }}</dd></div>
          @if (liveRecord(); as rec) { <div><dt>Initiated by</dt><dd>{{ rec.actor ? rec.actor.id + ' (' + rec.actor.kind + ')' : 'Unavailable · not recorded' }}</dd></div><div><dt>Recorded</dt><dd>{{ rec.recordedAt ? (rec.recordedAt | date:'medium') : 'Unavailable · not recorded' }}</dd></div> }
        </dl>
        @if (!liveRecord()) { <p class="notice">The core confirms this version, but its activation is absent from the available journal. Date and actor are unavailable.</p> }
      } @else {
        <p class="notice">{{ st.status === 'disabled' ? 'Core publication is not configured. Journal records do not prove a live activation.' : st.status === 'none' ? 'The core reports no active version for this tenant.' : 'Live state unavailable. The journal below is not proof of the currently active version.' }}</p>
      }
    } @else { <p class="hint">{{ loading() ? 'Checking the live engine…' : 'Live state has not been verified.' }}</p> }
    <p class="hint">Read-only view. Merging data and publishing permissions are separate facts. Use global Apply to publish reviewed changes.</p>
  </section>
  <section class="card" aria-labelledby="history-title"><div class="activation-head"><div><h3 id="history-title">Activation history</h3><p class="hint">{{ records().length }} recorded entries · newest first</p></div>
    <label>Filter <select aria-label="Filter activation history" [ngModel]="filter()" (ngModelChange)="filter.set($event)"><option value="all">All states</option><option value="applied">Applied</option><option value="failed">Failed</option><option value="pending">Pending</option><option value="recorded">Journal only</option></select></label></div>
    <p class="hint">Recorded time is not the commit date. Missing actors and old confirmation times are shown as unavailable, never inferred from commit authors. Dates use your browser's timezone. Development memory journals are lost on restart.</p>
    @for (a of filtered(); track a.seq) {
      <article class="entry"><div class="entry-head"><b>#{{ a.seq }}</b><span class="state" [class.applied]="a.state === 'applied'" [class.failed]="a.state === 'failed'">{{ stateLabel(a.state) }}</span>
        @if (isLive(a)) { <span class="state applied">Current live version</span> }
        <span class="entry-date">{{ a.recordedAt ? (a.recordedAt | date:'medium') : 'Recorded date unavailable' }}</span></div>
        <code class="commit">{{ a.commit }}</code>
        <dl class="facts"><div><dt>Initiated by</dt><dd>{{ a.actor ? a.actor.id + ' (' + a.actor.kind + ')' : 'Unavailable · not recorded' }}</dd></div><div><dt>Last core confirmation</dt><dd>{{ a.appliedAt ? (a.appliedAt | date:'medium') : 'Unavailable · not recorded' }}</dd></div></dl>
        @if (a.error) { <p class="error">{{ a.error }}</p> }
        <details (toggle)="openDetails(a, $event)"><summary>Change history and references</summary>
          @if (a.requestId) { <p>Request reference: <code>{{ a.requestId }}</code></p> }
          @if (details()[a.seq]; as d) {
            @if (d.loading) { <p role="status">Loading the recorded Dolt changes…</p> }
            @if (d.error) { <p class="notice">{{ d.error }}</p> }
            @if (d.message) { <p><b>Commit message:</b> {{ d.message }}</p><p class="hint">Commit author: {{ d.author }} · Commit date: {{ d.date | date:'medium' }}. These describe the data commit, not who activated it.</p> }
            @if (d.base) { <p class="hint">Net changes since preceding journal entry #{{ d.base.seq }} (<code>{{ d.base.commit }}</code>). A failed or journal-only entry is not a previously live version.</p> }
            @if (d.diff; as diff) {
              @if (diff.tables.length) { <div class="scroll"><table><caption>Changed tables · no row values or secrets</caption><thead><tr><th>Table</th><th>Change</th><th>Rows + / ~ / −</th><th>Schema</th></tr></thead><tbody>
                @for (t of diff.tables; track t.table) { <tr><td>{{ t.table }}</td><td>{{ t.kind }}</td><td>{{ t.rows ? t.rows.added + ' / ' + t.rows.modified + ' / ' + t.rows.removed : 'Unavailable' }}</td><td>{{ t.schemaChange ? 'Changed' : 'Unchanged' }}</td></tr> }
              </tbody></table></div> } @else { <p>No net table changes between these two commits (a repeat activation can still have its own sequence).</p> }
            }
          }
        </details>
      </article>
    } @empty { <p class="empty">{{ loading() ? 'Loading history…' : records().length ? 'No entries match this filter.' : 'No activation records are available. This does not prove that the core has no active version.' }}</p> }
  </section>`
})
export class ActivationPage implements OnInit {
  private readonly s = inject(Session);
  private epoch = 0;
  readonly records = signal<ActivationRecord[]>([]);
  readonly status = signal<ActivationStatus | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly filter = signal('all');
  readonly details = signal<Record<number, { loading?: boolean; error?: string; message?: string; author?: string; date?: string; base?: ActivationRecord; diff?: DiffSummary }>>({});
  readonly filtered = computed(() => [...this.records()].sort((a,b) => b.seq-a.seq).filter(a => this.filter() === 'all' || a.state === this.filter()));
  readonly liveRecord = computed(() => this.records().find(a => this.isLive(a)));
  ngOnInit() { void this.load(); }
  isLive(a: ActivationRecord) { const c = this.status()?.core; return !!c && a.seq === c.seq && a.commit === c.commit; }
  stateLabel(s?: string) { return ({ applied: 'Applied · core confirmed', failed: 'Failed', pending: 'Pending', recorded: 'Journal only' } as Record<string,string>)[s ?? ''] ?? 'State unavailable'; }
  async load() {
    if (this.loading()) return;
    ++this.epoch; this.loading.set(true); this.error.set(''); this.status.set(null); this.details.set({});
    const result = await Promise.allSettled([this.s.api.activationJournal(this.s.adminToken()), this.s.api.activationStatus(this.s.adminToken())]);
    if (result[0].status === 'fulfilled') this.records.set(result[0].value); else { this.records.set([]); this.error.set('Activation history could not be read. Refresh to try again.'); }
    if (result[1].status === 'fulfilled') this.status.set(result[1].value);
    else this.error.update(e => (e ? e + ' ' : '') + 'Live state could not be verified (an administrator capability is required).');
    this.loading.set(false);
  }
  async openDetails(a: ActivationRecord, event: Event) {
    if (!(event.target as HTMLDetailsElement).open || this.details()[a.seq]) return;
    this.details.update(d => ({ ...d, [a.seq]: { loading: true } }));
    const epoch = this.epoch;
    const v = new VersioningClient(this.s.api); v.adminToken = this.s.adminToken();
    const base = [...this.records()].filter(x => x.seq < a.seq).sort((x,y) => y.seq-x.seq)[0];
    const [commit, diff] = await Promise.allSettled([v.commit(a.commit), base ? v.diff(base.commit, a.commit, false) : Promise.resolve(undefined)]);
    if (epoch !== this.epoch) return;
    this.details.update(d => ({...d, [a.seq]: { base, loading: false,
      ...(commit.status === 'fulfilled' ? { message: commit.value.message, author: commit.value.author, date: commit.value.date } : {}),
      ...(diff.status === 'fulfilled' && diff.value ? { diff: diff.value } : {}),
      error: !base ? 'No preceding activation is available. The initial change interval cannot be reconstructed.' : commit.status === 'rejected' || diff.status === 'rejected' ? 'Some Dolt details are unavailable or access is denied. No change history has been inferred.' : undefined
    }}));
  }
}
