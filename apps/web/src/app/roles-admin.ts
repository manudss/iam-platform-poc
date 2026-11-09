import { Component, HostListener, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AssignmentData, Role, SodRule, referencedActions } from './assignment-data';
import { initials, deptColor } from './users';

@Component({selector:'app-roles-admin',imports:[FormsModule,RouterLink],styleUrls:['./users.css','./assignments.css'],template:`
<div class="head"><div class="grow"><h2>Roles</h2><span class="cnt">A catalogue of access roles, members and policy references.</span></div><button id="role-create" (click)="create()" [disabled]="locked()">Create role</button><button class="secondary" (click)="d.load()" [disabled]="d.busy()">Refresh</button></div>
<div class="stats"><div class="stat"><span class="n">{{d.roles().length}}</span><span class="l">Roles</span></div><div class="stat"><span class="n">{{sensitive()}}</span><span class="l">Sensitive roles</span></div><div class="stat"><span class="n">{{d.assignments().length}}</span><span class="l">Assignments</span></div><div class="stat"><span class="n">{{d.rules().length}}</span><span class="l">SoD rules</span></div></div>
@if(d.error()){<p class="msg error" role="alert">{{d.error()}}</p>}
@if(d.note()){<p class="msg" role="status">{{d.note()}}</p>}
<div class="toolbar"><span class="search"><input name="roleSearch" placeholder="Search a role name or id…" aria-label="Search roles" [ngModel]="search()" (ngModelChange)="search.set($event)" /></span><select name="roleSensitivity" aria-label="Sensitivity filter" [ngModel]="sensitivity()" (ngModelChange)="sensitivity.set($event)"><option value="">All roles</option><option value="sensitive">Sensitive only</option><option value="standard">Standard only</option></select></div>
@if(d.loading()){<p role="status">Loading roles…</p>}
<div class="tcard"><div class="twrap"><table id="role-table"><thead><tr><th>Role</th><th>Members</th><th>Policy references</th><th>Risk &amp; controls</th><th></th></tr></thead><tbody>
@for(r of filtered();track r.id){<tr><td><span class="tuser"><span class="role-symbol">⚖</span><span class="tx"><b>{{r.label}}</b><small>{{r.id}}</small></span></span></td><td>{{r.assigned}} member(s)</td><td>{{d.refs([r.id]).length}} linked rule(s)</td><td><div class="chips"><span class="pill" [class.sensitive]="r.is_sensitive">{{r.is_sensitive?'Sensitive':'Standard'}}</span>@if(roleRules(r.id).length){<span class="pill">{{roleRules(r.id).length}} SoD rule(s)</span>}</div></td><td class="acts"><button class="secondary rowbtn" (click)="open(r)">Open role</button></td></tr>}
@empty{<tr><td colspan="5" class="empty">No roles match.</td></tr>}
</tbody></table></div><div class="tfoot">{{filtered().length}} of {{d.roles().length}} roles · changes on {{d.s.branch()}}</div></div>
<p class="hint">A role alone grants nothing. Policies define access; Review &amp; Apply publishes staged changes. Use Assignments to search across people.</p>
@if(opened()){
<div class="scrim" (click)="close()"></div><aside class="drawer wide" id="role-editor" role="dialog" aria-modal="true" [attr.aria-label]="isNew()?'Create role':'Role '+key()">
 <div class="dhead"><span class="role-symbol">⚖</span><div class="tx"><h3>{{isNew()?'Create role':form.label}}</h3><span class="sub">{{key() || 'New definition'}} @if(!isNew()){<span class="pill" [class.sensitive]="form.is_sensitive">{{form.is_sensitive?'Sensitive':'Standard'}}</span>}</span></div><button class="secondary x" (click)="close()" aria-label="Close role editor">✕</button></div>
 @if(!isNew()){<div class="dtabs" role="tablist" aria-label="Role details">@for(t of tabs;track t.id){<button role="tab" type="button" [class.on]="tab()===t.id" [attr.aria-selected]="tab()===t.id" (click)="tab.set(t.id)">{{t.label}}</button>}</div>}
 <div class="dbody">
 @if(d.error()){<p class="msg error" role="alert">{{d.error()}}</p>}
 @if(d.note()){<p class="msg" role="status">{{d.note()}}</p>}
 @if(tab()==='members' && !isNew()){
  <h4>{{members().length}} members</h4><div class="catalog-filters"><input name="memberSearch" aria-label="Search role members" placeholder="Search members…" [ngModel]="memberSearch()" (ngModelChange)="memberSearch.set($event)" /><select aria-label="Member department" name="memberDept" [ngModel]="memberDept()" (ngModelChange)="memberDept.set($event)"><option value="">All departments</option>@for(x of departments();track x){<option [value]="x">{{x}}</option>}</select></div>
  <div class="member-list">@for(u of filteredMembers();track u.id){<div class="mrow"><span class="av" [style.background]="deptColor(u.department)+'22'" [style.color]="deptColor(u.department)">{{initials(u.display_name)}}</span><span class="grow"><b>{{u.display_name}}</b><small>{{u.id}} · {{u.department || '-'}}</small></span><button class="secondary" [attr.aria-label]="'Remove member '+u.id" (click)="d.stage([{identity:u.id,role:key(),assigned:false}])" [disabled]="locked()">Remove</button></div>}@empty{<p class="empty">No members match.</p>}</div>
  <h4>Add a member</h4><label>Find a person<input name="addMemberSearch" placeholder="Search by name, id or e-mail…" [ngModel]="addSearch()" (ngModelChange)="addSearch.set($event)" /></label><label>Person<select name="newMember" [(ngModel)]="newMember"><option value="">Choose a person…</option>@for(u of candidates();track u.id){<option [value]="u.id">{{u.display_name}} ({{u.id}})</option>}</select></label>
  @if(newMember && proposedConflict()){<p class="warning">This assignment creates a SoD conflict. You can stage it, but Apply will be refused until the conflict is removed.</p>}
  <button (click)="addMember()" [disabled]="locked() || !newMember">Stage member</button><p class="hint">For many people and roles, use the <a routerLink="/assignments/matrix">bulk matrix</a>.</p>
 }@else if(tab()==='grants'){
  <h4>Policy references</h4><p class="hint">These Cedar rules explicitly mention this role. They are not unconditional grants: conditions, resources and forbid rules still apply. Other policies may apply too.</p>
  @if(d.policyNote()){<p class="warning">{{d.policyNote()}}</p>}
  @for(r of d.refs([key()]);track r.id){<article class="policy-ref"><span class="pill" [class.bad]="r.effect==='forbid'">{{r.effect}}</span><b>{{r.name}}</b><p>{{r.description || r.summary}}</p><div class="chips">@for(a of actions(r);track a){<code>{{a}}</code>}</div><details><summary>Conditions &amp; source</summary><pre>{{r.text}}</pre></details></article>}@empty{<p class="empty">No explicit role reference in the available policy catalogue.</p>}<a routerLink="/policies">Inspect and simulate in Policies</a>
 }@else if(tab()==='sod'){
  <h4>Separation of duties</h4><p class="hint">A person cannot hold both roles. Apply refuses any conflicting assignment.</p>
  <div id="sod">@for(x of roleRules(key());track x.role_a+x.role_b){<div class="mrow"><span class="grow"><b>{{x.role_a}}</b><small>cannot be held with {{x.role_b}}</small></span><button class="secondary" (click)="removeRule(x)" [disabled]="locked()">Remove rule</button></div>}@empty{<p class="empty">No SoD rule for this role.</p>}</div>
  <label>Incompatible role<select name="sodOtherRole" [(ngModel)]="otherRole"><option value="">Choose a role…</option>@for(r of d.roles();track r.id){@if(r.id!==key()){<option [value]="r.id">{{r.label}} ({{r.id}})</option>}}</select></label><button id="sod-add" (click)="addRule()" [disabled]="locked() || !otherRole">Add SoD rule</button>
 }@else{
  <h4>Role definition</h4><label>Role ID<input name="rid" [(ngModel)]="form.id" [disabled]="!isNew()" pattern="[a-z0-9-]{1,32}" maxlength="32" /><small>Lowercase letters, digits and dashes. Cannot change: policies refer to it.</small></label><label>Label<input name="rlabel" [(ngModel)]="form.label" maxlength="80" /></label><label class="inline"><input type="checkbox" name="rsens" [(ngModel)]="form.is_sensitive" /> Sensitive role</label><p class="hint">The sensitive flag is a catalogue marker, not a permission rule.</p>
  @if(!isNew()){<div class="danger-zone"><p>Delete only when no person holds this role and no SoD rule refers to it. Check policy references before deleting.</p><button class="danger" (click)="remove()" [disabled]="locked() || members().length>0 || roleRules(key()).length>0">Delete role</button></div>}
 }
 </div><div class="foot">@if(tab()==='settings' || isNew()){<button class="grow" id="role-add" (click)="save()" [disabled]="locked() || !form.id || !form.label.trim()">{{isNew()?'Create role':'Save definition'}}</button>}<button class="secondary" (click)="close()">{{tab()==='settings' || isNew()?'Cancel':'Done'}}</button><span class="hint grow">Staged on {{d.s.branch()}} · live after Apply</span></div>
</aside>}
`})
export class RolesAdminPage {
 ngOnInit(){void this.d.load();}
 protected readonly d=inject(AssignmentData);protected search=signal('');protected sensitivity=signal('');protected opened=signal(false);protected isNew=signal(false);protected key=signal('');protected tab=signal('members');
 protected memberSearch=signal('');protected memberDept=signal('');protected addSearch=signal('');protected newMember='';protected otherRole='';
 protected form={id:'',label:'',is_sensitive:false};protected readonly initials=initials;protected readonly deptColor=deptColor;protected readonly actions=referencedActions;
 protected tabs=[{id:'members',label:'Members'},{id:'grants',label:'Grants'},{id:'sod',label:'SoD rules'},{id:'settings',label:'Settings'}];
 protected filtered=computed(()=>this.d.roles().filter(r=>(!this.search() || (r.id+' '+r.label).toLowerCase().includes(this.search().toLowerCase())) && (!this.sensitivity() || r.is_sensitive===(this.sensitivity()==='sensitive'))));
 protected sensitive=computed(()=>this.d.roles().filter(r=>r.is_sensitive).length);
 protected members=computed(()=>this.d.users().filter(u=>this.d.ids(u.id).includes(this.key())));
 protected departments=computed(()=>[...new Set(this.members().map(u=>u.department).filter(Boolean))].sort());
 protected filteredMembers=computed(()=>this.members().filter(u=>(!this.memberDept() || u.department===this.memberDept()) && (u.id+' '+u.display_name).toLowerCase().includes(this.memberSearch().toLowerCase())));
 protected candidates=computed(()=>this.d.users().filter(u=>!this.d.ids(u.id).includes(this.key()) && (u.id+' '+u.display_name+' '+(u.email??'')).toLowerCase().includes(this.addSearch().toLowerCase())));
 constructor(){effect(()=>{this.d.s.branchEpoch();this.opened.set(false);});}
 protected roleRules(id:string){return this.d.rules().filter(r=>r.role_a===id || r.role_b===id);}
 protected locked(){return this.d.busy() || this.d.loading() || !this.d.s.branch() || this.d.s.branch()==='main';}
 protected open(r:Role){this.key.set(r.id);this.form={...r};this.isNew.set(false);this.tab.set('members');this.memberSearch.set('');this.memberDept.set('');this.addSearch.set('');this.newMember='';this.otherRole='';this.opened.set(true);}
 protected create(){this.key.set('');this.form={id:'',label:'',is_sensitive:false};this.isNew.set(true);this.tab.set('settings');this.opened.set(true);}
 @HostListener('document:keydown.escape') protected close(){if(!this.d.busy())this.opened.set(false);}
 private async mutate(method:string,path:string,body:object|undefined,message:string){this.d.busy.set(true);this.d.error.set('');try{await this.d.request(method,path,body);this.d.note.set(message+' Saved on the working branch; live after Apply.');await this.d.load();return true;}catch(e){this.d.error.set((e as Error).message);return false;}finally{this.d.busy.set(false);}}
 protected async save(){if(await this.mutate(this.isNew()?'POST':'PATCH',this.isNew()?'/roles':'/roles/'+encodeURIComponent(this.key()),{id:this.form.id,label:this.form.label,is_sensitive:this.form.is_sensitive},'Role saved.'))this.close();}
 protected async remove(){if(confirm(`Delete role ${this.key()}? Policy references are not removed automatically.`) && await this.mutate('DELETE','/roles/'+encodeURIComponent(this.key()),undefined,'Role deleted.'))this.close();}
 protected async addRule(){if(await this.mutate('POST','/roles/sod-rules',{role_a:this.key(),role_b:this.otherRole},'Rule added.'))this.otherRole='';}
 protected removeRule(x:SodRule){if(confirm(`Remove the rule ${x.role_a} + ${x.role_b}? This loosens a control.`))void this.mutate('POST','/roles/sod-rules/remove',{...x,confirm:true},'Rule removed.');}
 protected proposedConflict(){return this.d.rules().some(r=>r.role_a===this.key() && this.d.ids(this.newMember).includes(r.role_b)||r.role_b===this.key() && this.d.ids(this.newMember).includes(r.role_a));}
 protected async addMember(){if(await this.d.stage([{identity:this.newMember,role:this.key(),assigned:true}]))this.newMember='';}
}
