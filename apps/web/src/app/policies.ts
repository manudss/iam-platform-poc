import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';

export interface Rule {
  id: string; set: string; name: string; kind: 'policy' | 'template'; effect: 'permit' | 'forbid'; description: string | null; pillar: string | null;
  summary: string; conditions: number; text: string;
}
export interface Usage { allow: number; deny: number; last_at: string | null }
export interface RuleFilter { pillar: string; effect: string; text: string }

/** Distinct grouping labels (the @pillar annotation), sorted; rules without one are grouped under "other". */
export const pillarOf = (r: Rule) => r.pillar ?? 'other';
export const pillars = (rules: Rule[]): string[] => [...new Set(rules.map(pillarOf))].sort();
/** Filter by pillar, effect and a free text matched against id, description, summary and Cedar text (case-insensitive). Empty values mean "all". */
export function filterRules(rules: Rule[], f: RuleFilter): Rule[] {
  const t = f.text.trim().toLowerCase();
  return rules.filter((r) => (!f.pillar || pillarOf(r) === f.pillar) && (!f.effect || r.effect === f.effect)
    && (!t || [r.id, r.description ?? '', r.summary, r.text].some((x) => x.toLowerCase().includes(t))));
}
export const usageText = (u: Usage | undefined) => !u ? 'not used recently' : `${u.allow} allowed, ${u.deny} denied`;

/** Policies plugin screen (policy-studio, step 1): READ-ONLY list of the Cedar rules the core decides with. Nothing here edits a rule. */
@Component({
  selector: 'app-policies', imports: [FormsModule], styleUrl: './pages.css',
  template: `
  <p class="lead">Policies (plugin). The access rules the platform decides with, as the core loaded them. Read-only for now.</p>
  <p class="hint">A <b>forbid</b> always wins over a <b>permit</b>, even when they come from different sets. The decision audit names the rule that decided, with the same name as below.</p>
  @if (problem()) { <p role="alert" class="msg bad" id="pol-problem">{{problem()}}</p> }
  @if (off()) { <p class="hint" id="pol-off">The Policy studio plugin is not enabled on this branch. Enable it in Plugins first.</p> } @else if (rules().length) {
  <section class="card"><div class="row">
    <label>Group<select name="ppillar" [(ngModel)]="f.pillar"><option value="">All</option>@for (p of groups(); track p) { <option [value]="p">{{p}}</option> }</select></label>
    <label>Effect<select name="peffect" [(ngModel)]="f.effect"><option value="">All</option><option value="permit">permit</option><option value="forbid">forbid</option></select></label>
    <label>Search<input name="ptext" [(ngModel)]="f.text" placeholder="name, description or Cedar text" /></label></div>
  <p class="hint" id="pol-count">{{shown().length}} of {{rules().length}} rules in {{sets()}} {{sets() === 1 ? 'set' : 'sets'}}. Usage counts the last {{window()}} audited decisions at most.</p>
  <div class="scroll"><table id="pol-table"><thead><tr><th>Rule</th><th>Effect</th><th>Group</th><th>What it says</th><th>Recent use</th><th></th></tr></thead><tbody>
  @for (r of shown(); track r.id) { <tr><td><b>{{r.id}}</b>@if (r.kind === 'template') { <br><small>template (linked per person, role or resource)</small> }<br><small>set {{r.set}}</small></td>
    <td>{{r.effect}}</td><td>{{r.pillar ?? 'other'}}</td><td>{{r.description ?? r.summary}}@if (r.description) { <br><small>{{r.summary}}</small> }</td>
    <td>{{use(r.id)}}</td><td><button class="secondary" (click)="toggle(r.id)">{{open() === r.id ? 'Hide' : 'Cedar'}}</button></td></tr>
    @if (open() === r.id) { <tr><td colspan="6"><pre id="pol-text">{{r.text}}</pre></td></tr> } }
  @empty { <tr><td colspan="6">No rule matches.</td></tr> }</tbody></table></div></section> }`,
})
export class PoliciesPage {
  protected readonly s = inject(Session);
  protected rules = signal<Rule[]>([]); protected usage = signal<Record<string, Usage>>({}); protected problem = signal(''); protected off = signal(false);
  protected open = signal(''); protected nsets = signal(0); protected win = signal(0);
  protected f: RuleFilter = { pillar: '', effect: '', text: '' };
  constructor() { effect(() => { this.s.branchEpoch(); this.s.adminToken(); void this.load(); }); }
  protected groups() { return pillars(this.rules()); }
  protected shown() { return filterRules(this.rules(), this.f); }
  protected sets() { return this.nsets(); }
  protected window() { return this.win(); }
  protected use(id: string) { return usageText(this.usage()[id]); }
  protected toggle(id: string) { this.open.set(this.open() === id ? '' : id); }
  protected async load() {
    try {
      const h: Record<string, string> = this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {};
      const r = await this.s.api.raw<any>('GET', '/policies', undefined, h);
      if (r.status === 404) { this.off.set(true); this.problem.set(''); return; }
      if (r.status >= 400) { this.problem.set(Array.isArray(r.data.message) ? r.data.message.join(' ') : r.data.message ?? 'Refused'); return; }
      this.off.set(false); this.rules.set(r.data.rules); this.usage.set(r.data.usage ?? {}); this.nsets.set(r.data.engine?.sets ?? 0); this.win.set(r.data.usage_window?.max ?? 0); this.problem.set('');
    } catch (e) { this.problem.set((e as Error).message); }
  }
}
