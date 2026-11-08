import { Component, HostListener, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';
import { UserProfile } from './api';

/* Pure helpers, exported for the unit tests (users.spec.ts). */

export type UserStatus = 'enabled' | 'disabled' | 'no-credential';
export const userStatus = (u: UserProfile): UserStatus =>
  !u.hasCredential ? 'no-credential' : u.login_enabled ? 'enabled' : 'disabled';

export const statusLabel = (s: UserStatus): string =>
  s === 'enabled' ? 'Enabled' : s === 'disabled' ? 'Disabled' : 'No credential';

export const initials = (name: string): string => {
  const p = (name || '?').trim().split(/\s+/);
  return ((p[0]?.[0] ?? '?') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
};

const PALETTE = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];
export const deptColor = (dept: string): string => {
  let h = 0;
  for (const c of dept || '') h = (h * 31 + (c.codePointAt(0) ?? 0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

export type SortKey = 'name' | 'dept' | 'status';
export interface UserFilter { q: string; dept: string; status: '' | UserStatus; }

export function filterUsers(users: UserProfile[], f: UserFilter): UserProfile[] {
  const q = f.q.trim().toLowerCase();
  return users.filter((u) => {
    if (f.dept && u.department !== f.dept) return false;
    if (f.status && userStatus(u) !== f.status) return false;
    if (q && ![u.id, u.display_name, u.department, u.email ?? ''].some((x) => x?.toLowerCase().includes(q))) return false;
    return true;
  });
}

const STATUS_RANK: Record<UserStatus, number> = { 'enabled': 0, 'disabled': 1, 'no-credential': 2 };
export function sortUsers(users: UserProfile[], key: SortKey, dir: 1 | -1): UserProfile[] {
  const val = (u: UserProfile): string | number =>
    key === 'name' ? u.display_name.toLowerCase() : key === 'dept' ? (u.department || '').toLowerCase() : STATUS_RANK[userStatus(u)];
  return [...users].sort((a, b) => {
    const x = val(a), y = val(b);
    const c = x < y ? -1 : x > y ? 1 : a.display_name.localeCompare(b.display_name);
    return c * dir;
  });
}

export interface Chain { manager: UserProfile | null; reports: UserProfile[]; }
export function managerChain(u: UserProfile, users: UserProfile[]): Chain {
  return {
    manager: users.find((x) => x.id === u.manager_id) ?? null,
    reports: users.filter((x) => x.manager_id === u.id).sort((a, b) => a.display_name.localeCompare(b.display_name)),
  };
}

export interface UserStats { total: number; enabled: number; noCred: number; depts: number; }
export function userStats(users: UserProfile[]): UserStats {
  return {
    total: users.length,
    enabled: users.filter((u) => userStatus(u) === 'enabled').length,
    noCred: users.filter((u) => userStatus(u) === 'no-credential').length,
    depts: new Set(users.map((u) => u.department).filter(Boolean)).size,
  };
}

@Component({ selector: 'app-users', imports: [FormsModule], styleUrl: './users.css', template: `
<p class="lead">Manage the directory used for sign-in. Profiles are committed to the selected working branch; password hashes are kept outside the database explorer.</p>
<p class="hint">Fictional demo only. On the free hosted demo, all data is lost when its disk is replaced. A new account has no role until an administrator assigns one in Assignments; creating a user never grants access by itself.</p>
@if (note()) { <p role="status" class="msg">{{note()}}</p> }
<div class="head">
  <div class="grow"><h2>Users</h2><span class="cnt">{{stats().total}} users · {{stats().enabled}} can sign in · {{stats().depts}} departments</span></div>
  <button id="user-create" (click)="start()" [disabled]="busy() || s.branch()==='main'" [title]="s.branch()==='main' ? 'Main is read only: pick a working branch above' : 'Create a user on the working branch'">Create user</button>
  <button class="secondary" (click)="load()">Refresh</button>
</div>
<div class="stats">
  <div class="stat"><span class="n">{{stats().total}}</span><span class="l">Users</span></div>
  <div class="stat"><span class="n">{{stats().enabled}}</span><span class="l">Sign-in enabled</span></div>
  <div class="stat"><span class="n">{{stats().noCred}}</span><span class="l">No credential</span></div>
  <div class="stat"><span class="n">{{stats().depts}}</span><span class="l">Departments</span></div>
</div>
<div class="toolbar">
  <span class="search"><input name="userSearch" placeholder="Search a name, id, e-mail…" [ngModel]="search()" (ngModelChange)="search.set($event)" /></span>
  <select name="userDept" [ngModel]="fdept()" (ngModelChange)="fdept.set($event)" aria-label="Department filter">
    <option value="">All departments</option>
    @for (d of departments(); track d) { <option [value]="d">{{d}}</option> }
  </select>
  <select name="userStatus" [ngModel]="fstatus()" (ngModelChange)="fstatus.set($event)" aria-label="Sign-in status filter">
    <option value="">Any status</option>
    <option value="enabled">Sign-in enabled</option>
    <option value="disabled">Disabled</option>
    <option value="no-credential">No credential</option>
  </select>
</div>
<div class="tcard"><div class="twrap"><table id="users-table">
<thead><tr>
  <th><button class="thbtn" (click)="sortBy('name')">User {{sortIcon('name')}}</button></th>
  <th><button class="thbtn" (click)="sortBy('dept')">Department {{sortIcon('dept')}}</button></th>
  <th>E-mail</th><th>Manager</th>
  <th><button class="thbtn" (click)="sortBy('status')">Sign-in {{sortIcon('status')}}</button></th>
  <th></th>
</tr></thead>
<tbody>
@for (u of filtered(); track u.id) {<tr>
  <td><span class="tuser"><span class="av" [style.background]="deptColor(u.department)+'22'" [style.color]="deptColor(u.department)" [style.border]="'1px solid '+deptColor(u.department)+'55'">{{initials(u.display_name)}}</span><span class="tx"><b>{{u.display_name}}</b><small>{{u.id}}</small></span></span></td>
  <td><span class="tag" [style.background]="deptColor(u.department)+'1f'" [style.color]="deptColor(u.department)">{{u.department || '—'}}</span></td>
  <td class="mail">{{u.email || '—'}}</td>
  <td class="mgr">{{managerName(u)}}</td>
  <td><span class="st" [class.ok]="userStatus(u)==='enabled'" [class.off]="userStatus(u)==='no-credential'" [class.bad]="userStatus(u)==='disabled'">{{statusLabel(userStatus(u))}}</span></td>
  <td class="acts"><button class="secondary rowbtn" (click)="start(u)" [disabled]="s.branch()==='main'">Edit</button>
    <span class="rowmenu"><button class="secondary rowbtn" (click)="toggleMenu(u.id, $event)" [attr.aria-expanded]="menuFor()===u.id" aria-label="More actions">⋯</button>
      @if (menuFor()===u.id) {<span class="pop" (click)="$event.stopPropagation()">
        <button (click)="quickToggle(u)" [disabled]="busy() || s.branch()==='main' || !u.hasCredential" [class.danger]="u.login_enabled" [title]="!u.hasCredential ? 'No credential yet: give one with Edit first' : ''">{{u.login_enabled ? 'Disable sign-in' : 'Enable sign-in'}}</button>
      </span>}
    </span></td>
</tr>}
@empty {<tr><td colspan="6" class="empty">No users match.</td></tr>}
</tbody></table></div>
<div class="tfoot"><span>{{filtered().length}} of {{users().length}} users · sorted by {{sortLabel()}}</span></div></div>

@if (editing()) {<div class="scrim" (click)="cancel()"></div>
<aside class="drawer" id="user-editor" role="dialog" [attr.aria-label]="key ? 'Edit '+key : 'Create user'">
  <div class="dhead">
    <!-- PROFILE-PICTURE-SLOT: the profile-plugins PR enriches this avatar (photo when the picture plugin is active, initials otherwise). -->
    <span class="av big" [style.background]="deptColor(form.department || 'user')+'22'" [style.color]="deptColor(form.department || 'user')" [style.border]="'1px solid '+deptColor(form.department || 'user')+'55'">{{initials(form.display_name || form.id || '?')}}</span>
    <span class="tx"><h3>{{key ? (form.display_name || key) : 'Create user'}}</h3>
      @if (key) {<span class="sub">{{key}} · <span class="tag" [style.background]="deptColor(form.department || 'user')+'1f'" [style.color]="deptColor(form.department || 'user')">{{form.department || '—'}}</span>
        @if (current(); as cu) {<span class="st" [class.ok]="userStatus(cu)==='enabled'" [class.off]="userStatus(cu)==='no-credential'" [class.bad]="userStatus(cu)==='disabled'">{{statusLabel(userStatus(cu))}}</span>}</span>}
    </span>
    <button class="secondary x" type="button" (click)="cancel()" title="Close">✕</button>
  </div>
  <form (ngSubmit)="save()">
  <h4>Identity</h4>
  <label>User ID<input name="uid" [(ngModel)]="form.id" [disabled]="!!key" required pattern="[a-z0-9-]{1,32}" />@if(!key){<small>Lowercase letters, digits and dashes; cannot change later.</small>}</label>
  <label>Display name<input name="displayName" [(ngModel)]="form.display_name" maxlength="80" /></label>
  <h4>Organisation</h4>
  <label>E-mail <small>used for sign-in codes</small><input name="email" type="text" [(ngModel)]="form.email" maxlength="254" autocomplete="off" /></label>
  <label>Department<input name="department" [(ngModel)]="form.department" maxlength="40" /></label>
  <label>Manager<select name="manager" [(ngModel)]="form.manager_id"><option value="">None</option>@for(u of users();track u.id){@if(u.id!==form.id){<option [value]="u.id">{{u.display_name}} ({{u.id}})</option>}}</select></label>
  @if (key && chain(); as c) {@if (c.manager || c.reports.length) {<div class="chain">
    @if (c.manager) {<span class="node"><span class="av mini" [style.background]="deptColor(c.manager.department)+'22'" [style.color]="deptColor(c.manager.department)">{{initials(c.manager.display_name)}}</span> {{c.manager.display_name}}</span><span class="arr">←</span>}
    <span class="node me"><span class="av mini" [style.background]="deptColor(form.department || 'user')+'22'" [style.color]="deptColor(form.department || 'user')">{{initials(form.display_name || key || '?')}}</span> {{form.display_name || key}}</span>
    @if (c.reports.length) {<span class="arr">←</span>}
    @for (r of c.reports; track r.id) {<span class="node"><span class="av mini" [style.background]="deptColor(r.department)+'22'" [style.color]="deptColor(r.department)">{{initials(r.display_name)}}</span> {{r.display_name}}</span>}
  </div>}}
  @if (key && pfields().length) { <h4>Profile fields</h4><p class="hint">Fields the administrator configuration lets an administrator edit. Saved on the working branch like the rest.</p>
  @for (f of pfields(); track f.key) { <label>{{f.label}}@if(!f.editable){<small> (read only)</small>}
  @if (f.type==='select') {<select [name]="'pf'+f.key" [ngModel]="pvals()[f.key] ?? ''" (ngModelChange)="setP(f.key,$event)" [disabled]="!f.editable"><option value="">-</option>@for(o of f.options;track o.value){<option [value]="o.value">{{o.label}}</option>}</select>}
  @else {<input [name]="'pf'+f.key" [ngModel]="pvals()[f.key] ?? ''" (ngModelChange)="setP(f.key,$event)" [disabled]="!f.editable" />}</label> } }
  <!-- PROFILE-PLUGINS-SLOT: the profile-plugins PR mounts <app-user-plugin-sections [userId]="key"> here (TOTP, PIN, lockout), between Profile fields and Security. Single marked line, additive only. -->
  <h4>Security</h4>
  <label class="inline"><input type="checkbox" name="enabled" [(ngModel)]="form.login_enabled" /> Allow sign-in</label>
  <label>{{key ? 'New password (leave blank to keep)' : 'Password'}}<input type="password" name="userPassword" [(ngModel)]="password" autocomplete="new-password" minlength="12" maxlength="128" [required]="!key" /></label>
  <p class="hint">12 to 128 characters. Sent only in the request body; never returned in the table, SQL, history or logs. Do not use a real password in this public demo.</p>
  @if (key && form.login_enabled) {<div class="danger-zone"><p>Disabling sign-in applies on the working branch and takes effect only after Review &amp; Apply.</p><button type="button" class="danger" id="user-disable" (click)="disableAndSave()" [disabled]="busy()">Disable sign-in</button></div>}
  <div class="foot"><button class="grow" id="user-save" [disabled]="busy()">Save user</button><button type="button" class="secondary" (click)="cancel()">Cancel</button></div>
  </form>
</aside>}
` })
export class UsersPage {
  protected readonly s = inject(Session);
  protected users = signal<UserProfile[]>([]); protected note = signal(''); protected busy = signal(false); protected editing = signal(false);
  protected pfields = signal<any[]>([]); protected pvals = signal<Record<string, unknown>>({}); private pchanged: Record<string, unknown> = {};
  protected search = signal(''); protected fdept = signal(''); protected fstatus = signal<'' | UserStatus>('');
  protected sortKey = signal<SortKey>('name'); protected sortDir = signal<1 | -1>(1);
  protected menuFor = signal<string | null>(null);
  protected key: string | null = null; protected password = ''; protected form = { id: '', display_name: '', email: '', department: '', manager_id: '', login_enabled: true };

  protected readonly initials = initials; protected readonly deptColor = deptColor;
  protected readonly userStatus = userStatus; protected readonly statusLabel = statusLabel;

  ngOnInit() { void this.load(); }

  protected stats = computed(() => userStats(this.users()));
  protected departments = computed(() => [...new Set(this.users().map((u) => u.department).filter(Boolean))].sort());
  protected filtered = computed(() => sortUsers(filterUsers(this.users(), { q: this.search(), dept: this.fdept(), status: this.fstatus() }), this.sortKey(), this.sortDir()));
  // NOT computed(): key is a plain property (ngModel-bound form state), so a computed would cache the first user opened.
  protected current() { return this.users().find((u) => u.id === this.key) ?? null; }
  protected chain() { const c = this.current(); return c ? managerChain(c, this.users()) : null; }

  protected sortBy(k: SortKey) { if (this.sortKey() === k) this.sortDir.update((d) => (d === 1 ? -1 : 1)); else { this.sortKey.set(k); this.sortDir.set(1); } }
  protected sortIcon(k: SortKey) { return this.sortKey() !== k ? '↕' : this.sortDir() === 1 ? '↑' : '↓'; }
  protected sortLabel() { return (this.sortKey() === 'name' ? 'name' : this.sortKey() === 'dept' ? 'department' : 'sign-in status') + (this.sortDir() === 1 ? ' ↑' : ' ↓'); }
  protected managerName(u: UserProfile) { const m = this.users().find((x) => x.id === u.manager_id); return m ? m.display_name : u.manager_id || '—'; }

  protected toggleMenu(id: string, ev: Event) { ev.stopPropagation(); this.menuFor.update((m) => (m === id ? null : id)); }
  @HostListener('document:click') closeMenu() { this.menuFor.set(null); }

  protected async load() { try { const r = await this.s.api.raw<{ users: UserProfile[] }>('GET', '/users', undefined, this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {}); this.users.set(r.data.users); } catch (e) { this.note.set((e as Error).message); } }
  protected start(u?: UserProfile) { this.menuFor.set(null); this.key = u?.id ?? null; this.form = { id: u?.id ?? '', display_name: u?.display_name ?? '', email: u?.email ?? '', department: u?.department ?? '', manager_id: u?.manager_id ?? '', login_enabled: u?.login_enabled ?? true }; this.password = ''; this.editing.set(true); this.pfields.set([]); this.pchanged = {}; if (u) void this.loadP(u.id); }
  private h(): Record<string, string> { return this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {}; }
  private async loadP(id: string) { try { const r = await this.s.api.raw<any>('GET', '/users/' + encodeURIComponent(id) + '/profile', undefined, this.h()); if (r.status < 400) { this.pfields.set(r.data.fields.filter((f: any) => !f.key.startsWith('base.'))); this.pvals.set(r.data.values); } } catch { /* profile fields are optional */ } }
  protected setP(k: string, v: unknown) { this.pvals.update((x) => ({ ...x, [k]: v })); this.pchanged[k] = v === '' ? null : v; }
  protected cancel() { this.password = ''; this.editing.set(false); }
  protected disableAndSave() { this.form.login_enabled = false; void this.save(); }
  protected async quickToggle(u: UserProfile) {
    this.menuFor.set(null); this.busy.set(true);
    try {
      await this.s.api.saveUser(u.id, { id: u.id, display_name: u.display_name, email: u.email ?? '', department: u.department, manager_id: u.manager_id ?? '', login_enabled: !u.login_enabled }, this.s.adminToken());
      await this.load(); this.note.set((u.login_enabled ? 'Sign-in disabled for ' : 'Sign-in enabled for ') + u.id + '. Apply is required before live sign-in changes.');
    } catch (e) { this.note.set((e as Error).message); } finally { this.busy.set(false); }
  }
  protected async save() {
    this.busy.set(true);
    try {
      const b: Record<string, unknown> = { ...this.form }; if (this.password) b['password'] = this.password;
      await this.s.api.saveUser(this.key, b, this.s.adminToken());
      if (this.key && Object.keys(this.pchanged).length) { const r = await this.s.api.raw<any>('PATCH', '/users/' + encodeURIComponent(this.key) + '/profile', { values: this.pchanged }, this.h()); if (r.status >= 400) throw new Error(Array.isArray(r.data.message) ? r.data.message.join(' ') : r.data.message ?? 'Profile fields refused'); }
      this.cancel(); await this.load(); this.note.set('User saved on the working branch. Apply is required before live sign-in changes.');
    } catch (e) { this.note.set((e as Error).message); } finally { this.password = ''; this.busy.set(false); }
  }
}
