import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AssignmentData, referencedActions } from './assignment-data';

/** One editor is shared by Users and the assignment search drawer. Actions stage immediately, never publish. */
@Component({selector:'app-roles-rights',imports:[FormsModule,RouterLink],styleUrls:['./users.css','./assignments.css'],template:`
<div class="dtabs" role="tablist" aria-label="User access">
 <button type="button" role="tab" [attr.aria-selected]="tab()==='roles'" [class.on]="tab()==='roles'" (click)="tab.set('roles')">Roles ({{d.ids(userId()).length}})</button>
 <button type="button" role="tab" [attr.aria-selected]="tab()==='rights'" [class.on]="tab()==='rights'" (click)="tab.set('rights')">Resulting rights</button>
</div>
@if(d.error()){<p class="msg error" role="alert">{{d.error()}}</p>}
@if(d.note()){<p class="msg" role="status">{{d.note()}}</p>}
@if(d.loading()){<p class="hint" role="status">Loading access…</p>}
@else if(tab()==='roles'){
 <p class="hint">Direct assignments on {{d.s.branch()}}. Changes are staged separately from the user profile.</p>
 @if(d.conflict(userId()).length){<div class="warning" role="alert">@for(c of d.conflict(userId());track c.role_a+c.role_b){<p>SoD: {{userId()}} has {{c.role_a}} and {{c.role_b}}. Remove one before Apply.</p>}</div>}
 <div class="member-list">@for(id of d.ids(userId());track id){<div class="mrow"><span class="grow"><b>{{d.label(id)}}</b><small>{{id}}</small></span><button type="button" class="secondary" [attr.aria-label]="'Remove '+id" (click)="d.stage([{identity:userId(),role:id,assigned:false}])" [disabled]="locked()">Remove</button></div>}@empty{<p class="empty">No role assigned. Creating a user grants no access.</p>}</div>
 <label>Add a role<select name="assignmentRole" [ngModel]="selected()" (ngModelChange)="selected.set($event)"><option value="">Choose a role…</option>@for(r of available();track r.id){<option [value]="r.id">{{r.label}} ({{r.id}})</option>}</select></label>
 @if(proposedConflict()){<p class="warning" role="alert">This role conflicts with an existing assignment. You may stage it to inspect the conflict, but Apply will be refused.</p>}
 <button type="button" (click)="add()" [disabled]="locked() || !selected()">Stage assignment</button>
 <p class="hint">Assignments have no expiry in this POC. Temporary access is not supported.</p>
}@else{
 <p class="hint">Policy references for these roles, not a guarantee of access. Conditions, resources, other rules and forbids are evaluated by the permission engine. Unlinked policies may also apply.</p>
 @if(d.policyNote()){<p class="warning">{{d.policyNote()}}</p>}
 @for(r of d.refs(d.ids(userId()));track r.id){<article class="policy-ref"><span class="pill" [class.bad]="r.effect==='forbid'">{{r.effect}}</span><b>{{r.name}}</b><p>{{r.description || r.summary}}</p><div class="chips">@for(a of actions(r);track a){<code>{{a}}</code>}</div><details><summary>Conditions &amp; source</summary><pre>{{r.text}}</pre></details></article>}@empty{<p class="empty">No explicit role reference found in the available policy catalogue.</p>}
 <a routerLink="/policies">Open Policies to inspect and simulate</a>
}
`})
export class RolesRights {
 readonly userId=input.required<string>();protected readonly d=inject(AssignmentData);protected tab=signal<'roles'|'rights'>('roles');protected selected=signal('');
 protected available=computed(()=>this.d.roles().filter(r=>!this.d.ids(this.userId()).includes(r.id)));
 protected proposedConflict(){const id=this.selected();return !!id && this.d.rules().some(r=>r.role_a===id && this.d.ids(this.userId()).includes(r.role_b)||r.role_b===id && this.d.ids(this.userId()).includes(r.role_a));}
 protected locked(){return this.d.busy()||this.d.loading()||!this.d.s.branch()||this.d.s.branch()==='main';}
 protected readonly actions=referencedActions;
 protected async add(){if(this.selected() && await this.d.stage([{identity:this.userId(),role:this.selected(),assigned:true}]))this.selected.set('');}
}
