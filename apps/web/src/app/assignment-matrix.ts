import { Component, HostListener, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AssignmentData, AssignmentOp, filterAssignments, wouldConflict } from './assignment-data';
import { AssignmentFilters, emptyFilter } from './assignment-filters';

export const cellKey=(identity:string,role:string)=>identity+'|'+role;
export function assignmentDelta(original:{identity_id:string;role_id:string}[], choices:Map<string,boolean>):AssignmentOp[] {
 return [...choices].flatMap(([key,assigned])=>{const [identity,role]=key.split('|');return original.some(a=>a.identity_id===identity&&a.role_id===role)===assigned?[]:[{identity,role,assigned}];});
}
@Component({selector:'app-assignment-matrix',imports:[FormsModule,RouterLink,AssignmentFilters],styleUrls:['./users.css','./assignments.css','./assignment-matrix.css'],template:`
<div class="head"><div class="grow"><h2>Bulk assignment matrix</h2><span class="cnt">{{step()===1?'1. Select people and role columns':'2. Edit the selected scope'}}</span></div><a routerLink="/assignments">Back to search</a></div>
<p class="hint">Direct roles only. Select people explicitly, choose role columns, then review the exact changes before staging. Nothing is live until Review &amp; Apply.</p>
@if(d.error()){<p class="msg error" role="alert">{{d.error()}}</p>}
@if(d.note()){<p class="msg" role="status">{{d.note()}}</p>}
@if(d.loading()){<p role="status">Loading the working branch…</p>}
@if(step()===1){
<app-assignment-filters [(filters)]="filter" />
<div class="selection-layout"><section class="searchcard"><div class="head"><div class="grow"><h3>People</h3><span class="hint">{{selectedUsers().size}} selected · {{results().length}} matching</span></div><button class="secondary" (click)="selectMatches()" [disabled]="d.loading() || results().length>100">Select all matches</button><button class="secondary" (click)="clearUsers()">Clear people</button></div>
<div class="selection-list">@for(u of results();track u.id){<label class="check-label"><input type="checkbox" [checked]="selectedUsers().has(u.id)" (change)="chooseUser(u.id,$any($event.target).checked)" [disabled]="!selectedUsers().has(u.id) && selectedUsers().size>=100" /><span class="text-pair"><b>{{u.display_name}}</b><small>{{u.id}} · {{u.department || '-'}} · {{d.ids(u.id).length}} roles</small></span></label>}@empty{<p class="empty">No matches. Change or reset the filters.</p>}</div><p class="hint">Selections survive filter changes. {{hiddenSelected()}} selected people are outside the current results. Maximum 100 people.</p></section>
<section class="searchcard"><h3>Role columns</h3><label>Find roles<input name="matrixRoleSearch" [ngModel]="roleSearch()" (ngModelChange)="roleSearch.set($event)" placeholder="Name or id…" /></label><div class="selection-list">@for(r of roleOptions();track r.id){<label class="check-label"><input type="checkbox" [checked]="selectedRoles().has(r.id)" (change)="chooseRole(r.id,$any($event.target).checked)" [disabled]="!selectedRoles().has(r.id)&&selectedRoles().size>=20" /><span class="text-pair"><b>{{r.label}}</b><small>{{r.id}}</small></span></label>}</div><p class="hint">{{selectedRoles().size}} columns selected · maximum 20. You can remove columns to keep the grid focused.</p></section></div>
<div class="matrix-foot"><span class="grow">{{selectedUsers().size}} people × {{selectedRoles().size}} roles</span><button (click)="step.set(2)" [disabled]="!selectedUsers().size || !selectedRoles().size || d.loading()">Open matrix</button></div>
}@else{
<div class="head"><div class="grow"><h3>{{people().length}} people × {{columns().length}} role columns</h3><span class="hint">Checked = assigned. Outlined cells = local changes. Red = SoD conflict.</span></div><button class="secondary" (click)="step.set(1)">Change selection</button></div>
<div class="matrix-wrap"><table class="matrix" id="assignment-matrix"><thead><tr><th>Person / Role</th>@for(r of columns();track r.id){<th><b>{{r.label}}</b><br><small>{{r.id}}</small><div><button class="secondary" (click)="setColumn(r.id,true)" [disabled]="locked()" [attr.aria-label]="'Assign '+r.id+' to selected people'">Assign all</button><button class="secondary" (click)="setColumn(r.id,false)" [disabled]="locked()" [attr.aria-label]="'Remove '+r.id+' from selected people'">Remove all</button></div></th>}</tr></thead><tbody>
@for(u of people();track u.id){<tr><th><b>{{u.display_name}}</b><br><small>{{u.id}} · {{u.department || '-'}}</small></th>@for(r of columns();track r.id){<td [class.changed]="changed(u.id,r.id)" [class.conflict]="cellConflict(u.id,r.id)"><input type="checkbox" [attr.aria-label]="u.id+' / '+r.id" [checked]="checked(u.id,r.id)" [disabled]="locked() || blocked(u.id,r.id)" (change)="toggle(u.id,r.id,$any($event.target).checked)" [title]="blocked(u.id,r.id)?'Remove the incompatible role first (including roles outside these columns)':'Toggle assignment'" />@if(blocked(u.id,r.id)){<small class="ko"> SoD blocked</small>}</td>}</tr>}
</tbody></table></div>
@if(skipped()){<p class="warning">{{skipped()}} conflicting addition(s) skipped. Remove incompatible roles first. Roles outside the selected columns also count.</p>}
@if(ops().length>1000){<p class="warning">This batch has more than 1000 changes. Narrow the selection or reset some cells.</p>}
<div class="matrix-foot"><span class="grow">{{adds()}} additions · {{ops().length-adds()}} removals · {{ops().length}} pending changes</span><button class="secondary" (click)="reset()" [disabled]="!ops().length || d.busy()">Reset edits</button><button (click)="reviewing.set(true)" [disabled]="locked() || !ops().length || ops().length>1000">Review changes</button></div>
}
@if(reviewing()){
<div class="scrim" (click)="reviewing.set(false)"></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="Review bulk assignment changes" id="matrix-review"><div class="dhead"><div class="tx"><h3>Review {{ops().length}} assignment changes</h3><span class="hint">Branch {{d.s.branch()}} · no automatic publication</span></div><button class="secondary x" (click)="reviewing.set(false)" aria-label="Close bulk review">✕</button></div><div class="dbody"><p>{{adds()}} additions and {{ops().length-adds()}} removals. Unlisted cells stay unchanged.</p><div class="member-list">@for(op of ops();track op.identity+op.role){<div class="mrow"><span class="pill" [class.bad]="!op.assigned">{{op.assigned?'Add':'Remove'}}</span><span class="grow"><b>{{op.identity}}</b><small>{{op.role}}</small></span></div>}</div><p class="hint">The server validates the full batch before writing and stages it in one assignment commit. Apply runs the authoritative SoD checks.</p>@if(d.error()){<p role="alert" class="msg error">{{d.error()}}</p>}</div><div class="foot"><button class="grow" (click)="stage()" [disabled]="locked()">Stage {{ops().length}} changes</button><button class="secondary" (click)="reviewing.set(false)" [disabled]="d.busy()">Cancel</button></div></aside>}
`})
export class AssignmentMatrixPage {
 ngOnInit(){void this.d.load();}
 protected readonly d=inject(AssignmentData);protected filter=signal(emptyFilter());protected roleSearch=signal('');protected step=signal(1);protected selectedUsers=signal(new Set<string>());protected selectedRoles=signal(new Set<string>());protected choices=signal(new Map<string,boolean>());protected reviewing=signal(false);protected skipped=signal(0);
 protected results=computed(()=>filterAssignments(this.d.users(),this.d.assignments(),this.d.rules(),this.d.members(),this.d.staged(),this.filter()));
 protected roleOptions=computed(()=>this.d.roles().filter(r=>(r.id+' '+r.label).toLowerCase().includes(this.roleSearch().toLowerCase())));
 protected people=computed(()=>this.d.users().filter(u=>this.selectedUsers().has(u.id)).sort((a,b)=>a.display_name.localeCompare(b.display_name)));
 protected columns=computed(()=>this.d.roles().filter(r=>this.selectedRoles().has(r.id)));
 protected ops=computed(()=>assignmentDelta(this.d.assignments(),this.choices()));protected adds=computed(()=>this.ops().filter(o=>o.assigned).length);
 protected hiddenSelected=computed(()=>[...this.selectedUsers()].filter(id=>!this.results().some(u=>u.id===id)).length);
 constructor(){effect(()=>{this.d.s.branchEpoch();this.selectedUsers.set(new Set());this.selectedRoles.set(new Set());this.choices.set(new Map());this.step.set(1);this.reviewing.set(false);});}
 protected chooseUser(id:string,on:boolean){this.selectedUsers.update(s=>{const n=new Set(s);on?n.add(id):n.delete(id);return n;});if(!on)this.drop(k=>k.startsWith(id+'|'));}
 protected chooseRole(id:string,on:boolean){this.selectedRoles.update(s=>{const n=new Set(s);on?n.add(id):n.delete(id);return n;});if(!on)this.drop(k=>k.endsWith('|'+id));}
 private drop(test:(k:string)=>boolean){this.choices.update(m=>new Map([...m].filter(([k])=>!test(k))));}
 protected clearUsers(){this.selectedUsers.set(new Set());this.reset();}
 protected selectMatches(){const ids=new Set(this.selectedUsers());for(const u of this.results()){if(ids.size>=100)break;ids.add(u.id);}this.selectedUsers.set(ids);}
 protected checked(id:string,role:string){return this.choices().get(cellKey(id,role)) ?? this.d.ids(id).includes(role);}
 private effective(id:string){return this.d.roles().filter(r=>this.checked(id,r.id)).map(r=>r.id);}
 protected blocked(id:string,role:string){return !this.checked(id,role)&&wouldConflict(this.effective(id),role,this.d.rules());}
 protected cellConflict(id:string,role:string){return this.checked(id,role)&&wouldConflict(this.effective(id),role,this.d.rules());}
 protected changed(id:string,role:string){return this.checked(id,role)!==this.d.ids(id).includes(role);}
 protected toggle(id:string,role:string,on:boolean){if(on&&this.blocked(id,role))return;this.choices.update(m=>new Map(m).set(cellKey(id,role),on));}
 protected setColumn(role:string,on:boolean){let skipped=0;for(const u of this.people()){if(on&&this.blocked(u.id,role))skipped++;else this.toggle(u.id,role,on);}this.skipped.set(skipped);}
 protected locked(){return this.d.busy()||this.d.loading()||this.d.s.branch()==='main'||!this.d.s.branch();}
 protected reset(){this.choices.set(new Map());this.skipped.set(0);}
 @HostListener('document:keydown.escape') protected close(){if(!this.d.busy())this.reviewing.set(false);}
 protected async stage(){const ops=this.ops();if(await this.d.stage(ops)){this.reset();this.reviewing.set(false);}}
}
