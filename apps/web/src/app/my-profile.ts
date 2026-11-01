import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';
import { EField } from './profile-fields';

/** The signed-in person's own profile, as configured by the administrator. The subject is the token's: there is no user id to type. */
@Component({
  selector: 'app-my-profile', imports: [FormsModule], styleUrl: './pages.css',
  template: `
  <p class="lead">Your profile. Only the fields your administrator allows can be changed here. Your roles, organizations, department and manager are assigned by administrators and cannot be edited from this page.</p>
  <p class="hint">Fictional demo only: do not enter real personal data.</p>
  @if (policy()==='review') { <p class="hint" id="mp-policy">Your changes are sent for validation: they wait on your personal change set until a validator accepts them.</p> }
  @if (pending().length) { <p role="status" class="msg" id="mp-pending">Waiting for validation: {{pending().join(', ')}}</p> }
  @if (note()) { <p role="status" class="msg" id="mp-note">{{note()}}</p> }
  @if (problem()) { <p role="alert" class="msg bad" id="mp-problem">{{problem()}}</p> }
  <section class="card"><form id="mp-form" (ngSubmit)="save()">
  @for (f of fields(); track f.key) {
    <label>{{f.label}} @if (!f.editable) { <small>(read only)</small> }
      @if (f.type==='select') { <select [name]="f.key" [ngModel]="vals()[f.key] ?? ''" (ngModelChange)="set(f.key,$event)" [disabled]="!f.editable"><option value="">-</option>@for (o of f.options; track o.value) {<option [value]="o.value">{{o.label}}</option>}</select> }
      @else if (f.type==='boolean') { <input type="checkbox" [name]="f.key" [ngModel]="!!vals()[f.key]" (ngModelChange)="set(f.key,$event)" [disabled]="!f.editable" /> }
      @else { <input [type]="f.type==='number'?'number':'text'" [name]="f.key" [ngModel]="vals()[f.key] ?? ''" (ngModelChange)="set(f.key,$event)" [disabled]="!f.editable" [attr.aria-label]="f.label" /> }
      @if (f.help) { <small>{{f.help}}</small> }</label>
  } @empty { <p>{{loaded() ? 'No profile field is shown to you.' : 'Loading...'}}</p> }
  <button id="mp-save" [disabled]="busy() || !editable()">Save my profile</button></form></section>
  <section class="card" id="mp-sections"><h3>Assigned by administrators (read only)</h3>
  @if (orgs() !== undefined) { <p id="mp-orgs"><b>Organizations:</b> {{orgs()!.length ? orgNames() : 'none'}}</p> }
  @if (roles() !== undefined) { <p id="mp-roles"><b>Roles:</b> {{roles()!.length ? roleNames() : 'none'}}</p> }</section>`,
})
export class MyProfilePage {
  protected readonly s = inject(Session);
  protected fields = signal<EField[]>([]); protected vals = signal<Record<string, unknown>>({}); protected changed: Record<string, unknown> = {};
  protected orgs = signal<{ id: string; name: string }[] | undefined>(undefined); protected roles = signal<{ id: string; label: string | null }[] | undefined>(undefined);
  protected orgNames() { return this.orgs()!.map((o) => o.name).join(', '); } protected roleNames() { return this.roles()!.map((r) => r.label || r.id).join(', '); }
  protected policy = signal('immediate'); protected pending = signal<string[]>([]); protected note = signal(''); protected problem = signal(''); protected busy = signal(false); protected loaded = signal(false);
  constructor() { effect(() => { this.s.branchEpoch(); void this.load(); }); }
  protected editable() { return this.fields().some((f) => f.editable); }
  protected set(k: string, v: unknown) { this.vals.update((x) => ({ ...x, [k]: v })); this.changed[k] = v === '' ? null : v; }
  protected async load() {
    try {
      const r = await this.s.api.raw<any>('GET', '/me/profile');
      if (r.status >= 400) throw new Error(r.data.message ?? 'Cannot load');
      this.orgs.set(r.data.sections?.organizations); this.roles.set(r.data.sections?.roles); this.policy.set(r.data.policy ?? 'immediate'); this.pending.set(r.data.pending ?? []); this.fields.set(r.data.fields); this.vals.set(r.data.values); this.changed = {}; this.problem.set(''); this.loaded.set(true);
    } catch (e) { this.problem.set((e as Error).message); this.loaded.set(true); }
  }
  protected async save() {
    this.busy.set(true);
    try {
      const r = await this.s.api.raw<any>('PATCH', '/me/profile', { values: this.changed });
      if (r.status >= 400) throw new Error(Array.isArray(r.data.message) ? r.data.message.join(' ') : r.data.message ?? 'Refused');
      this.note.set(this.policy()==='review' ? 'Sent for validation. Your live profile does not change until a validator accepts.' : 'Profile saved.'); await this.load();
    } catch (e) { this.problem.set((e as Error).message); this.note.set(''); } finally { this.busy.set(false); }
  }
}
