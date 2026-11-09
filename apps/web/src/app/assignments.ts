import { Component, HostListener, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AssignmentData, filterAssignments } from './assignment-data';
import { AssignmentFilters, emptyFilter } from './assignment-filters';
import { RolesRights } from './roles-rights';
import { UserProfile } from './api';
import { initials, deptColor, userStatus, statusLabel } from './users';

@Component({selector:'app-assignments',imports:[RouterLink,AssignmentFilters,RolesRights],styleUrls:['./users.css','./assignments.css'],template:`
<div class="head"><div class="grow"><h2>Assignments</h2><span class="cnt">Find people by access, then manage their roles.</span></div><a class="btn" routerLink="/assignments/matrix">Bulk edit matrix</a><button class="secondary" (click)="d.load()" [disabled]="d.busy()">Refresh</button></div>
<div class="stats"><div class="stat"><span class="n">{{d.assignments().length}}</span><span class="l">Direct assignments</span></div><div class="stat"><span class="n">{{d.users().length}}</span><span class="l">People in scope</span></div><div class="stat"><span class="n">{{withoutRole()}}</span><span class="l">Without a role</span></div><div class="stat"><span class="n">{{conflictCount()}}</span><span class="l">People with SoD conflicts</span></div></div>
<app-assignment-filters [(filters)]="filter" />
@if(d.error()){<p class="msg error" role="alert">{{d.error()}}</p>}
@if(d.note()){<p class="msg" role="status">{{d.note()}}</p>}
@if(d.loading()){<p role="status">Loading assignments…</p>}
<p class="result-count">{{results().length}} matching people · {{d.s.branch()}} <span class="hint"> · Direct roles only. Review &amp; Apply makes staged changes live.</span></p>
<div class="tcard"><div class="twrap"><table id="assignments"><thead><tr><th>Person</th><th>Department</th><th>Roles</th><th>Checks</th><th></th></tr></thead><tbody>
@for(u of results();track u.id){<tr><td><span class="tuser"><span class="av" [style.background]="'color-mix(in srgb, '+deptColor(u.department)+' 13%, transparent)'" [style.color]="deptColor(u.department)">{{initials(u.display_name)}}</span><span class="tx"><b>{{u.display_name}}</b><small>{{u.id}}</small></span></span></td><td>{{u.department || '-'}}</td><td class="roles"><div class="chips">@for(id of d.ids(u.id);track id){<span class="pill" [title]="d.label(id)">{{id}}</span>}@empty{<span class="hint">No role</span>}</div></td><td><div class="chips">@if(d.conflict(u.id).length){<span class="pill bad">SoD conflict</span>}@else{<span class="st ok">No SoD conflict</span>}@if(d.staged().has(u.id)){<span class="pill">Staged</span>}</div></td><td class="acts"><button class="secondary rowbtn" (click)="open(u)">Manage roles</button></td></tr>}
@empty{<tr><td colspan="5" class="empty">No people match these filters.</td></tr>}
</tbody></table></div><div class="tfoot">{{results().length}} of {{d.users().length}} people · sorted by name</div></div>
<p class="hint">Use Users for profile and sign-in settings. This console searches across assignments. Groups and assignment expiry are not part of this POC.</p>
@if(person();as u){<div class="scrim" (click)="close()"></div><aside class="drawer" role="dialog" aria-modal="true" [attr.aria-label]="'Roles for '+u.display_name" id="assignment-editor"><div class="dhead"><span class="av big" [style.background]="'color-mix(in srgb, '+deptColor(u.department)+' 13%, transparent)'" [style.color]="deptColor(u.department)">{{initials(u.display_name)}}</span><div class="tx"><h3>{{u.display_name}}</h3><span class="sub">{{u.id}} · {{u.department || '-'}}</span><span class="st" [class.ok]="userStatus(u)==='enabled'">{{statusLabel(userStatus(u))}}</span></div><button class="secondary x" (click)="close()" aria-label="Close assignment editor" [disabled]="d.busy()">✕</button></div><div class="dbody"><app-roles-rights [userId]="u.id" /></div><div class="foot"><button class="secondary grow" (click)="close()">Done</button><a routerLink="/users">Open Users</a></div></aside>}
`})
export class AssignmentsPage {
 ngOnInit(){void this.d.load();}
 protected readonly d=inject(AssignmentData);protected filter=signal(emptyFilter());protected person=signal<UserProfile|null>(null);
 protected results=computed(()=>filterAssignments(this.d.users(),this.d.assignments(),this.d.rules(),this.d.members(),this.d.staged(),this.filter()));
 protected withoutRole=computed(()=>this.d.users().filter(u=>!this.d.ids(u.id).length).length);
 protected conflictCount=computed(()=>this.d.users().filter(u=>this.d.conflict(u.id).length).length);
 protected readonly initials=initials;protected readonly deptColor=deptColor;protected readonly userStatus=userStatus;protected readonly statusLabel=statusLabel;
 constructor(){effect(()=>{this.d.s.branchEpoch();this.person.set(null);});}
 protected open(u:UserProfile){this.person.set(u);}
 @HostListener('document:keydown.escape') protected close(){if(!this.d.busy())this.person.set(null);}
}
