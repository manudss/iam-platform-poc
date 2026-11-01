import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';
import { UserProfile } from './api';

interface Org { id: string; name: string; parent_id: string | null }

/** Organizations plugin screen. Memberships are assigned here by an administrator; they are not a profile field. Saved on the working branch, live after Apply. */
@Component({
  selector: 'app-organizations', imports: [FormsModule], styleUrl: './pages.css',
  template: `
  <p class="lead">Organizations (plugin). Create organizations, nest them, and assign people. A person sees their organizations on their profile, read only.</p>
  <p class="hint">Membership is an assignment made by an administrator. It is never asked at sign-up and no profile setting lets a person change it. Fictional demo only.</p>
  @if (note()) { <p role="status" class="msg" id="org-note">{{note()}}</p> }
  @if (problem()) { <p role="alert" class="msg bad" id="org-problem">{{problem()}}</p> }
  @if (off()) { <p class="hint" id="org-off">The Organizations plugin is not enabled on this branch. Enable it in Plugins first.</p> } @else {
  <section class="card"><div class="scroll"><table id="org-table"><thead><tr><th>Organization</th><th>Parent</th><th>Members</th><th></th></tr></thead><tbody>
  @for (o of orgs(); track o.id) { <tr><td><input [name]="'on'+o.id" [ngModel]="o.name" (ngModelChange)="o.name=$event" maxlength="80" [attr.aria-label]="'Name of '+o.id" /><br><small>{{o.id}}</small></td>
    <td>{{o.parent_id || '-'}}</td><td>{{count(o.id)}}</td>
    <td><button class="secondary" (click)="rename(o)" [disabled]="s.branch()==='main'">Save name</button><button class="secondary" (click)="remove(o.id)" [disabled]="s.branch()==='main'">Delete</button></td></tr> }
  @empty { <tr><td colspan="4">No organization yet.</td></tr> }</tbody></table></div>
  <div class="row"><label>ID<input name="nid" [(ngModel)]="nid" pattern="[a-z0-9-]{1,32}" /></label><label>Name<input name="nname" [(ngModel)]="nname" maxlength="80" /></label>
  <label>Parent<select name="npar" [(ngModel)]="npar"><option value="">None</option>@for (o of orgs(); track o.id) {<option [value]="o.id">{{o.name}}</option>}</select></label>
  <button id="org-add" (click)="add()" [disabled]="s.branch()==='main'">Add organization</button></div>
  @if (s.branch()==='main') { <p class="hint">Choose a working branch (not main) to make changes.</p> }</section>
  <section class="card" id="org-assign"><h3>Assign a person</h3>
  <div class="row"><label>Person<select name="auser" [ngModel]="user" (ngModelChange)="pick($event)"><option value="">Choose...</option>@for (u of users(); track u.id) {<option [value]="u.id">{{u.display_name}} ({{u.id}})</option>}</select></label></div>
  @if (user) { @for (o of orgs(); track o.id) { <label class="inline"><input type="checkbox" [name]="'m'+o.id" [ngModel]="chosen().includes(o.id)" (ngModelChange)="toggle(o.id,$event)" /> {{o.name}}</label> }
  <button id="org-assign-save" (click)="assign()" [disabled]="s.branch()==='main'">Save assignment</button> }</section> }`,
})
export class OrganizationsPage {
  protected readonly s = inject(Session);
  protected orgs = signal<Org[]>([]); protected members = signal<{ subject: string; org_id: string }[]>([]); protected users = signal<UserProfile[]>([]); protected chosen = signal<string[]>([]);
  protected note = signal(''); protected problem = signal(''); protected off = signal(false); protected user = ''; protected nid = ''; protected nname = ''; protected npar = '';
  constructor() { effect(() => { this.s.branchEpoch(); this.s.adminToken(); void this.load(); }); }
  private h(): Record<string, string> { return this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {}; }
  protected count(id: string) { return this.members().filter((m) => m.org_id === id).length; }
  private fail(r: { status: number; data: any }) { if (r.status < 400) return false; this.problem.set(Array.isArray(r.data.message) ? r.data.message.join(' ') : r.data.message ?? 'Refused'); return true; }
  protected async load() {
    try {
      const r = await this.s.api.raw<any>('GET', '/organizations', undefined, this.h());
      if (r.status === 404) { this.off.set(true); this.problem.set(''); return; }
      if (this.fail(r)) return; this.off.set(false); this.orgs.set(r.data.orgs); this.members.set(r.data.members); this.problem.set('');
      const u = await this.s.api.raw<{ users: UserProfile[] }>('GET', '/users', undefined, this.h());
      this.users.set(u.status < 400 ? u.data.users : []);
    } catch (e) { this.problem.set((e as Error).message); }
  }
  private async run(method: string, path: string, body: object | undefined, ok: string) { const r = await this.s.api.raw<any>(method, path, body, this.h()); if (this.fail(r)) return; this.note.set(ok + ' Saved on the working branch; live after Apply.'); this.problem.set(''); await this.load(); }
  protected add() { void this.run('POST', '/organizations', { id: this.nid, name: this.nname, parent_id: this.npar || null }, 'Organization added.').then(() => { this.nid = ''; this.nname = ''; }); }
  protected rename(o: Org) { void this.run('PATCH', `/organizations/${encodeURIComponent(o.id)}`, { name: o.name }, 'Name saved.'); }
  protected remove(id: string) { void this.run('DELETE', `/organizations/${encodeURIComponent(id)}`, undefined, 'Organization deleted.'); }
  protected pick(u: string) { this.user = u; this.chosen.set(this.members().filter((m) => m.subject === u).map((m) => m.org_id)); }
  protected toggle(id: string, on: boolean) { this.chosen.update((c) => on ? [...new Set([...c, id])] : c.filter((x) => x !== id)); }
  protected assign() { void this.run('PUT', `/organizations/memberships/${encodeURIComponent(this.user)}`, { orgIds: this.chosen() }, 'Assignment saved.'); }
}
