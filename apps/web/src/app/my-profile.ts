import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';
import { EField } from './profile-fields';
import { ProfileComponents } from './profile-components';

const PICTURE = 'profile-picture.picture';

/** The signed-in person's own profile, as configured by the administrator. The subject is the token's: there is no user id to type. */
@Component({
  selector: 'app-my-profile', imports: [FormsModule, ProfileComponents], styleUrl: './pages.css',
  template: `
  <p class="lead">Your profile. Only the fields your administrator allows can be changed here. Your roles, organizations, department and manager are assigned by administrators and cannot be edited from this page. Fictional demo only: do not enter real personal data.</p>
  @if (policy()==='review') { <p class="hint" id="mp-policy">Your changes are sent for validation: they wait on your personal change set until a validator accepts them.</p> }
  @if (pending().length) { <p role="status" class="msg" id="mp-pending">Waiting for validation: {{pending().join(', ')}}</p> }
  @if (note()) { <p role="status" class="msg" id="mp-note">{{note()}}</p> }
  @if (problem()) { <p role="alert" class="msg bad" id="mp-problem">{{problem()}}</p> }

  <section class="card mp-head">
    <div class="mp-id">
      @if (picture()) { <img class="mp-avatar" [src]="picture()" alt="Profile picture"> }
      @else { <span class="mp-avatar mp-initials" aria-hidden="true">{{initials()}}</span> }
      <div class="mp-id-text">
        <h2 class="mp-name">{{displayName()}}</h2>
        <p class="hint mp-chips"><span class="pill">{{s.user()}}</span>@if (department()) { <span class="pill">{{department()}}</span> }</p>
      </div>
    </div>
    @if (picField(); as pf) {
      <div class="mp-pic-actions">
        @if (pf.editable) {
          <label class="up btn secondary">Change the picture…<input type="file" accept="image/png,image/jpeg,image/webp" (change)="pick($event)" hidden></label>
          @if (picture()) { <button type="button" class="secondary" (click)="removePicture()">Remove</button> }
          <small class="hint">Profile-picture plugin: png, jpeg or webp, squared and resized to 256 px on your device (256 KB max). Fictional demo: do not use a real photo.</small>
        } @else { <small class="hint">Profile picture (read only) · profile-picture plugin</small> }
      </div>
    }
  </section>

  <div class="mp-cols">
  <section class="card"><form id="mp-form" (ngSubmit)="save()">
  @for (sec of sections(); track sec.name) {
    @if (sec.name) { <h3 class="profile-section">{{sec.name}}</h3> }
    @for (f of sec.fields; track f.key) {
      @if (f.type !== 'image') {
      <label>{{f.label}} @if (!f.editable) { <small>(read only)</small> }
        @if (f.type==='select') { <select [name]="f.key" [ngModel]="vals()[f.key] ?? ''" (ngModelChange)="set(f.key,$event)" [disabled]="!f.editable"><option value="">-</option>@for (o of f.options; track o.value) {<option [value]="o.value">{{o.label}}</option>}</select> }
        @else if (f.type==='boolean') { <input type="checkbox" [name]="f.key" [ngModel]="!!vals()[f.key]" (ngModelChange)="set(f.key,$event)" [disabled]="!f.editable" /> }
        @else { <input [type]="f.type==='number'?'number':f.type==='date'?'date':f.type==='email'?'email':f.type==='url'?'url':f.type==='phone'?'tel':'text'" [name]="f.key" [ngModel]="vals()[f.key] ?? ''" (ngModelChange)="set(f.key,$event)" [disabled]="!f.editable" [attr.aria-label]="f.label" /> }
        @if (f.help) { <small>{{f.help}}</small> }</label>
      }
    }
  } @empty { <p>{{loaded() ? 'No profile field is shown to you.' : 'Loading...'}}</p> }
  <div class="row"><button id="mp-save" [disabled]="busy() || !editable()">Save my profile</button>
  @if (policy()==='immediate') { <small class="hint">takes effect immediately</small> }</div>
  </form></section>
  <div class="mp-side">
  <section class="card" id="mp-security"><h3>Security</h3>
    <p class="hint">Only the fields your administrator allows can be changed on this page.</p>
    <app-profile-components surface="self" [exclude]="[pictureKey]" />
  </section>
  <section class="card" id="mp-sections"><h3>Assigned by administrators (read only)</h3>
  @if (orgs() !== undefined) { <p id="mp-orgs"><b>Organizations:</b> {{orgs()!.length ? orgNames() : 'none'}}</p> }
  @if (roles() !== undefined) { <p id="mp-roles"><b>Roles:</b> {{roles()!.length ? roleNames() : 'none'}}</p> }</section>
  </div>
  </div>`,
})
export class MyProfilePage {
  protected readonly s = inject(Session);
  protected fields = signal<EField[]>([]); protected vals = signal<Record<string, unknown>>({}); protected changed: Record<string, unknown> = {};
  protected orgs = signal<{ id: string; name: string }[] | undefined>(undefined); protected roles = signal<{ id: string; label: string | null }[] | undefined>(undefined);
  protected orgNames() { return this.orgs()!.map((o) => o.name).join(', '); } protected roleNames() { return this.roles()!.map((r) => r.label || r.id).join(', '); }
  protected policy = signal('immediate'); protected pending = signal<string[]>([]); protected note = signal(''); protected problem = signal(''); protected busy = signal(false); protected loaded = signal(false);
  protected readonly pictureKey = PICTURE;
  constructor() { effect(() => { this.s.branchEpoch(); void this.load(); }); }
  /** Fields grouped by their configured section, in schema order (the server already sorts by order, key). */
  protected sections() {
    const out: { name: string; fields: EField[] }[] = [];
    for (const f of this.fields()) {
      const name = f.section ?? f.group ?? '';
      const last = out[out.length - 1];
      if (last && last.name === name) last.fields.push(f); else out.push({ name, fields: [f] });
    }
    return out;
  }
  protected editable() { return this.fields().some((f) => f.editable && f.type !== 'image'); }
  protected set(k: string, v: unknown) { this.vals.update((x) => ({ ...x, [k]: v })); this.changed[k] = v === '' ? null : v; }
  protected picField() { return this.fields().find((f) => f.key === PICTURE); }
  protected picture() { return (this.vals()[PICTURE] as string) || ''; }
  protected displayName() { return (this.vals()['base.display_name'] as string) || this.s.user(); }
  protected department() { return (this.vals()['base.department'] as string) || ''; }
  protected initials() {
    const parts = this.displayName().trim().split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
  }
  protected pick(ev: Event) {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { this.problem.set('A png, jpeg or webp image is required.'); return; }
    const img = new Image();
    img.onload = () => {
      const size = 256, canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const g = canvas.getContext('2d')!;
      const side = Math.min(img.width, img.height);
      g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      void this.savePicture(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => this.problem.set('This file is not a readable image.');
    img.src = URL.createObjectURL(file);
    (ev.target as HTMLInputElement).value = '';
  }
  protected removePicture() { void this.savePicture(null); }
  private async savePicture(value: string | null) {
    try {
      const r = await this.s.api.raw<any>('PATCH', '/me/profile', { values: { [PICTURE]: value } });
      if (r.status >= 400) throw new Error(Array.isArray(r.data.message) ? r.data.message.join(' ') : r.data.message ?? 'Refused');
      this.note.set(value ? 'Picture saved.' : 'Picture removed.'); this.problem.set(''); await this.load();
    } catch (e) { this.problem.set((e as Error).message); }
  }
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
