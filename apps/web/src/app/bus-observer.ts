import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';

export interface BusOutcome { id: string; mandatory: boolean; status: string; verdict?: string | null; detail?: string | null; data_keys?: string[] | null }
export interface BusRec { seq: number; at_ms: number; envelope_id: string; kind: string; mode: string; tenant?: string | null; effect_key?: string | null; source?: string | null; payload: Record<string, string>; elapsed_ms: number; verdict?: string | null; expected: { id: string; mandatory: boolean }[]; outcomes: BusOutcome[] }
export type Result = 'ok' | 'refused' | 'error' | 'no-consumer' | 'silent-optional';

/** What the exchange amounted to, read from the real record. A silent MANDATORY subscriber is a refusal (D3); a silent optional one is ignored. */
export function result(r: BusRec): Result {
  if (r.outcomes.some((o) => o.status === 'invalid')) return 'error';
  if (r.verdict === 'deny' || r.outcomes.some((o) => o.mandatory && o.status === 'silent')) return 'refused';
  if (!r.expected.length) return 'no-consumer';
  if (r.outcomes.some((o) => o.status === 'silent')) return 'silent-optional';
  return 'ok';
}
export const answered = (r: BusRec): string[] => r.outcomes.filter((o) => o.status === 'replied').map((o) => o.id);
export const silentOnes = (r: BusRec): string[] => r.outcomes.filter((o) => o.status !== 'replied').map((o) => o.id);

export const FIT = 0, FIT_SECONDS = 60;
/** x1 = one second of playback is one second of recorded history; FIT compresses the whole span into 60 s (effective factor displayed). */
export function factor(speed: number, from: number, to: number): number { return speed === FIT ? Math.max(1, (to - from) / (FIT_SECONDS * 1000)) : speed; }
export function advance(cursor: number, dtMs: number, speed: number, from: number, to: number): { cursor: number; done: boolean } {
  const c = cursor + dtMs * factor(speed, from, to);
  return c >= to ? { cursor: to, done: true } : { cursor: Math.max(from, c), done: false };
}
export function factorLabel(f: number): string { const r = Math.round(f * 10) / 10; const h = f >= 3600 ? `${Math.round(f / 360) / 10} h` : f >= 60 ? `${Math.round(f / 6) / 10} min` : `${r} s`; return `x${r} (1 s of playback = ${h} of history)`; }
export const seenAt = (rs: BusRec[], cursor: number): BusRec[] => rs.filter((r) => r.at_ms <= cursor).sort((a, b) => a.seq - b.seq);
export function stepTo(rs: BusRec[], cursor: number, dir: 1 | -1): number | undefined {
  const ts = rs.map((r) => r.at_ms).sort((a, b) => a - b);
  return dir === 1 ? ts.find((t) => t > cursor) : [...ts].reverse().find((t) => t < cursor);
}

/**
 * Event bus observer. READ ONLY: a re-reading of what really went through the core's NATS bus (events, who was expected, who answered,
 * delay, silence). No button sends, replays or answers anything. The record lives in the core's memory (bounded); it is empty after a core restart.
 */
