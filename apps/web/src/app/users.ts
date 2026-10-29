import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Session } from './session';
import { UserProfile } from './api';
@Component({ selector:'app-users', imports:[FormsModule], styleUrl:'./pages.css', template:`
<p class="lead">Manage the directory used for sign-in. Profiles are committed to the selected working branch; password hashes are kept outside the database explorer.</p>
<p class="hint">Fictional demo only. On the free hosted demo, all data is lost when its disk is replaced. New accounts have demo administrator access, not production permissions.</p>
@if (note()) { <p role="status" class="msg">{{note()}}</p> }
<section class="card"><div class="row"><label>Search users<input name="search" [(ngModel)]="search" /></label><button (click)="start()" [disabled]="busy() || s.branch()==='main'">Create user</button><button class="secondary" (click)="load()">Refresh</button></div>
<div class="scroll"><table id="users-table"><thead><tr><th>User</th><th>Display name</th><th>Department</th><th>Manager</th><th>Sign-in</th><th></th></tr></thead><tbody>
@for (u of filtered();track u.id) {<tr><td>{{u.id}}</td><td>{{u.display_name}}</td><td>{{u.department}}</td><td>{{u.manager_id || '-'}}</td><td>{{u.login_enabled && u.hasCredential ? 'Enabled' : 'Disabled / no credential'}}</td><td><button class="secondary" (click)="start(u)" [disabled]="s.branch()==='main'">Edit</button></td></tr>}
@empty {<tr><td colspan="6">No users.</td></tr>}
</tbody></table></div></section>
@if (editing()) {<section class="card" id="user-editor"><h3>{{key ? 'Edit '+key : 'Create user'}}</h3><form (ngSubmit)="save()">
<div class="row"><label>User ID<input name="uid" [(ngModel)]="form.id" [disabled]="!!key" required pattern="[a-z0-9-]{1,32}" /></label><label>Display name<input name="displayName" [(ngModel)]="form.display_name" maxlength="80" /></label></div>
<div class="row"><label>Department<input name="department" [(ngModel)]="form.department" maxlength="40" /></label><label>Manager<select name="manager" [(ngModel)]="form.manager_id"><option value="">None</option>@for(u of users();track u.id){@if(u.id!==form.id){<option [value]="u.id">{{u.display_name}} ({{u.id}})</option>}}</select></label></div>
<label class="inline"><input type="checkbox" name="enabled" [(ngModel)]="form.login_enabled" /> Allow sign-in</label>
<label>{{key ? 'New password (leave blank to keep)' : 'Password'}}<input type="password" name="userPassword" [(ngModel)]="password" autocomplete="new-password" minlength="12" maxlength="128" [required]="!key" /></label>
<p class="hint">12 to 128 characters. Sent only in the request body; never returned in the table, SQL, history or logs. Do not use a real password in this public demo.</p>
<button id="user-save" [disabled]="busy()">Save user</button><button type="button" class="secondary" (click)="cancel()">Cancel</button></form></section>}
` })
export class UsersPage {
  protected readonly s=inject(Session); protected users=signal<UserProfile[]>([]); protected note=signal(''); protected busy=signal(false); protected editing=signal(false);
  protected search='';protected key:string|null=null;protected password='';protected form={id:'',display_name:'',department:'',manager_id:'',login_enabled:true};
  ngOnInit(){void this.load();} protected filtered(){const q=this.search.toLowerCase();return this.users().filter(u=>[u.id,u.display_name,u.department].some(x=>x?.toLowerCase().includes(q)));}
  protected async load(){try{const r=await this.s.api.raw<{users:UserProfile[]}>('GET','/users',undefined,this.s.adminToken()?{'x-api-admin-token':this.s.adminToken()}:{});this.users.set(r.data.users);}catch(e){this.note.set((e as Error).message);}}
  protected start(u?:UserProfile){this.key=u?.id??null;this.form={id:u?.id??'',display_name:u?.display_name??'',department:u?.department??'',manager_id:u?.manager_id??'',login_enabled:u?.login_enabled??true};this.password='';this.editing.set(true);}
  protected cancel(){this.password='';this.editing.set(false);}
  protected async save(){this.busy.set(true);try{const b:Record<string,unknown>={...this.form};if(this.password)b['password']=this.password;await this.s.api.saveUser(this.key,b,this.s.adminToken());this.cancel();await this.load();this.note.set('User saved on the working branch. Apply is required before live sign-in changes.');}catch(e){this.note.set((e as Error).message);}finally{this.password='';this.busy.set(false);}}
}
