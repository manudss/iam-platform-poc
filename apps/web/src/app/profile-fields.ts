import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';

export interface CatField { fullKey: string; plugin: string; label: string; type: string; klass: 'profile' | 'authority'; pii: string; storage: string; help?: string }
export interface Setting { enabled: boolean; signup: 'off' | 'optional' | 'required'; selfView: boolean; selfEdit: boolean; adminEdit: boolean }
export interface EField { key: string; label: string; type: string; help?: string; options?: { value: string; label: string }[]; klass: string; editable: boolean; required?: boolean; visible: boolean }

/** Authority fields never get "sign-up" or "user can edit": the screen disables them, and the server refuses them anyway. */
export const lockedFor = (f: CatField) => f.klass === 'authority';

/** Admin: which fields exist (base + plugins) and where each is shown or editable. Saved on the working branch, live after Apply. */
@Component({
  selector: 'app-profile-fields', imports: [FormsModule], styleUrl: './pages.css',
  template: `
  <p class="lead">Profile fields come from the core and from plugins. For each field choose where it is hidden, asked at sign-up, visible or editable by the person, and editable by an administrator.</p>
  <p class="hint">Fields marked <b>authority</b> (department, manager, grade...) decide what someone may be or do. They can never be asked at sign-up nor edited by the person; only an administrator changes them. Roles and organizations are assigned separately, never from a profile form. Fictional data only: history keeps every value.</p>
  @if (note()) { <p role="status" class="msg" id="pf-note">{{note()}}</p> }
  @if (problem()) { <p role="alert" class="msg bad" id="pf-problem">{{problem()}}</p> }
  <section class="card"><div class="scroll"><table id="pf-table"><thead><tr><th>Field</th><th>Origin</th><th>Class</th><th>Shown</th><th>At sign-up</th><th>Person sees</th><th>Person edits</th><th>Admin edits</th></tr></thead><tbody>
  @for (f of cat(); track f.fullKey) { @if (cfg()[f.fullKey]; as c) {
    <tr [attr.data-key]="f.fullKey"><td>{{f.label}}<br><small>{{f.fullKey}}</small></td><td>{{f.plugin}}</td>
    <td>@if (locked(f)) { <span class="pill warn">authority</span> } @else { profile }@if (f.pii!=='none') { <br><small>PII: {{f.pii}}</small> }</td>
    <td><input type="checkbox" [name]="'en'+f.fullKey" [(ngModel)]="c.enabled" (ngModelChange)="dirty.set(true)" [attr.aria-label]="'Show '+f.fullKey" /></td>
    <td><select [name]="'su'+f.fullKey" [(ngModel)]="c.signup" (ngModelChange)="dirty.set(true)" [disabled]="locked(f)" [attr.aria-label]="'Sign-up '+f.fullKey"><option value="off">no</option><option value="optional">optional</option><option value="required">required</option></select></td>
    <td><input type="checkbox" [name]="'sv'+f.fullKey" [(ngModel)]="c.selfView" (ngModelChange)="dirty.set(true)" [attr.aria-label]="'Person sees '+f.fullKey" /></td>
    <td><input type="checkbox" [name]="'se'+f.fullKey" [(ngModel)]="c.selfEdit" (ngModelChange)="dirty.set(true)" [disabled]="locked(f) || f.storage==='identities'" [attr.aria-label]="'Person edits '+f.fullKey" />@if (f.storage==='identities' && !locked(f)) { <br><small>later (needs re-authentication)</small> }</td>
    <td><input type="checkbox" [name]="'ae'+f.fullKey" [(ngModel)]="c.adminEdit" (ngModelChange)="dirty.set(true)" [attr.aria-label]="'Admin edits '+f.fullKey" /></td></tr> } }
  @empty { <tr><td colspan="8">{{loaded() ? 'No fields.' : 'Loading...'}}</td></tr> }
  </tbody></table></div></section>
  <section class="card" id="pf-policy"><h3>How people's own edits are published</h3>
    <label>Policy <select name="selfEditPolicy" [(ngModel)]="policy" (ngModelChange)="dirty.set(true)" aria-label="Own-edit policy"><option value="immediate">Immediate: a person's edits go live at once (Dolt main)</option><option value="review">Validated: edits wait on a personal change set until a validator accepts them</option></select></label>
    <p class="hint">Live only after Save and Apply. With validation, each person's edits stay on an automatic personal Dolt branch (not a Git branch); a validator (an administrator other than the author) reviews the changes on the page Profile reviews, then accepts (merge into main) or refuses (the change set is deleted). Live policy: <b id="pf-livepolicy">{{livePolicy()}}</b>.</p>
  </section>
  <section class="card" id="pf-signup"><h3>Public sign-up</h3>
    <label class="inline"><input type="checkbox" name="signupopen" [(ngModel)]="signupOpen" (ngModelChange)="dirty.set(true)" /> Open the sign-up form (off by default)</label>
    <p class="hint">Live only after Save and Apply. Anyone with the link can then send a request: it needs e-mail confirmation (simulated here: the code goes to the demo outbox, not to a mailbox) and your approval. Approval creates an account with <b>no role, department or manager</b>. Fictional data only; do not open this on a public demo with real people.</p>
    <p class="hint">Live status: sign-up is <b id="pf-live">{{liveOpen() ? 'open' : 'closed'}}</b>.</p>
    @if (requests().length) { <div class="scroll"><table id="pf-requests"><thead><tr><th>Request</th><th>E-mail</th><th>Confirmed</th><th></th></tr></thead><tbody>
    @for (q of requests(); track q.id) { <tr><td>{{q.display_name}}<br><small>{{q.id}}</small></td><td>{{q.email}}</td><td>{{q.confirmed ? 'yes' : 'no'}}</td>
    <td><button class="secondary" (click)="decide(q.id, true)" [disabled]="!q.confirmed || s.branch()==='main'">Approve on this branch</button><button class="secondary" (click)="decide(q.id, false)">Reject</button></td></tr> }
    </tbody></table></div> } @else { <p class="hint">No pending request.</p> }
  </section>
  <section class="card"><div class="row"><button id="pf-save" (click)="save()" [disabled]="busy() || !loaded() || s.branch()==='main'">Save on this branch</button>
  @if (dirty()) { <span class="pill warn">Unsaved edits</span> }</div>
  @if (s.branch()==='main') { <p class="hint">Choose a working branch (not main) to save. Changes become live only after Apply.</p> }
  <p class="hint">Plugins that declare fields must be enabled in Plugins to appear here. Disabling a plugin hides its fields; stored values are kept.</p></section>`,
})
export class ProfileFieldsPage {
  protected readonly s = inject(Session);
  protected cat = signal<CatField[]>([]); protected cfg = signal<Record<string, Setting>>({});
  protected note = signal(''); protected problem = signal(''); protected busy = signal(false); protected dirty = signal(false); protected loaded = signal(false); protected signupOpen = false; protected policy: 'immediate' | 'review' = 'immediate'; protected livePolicy = signal('immediate'); protected liveOpen = signal(false); protected requests = signal<{ id: string; display_name: string; email: string; confirmed: boolean }[]>([]);
  constructor() { effect(() => { this.s.branchEpoch(); this.s.adminToken(); void this.load(); }); }
  private h(): Record<string, string> { return this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {}; }
  protected locked = lockedFor;
  protected async load() {
    this.loaded.set(false);
    try {
      const r = await this.s.api.raw<any>('GET', '/profile-fields', undefined, this.h());
      if (r.status >= 400) throw new Error(r.data.message ?? 'Cannot load');
      const defaults = (f: CatField): Setting => ({ enabled: true, signup: 'off', selfView: true, selfEdit: false, adminEdit: true });
      const eff: Record<string, Setting> = {};
      for (const f of r.data.catalogue as CatField[]) eff[f.fullKey] = { ...defaults(f), ...(r.data.working.settings?.[f.fullKey] ?? {}) };
      this.signupOpen = !!r.data.working.config.signup?.open; this.policy = r.data.working.config.selfEditPolicy === 'review' ? 'review' : 'immediate'; this.livePolicy.set(r.data.live.config.selfEditPolicy === 'review' ? 'review' : 'immediate'); this.liveOpen.set(!!r.data.live.config.signup?.open); void this.loadRequests(); this.cat.set(r.data.catalogue); this.cfg.set(eff); this.dirty.set(false); this.problem.set(''); this.loaded.set(true);
    } catch (e) { this.problem.set((e as Error).message); }
  }
  protected async loadRequests() { try { const r = await this.s.api.raw<any>('GET', '/signup/requests', undefined, this.h()); this.requests.set(r.status < 400 ? r.data.requests : []); } catch { this.requests.set([]); } }
  protected async decide(id: string, ok: boolean) {
    try {
      const r = await this.s.api.raw<any>(ok ? 'POST' : 'DELETE', `/signup/requests/${encodeURIComponent(id)}${ok ? '/approve' : ''}`, ok ? {} : undefined, this.h());
      if (r.status >= 400) throw new Error(r.data.message ?? 'Refused');
      this.note.set(ok ? 'Account created on the working branch with no role. It can sign in after Apply.' : 'Request rejected.'); await this.loadRequests();
    } catch (e) { this.problem.set((e as Error).message); }
  }
  protected async save() {
    this.busy.set(true);
    try {
      const r = await this.s.api.raw<any>('PUT', '/profile-fields', { config: { fields: this.cfg(), signup: { open: this.signupOpen }, selfEditPolicy: this.policy } }, this.h());
      if (r.status >= 400) throw new Error(Array.isArray(r.data.message) ? r.data.message.join(' ') : r.data.message ?? 'Refused');
      this.note.set('Saved on the working branch. Nothing changes for people until Apply.'); this.problem.set(''); await this.load();
    } catch (e) { this.problem.set((e as Error).message); } finally { this.busy.set(false); }
  }
}