@Component({
  selector: 'app-bus-observer', imports: [FormsModule], styleUrl: './pages.css',
  template: `
  <p class="lead">Event bus (NATS), as seen by the core. Which events went through, who was expected to answer, who did, how long it took. Read only: viewing never sends, replays or answers anything. Data is masked.</p>
  @if (problem()) { <p role="alert" class="msg bad" id="bo-problem">{{problem()}}</p> }
  @if (off()) { <p class="hint" id="bo-off">The bus is not connected on this core (no NATS). Nothing to observe, and nothing depends on it.</p> } @else {
  <section class="card">
    <p class="hint" id="bo-since">{{entries().length}} exchange(s) in the core's memory (keeps the last {{capacity()}}, lost when the core restarts).@if (dropped()) { Older ones were dropped. }</p>
    <label>Kind<select name="bk" [ngModel]="kind()" (ngModelChange)="kind.set($event)" id="bo-kind"><option value="">All</option>@for (k of kinds(); track k) { <option [value]="k">{{k}}</option> }</select></label>
    <button type="button" id="bo-refresh" (click)="load()">Refresh</button>
  </section>
  <section class="card" id="bo-player" aria-label="Playback of the recorded exchanges (read only)">
    <div class="row">
      <button type="button" id="bo-play" (click)="toggle()" [disabled]="!list().length">{{playing() ? 'Pause' : (atEnd() ? 'Replay from start' : 'Play')}}</button>
      <button type="button" id="bo-prev" (click)="step(-1)" [disabled]="!list().length">Previous</button>
      <button type="button" id="bo-next" (click)="step(1)" [disabled]="!list().length">Next</button>
      <label>Speed<select name="bsp" [ngModel]="speed()" (ngModelChange)="speed.set(+$event)" id="bo-speed"><option [ngValue]="1">x1 (real time)</option><option [ngValue]="10">x10</option><option [ngValue]="60">x60</option><option [ngValue]="600">x600</option><option [ngValue]="0">Fit in 60 s</option></select></label>
    </div>
    <label class="bo-scrub">Position<input type="range" id="bo-scrub" name="bscr" min="0" max="1000" step="1" [ngModel]="pos()" (ngModelChange)="seek(+$event)" [attr.aria-valuetext]="cursorLabel()"></label>
    <p class="hint" id="bo-clock">Position: {{cursorLabel()}} ({{seen().length}} of {{list().length}} exchanges seen). Speed: {{speedLabel()}}. Only re-reads the record: nothing is sent again.</p>
    @if (current(); as c) { <div id="bo-step" class="card"><strong>{{c.kind}}</strong> ({{c.mode}}) - {{label(c)}} - {{c.elapsed_ms}} ms<br>
      Expected: @for (x of c.expected; track x.id) { <span class="chip">{{x.id}}@if (x.mandatory) { (mandatory) }</span> } @empty { nobody subscribed }
      <br>Answered: @for (x of ans(c); track x) { <span class="chip ok">{{x}}</span> } @empty { <span class="chip warn">nobody</span> }
      @for (s of mute(c); track s) { <span class="chip mute">silent: {{s}}</span> }
      <br><small>Correlation: {{c.envelope_id}}@if (c.effect_key) { - effectKey {{c.effect_key}} } - Source: {{c.source ?? 'core'}}</small>
      <br><small>Data (masked): {{payloadText(c)}}</small></div> }
  </section>
  <section class="card"><div class="scroll"><table id="bo-table"><thead><tr><th>Time</th><th>Event</th><th>Expected</th><th>Answered</th><th>Result</th><th>Delay</th></tr></thead><tbody>
  @for (e of seen(); track e.seq) { <tr [class.bo-now]="e === current()">
    <td>{{time(e)}}</td><td>{{e.kind}}<br><small>{{e.mode}} - {{e.source ?? 'core'}} - {{e.envelope_id}}</small></td>
    <td>@for (x of e.expected; track x.id) { <span class="chip">{{x.id}}</span> } @empty { - }</td>
    <td>@for (a of ans(e); track a) { <span class="chip ok">{{a}}</span> } @empty { <span class="chip warn">nobody</span> }@for (s of mute(e); track s) { <span class="chip mute" title="expected, did not answer">silent: {{s}}</span> }</td>
    <td>{{label(e)}}</td><td>{{e.elapsed_ms}} ms</td></tr> }
  @empty { <tr><td colspan="6">@if (list().length) { Press Play: exchanges appear as the playback reaches them. } @else { No exchange recorded yet. }</td></tr> }</tbody></table></div></section> }`,
  styles: [`.chip.ok{background:#dcfce7}.chip.warn{background:#fef3c7}.chip.mute{background:#f1f5f9}.bo-now{background:#eef2ff}.bo-scrub{display:block;margin:.5rem 0}.bo-scrub input{width:100%}`],
})
export class BusObserverPage implements OnDestroy {
  protected readonly s = inject(Session);
  protected entries = signal<BusRec[]>([]); protected capacity = signal(0); protected dropped = signal(false);
  protected problem = signal(''); protected off = signal(false); protected kind = signal('');
  protected playing = signal(false); protected speed = signal(1); protected cursor = signal(0); protected range = signal<[number, number]>([0, 1]);
  private timer: ReturnType<typeof setInterval> | undefined;
  protected kinds = computed(() => [...new Set(this.entries().map((e) => e.kind))].sort());
  protected list = computed(() => this.entries().filter((e) => !this.kind() || e.kind === this.kind()));
  protected pos = computed(() => Math.round(((this.cursor() - this.range()[0]) / Math.max(1, this.range()[1] - this.range()[0])) * 1000));
  protected seen = computed(() => seenAt(this.list(), this.cursor()));
  protected current = computed(() => this.seen().at(-1));
  protected atEnd = computed(() => this.cursor() >= this.range()[1]);
  protected cursorLabel = computed(() => new Date(this.cursor()).toISOString().slice(11, 23) + ' UTC');
  protected speedLabel = computed(() => (this.speed() === FIT ? 'compressed, effective ' : '') + factorLabel(factor(this.speed(), this.range()[0], this.range()[1])));
  constructor() { effect(() => { this.s.adminToken(); void this.load(); }); }
  protected ans = answered; protected mute = silentOnes;
  protected label(r: BusRec) { return ({ ok: 'ok', refused: 'refused', error: 'error (invalid answer)', 'no-consumer': 'no consumer', 'silent-optional': 'ok, an optional party stayed silent' } as Record<Result, string>)[result(r)]; }
  protected time(r: BusRec) { return new Date(r.at_ms).toISOString().slice(11, 23); }
  protected payloadText(r: BusRec) { return JSON.stringify(r.payload); }
  protected toggle() {
    if (this.playing()) return this.stop();
    if (this.atEnd()) this.cursor.set(this.range()[0]);
    this.playing.set(true);
    this.timer = setInterval(() => { const r = advance(this.cursor(), 100, this.speed(), this.range()[0], this.range()[1]); this.cursor.set(r.cursor); if (r.done) this.stop(); }, 100);
  }
  private stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.playing.set(false); }
  protected seek(p: number) { this.stop(); this.cursor.set(this.range()[0] + (p / 1000) * (this.range()[1] - this.range()[0])); }
  protected step(dir: 1 | -1) { this.stop(); const t = stepTo(this.list(), this.cursor(), dir); if (t !== undefined) this.cursor.set(t); }
  ngOnDestroy() { this.stop(); }
  private hd(): Record<string, string> { return this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {}; }
  protected async load() {
    try {
      const r = await this.s.api.raw<any>('GET', '/bus/records?limit=500', undefined, this.hd());
      if (r.status >= 400) { this.problem.set(Array.isArray(r.data?.message) ? r.data.message.join(' ') : r.data?.message ?? 'Refused'); return; }
      this.problem.set(''); this.off.set(!r.data.enabled); this.capacity.set(r.data.capacity); this.dropped.set((r.data.first_seq ?? 0) > 1);
      const rs: BusRec[] = r.data.records; this.entries.set(rs); this.stop();
      const from = rs.length ? Math.min(...rs.map((x) => x.at_ms)) - 1000 : 0, to = rs.length ? Math.max(...rs.map((x) => x.at_ms)) + 1000 : 1;
      this.range.set([from, to]); this.cursor.set(from);
    } catch (e) { this.problem.set((e as Error).message); }
  }
}
