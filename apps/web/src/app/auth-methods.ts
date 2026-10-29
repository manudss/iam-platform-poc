import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';

export interface MethodInstance { id: string; type: string; name: string; enabled: boolean; level: number; config: Record<string, any> }
export interface Chain { id: string; name: string; enabled: boolean; steps: string[]; level: number; note?: string }
export interface AuthnConfig { methods: MethodInstance[]; chains: Chain[]; defaultChain: string | null }
export interface Analysis { id: string; declaredLevel: number; effectiveLevel: number; maxStepLevel: number; verifiedFactors: string[]; simulatedSteps: string[]; mfa: boolean; warnings: string[]; basis: string }
interface SettingField { key: string; type: string; label: string; help?: string; default?: unknown; options?: { value: string; label: string }[]; min?: number; max?: number; visibleIf?: { key: string; equals: unknown } }
export interface CatalogueEntry { id: string; name: string; description: string; factor: string; maturity: 'implemented' | 'catalogue'; suggestedLevel: number; provisioning: string; settings: SettingField[]; simulatedByDefault: boolean }

/** Suggestion only: a chain cannot be weaker than its strongest step, so that is the starting value. The administrator sets the real level. */
export const suggestChainLevel = (cfg: AuthnConfig, steps: string[]) => Math.max(1, ...steps.map((s) => cfg.methods.find((m) => m.id === s)?.level ?? 1));
export const slug = (s: string, taken: string[]) => { const b = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34) || 'item'; let id = b, i = 2; while (taken.includes(id)) id = `${b}-${i++}`; return id; };

/**
 * Administration of authentication methods (plugins), their ordered instances and the chains the core runs at sign-in.
 * Everything is saved on the selected working branch and becomes the live sign-in only after Apply. Levels are configured, not measured.
 */
