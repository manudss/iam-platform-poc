import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';

export interface Rule {
  id: string; set: string; name: string; kind: 'policy' | 'template'; effect: 'permit' | 'forbid'; description: string | null; pillar: string | null;
  summary: string; conditions: number; text: string;
}
export interface Usage { allow: number; deny: number; last_at: string | null }
export interface RuleFilter { pillar: string; effect: string; text: string }
export interface SimResult {
  allow: boolean; reasons: string[]; errors: string[]; matched_permits: string[]; matched_forbids: string[];
  errored_rules: { id: string; error: string }[]; templates: string[]; explanation: string;
}
/** Parses the simulator's context field: empty means "no context", otherwise a JSON object. */
export function parseSimContext(text: string): { context?: Record<string, unknown>; error?: string } {
  const t = text.trim();
  if (!t) return {};
  try {
    const v = JSON.parse(t) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { error: 'The context must be a JSON object, e.g. {"roles": ["payment-approver"]}.' };
    return { context: v as Record<string, unknown> };
  } catch { return { error: 'The context is not valid JSON.' }; }
}

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
/** Whether the core validated the rules against its Cedar schema at load (policy-studio step 2). */
export const schemaText = (v: boolean | undefined) => v
  ? 'Every rule was validated against the Cedar schema when the core loaded them.'
  : 'No Cedar schema: the rules were loaded without validation.';

/** Policies plugin screen (policy-studio): step 1 = READ-ONLY catalogue of the Cedar rules the core decides with; step 3 = the "why refused?" simulator. Nothing here edits a rule. */
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
  <p class="hint" id="pol-schema">{{schemaLine()}}</p>
  <div class="scroll"><table id="pol-table"><thead><tr><th>Rule</th><th>Effect</th><th>Group</th><th>What it says</th><th>Recent use</th><th></th></tr></thead><tbody>
  @for (r of shown(); track r.id) { <tr><td><b>{{r.id}}</b>@if (r.kind === 'template') { <br><small>template (linked per person, role or resource)</small> }<br><small>set {{r.set}}</small></td>
    <td>{{r.effect}}</td><td>{{r.pillar ?? 'other'}}</td><td>{{r.description ?? r.summary}}@if (r.description) { <br><small>{{r.summary}}</small> }</td>
    <td>{{use(r.id)}}</td><td><button class="secondary" (click)="toggle(r.id)">{{open() === r.id ? 'Hide' : 'Cedar'}}</button></td></tr>
    @if (open() === r.id) { <tr><td colspan="6"><pre id="pol-text">{{r.text}}</pre></td></tr> } }
  @empty { <tr><td colspan="6">No rule matches.</td></tr> }</tbody></table></div></section>
  <section class="card" id="sim-card"><h3>Simulator: why refused?</h3>
    <p class="hint">Try a request against the loaded rules. The answer names every permit and forbid that matches, not only the one that decides. The context is yours to invent: the simulator never reads the tenant's data, so you can explore roles or conflicts nobody has. Nothing is decided or recorded.</p>
    <div class="row">
      <label>Person<input name="sim-principal" [(ngModel)]="sim.principal" placeholder='User::"alice"' /></label>
      <label>Action<input name="sim-action" [(ngModel)]="sim.action" placeholder='Action::"approve"' /></label>
      <label>Resource<input name="sim-resource" [(ngModel)]="sim.resource" placeholder='Request::"r1"' /></label></div>
    <div class="row"><label style="flex:1">Context (JSON, optional)<textarea name="sim-context" rows="2" [(ngModel)]="sim.contextText" placeholder='{"roles": ["payment-approver"], "sod_conflict": true}'></textarea></label></div>
    <p><button (click)="runSim()" [disabled]="simBusy()">{{simBusy() ? 'Simulating...' : 'Simulate'}}</button></p>
    @if (simProblem()) { <p role="alert" class="msg bad" id="sim-problem">{{simProblem()}}</p> }
    @if (simOut(); as o) { <div class="result" [class.bad]="!o.allow" id="sim-result">
      <b>{{o.allow ? 'ALLOWED' : 'DENIED'}}</b> {{o.explanation}}
      <br><small>Deciding: {{o.reasons.join(', ') || 'none'}} - Matching permits: {{o.matched_permits.join(', ') || 'none'}} - Matching forbids: {{o.matched_forbids.join(', ') || 'none'}}</small>
      @if (o.errored_rules.length) { <br><small>Errored and skipped: {{erroredText(o.errored_rules)}}</small> }
      @if (o.templates.length) { <br><small>Templates apply only once linked per person, role or resource: {{o.templates.join(', ')}}</small> }
    </div> }
  </section> }`,
})
export class PoliciesPage {
  protected readonly s = inject(Session);
  protected rules = signal<Rule[]>([]); protected usage = signal<Record<string, Usage>>({}); protected problem = signal(''); protected off = signal(false);
  protected open = signal(''); protected nsets = signal(0); protected win = signal(0); protected validated = signal<boolean | undefined>(undefined);
  protected f: RuleFilter = { pillar: '', effect: '', text: '' };
  constructor() { effect(() => { this.s.branchEpoch(); this.s.adminToken(); void this.load(); }); }
  protected groups() { return pillars(this.rules()); }
  protected shown() { return filterRules(this.rules(), this.f); }
  protected sets() { return this.nsets(); }
  protected window() { return this.win(); }
  protected use(id: string) { return usageText(this.usage()[id]); }
  protected schemaLine() { return schemaText(this.validated()); }
  protected toggle(id: string) { this.open.set(this.open() === id ? '' : id); }
  protected sim = { principal: 'User::"alice"', action: 'Action::"approve"', resource: 'Request::"r1"', contextText: '' };
  protected simBusy = signal(false); protected simOut = signal<SimResult | null>(null); protected simProblem = signal('');
  protected erroredText(rules: { id: string; error: string }[]) { return rules.map((r) => r.id).join(', '); }
  protected async runSim() {
    const parsed = parseSimContext(this.sim.contextText);
    if (parsed.error) { this.simProblem.set(parsed.error); return; }
    this.simBusy.set(true); this.simProblem.set(''); this.simOut.set(null);
    try {
      const h: Record<string, string> = this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {};
      const r = await this.s.api.raw<SimResult & { message?: string }>('POST', '/policies/simulate',
        { principal: this.sim.principal, action: this.sim.action, resource: this.sim.resource, ...(parsed.context ? { context: parsed.context } : {}) }, h);
      if (r.status >= 400) { this.simProblem.set(Array.isArray(r.data.message) ? r.data.message.join(' ') : r.data.message ?? 'Refused'); return; }
      this.simOut.set(r.data);
    } catch (e) { this.simProblem.set((e as Error).message); } finally { this.simBusy.set(false); }
  }
  protected async load() {
    try {
      const h: Record<string, string> = this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {};
      const r = await this.s.api.raw<any>('GET', '/policies', undefined, h);
      if (r.status === 404) { this.off.set(true); this.problem.set(''); return; }
      if (r.status >= 400) { this.problem.set(Array.isArray(r.data.message) ? r.data.message.join(' ') : r.data.message ?? 'Refused'); return; }
      this.off.set(false); this.rules.set(r.data.rules); this.usage.set(r.data.usage ?? {}); this.nsets.set(r.data.engine?.sets ?? 0); this.validated.set(r.data.engine?.schema); this.win.set(r.data.usage_window?.max ?? 0); this.problem.set('');
    } catch (e) { this.problem.set((e as Error).message); }
  }
}
