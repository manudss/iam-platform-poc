import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';

export interface JEntry { id: string; at: string; kind: string; name: string; slot?: string; mode: string; candidates: string[]; answered: string[]; outcome: string; durationMs?: number; detail?: string; payload: Record<string, string> }
export interface Bucket { start: number; count: number; bad: number }
export const PERIODS: Record<string, number> = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 };

/** Pure helper: groups entries into at most `n` equal time buckets (for the timeline bars). */
export function bucketize(entries: JEntry[], from: number, to: number, n = 24): Bucket[] {
  const span = Math.max(to - from, 1), size = span / n;
  const out: Bucket[] = Array.from({ length: n }, (_, i) => ({ start: from + i * size, count: 0, bad: 0 }));
  for (const e of entries) {
    const t = Date.parse(e.at); if (t < from || t > to) continue;
    const b = out[Math.min(n - 1, Math.floor((t - from) / size))]; b.count++; if (e.outcome === 'refused' || e.outcome === 'error') b.bad++;
  }
  return out;
}
/** Plugins that could have answered but did not (display only). */
export function silent(e: JEntry): string[] { return e.candidates.filter((c) => !e.answered.includes(c)); }

/**
 * Hooks journal page (plugin `hooks-journal`). READ ONLY: a visual re-reading of recorded hook calls. There is no button that
 * replays, emits or answers anything. History starts when the plugin was enabled; earlier periods are empty, not reconstructed.
 */
@Component({
  selector: 'app-journal', imports: [FormsModule], styleUrl: './pages.css',
  template: `
  <p class="lead">Hooks journal (plugin). Which plugins could answer a hook, and which one did. Read only: viewing never calls a hook, emits an event or assigns a role.</p>
  @if (problem()) { <p role="alert" class="msg bad" id="jr-problem">{{problem()}}</p> }
  @if (off()) { <p class="hint" id="jr-off">The Hooks journal plugin is not enabled on this branch. Enable it in Plugins first; it records from that moment on.</p> } @else {
  <section class="card">
    <div class="row"><label>Period<select name="jp" [ngModel]="period()" (ngModelChange)="setPeriod($event)" id="jr-period"><option value="1h">Last hour</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option></select></label>
    <label>Kind<select name="jk" [ngModel]="kind()" (ngModelChange)="kind.set($event); load()" id="jr-kind"><option value="">All</option><option value="plugin-hook">Plugin hooks</option><option value="app-event">Application events</option></select></label></div>
    <p class="hint" id="jr-since">@if (since()) { Recording since {{since()}}. Nothing before that moment exists in this journal. } @else { Nothing recorded yet. Recording starts when the plugin is enabled. }</p>
    <svg id="jr-chart" role="img" [attr.aria-label]="'Calls over time: '+total()+' recorded'" viewBox="0 0 480 90" preserveAspectRatio="none" class="jr-chart">
      @for (b of buckets(); track b.start; let i = $index) { <rect [attr.x]="i*20+2" [attr.width]="16" [attr.y]="88-h(b.count)" [attr.height]="h(b.count)" [attr.fill]="b.bad ? '#dc2626' : '#4f46e5'" rx="2"><title>{{b.count}} call(s), {{b.bad}} refused or failed</title></rect> }
    </svg>
    <p class="hint">Bars: calls per slice of the period. Red: at least one refused or failed call. Replay here means reading the past; nothing is re-sent.</p>
  </section>
  <section class="card"><div class="scroll"><table id="jr-table"><thead><tr><th>Time</th><th>Hook</th><th>Could answer</th><th>Answered</th><th>Outcome</th></tr></thead><tbody>
  @for (e of entries(); track e.id) { <tr>
    <td>{{e.at.slice(0,19).replace('T',' ')}}</td><td>{{e.name}}<br><small>{{e.kind}} - {{e.mode}}@if (e.durationMs !== undefined) { - {{e.durationMs}} ms}</small></td>
    <td>@for (c of e.candidates; track c) { <span class="chip">{{c}}</span> } @empty { - }</td>
    <td>@for (a of e.answered; track a) { <span class="chip ok">{{a}}</span> } @empty { <span class="chip warn">nobody</span> }@for (s of silent(e); track s) { <span class="chip mute" title="could answer, did not">{{s}}</span> }</td>
    <td>{{e.outcome}}@if (e.detail) { <br><small>{{e.detail}}</small> }</td></tr> }
  @empty { <tr><td colspan="5">No call recorded in this period.</td></tr> }</tbody></table></div></section> }`,
  styles: [`.jr-chart{width:100%;height:90px;background:#f8fafc;border-radius:.5rem}.chip{display:inline-block;border:1px solid #cbd5e1;border-radius:999px;padding:0 .5rem;margin:0 .2rem .2rem 0;font-size:.8rem}.chip.ok{background:#dcfce7;border-color:#86efac}.chip.warn{background:#fef3c7;border-color:#fcd34d}.chip.mute{opacity:.55;border-style:dashed}`],
})
export class JournalPage {
  protected readonly s = inject(Session);
  protected entries = signal<JEntry[]>([]); protected buckets = signal<Bucket[]>([]); protected total = signal(0); protected since = signal('');
  protected problem = signal(''); protected off = signal(false); protected period = signal('24h'); protected kind = signal('');
  constructor() { effect(() => { this.s.branchEpoch(); this.s.adminToken(); void this.load(); }); }
  protected silent = silent;
  protected h(n: number) { const m = Math.max(1, ...this.buckets().map((b) => b.count)); return n ? Math.max(3, Math.round((n / m) * 80)) : 0; }
  protected setPeriod(p: string) { this.period.set(p); void this.load(); }
  private hd(): Record<string, string> { return this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {}; }
  protected async load() {
    const to = Date.now(), from = to - (PERIODS[this.period()] ?? PERIODS['24h']);
    const q = `?from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(to).toISOString())}&limit=200${this.kind() ? '&kind=' + this.kind() : ''}`;
    try {
      const r = await this.s.api.raw<any>('GET', '/journal/entries' + q, undefined, this.hd());
      if (r.status === 403 && /not enabled/.test(String(r.data?.message))) { this.off.set(true); this.problem.set(''); return; }
      if (r.status >= 400) { this.problem.set(Array.isArray(r.data.message) ? r.data.message.join(' ') : r.data.message ?? 'Refused'); return; }
      this.off.set(false); this.problem.set(''); this.entries.set(r.data.entries); this.total.set(r.data.total); this.since.set(r.data.recordingSince ?? '');
      this.buckets.set(bucketize(r.data.entries, from, to));
    } catch (e) { this.problem.set((e as Error).message); }
  }
}