@Component({
  selector: 'app-auth-methods', imports: [FormsModule], styleUrl: './auth-methods.css',
  template: `
  <p class="lead">Choose how people prove who they are. Each <b>method</b> is a plugin type with its own settings; a type can be added several times with different settings. A <b>chain</b> runs several methods one after the other: sign-in succeeds only if every step succeeds.</p>
  <p class="hint"><b>Security level 1 to 10, 10 = strongest.</b> Levels are set by you: they are declared, not measured, and are never added up. They are meant to be used later to decide which services need which level. Fictional demo only.</p>
  @if (note()) { <p role="status" class="msg" id="authn-note">{{note()}}</p> }
  @if (problem()) { <p role="alert" class="msg bad" id="authn-problem">{{problem()}}</p> }
  <section class="card" id="authn-live"><h3>Live sign-in</h3>
    <p>@if (liveMode()==='chain') { Live sign-in runs the chain <b>{{liveChain()}}</b>. } @else { Live sign-in uses the single base password plugin (no chain is applied yet). }
    @if (dirty()) { <span class="pill warn">Unsaved edits</span> } @else if (differsFromLive()) { <span class="pill warn">Saved on this branch, not live until Apply</span> } @else { <span class="pill ok">Same as live</span> }</p>
  </section>

  <section class="card" id="authn-methods"><h3>Methods (in order)</h3>
    <p class="hint">The order is your display and priority order. Chain steps have their own order below.</p>
    <div class="scroll"><table><thead><tr><th>#</th><th>Name</th><th>Plugin type</th><th>Factor</th><th>Level (1-10)</th><th>On</th><th></th></tr></thead><tbody>
    @for (m of cfg().methods; track m.id; let i = $index) {
      <tr [class.sel]="editing()===m.id">
        <td>{{i+1}}</td><td><input class="name" [name]="'mn'+m.id" [ngModel]="m.name" (ngModelChange)="m.name=$event;touch()" maxlength="60" [attr.aria-label]="'Name of '+m.id" /><br><small>{{m.id}}</small></td>
        <td>{{typeName(m.type)}} @if (sim(m)) { <span class="pill warn" title="No real proof of the factor">simulated</span> }</td>
        <td>{{factor(m.type)}}</td>
        <td><input type="number" class="lvl" min="1" max="10" [name]="'ml'+m.id" [ngModel]="m.level" (ngModelChange)="m.level=+$event;touch()" [attr.aria-label]="'Level of '+m.id" /></td>
        <td><input type="checkbox" [name]="'me'+m.id" [ngModel]="m.enabled" (ngModelChange)="m.enabled=$event;touch()" [attr.aria-label]="'Enable '+m.id" /></td>
        <td class="acts"><button class="secondary" (click)="move(cfg().methods,i,-1)" [disabled]="i===0" aria-label="Move up">↑</button><button class="secondary" (click)="move(cfg().methods,i,1)" [disabled]="i===cfg().methods.length-1" aria-label="Move down">↓</button>
          <button class="secondary" (click)="editing.set(editing()===m.id?'':m.id)">Settings</button><button class="secondary" (click)="removeMethod(m.id)">Remove</button></td>
      </tr>
      @if (editing()===m.id) { <tr class="detail"><td colspan="7">
        <p class="hint">{{entry(m.type)?.description}}</p>
        @for (f of fields(m); track f.key) { <label>{{f.label}}
          @switch (f.type) {
            @case ('select') { <select [name]="'cf'+m.id+f.key" [ngModel]="m.config[f.key] ?? f.default" (ngModelChange)="m.config[f.key]=$event;touch()">@for (o of f.options; track o.value) {<option [value]="o.value">{{o.label}}</option>}</select> }
            @case ('number') { <input type="number" [attr.min]="f.min ?? null" [attr.max]="f.max ?? null" [name]="'cf'+m.id+f.key" [ngModel]="m.config[f.key] ?? f.default" (ngModelChange)="m.config[f.key]=+$event;touch()" /> }
            @default { <input type="text" [name]="'cf'+m.id+f.key" [ngModel]="m.config[f.key] ?? f.default" (ngModelChange)="m.config[f.key]=$event;touch()" /> }
          }@if (f.help) {<small>{{f.help}}</small>}</label> } @empty { <p class="hint">This type has no settings.</p> }
        @if (entry(m.type)?.provisioning==='admin-demo') { <div class="enroll"><h4>Demo enrollment for a user</h4>
          <p class="hint">Provisioned by an administrator for this demo only and stored outside the database. A secret or a generated PIN is shown once, here, and cannot be shown again. Save the method first.</p>
          <div class="row"><label>User<input type="text" name="enrolluser" [(ngModel)]="enrollUser" /></label>
          @if (m.type==='email-otp') { <label>Demo address (used only when the user has no e-mail on the profile)<input type="text" name="enrollemail" [(ngModel)]="enrollEmail" /></label> }
          @if (m.type==='digit-code') { <label>PIN (exactly the digits set in Settings, or leave empty to generate)<input type="password" name="enrollpin" [(ngModel)]="enrollPin" autocomplete="off" inputmode="numeric" /></label> }
          <button (click)="enroll(m)" [disabled]="busy()">Provision</button></div>
          @if (shown() && shownFor()===m.id) { <div class="result" id="authn-shown"><b>Shown once.</b> {{shown()}}</div> }
        </div> }
      </td></tr> }
    } @empty { <tr><td colspan="7">No methods yet. Add one below, or create the starter set.</td></tr> }
    </tbody></table></div>
    <div class="row add"><label>Add a method of type<select name="newtype" [(ngModel)]="newType">@for (t of implemented(); track t.id) {<option [value]="t.id">{{t.name}}</option>}</select></label>
      <label>Name<input type="text" name="newname" [(ngModel)]="newName" maxlength="60" placeholder="for example Authenticator app" /></label>
      <button id="authn-add-method" (click)="addMethod()">Add method</button>
      @if (!cfg().methods.length) { <button class="secondary" id="authn-starter" (click)="starter()">Create starter set</button> }</div>
  </section>

  <section class="card" id="authn-chains"><h3>Chains</h3>
    <p class="hint">A chain is an ordered list of method instances. The level of a chain is yours to declare (it cannot be below its strongest step). It is not the sum of the steps.</p>
    @for (c of cfg().chains; track c.id; let ci = $index) {
      <div class="chain" [attr.data-chain]="c.id">
        <div class="row"><label>Name<input type="text" class="name" [name]="'cn'+c.id" [ngModel]="c.name" (ngModelChange)="c.name=$event;touch()" maxlength="60" /></label>
          <label>Declared level (1-10)<input type="number" class="lvl" min="1" max="10" [name]="'cl'+c.id" [ngModel]="c.level" (ngModelChange)="c.level=+$event;touch()" /></label>
          <label class="inline"><input type="checkbox" [name]="'ce'+c.id" [ngModel]="c.enabled" (ngModelChange)="c.enabled=$event;touch()" /> Enabled</label>
          <label class="inline"><input type="radio" name="defaultchain" [value]="c.id" [ngModel]="cfg().defaultChain" (ngModelChange)="cfg().defaultChain=$event;touch()" /> Used for sign-in</label>
          <button class="secondary" (click)="suggest(c)">Suggest level</button><button class="secondary" (click)="removeChain(c.id)">Remove chain</button></div>
        <ol class="steps">@for (s of c.steps; track s; let si = $index) { <li><b>{{methodName(s)}}</b> <small>level {{methodLevel(s)}} · {{factor(methodType(s))}}@if (simId(s)) { · simulated }</small>
          <button class="secondary" (click)="move(c.steps,si,-1)" [disabled]="si===0" aria-label="Step up">↑</button><button class="secondary" (click)="move(c.steps,si,1)" [disabled]="si===c.steps.length-1" aria-label="Step down">↓</button><button class="secondary" (click)="c.steps.splice(si,1);touch()">Remove step</button></li> }
          @if (!c.steps.length) { <li class="hint">No steps.</li> }</ol>
        <div class="row"><label>Add a step<select [attr.name]="'as'+c.id" (change)="stepPick[c.id]=$any($event.target).value">@for (m of cfg().methods; track m.id) { @if (!c.steps.includes(m.id)) {<option [value]="m.id">{{m.name}} ({{m.id}})</option>} }</select></label>
          <button class="secondary" (click)="addStep(c)">Add step</button>
          <button class="secondary" (click)="c.note=c.note?'':' ';touch()" hidden>.</button></div>
        @if (analysis(c.id); as a) { <div class="analysis"><span class="pill" [class.ok]="a.mfa" [class.warn]="!a.mfa">{{a.mfa ? 'Multi-factor (2+ verified factor categories)' : 'Not multi-factor'}}</span>
          <span class="pill">Declared level {{a.declaredLevel}}</span><span class="pill" [class.warn]="a.effectiveLevel<a.declaredLevel">Effective level {{a.effectiveLevel}}</span>
          <span class="pill">Verified factors: {{a.verifiedFactors.join(', ') || 'none'}}</span>
          @for (w of a.warnings; track w) { <p class="warnline">⚠ {{w}}</p> }<small>{{a.basis}}</small></div> }
      </div>
    } @empty { <p class="hint">No chains yet.</p> }
    <div class="row add"><label>New chain name<input type="text" name="newchain" [(ngModel)]="newChain" maxlength="60" placeholder="for example Password then authenticator" /></label><button id="authn-add-chain" (click)="addChain()">Add chain</button></div>
  </section>

  <section class="card"><div class="row"><button id="authn-save" (click)="save()" [disabled]="busy() || !!problem() || (s.branch()==='main')">Save on this branch</button><button class="secondary" (click)="load()">Discard edits and reload</button>
    <button class="secondary" (click)="showOutbox()">Demo outbox</button></div>
    @if (s.branch()==='main') { <p class="hint">Choose a working branch (not main) to save. Changes become live only after Apply.</p> }
    @if (outbox()) { <div class="result" id="authn-outbox"><b>Demo outbox (simulated: no e-mail is sent).</b> Codes appear here in clear for administrators.
      <ul>@for (m of outbox(); track m.at) { <li>{{m.at}} to {{m.to}} (user {{m.user}}): {{m.text}}</li> } @empty { <li>Empty.</li> }</ul></div> }
  </section>

  <section class="card"><h3>Catalogue</h3><div class="scroll"><table><thead><tr><th>Type</th><th>Factor</th><th>Suggested level</th><th>Status</th><th>What it does</th></tr></thead><tbody>
    @for (t of catalogue(); track t.id) { <tr><td>{{t.name}}</td><td>{{t.factor}}</td><td>{{t.suggestedLevel}}</td><td>@if (t.maturity==='implemented') { <span class="pill ok">implemented</span> @if (t.simulatedByDefault) { <span class="pill warn">simulated delivery</span> } } @else { <span class="pill">not built</span> }</td><td>{{t.description}}</td></tr> }
  </tbody></table></div></section>`,
})
export class AuthMethodsPage {
  protected readonly s = inject(Session);
  protected cfg = signal<AuthnConfig>({ methods: [], chains: [], defaultChain: null });
  protected catalogue = signal<CatalogueEntry[]>([]);
  protected analyses = signal<Analysis[]>([]);
  protected live = signal<{ config: AuthnConfig; signInMode: string } | null>(null);
  protected saved = '';
  protected note = signal(''); protected problem = signal(''); protected busy = signal(false); protected dirty = signal(false);
  protected editing = signal(''); protected shown = signal(''); protected shownFor = signal(''); protected outbox = signal<{ at: string; to: string; user: string; text: string }[] | null>(null);
  protected newType = 'totp'; protected newName = ''; protected newChain = ''; protected stepPick: Record<string, string> = {};
  protected enrollUser = 'demo-alice'; protected enrollEmail = ''; protected enrollPin = '';
  private timer?: ReturnType<typeof setTimeout>;

