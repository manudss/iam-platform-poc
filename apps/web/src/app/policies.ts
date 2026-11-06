import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';

export interface Rule {
  id: string; set: string; name: string; kind: 'policy' | 'template' | 'link'; effect: 'permit' | 'forbid'; description: string | null; pillar: string | null;
  summary: string; conditions: number; text: string; template?: string; values?: Record<string, string>;
}
export interface Candidate { sets: { set: string; text: string }[]; links: { id: string; template: string; values: Record<string, string> }[] }
/** Rebuilds the candidate rule set the validate/simulate endpoints take, from the catalogue: rule texts grouped by set,
 *  links with their beneficiaries. `edit` replaces one rule's text (or adds a new rule), `drop` removes one rule. */
export function buildCandidate(rules: Rule[], edit?: { set: string; id: string; text: string } | null, drop?: { set: string; id: string } | null): Candidate {
  const bySet = new Map<string, string[]>();
  let replaced = false;
  for (const r of rules) {
    if (r.kind === 'link') continue;
    if (drop && r.set === drop.set && r.name === drop.id) continue;
    const list = bySet.get(r.set) ?? bySet.set(r.set, []).get(r.set)!;
    if (edit && r.set === edit.set && r.name === edit.id) { list.push(edit.text); replaced = true; } else list.push(r.text);
  }
  if (edit && !replaced) (bySet.get(edit.set) ?? bySet.set(edit.set, []).get(edit.set)!).push(edit.text);
  return {
    sets: [...bySet.entries()].map(([set, texts]) => ({ set, text: texts.join('\n\n') })),
    links: rules.filter((r) => r.kind === 'link').map((r) => ({ id: r.id, template: r.template ?? '', values: r.values ?? {} })),
  };
}
/** Beneficiary suggestions for a template link: every known person, role and organisation as an entity uid. */
export function beneficiaryOptions(users: string[], roles: string[], orgs: string[]): string[] {
  return [...users.map((u) => `User::"${u}"`), ...roles.map((r) => `Role::"${r}"`), ...orgs.map((o) => `Organization::"${o}"`)];
}
/** The beneficiary of a link, for the catalogue row. */
export const targetOf = (r: Rule) => Object.values(r.values ?? {}).join(', ');
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

