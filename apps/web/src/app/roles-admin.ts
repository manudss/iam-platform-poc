import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';

interface Role { id: string; label: string; is_sensitive: boolean; assigned: number }

/** Role definitions and separation-of-duties rules. A role grants nothing by itself: what it allows is written in the policies. People are assigned in Assignments. */
@Component({
  selector: 'app-roles-admin', imports: [FormsModule], styleUrl: './pages.css',
  template: `
  <p class="lead">Roles and separation of duties. Creating a role grants nothing: what a role may do is decided by the policies, which are not edited here. People are assigned to roles in Assignments, and Apply still blocks any assignment that breaks a rule.</p>
  <p class="hint">A role id never changes (policies refer to it). A role that is assigned or named in a rule cannot be deleted. Removing a rule loosens a control and asks for confirmation. Saved on the working branch, live after Apply.</p>
  @if (note()) { <p role="status" class="msg" id="role-note">{{note()}}</p> }
  @if (problem()) { <p role="alert" class="msg bad" id="role-problem">{{problem()}}</p> }
  <section class="card"><div class="scroll"><table id="role-table"><thead><tr><th>Role</th><th>Label</th><th>Sensitive</th><th>Assigned</th><th></th></tr></thead><tbody>
  @for (r of roles(); track r.id) { <tr><td>{{r.id}}</td><td><input [name]="'rl'+r.id" [(ngModel)]="r.label" maxlength="80" [attr.aria-label]="'Label of '+r.id" /></td>
    <td><input type="checkbox" [name]="'rs'+r.id" [(ngModel)]="r.is_sensitive" [attr.aria-label]="'Sensitive '+r.id" /></td><td>{{r.assigned}}</td>
    <td><button class="secondary" (click)="save(r)" [disabled]="s.branch()==='main'">Save</button><button class="secondary" (click)="remove(r.id)" [disabled]="s.branch()==='main'">Delete</button></td></tr> }
  @empty { <tr><td colspan="5">No role.</td></tr> }</tbody></table></div>
  <div class="row"><label>ID<input name="rid" [(ngModel)]="rid" pattern="[a-z0-9-]{1,32}" /></label><label>Label<input name="rlabel" [(ngModel)]="rlabel" maxlength="80" /></label>
  <label class="inline"><input type="checkbox" name="rsens" [(ngModel)]="rsens" /> Sensitive</label><button id="role-add" (click)="add()" [disabled]="s.branch()==='main'">Add role</button></div></section>
  <section class="card" id="sod"><h3>Separation of duties</h3><p class="hint">A person cannot hold both roles of a rule.</p>
  <ul>@for (x of rules(); track x.role_a + x.role_b) { <li>{{x.role_a}} + {{x.role_b}} <button class="secondary" (click)="removeRule(x)" [disabled]="s.branch()==='main'">Remove rule</button></li> } @empty { <li>No rule.</li> }</ul>
  <div class="row"><label>Role A<select name="sa" [(ngModel)]="sa">@for (r of roles(); track r.id) {<option [value]="r.id">{{r.id}}</option>}</select></label>
  <label>Role B<select name="sb" [(ngModel)]="sb">@for (r of roles(); track r.id) {<option [value]="r.id">{{r.id}}</option>}</select></label><button id="sod-add" (click)="addRule()" [disabled]="s.branch()==='main'">Add rule</button></div></section>`,
})
export class RolesAdminPage {
  protected readonly s = inject(Session);
  protected roles = signal<Role[]>([]); protected rules = signal<{ role_a: string; role_b: string }[]>([]);
  protected note = signal(''); protected problem = signal(''); protected rid = ''; protected rlabel = ''; protected rsens = false; protected sa = ''; protected sb = '';
  constructor() { effect(() => { this.s.branchEpoch(); this.s.adminToken(); void this.load(); }); }
  private h(): Record<string, string> { return this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {}; }
  private async call(method: string, path: string, body?: object, ok?: string) {
    try {
      const r = await this.s.api.raw<any>(method, path, body ?? (method === 'GET' ? undefined : {}), this.h());
      if (r.status >= 400) { this.problem.set(Array.isArray(r.data.message) ? r.data.message.join(' ') : r.data.message ?? 'Refused'); return; }
      this.problem.set(''); if (ok) this.note.set(ok + ' Saved on the working branch; live after Apply.');
      this.roles.set(r.data.roles); this.rules.set(r.data.sodRules);
    } catch (e) { this.problem.set((e as Error).message); }
  }
  protected load() { return this.call('GET', '/roles'); }
  protected add() { void this.call('POST', '/roles', { id: this.rid, label: this.rlabel, is_sensitive: this.rsens }, 'Role added.'); }
  protected save(r: Role) { void this.call('PATCH', `/roles/${encodeURIComponent(r.id)}`, { label: r.label, is_sensitive: r.is_sensitive }, 'Role saved.'); }
  protected remove(id: string) { void this.call('DELETE', `/roles/${encodeURIComponent(id)}`, undefined, 'Role deleted.'); }
  protected addRule() { void this.call('POST', '/roles/sod-rules', { role_a: this.sa, role_b: this.sb }, 'Rule added.'); }
  protected removeRule(x: { role_a: string; role_b: string }) { if (confirm(`Remove the rule ${x.role_a} + ${x.role_b}? This loosens a control.`)) void this.call('POST', '/roles/sod-rules/remove', { ...x, confirm: true }, 'Rule removed.'); }
}