  constructor() { effect(() => { this.s.branchEpoch(); this.s.adminToken(); void this.load(); }); }
  private h(): Record<string, string> { return this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {}; }
  protected implemented() { return this.catalogue().filter((t) => t.maturity === 'implemented'); }
  protected entry(id: string) { return this.catalogue().find((t) => t.id === id); }
  protected typeName(id: string) { return this.entry(id)?.name ?? id; }
  protected factor(id: string) { return this.entry(id)?.factor ?? ''; }
  protected methodName(id: string) { return this.cfg().methods.find((m) => m.id === id)?.name ?? id; }
  protected methodLevel(id: string) { return this.cfg().methods.find((m) => m.id === id)?.level ?? 0; }
  protected methodType(id: string) { return this.cfg().methods.find((m) => m.id === id)?.type ?? ''; }
  protected sim(m: MethodInstance) { return m.type === 'email-otp' && (m.config['delivery'] ?? 'demo-outbox') === 'demo-outbox'; }
  protected simId(id: string) { const m = this.cfg().methods.find((x) => x.id === id); return !!m && this.sim(m); }
  protected analysis(id: string) { return this.analyses().find((a) => a.id === id); }
  protected fields(m: MethodInstance) { return (this.entry(m.type)?.settings ?? []).filter((f) => !f.visibleIf || (m.config[f.visibleIf.key] ?? this.entry(m.type)?.settings.find((x) => x.key === f.visibleIf!.key)?.default) === f.visibleIf.equals); }
  protected liveMode() { return this.live()?.signInMode ?? 'base-password'; }
  protected liveChain() { const l = this.live(); return l?.config.chains.find((c) => c.id === l.config.defaultChain)?.name ?? ''; }
  protected differsFromLive() { return !!this.live() && JSON.stringify(this.cfg()) !== JSON.stringify(this.live()!.config); }