/** Policies plugin screen (policy-studio): the catalogue of the Cedar rules the core decides with, the "why refused?" simulator (which runs on your CANDIDATE rules while the editor is open), and the editor: rule and link changes are validated against the schema by the core and committed on their own Dolt branch - they decide only after a merge + Apply (Workspace). */
@Component({
  selector: 'app-policies', imports: [FormsModule], styleUrl: './pages.css',
  template: `
  <p class="lead">Policies (plugin). The access rules the platform decides with, as the core loaded them. Changes happen on a branch, validated against the Cedar schema before they are committed; nothing decides until you merge and Apply.</p>
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
    <td>{{use(r.id)}}@if (r.kind === 'link') { <br><small>for {{target(r)}}</small> }</td>
    <td><button class="secondary" (click)="toggle(r.id)">{{open() === r.id ? 'Hide' : 'Cedar'}}</button>@if (r.kind !== 'link') { <button class="secondary" [id]="'pol-edit-'+r.id" (click)="startEdit(r)">Edit</button> <button class="secondary" (click)="removeRule(r)">Delete</button> }@if (r.kind === 'template') { <button class="secondary" (click)="startLink(r)">Link</button> }@if (r.kind === 'link') { <button class="secondary" (click)="removeLink(r)">Unlink</button> }</td></tr>
    @if (open() === r.id) { <tr><td colspan="6"><pre id="pol-text">{{r.text}}</pre></td></tr> } }
  @empty { <tr><td colspan="6">No rule matches.</td></tr> }</tbody></table></div></section>
  <section class="card" id="edit-card"><h3>Edit the rules (on a branch)</h3>
    <p class="hint">One change per branch. The core dry-builds the branch's whole rule set against the Cedar schema BEFORE anything is committed; a refused change names the rule and keeps nothing. A committed change still decides nothing until you merge the branch and Apply it (Workspace).</p>
    @if (!editing() && !linking()) { <p><button id="pol-new" (click)="startNew()">New rule</button></p> }
    @if (editing()) { <div class="row">
      <label>Set<input name="ed-set" [(ngModel)]="edit.set" list="pol-sets" /><datalist id="pol-sets">@for (sn of setNames(); track sn) { <option [value]="sn"></option> }</datalist></label>
      <label>Rule id<input name="ed-id" [(ngModel)]="edit.id" placeholder="approve-needs-payment-approver" /></label></div>
      <div class="row"><label style="flex:1">Cedar<textarea name="ed-cedar" rows="6" [(ngModel)]="edit.cedar" placeholder='permit(principal, action == Action::"approve", resource) when { ... };'></textarea></label></div>
      <p class="hint">While this editor is open, the simulator below runs on YOUR candidate rules (this change included).</p>
      <p><button id="ed-propose" (click)="proposeRule()" [disabled]="propBusy()">{{propBusy() ? 'Checking...' : 'Validate and commit on a branch'}}</button> <button class="secondary" (click)="cancelEdit()">Cancel</button></p> }
    @if (linking()) { <div class="row">
      <label>Link id<input name="lk-id" [(ngModel)]="link.id" placeholder="delegate:demo-bob" /></label>
      <label>Beneficiary<input name="lk-principal" [(ngModel)]="link.principal" list="pol-beneficiaries" placeholder='User::"demo-bob" or Role::"auditor"' /><datalist id="pol-beneficiaries">@for (b of beneficiaries(); track b) { <option [value]="b"></option> }</datalist></label>
      <label>Resource (optional)<input name="lk-resource" [(ngModel)]="link.resource" placeholder='Request::"r42"' /></label></div>
      <p class="hint">Instantiates the template <b>{{link.template}}</b> once, for this beneficiary. Pick people, roles and organisations that exist: the schema does not check a mistyped value - it would simply never match.</p>
      <p><button id="lk-propose" (click)="proposeLink()" [disabled]="propBusy()">{{propBusy() ? 'Checking...' : 'Validate and commit on a branch'}}</button> <button class="secondary" (click)="cancelEdit()">Cancel</button></p> }
    @if (propProblem()) { <p role="alert" class="msg bad" id="prop-problem">{{propProblem()}}</p> }
    @if (propOut(); as o) { <div class="result" id="prop-result"><b>Validated against the schema and committed.</b> Branch <b>{{o.branch}}</b>, commit {{o.commit}}@if (o.engine) { - {{o.engine.rules}} rules in {{o.engine.sets}} {{o.engine.sets === 1 ? 'set' : 'sets'}} }.<br><small>Nothing decides yet: merge the branch and Apply it in the Workspace to make it live.</small></div> }
  </section>
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
      @if (editing()) { <br><small>Answer computed on YOUR candidate rules (the editor's change included).</small> }
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
  protected target(r: Rule) { return targetOf(r); }
  protected setNames() { return [...new Set(this.rules().map((r) => r.set))].sort(); }
  protected edit = { set: 'default', id: '', cedar: '' };
  protected link = { id: '', template: '', principal: '', resource: '' };
  protected editing = signal(false); protected linking = signal(false);
  protected propBusy = signal(false); protected propProblem = signal(''); protected propOut = signal<{ branch: string; commit: string; valid: boolean; engine?: { rules: number; sets: number } } | null>(null);
  protected beneficiaries = signal<string[]>([]);
  private h(): Record<string, string> { const t = this.s.adminToken(); return t ? { 'x-api-admin-token': t } : {}; }
  private msg(r: { data: { message?: string | string[] } }) { return Array.isArray(r.data.message) ? r.data.message.join(' ') : r.data.message ?? 'Refused'; }
  protected startNew() { this.edit = { set: this.setNames()[0] ?? 'default', id: '', cedar: '' }; this.editing.set(true); this.linking.set(false); this.propProblem.set(''); this.propOut.set(null); }
  protected startEdit(r: Rule) { this.edit = { set: r.set, id: r.name, cedar: r.text }; this.editing.set(true); this.linking.set(false); this.propProblem.set(''); this.propOut.set(null); }
  protected startLink(t: Rule) { this.link = { id: `${t.id}:`, template: t.id, principal: '', resource: '' }; this.linking.set(true); this.editing.set(false); this.propProblem.set(''); this.propOut.set(null); void this.loadBeneficiaries(); }
  protected cancelEdit() { this.editing.set(false); this.linking.set(false); }
  private async propose(path: string, body: object) {
    this.propBusy.set(true); this.propProblem.set(''); this.propOut.set(null);
    try {
      const r = await this.s.api.raw<{ branch: string; commit: string; valid: boolean; engine?: { rules: number; sets: number }; message?: string | string[] }>('POST', path, body, this.h());
      if (r.status >= 400) { this.propProblem.set(this.msg(r)); return; }
      this.propOut.set(r.data); this.editing.set(false); this.linking.set(false);
    } catch (e) { this.propProblem.set((e as Error).message); } finally { this.propBusy.set(false); }
  }
  protected proposeRule() {
    if (!this.edit.id.trim() || !this.edit.cedar.trim() || !this.edit.set.trim()) { this.propProblem.set('Set, rule id and Cedar text are required.'); return; }
    void this.propose('/policies/rules/propose', { op: 'upsert', set: this.edit.set.trim(), id: this.edit.id.trim(), cedar: this.edit.cedar });
  }
  protected removeRule(r: Rule) { if (confirm(`Delete the rule ${r.id}? It happens on its own branch and decides only after you merge and Apply it.`)) void this.propose('/policies/rules/propose', { op: 'delete', set: r.set, id: r.name }); }
  protected proposeLink() {
    if (!this.link.id.trim() || !this.link.principal.trim()) { this.propProblem.set('Link id and beneficiary are required.'); return; }
    const values: Record<string, string> = { principal: this.link.principal.trim() };
    if (this.link.resource.trim()) values['resource'] = this.link.resource.trim();
    void this.propose('/policies/links/propose', { op: 'upsert', id: this.link.id.trim(), template: this.link.template, values });
  }
  protected removeLink(r: Rule) { if (confirm(`Remove the link ${r.id} (the grant to ${targetOf(r)})? It happens on its own branch and decides only after you merge and Apply it.`)) void this.propose('/policies/links/propose', { op: 'delete', id: r.id }); }
  private async loadBeneficiaries() {
    try {
      const [u, ro, o] = await Promise.all([
        this.s.api.raw<{ users?: { id: string }[] }>('GET', '/users', undefined, this.h()),
        this.s.api.raw<{ roles?: { id: string }[] }>('GET', '/roles', undefined, this.h()),
        this.s.api.raw<{ organizations?: { id: string }[] }>('GET', '/organizations', undefined, this.h()),
      ]);
      this.beneficiaries.set(beneficiaryOptions((u.data.users ?? []).map((x) => x.id), (ro.data.roles ?? []).map((x) => x.id), (o.data.organizations ?? []).map((x) => x.id)));
    } catch { /* the picker stays free-text */ }
  }
  protected sim = { principal: 'User::"alice"', action: 'Action::"approve"', resource: 'Request::"r1"', contextText: '' };
  protected simBusy = signal(false); protected simOut = signal<SimResult | null>(null); protected simProblem = signal('');
  protected erroredText(rules: { id: string; error: string }[]) { return rules.map((r) => r.id).join(', '); }
  protected async runSim() {
    const parsed = parseSimContext(this.sim.contextText);
    if (parsed.error) { this.simProblem.set(parsed.error); return; }
    this.simBusy.set(true); this.simProblem.set(''); this.simOut.set(null);
    try {
      const h: Record<string, string> = this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {};
      const cand = this.editing() ? buildCandidate(this.rules(), { set: this.edit.set.trim(), id: this.edit.id.trim(), text: this.edit.cedar }) : undefined;
      const r = await this.s.api.raw<SimResult & { message?: string }>('POST', '/policies/simulate',
        { principal: this.sim.principal, action: this.sim.action, resource: this.sim.resource, ...(parsed.context ? { context: parsed.context } : {}), ...(cand ? { policies: cand } : {}) }, h);
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
