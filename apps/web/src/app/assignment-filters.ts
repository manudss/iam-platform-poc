import { Component, computed, inject, model } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AssignmentData, AssignmentFilter } from './assignment-data';
export const emptyFilter = ():AssignmentFilter => ({q:'',department:'',organization:'',role:'',status:'',view:'all'});
@Component({selector:'app-assignment-filters',imports:[FormsModule],styleUrls:['./users.css','./assignments.css'],template:`
<div class="searchcard">
 <div class="bigsearch"><input name="assignmentSearch" aria-label="Search assignments" placeholder="Search people, e-mail, department or role…" [ngModel]="filters().q" (ngModelChange)="set('q',$event)" /></div>
 <div class="facets">
  <label>Department<select name="assignmentDepartment" [ngModel]="filters().department" (ngModelChange)="set('department',$event)"><option value="">All departments</option>@for(x of departments();track x){<option [value]="x">{{x}}</option>}</select></label>
  <label>Organization<select name="assignmentOrganization" [ngModel]="filters().organization" (ngModelChange)="set('organization',$event)" [disabled]="!!d.orgNote()"><option value="">All organizations</option>@for(x of d.orgs();track x.id){<option [value]="x.id">{{x.name}}</option>}</select></label>
  <label>Role held<select name="assignmentHeldRole" [ngModel]="filters().role" (ngModelChange)="set('role',$event)"><option value="">Any role</option>@for(r of d.roles();track r.id){<option [value]="r.id">{{r.label}}</option>}</select></label>
  <label>Sign-in status<select name="assignmentStatus" [ngModel]="filters().status" (ngModelChange)="set('status',$event)"><option value="">Any status</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option><option value="no-credential">No credential</option></select></label>
 </div>
 <div class="qviews" aria-label="Assignment views">@for(v of views;track v.id){<button type="button" [class.on]="filters().view===v.id" [attr.aria-pressed]="filters().view===v.id" (click)="set('view',v.id)">{{v.label}}</button>}<button type="button" class="secondary" (click)="reset()">Reset filters</button></div>
 @if(d.orgNote()){<p class="hint">{{d.orgNote()}}</p>}
 @if(filters().view==='staged' && d.stagedNote()){<p class="warning">{{d.stagedNote()}}</p>}
</div>
`})
export class AssignmentFilters {
 readonly filters=model<AssignmentFilter>(emptyFilter());protected readonly d=inject(AssignmentData);
 protected departments=computed(()=>[...new Set(this.d.users().map(u=>u.department).filter(Boolean))].sort());
 protected views:{id:AssignmentFilter['view'];label:string}[]=[{id:'all',label:'All people'},{id:'none',label:'Without a role'},{id:'conflicts',label:'SoD conflicts'},{id:'staged',label:'Staged changes'}];
 protected set(k:keyof AssignmentFilter,value:string){this.filters.update(f=>({...f,[k]:value}));}
 protected reset(){this.filters.set(emptyFilter());}
}