  protected async load() {
    try {
      const r = await this.s.api.raw<any>('GET', '/auth', undefined, this.h());
      this.catalogue.set(r.data.catalogue); this.cfg.set(r.data.working.config); this.analyses.set(r.data.working.analyses); this.live.set({ config: r.data.live.config, signInMode: r.data.live.signInMode });
      this.saved = JSON.stringify(r.data.working.config); this.dirty.set(false); this.problem.set('');
    } catch (e) { this.problem.set((e as Error).message); }
  }
  protected touch() { this.dirty.set(JSON.stringify(this.cfg()) !== this.saved); clearTimeout(this.timer); this.timer = setTimeout(() => void this.analyze(), 250); }
  private async analyze() {
    try { const r = await this.s.api.raw<any>('POST', '/auth/analyze', { config: this.cfg() }, this.h()); this.analyses.set(r.data.analyses); this.problem.set(''); }
    catch (e) { this.problem.set((e as Error).message); }
  }
  protected move<T>(a: T[], i: number, d: number) { const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; this.touch(); }
  protected addMethod() {
    const t = this.entry(this.newType); if (!t) return; const name = this.newName.trim() || t.name;
    const c = this.cfg(); c.methods.push({ id: slug(name, c.methods.map((m) => m.id)), type: t.id, name, enabled: true, level: t.suggestedLevel, config: Object.fromEntries(t.settings.filter((f) => f.default !== undefined).map((f) => [f.key, f.default])) });
    this.newName = ''; this.touch();
  }
  protected removeMethod(id: string) {
    const c = this.cfg(); if (c.chains.some((x) => x.steps.includes(id))) { this.problem.set(`Remove ${id} from its chains first.`); return; }
    c.methods = c.methods.filter((m) => m.id !== id); this.touch();
  }
  protected addChain() { const c = this.cfg(), name = this.newChain.trim() || 'New chain'; c.chains.push({ id: slug(name, c.chains.map((x) => x.id)), name, enabled: true, steps: [], level: 1 }); this.newChain = ''; this.touch(); }
  protected removeChain(id: string) { const c = this.cfg(); c.chains = c.chains.filter((x) => x.id !== id); if (c.defaultChain === id) c.defaultChain = null; this.touch(); }
  protected addStep(c: Chain) { const id = this.stepPick[c.id] || this.cfg().methods.find((m) => !c.steps.includes(m.id))?.id; if (!id) return; c.steps.push(id); c.level = Math.max(c.level, suggestChainLevel(this.cfg(), c.steps)); this.touch(); }
  protected suggest(c: Chain) { c.level = suggestChainLevel(this.cfg(), c.steps); this.note.set(`Suggested ${c.level}: the strongest step. Only a starting point, set the level you want to declare.`); this.touch(); }
  protected starter() {
    const c = this.cfg(), pw = this.entry('password')!;
    c.methods.push({ id: 'password', type: 'password', name: 'Password', enabled: true, level: pw.suggestedLevel, config: {} });
    c.chains.push({ id: 'password-only', name: 'Password only', enabled: true, steps: ['password'], level: pw.suggestedLevel }); c.defaultChain = 'password-only'; this.touch();
  }
  protected async save() {
    this.busy.set(true); this.note.set('');
    try {
      const r = await this.s.api.raw<any>('PUT', '/auth', { config: this.cfg() }, this.h());
      this.cfg.set(r.data.config); this.analyses.set(r.data.analyses); this.saved = JSON.stringify(r.data.config); this.dirty.set(false); this.problem.set('');
      this.note.set('Saved on the working branch. Sign-in does not change until Apply.'); await this.load();
    } catch (e) { this.problem.set((e as Error).message); } finally { this.busy.set(false); }
  }
  protected async enroll(m: MethodInstance) {
    if (this.dirty()) { this.problem.set('Save the method first, then provision.'); return; }
    this.busy.set(true); this.shown.set('');
    try {
      const body: Record<string, unknown> = m.type === 'email-otp' ? { email: this.enrollEmail } : m.type === 'digit-code' ? (this.enrollPin ? { pin: this.enrollPin } : {}) : {};
      const r = await this.s.api.raw<any>('POST', `/auth/enrollments/${encodeURIComponent(this.enrollUser)}/${encodeURIComponent(m.id)}`, body, this.h());
      const o = r.data.shownOnce; this.shownFor.set(m.id); this.enrollPin = '';
      this.shown.set(o ? (o.secret ? `Authenticator secret for ${this.enrollUser}: ${o.secret}` : `PIN for ${this.enrollUser}: ${o.pin}`) : `Enrolled ${this.enrollUser} for ${m.name}.`);
      this.problem.set('');
    } catch (e) { this.problem.set((e as Error).message); } finally { this.busy.set(false); }
  }
  protected async showOutbox() { try { this.outbox.set((await this.s.api.raw<any>('GET', '/auth/outbox', undefined, this.h())).data.messages); } catch (e) { this.problem.set((e as Error).message); } }
}
