import { UserAccountBlocks } from './user-account-blocks';
import { DirectoryAccountStatuses, BLOCK_LABELS, activeBlocks, accountState, matchesAccount } from './account-state';
import { RevealPassword } from './reveal-password';
import { Component, HostListener, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { canOpen } from './access';
import { Session } from './session';
import { UserProfile } from './api';
import { RolesRights } from './roles-rights';
import { UserPluginSections } from './user-plugin-sections';
import { UserAvatar, UserPictures } from './user-avatar';

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

const PALETTE = ['var(--accent)', 'var(--link)', 'var(--ok)', 'var(--warn-ink)', 'var(--bad)', 'var(--acc2)', 'var(--acc2-dark)', 'var(--ok)'];
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

@Component({ selector: 'app-users', imports: [FormsModule, RouterLink, RolesRights, UserPluginSections, UserAvatar, RevealPassword, UserAccountBlocks], styleUrl: './users.css', template: `
<p class="lead">Manage the directory used for sign-in. Profiles are committed to the selected working branch; password hashes are kept outside the database explorer.</p>
<p class="hint">Fictional demo only: do not enter real personal data. The data is kept on the server's disk and is backed up before each update, but this is a demo and nothing here is guaranteed to be kept. A new account has no role until an administrator assigns one from this drawer or Assignments; creating a user never grants access by itself.</p>
@if (note()) { <p role="status" class="msg">{{note()}}</p> }
<div class="head">
  <div class="grow"><h2>Users</h2><span class="cnt">{{stats().total}} users · {{stats().enabled}} enabled on branch · {{stats().depts}} departments</span></div>
  <button id="user-create" (click)="start()" [disabled]="busy() || s.branch()==='main'" [title]="s.branch()==='main' ? 'Main is read only: pick a working branch above' : 'Create a user on the working branch'">Create user</button>
  <button class="secondary" (click)="load()">Refresh</button>
</div>
<div class="stats">
  <div class="stat"><span class="n">{{stats().total}}</span><span class="l">Users</span></div>
  <div class="stat"><span class="n">{{stats().enabled}}</span><span class="l">Enabled on branch</span></div>
  <div class="stat"><span class="n">{{stats().noCred}}</span><span class="l">No credential</span></div>
  <div class="stat"><span class="n">{{stats().depts}}</span><span class="l">Departments</span></div>
</div>
<div class="toolbar">
  <span class="search"><input name="userSearch" placeholder="Search a name, id, e-mail…" [ngModel]="search()" (ngModelChange)="search.set($event)" /></span>
  <select name="userDept" [ngModel]="fdept()" (ngModelChange)="fdept.set($event)" aria-label="Department filter">
    <option value="">All departments</option>
    @for (d of departments(); track d) { <option [value]="d">{{d}}</option> }
  </select>
  <select name="userStatus" [ngModel]="fstatus()" (ngModelChange)="fstatus.set($event)" aria-label="Branch sign-in status filter">
    <option value="">Any branch sign-in setting</option>
    <option value="enabled">Sign-in enabled</option>
    <option value="disabled">Disabled</option>
    <option value="no-credential">No credential</option>
  </select>
  <select name="accountBlocked" [ngModel]="fblocked()" (ngModelChange)="fblocked.set($event)" aria-label="Live block filter">
    <option value="">All live block states</option><option value="blocked">Blocked accounts</option><option value="clear">No active block</option>
  </select>
  <select name="accountBlockKind" [ngModel]="fblockKind()" (ngModelChange)="fblockKind.set($event)" aria-label="Active block type filter">
    <option value="">All active block types</option>@for (k of blockKinds; track k) { <option [value]="k">{{blockLabels[k]}}</option> }
  </select>
</div>
<p class="hint">Branch sign-in settings above need Review &amp; Apply. Live state below includes all active security blocks, with expired locks excluded. "Not blocked" does not guarantee access to an application. Last checked: {{checkedAt()}}. Use Refresh for changes made elsewhere.</p>
@if (stateError()) { <p role="alert" class="msg bad">{{stateError()}}</p> }
<div class="tcard"><div class="twrap"><table id="users-table">
<thead><tr>
  <th><button class="thbtn" (click)="sortBy('name')">User {{sortIcon('name')}}</button></th>
  <th><button class="thbtn" (click)="sortBy('dept')">Department {{sortIcon('dept')}}</button></th>
  <th>E-mail</th><th>Manager</th>
  <th><button class="thbtn" (click)="sortBy('status')">Branch sign-in {{sortIcon('status')}}</button></th>
  <th>Live account state</th><th></th>
</tr></thead>
<tbody>
@for (u of filtered(); track u.id) {<tr>
  <td><span class="tuser"><app-avatar [userId]="u.id" [name]="u.display_name" [color]="deptColor(u.department)" /><span class="tx"><b>{{u.display_name}}</b><small>{{u.id}}</small></span></span></td>
  <td><span class="tag" [style.background]="'color-mix(in srgb, '+deptColor(u.department)+' 13%, transparent)'" [style.color]="deptColor(u.department)">{{u.department || '—'}}</span></td>
  <td class="mail">{{u.email || '—'}}</td>
  <td class="mgr">{{managerName(u)}}</td>
  <td><span class="st" [class.ok]="userStatus(u)==='enabled'" [class.off]="userStatus(u)==='no-credential'" [class.bad]="userStatus(u)==='disabled'">{{statusLabel(userStatus(u))}}</span></td>
  <td class="live-account-state"><span class="st" [class.bad]="liveState(u.id)==='Blocked' || liveState(u.id)==='Sign-in disabled'" [class.ok]="liveState(u.id)==='Not blocked'">{{liveState(u.id)}}</span>
    @for (b of liveBlocks(u.id); track b.kind) { <small class="block-kind">{{blockLabels[b.kind] || b.kind}}</small> }
  </td>
  <td class="acts"><button class="secondary rowbtn" [attr.id]="'user-open-'+u.id" (click)="start(u)" [title]="readOnly() ? 'View the main profile; authorised live block controls remain available' : 'Edit this user on the working branch'">{{readOnly() ? 'View' : 'Edit'}}</button>
    <span class="rowmenu"><button class="secondary rowbtn" (click)="toggleMenu(u.id, $event)" [attr.aria-expanded]="menuFor()===u.id" aria-label="More actions">⋯</button>
      @if (menuFor()===u.id) {<span class="pop" (click)="$event.stopPropagation()">
        <button (click)="quickToggle(u)" [disabled]="busy() || s.branch()==='main' || !u.hasCredential" [class.danger]="u.login_enabled" [title]="!u.hasCredential ? 'No credential yet: give one with Edit first' : ''">{{u.login_enabled ? 'Disable sign-in' : 'Enable sign-in'}}</button>
      </span>}
    </span></td>
</tr>}
@empty {<tr><td colspan="7" class="empty">No users match.</td></tr>}
</tbody></table></div>
<div class="tfoot"><span>{{filtered().length}} of {{people().length}} users · sorted by {{sortLabel()}}</span></div></div>

@if (editing()) {<div class="scrim" (click)="cancel()"></div>
<aside class="drawer" id="user-editor" role="dialog" [attr.aria-label]="key ? (readOnly() ? 'View '+key : 'Edit '+key) : 'Create user'">
  <div class="dhead">
    @if (photo()) {<img class="av big" id="drawer-photo" [src]="photo()" [style.object-fit]="'cover'" alt="">}
    @else {<span class="av big" [style.background]="'color-mix(in srgb, '+deptColor(form.department || 'user')+' 13%, transparent)'" [style.color]="deptColor(form.department || 'user')" [style.border]="'1px solid '+deptColor(form.department || 'user')">{{initials(form.display_name || form.id || '?')}}</span>}
    <span class="tx"><h3>{{key ? (form.display_name || key) : 'Create user'}}</h3>
      @if (key) {<span class="sub">{{key}} · <span class="tag" [style.background]="'color-mix(in srgb, '+deptColor(form.department || 'user')+' 13%, transparent)'" [style.color]="deptColor(form.department || 'user')">{{form.department || '—'}}</span>
        @if (current(); as cu) {<span class="st" [class.ok]="userStatus(cu)==='enabled'" [class.off]="userStatus(cu)==='no-credential'" [class.bad]="userStatus(cu)==='disabled'">Branch: {{statusLabel(userStatus(cu))}}</span>}</span>}
    </span>
    <button class="secondary x" type="button" (click)="cancel()" title="Close">✕</button>
  </div>
  @if (partialSave()) { <p role="alert" class="msg bad" id="user-partial-save">User details were saved to this branch, but the additional profile fields were not saved. Your field edits are kept below. Retry saves those fields without repeating unchanged user details. Nothing becomes live until Review &amp; Apply.</p> }
  @if (key) {
    <section class="panel user-live-status"><h4>Live account state</h4><strong>{{liveState(key)}}</strong>
      @for (b of liveBlocks(key); track b.kind) { <p>{{blockLabels[b.kind] || b.kind}}</p> }
      <p class="hint">Profile changes below belong to the selected branch. Live security blocks are independent.</p>
    </section>
    @if (canProtect()) { <app-user-account-blocks [userId]="key" (changed)="loadAccountStates()" /> }
    @else { <p class="hint">Managing blocks and viewing their reasons needs the account-blocks permission.</p> }
  }
  @if (readOnly()) { <p class="msg" id="user-readonly-note" role="status">Viewing the main profile (read only). Pick a working branch to edit profile data. Authorised live block actions above remain available.</p> }
  <form (ngSubmit)="save()"><fieldset class="ro-set" [disabled]="readOnly()">
  <h4>Identity</h4>
  <label>User ID<input name="uid" [(ngModel)]="form.id" [disabled]="!!key" required pattern="[a-z0-9-]{1,32}" />@if(!key){<small>Lowercase letters, digits and dashes; cannot change later.</small>}</label>
  <label>Display name<input name="displayName" [(ngModel)]="form.display_name" maxlength="80" /></label>
  <h4>Organisation</h4>
  <label>E-mail <small>used for sign-in codes</small><input name="email" type="text" [(ngModel)]="form.email" maxlength="254" autocomplete="off" /></label>
  <label>Department<input name="department" [disabled]="!canEditAuthority()" [(ngModel)]="form.department" maxlength="40" /></label>
  <label>Manager<select name="manager" [(ngModel)]="form.manager_id" [disabled]="!canEditAuthority()"><option value="">None</option>@for(u of users();track u.id){@if(u.id!==form.id){<option [value]="u.id">{{u.display_name}} ({{u.id}})</option>}}</select></label>
  @if (key && chain(); as c) {@if (c.manager || c.reports.length) {<div class="chain">
    @if (c.manager) {<span class="node"><span class="av mini" [style.background]="'color-mix(in srgb, '+deptColor(c.manager.department)+' 13%, transparent)'" [style.color]="deptColor(c.manager.department)">{{initials(c.manager.display_name)}}</span> {{c.manager.display_name}}</span><span class="arr">←</span>}
    <span class="node me"><span class="av mini" [style.background]="'color-mix(in srgb, '+deptColor(form.department || 'user')+' 13%, transparent)'" [style.color]="deptColor(form.department || 'user')">{{initials(form.display_name || key || '?')}}</span> {{form.display_name || key}}</span>
    @if (c.reports.length) {<span class="arr">←</span>}
    @for (r of c.reports; track r.id) {<span class="node"><span class="av mini" [style.background]="'color-mix(in srgb, '+deptColor(r.department)+' 13%, transparent)'" [style.color]="deptColor(r.department)">{{initials(r.display_name)}}</span> {{r.display_name}}</span>}
  </div>}}
  @if (key && pfields().length) { <h4>Profile fields</h4><p class="hint">Fields the administrator configuration lets an administrator edit. Saved on the working branch like the rest.</p>
  @for (f of pfields(); track f.key) {
  @if (f.type==='image') { <div class="pf-image"><span class="pf-label">{{f.label}} <small>(read only) · plugin profile-picture</small></span>@if (photo()) {<img class="pf-thumb" [src]="photo()" alt="" />}@else {<span class="pf-thumb pf-nopic">No picture</span>}<small class="hint">Belongs to the person; administrators see it but cannot change it.</small></div> }
  @else { <label>{{f.label}}@if(!f.editable){<small> (read only)</small>}
  @if (f.type==='select') {<select [name]="'pf'+f.key" [ngModel]="pvals()[f.key] ?? ''" (ngModelChange)="setP(f.key,$event)" [disabled]="!f.editable"><option value="">-</option>@for(o of f.options;track o.value){<option [value]="o.value">{{o.label}}</option>}</select>}
  @else if (f.type==='boolean') {<select [name]="'pf'+f.key" [ngModel]="boolStr(f.key)" (ngModelChange)="setP(f.key,$event===''?null:$event==='true')" [disabled]="!f.editable"><option value="">-</option><option value="true">Yes</option><option value="false">No</option></select>}
  @else if (f.type==='number' || f.type==='date' || f.type==='email' || f.type==='url' || f.type==='phone') {<input [type]="f.type==='phone'?'tel':f.type" [name]="'pf'+f.key" [ngModel]="pvals()[f.key] ?? ''" (ngModelChange)="setP(f.key,$event)" [disabled]="!f.editable" />}
  @else {<input type="text" [name]="'pf'+f.key" [ngModel]="pvals()[f.key] ?? ''" (ngModelChange)="setP(f.key,$event)" [disabled]="!f.editable" />}
  </label> } } }
  @if (key) {<app-user-plugin-sections [userId]="key" />}
  @if(key){<h4>Roles &amp; rights</h4><app-roles-rights [userId]="key" />}
  <h4>Security</h4>
  <label class="inline"><input type="checkbox" name="enabled" [(ngModel)]="form.login_enabled" /> Allow sign-in</label>
  @if (!key) {
  <label>Temporary password<input type="password" name="userPassword" [(ngModel)]="password" autocomplete="new-password" minlength="12" maxlength="128" required /></label>
  <label>Valid for (hours, at most 168)<input type="number" name="userTempHours" [(ngModel)]="tempHours" min="1" max="168" step="1" required /></label>
  <p class="hint">The person must choose their own password at first sign-in. Sent only in the request body; never returned in the table, SQL, history or logs. Do not use a real password in this public demo.</p>
  } @else if (!readOnly()) {
  <p class="hint">An administrator cannot set a permanent password. Set a temporary one: the person must choose a new password at the next sign-in.</p>
  <label>Temporary password<input type="password" name="tempPassword" [(ngModel)]="tempPassword" autocomplete="new-password" minlength="12" maxlength="128" /></label>
  <label>Valid for (hours, at most 168)<input type="number" name="tempPasswordHours" [(ngModel)]="tempHours" min="1" max="168" step="1" /></label>
  <button type="button" class="secondary" id="user-temp-password" (click)="setTemporary()" [disabled]="busy() || !tempPassword">Set temporary password</button>
  }
  @if (key && form.login_enabled && !readOnly()) {<div class="danger-zone"><p>Disabling sign-in applies on the working branch and takes effect only after Review &amp; Apply.</p><button type="button" class="danger" id="user-disable" (click)="disableAndSave()" [disabled]="busy()">Disable sign-in</button></div>}
  </fieldset>
  <div class="foot">@if (!readOnly()) {<button class="grow" id="user-save" [disabled]="busy()">Save user to branch</button>}<button type="button" class="secondary" [class.grow]="readOnly()" (click)="cancel()">{{readOnly() ? 'Close' : 'Cancel'}}</button></div>
  </form>
</aside>}
` })
export class UsersPage {
  protected readonly s = inject(Session);
  protected users = signal<UserProfile[]>([]); protected note = signal(''); protected busy = signal(false); protected editing = signal(false);
  protected pfields = signal<any[]>([]); protected pvals = signal<Record<string, unknown>>({}); private pchanged: Record<string, unknown> = {};
  /** The picture plugin's value for the edited user, when the plugin is active (the avatar shows it, initials otherwise). */
  protected photo() { const v = this.pvals()['profile-picture.picture'] ?? (this.key ? this.photos()[this.key] : undefined); return typeof v === 'string' && v.startsWith('data:image/') ? v : ''; }
  /** Pictures of the people in the list (live values, only what the server lets this administrator see). */
  private readonly pictures = inject(UserPictures);
  protected photos = this.pictures.map;
  protected readOnly() { return this.s.branch() === 'main'; }
  private pvalsFor: string | null = null; private profileRequest = 0;
  protected accountStates = signal<DirectoryAccountStatuses>({ asOf: 0, accounts: {} });
  protected stateError = signal(''); protected fblocked = signal(''); protected fblockKind = signal('');
  protected readonly blockLabels = BLOCK_LABELS; protected readonly blockKinds = Object.keys(BLOCK_LABELS);
  private serverOffset = 0;
  protected clock = signal(Date.now()); private stateRequest = 0;
  private clockTimer?: ReturnType<typeof setInterval>;
  protected checkedAt() { return this.accountStates().asOf ? new Date(this.accountStates().asOf).toLocaleTimeString('en-GB') : 'not yet checked'; }
  protected liveState(id: string) { return accountState(this.accountStates().accounts[id], this.clock()); }
  protected liveBlocks(id: string) { return activeBlocks(this.accountStates().accounts[id]?.blocks ?? [], this.clock()); }
  protected async loadAccountStates() {
    const request = ++this.stateRequest, branch = this.s.branch(); this.accountStates.set({ asOf: 0, accounts: {} }); this.stateError.set('');
    try { const r = await this.s.api.raw<DirectoryAccountStatuses>('GET', '/directory-account-status', undefined, this.h());
      if (request !== this.stateRequest || branch !== this.s.branch()) return;
      if (r.status >= 400 || !r.data?.accounts || typeof r.data.asOf !== 'number') throw new Error('Live account state unavailable. Refresh to check again.');
      this.serverOffset = r.data.asOf - Date.now(); this.accountStates.set(r.data); this.clock.set(r.data.asOf);
    } catch (e) { if (request === this.stateRequest) this.stateError.set((e as Error).message); }
  }
  protected search = signal(''); protected fdept = signal(''); protected fstatus = signal<'' | UserStatus>('');
  protected sortKey = signal<SortKey>('name'); protected sortDir = signal<1 | -1>(1);
  protected menuFor = signal<string | null>(null);
  protected partialSave = signal(false);
  private savedDetails = '';
  protected key: string | null = null; protected password = ''; protected tempPassword = ''; protected tempHours = 72; protected form = { id: '', display_name: '', email: '', department: '', manager_id: '', login_enabled: true };

  protected readonly initials = initials; protected readonly deptColor = deptColor;
  protected readonly userStatus = userStatus; protected readonly statusLabel = statusLabel;

  ngOnInit() { void this.load(); if (typeof window !== 'undefined') this.clockTimer = setInterval(() => this.clock.set(Date.now() + this.serverOffset), 1000); }

  /** Referenced managers (reference rows) feed the manager field and the chain, never the list. */
  protected people = computed(() => this.users().filter((u) => !(u as { reference?: boolean }).reference));
  /** Manager and department are authority fields: only the super admin changes them. */
  protected canProtect() { return canOpen(this.s.access(), 'account-blocks'); }
  protected canEditAuthority() { const a = this.s.access(); return !a || !a.screenAccess || !a.screens || a.screens.includes('authority-edit'); }
  protected stats = computed(() => userStats(this.people()));
  protected departments = computed(() => [...new Set(this.people().map((u) => u.department).filter(Boolean))].sort());
  protected filtered = computed(() => sortUsers(filterUsers(this.people().filter(u => matchesAccount(this.accountStates().accounts[u.id], this.fblocked(), this.fblockKind(), this.clock())), { q: this.search(), dept: this.fdept(), status: this.fstatus() }), this.sortKey(), this.sortDir()));
  // NOT computed(): key is a plain property (ngModel-bound form state), so a computed would cache the first user opened.
  protected current() { return this.users().find((u) => u.id === this.key) ?? null; }
  protected chain() { const c = this.current(); return c ? managerChain(c, this.users()) : null; }

  protected sortBy(k: SortKey) { if (this.sortKey() === k) this.sortDir.update((d) => (d === 1 ? -1 : 1)); else { this.sortKey.set(k); this.sortDir.set(1); } }
  protected sortIcon(k: SortKey) { return this.sortKey() !== k ? '↕' : this.sortDir() === 1 ? '↑' : '↓'; }
  protected sortLabel() { return (this.sortKey() === 'name' ? 'name' : this.sortKey() === 'dept' ? 'department' : 'sign-in status') + (this.sortDir() === 1 ? ' ↑' : ' ↓'); }
  protected managerName(u: UserProfile) { const m = this.users().find((x) => x.id === u.manager_id); return m ? m.display_name : u.manager_id || '—'; }

  protected toggleMenu(id: string, ev: Event) { ev.stopPropagation(); this.menuFor.update((m) => (m === id ? null : id)); }
  @HostListener('document:click') closeMenu() { this.menuFor.set(null); }

  protected async load() { void this.loadAccountStates(); try { const r = await this.s.api.raw<{ users: UserProfile[] }>('GET', '/users', undefined, this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {}); this.users.set(r.data.users); void this.loadPhotos(); } catch (e) { this.note.set((e as Error).message); } }
  private async loadPhotos() { await this.pictures.ensure(true); }
  protected start(u?: UserProfile) { this.partialSave.set(false); this.savedDetails = ''; this.menuFor.set(null); this.key = u?.id ?? null; this.form = { id: u?.id ?? '', display_name: u?.display_name ?? '', email: u?.email ?? '', department: u?.department ?? '', manager_id: u?.manager_id ?? '', login_enabled: u?.login_enabled ?? true }; this.password = ''; this.editing.set(true); this.pfields.set([]); this.pvals.set({}); this.pchanged = {}; this.pvalsFor = u?.id ?? null; ++this.profileRequest; if (u) void this.loadP(u.id); }
  private h(): Record<string, string> { return this.s.adminToken() ? { 'x-api-admin-token': this.s.adminToken() } : {}; }
  private async loadP(id: string) { const request = this.profileRequest, branch = this.s.branch(); try { const r = await this.s.api.raw<any>('GET', '/users/' + encodeURIComponent(id) + '/profile', undefined, this.h()); if (r.status < 400 && this.editing() && this.pvalsFor === id && this.key === id && request === this.profileRequest && branch === this.s.branch()) { this.pfields.set(r.data.fields.filter((f: any) => !f.key.startsWith('base.'))); this.pvals.set(r.data.values); } } catch { /* profile fields are optional */ } }
  protected setP(k: string, v: unknown) { this.pvals.update((x) => ({ ...x, [k]: v })); this.pchanged[k] = v === '' ? null : v; }
  protected boolStr(k: string) { const v = this.pvals()[k]; return v === true ? 'true' : v === false ? 'false' : ''; }
  protected cancel() { this.partialSave.set(false); this.savedDetails = ''; this.password = ''; this.tempPassword = ''; this.editing.set(false); this.pvals.set({}); this.pfields.set([]); this.pvalsFor = null; ++this.profileRequest; }
  ngOnDestroy() { ++this.stateRequest; clearInterval(this.clockTimer); this.cancel(); }
  protected disableAndSave() { this.form.login_enabled = false; void this.save(); }
  protected async quickToggle(u: UserProfile) {
    this.menuFor.set(null); this.busy.set(true);
    try {
      await this.s.api.saveUser(u.id, { id: u.id, display_name: u.display_name, email: u.email ?? '', department: u.department, manager_id: u.manager_id ?? '', login_enabled: !u.login_enabled }, this.s.adminToken());
      await this.load(); this.note.set((u.login_enabled ? 'Sign-in disabled for ' : 'Sign-in enabled for ') + u.id + '. Apply is required before live sign-in changes.');
    } catch (e) { this.note.set((e as Error).message); } finally { this.busy.set(false); }
  }
  /** Admin: a TEMPORARY password for an existing person. The value is typed here, sent once, never kept. */
  protected async setTemporary() {
    if (this.readOnly() || !this.key || !this.tempPassword) return;
    this.busy.set(true);
    try {
      const r = await this.s.api.raw<any>('POST', '/users/' + encodeURIComponent(this.key) + '/temporary-password', { password: this.tempPassword, hours: Number(this.tempHours) }, this.h());
      if (r.status >= 400) throw new Error(Array.isArray(r.data?.message) ? r.data.message.join(' ') : r.data?.message ?? 'Temporary password not set');
      this.note.set(r.data?.pendingPublication ? 'Temporary password saved on the working branch. It is active only after Review & Apply.' : 'Temporary password set. The person must choose a new password at the next sign-in.');
    } catch (e) { this.note.set('Temporary password not set: ' + (e as Error).message); } finally { this.tempPassword = ''; this.busy.set(false); }
  }
  protected async save() {
    if (this.readOnly()) return; // main is read only: the sheet opens for reading, the API refuses writes anyway
    this.busy.set(true);
    try {
      const b: Record<string, unknown> = { ...this.form }; if (!this.key && this.password) { b['password'] = this.password; b['hours'] = Number(this.tempHours); }
      // The directory and plugin stores use separate requests. Keep a checkpoint so an error in the
      // second cannot look like an all-or-nothing failure, and retries do not repeat a password reset.
      const details = JSON.stringify([this.s.branch(), this.key, this.form]);
      if (this.savedDetails !== details || (!this.key && this.password)) {
        await this.s.api.saveUser(this.key, b, this.s.adminToken());
        this.savedDetails = details; this.password = '';
      }
      if (this.key && Object.keys(this.pchanged).length) { const r = await this.s.api.raw<any>('PATCH', '/users/' + encodeURIComponent(this.key) + '/profile', { values: this.pchanged }, this.h()); if (r.status >= 400) throw new Error(Array.isArray(r.data.message) ? r.data.message.join(' ') : r.data.message ?? 'Profile fields refused'); }
      this.partialSave.set(false);
      this.cancel(); await this.load(); this.note.set('User saved on the working branch. Apply is required before live sign-in changes.');
    } catch (e) { this.partialSave.set(!!this.savedDetails); this.note.set((this.savedDetails ? 'Additional profile fields not saved: ' : 'User details not saved: ') + (e as Error).message); } finally { this.password = ''; this.busy.set(false); }
  }
}
