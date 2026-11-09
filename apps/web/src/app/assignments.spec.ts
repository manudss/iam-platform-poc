import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { AssignmentData, conflicts, filterAssignments, policyReferences, referencedActions, wouldConflict } from './assignment-data';
import { AssignmentMatrixPage, assignmentDelta, cellKey } from './assignment-matrix';
import { AssignmentsPage } from './assignments';
import { RolesAdminPage } from './roles-admin';
import { RolesRights } from './roles-rights';
import { emptyFilter } from './assignment-filters';
import type { Rule } from './policies';
import type { UserProfile } from './api';
const users:UserProfile[]=[
 {id:'demo-alice',display_name:'Alice Durand',department:'it',email:'alice@example.invalid',manager_id:null,hasCredential:true,login_enabled:true},
 {id:'demo-bob',display_name:'Bob Marchand',department:'finance',email:'bob@example.invalid',manager_id:null,hasCredential:true,login_enabled:true},
 {id:'camille-martin',display_name:'Camille Martin',department:'finance',manager_id:null,hasCredential:false,login_enabled:true}
];
const assignments=[{identity_id:'demo-alice',role_id:'employee'},{identity_id:'demo-bob',role_id:'payment-creator'}];
const rules=[{role_a:'payment-creator',role_b:'payment-approver'}];
const roles=[{id:'employee',label:'Employee',is_sensitive:false,assigned:1},{id:'payment-creator',label:'Payment creator',is_sensitive:true,assigned:1},{id:'payment-approver',label:'Payment approver',is_sensitive:true,assigned:0}];
function dataStub(){const stage=vi.fn(async()=>true);return {
 s:{branch:signal('work'),branchEpoch:signal(0)},users:signal(users),roles:signal(roles),rules:signal(rules),assignments:signal(assignments),orgs:signal([{id:'fin',name:'Finance'}]),members:signal([{subject:'demo-bob',org_id:'fin'}]),staged:signal(new Set(['demo-bob'])),policies:signal([]),policyNote:signal(''),orgNote:signal(''),stagedNote:signal(''),error:signal(''),note:signal(''),loading:signal(false),busy:signal(false),stage,load:vi.fn(),
 ids:(id:string)=>assignments.filter(a=>a.identity_id===id).map(a=>a.role_id),label:(id:string)=>roles.find(r=>r.id===id)?.label??id,conflict:()=>[],refs:()=>[]
};}
function configure(){const d=dataStub();TestBed.configureTestingModule({providers:[provideRouter([]),{provide:AssignmentData,useValue:d}]});return d;}

describe('assignment search and SoD helpers',()=>{
 const filter=(f:object)=>filterAssignments(users,assignments,rules,[{subject:'demo-bob',org_id:'fin'}],new Set(['demo-bob']),{...emptyFilter(),...f}).map(u=>u.id);
 it('combines name/email/role search with all facets',()=>{expect(filter({q:'bob@example',department:'finance',organization:'fin',role:'payment-creator',status:'enabled'})).toEqual(['demo-bob']);expect(filter({q:'PAYMENT-CREATOR'})).toEqual(['demo-bob']);expect(filter({q:'bob',organization:'elsewhere'})).toEqual([]);});
 it('distinguishes no role, no credential, staged and conflict views',()=>{expect(filter({view:'none'})).toEqual(['camille-martin']);expect(filter({status:'no-credential'})).toEqual(['camille-martin']);expect(filter({view:'staged'})).toEqual(['demo-bob']);expect(filter({view:'conflicts'})).toEqual([]);});
 it('detects both sides of a SoD rule including roles outside matrix columns',()=>{expect(wouldConflict(['payment-creator'],'payment-approver',rules)).toBe(true);expect(wouldConflict(['payment-approver'],'payment-creator',rules)).toBe(true);expect(wouldConflict(['employee'],'payment-creator',rules)).toBe(false);expect(conflicts(['payment-creator','payment-approver'],rules)).toEqual(rules);});
 it('computes additions/removals without unchanged cells',()=>{expect(assignmentDelta(assignments,new Map([[cellKey('demo-bob','payment-creator'),false],[cellKey('demo-alice','employee'),true],[cellKey('demo-alice','payment-approver'),true]]))).toEqual([{identity:'demo-bob',role:'payment-creator',assigned:false},{identity:'demo-alice',role:'payment-approver',assigned:true}]);});
 it('lists only explicit policy references, preserves forbid and action details',()=>{const p={id:'p',text:'forbid(principal, action == Action::"approve", resource) when { context.roles.contains("payment-approver") };',effect:'forbid'} as Rule;expect(policyReferences([p],['payment-approver'])).toEqual([p]);expect(policyReferences([p],['payment'])).toEqual([]);expect(referencedActions(p)).toEqual(['approve']);});
});
describe('access UI contracts',()=>{
 afterEach(()=>TestBed.resetTestingModule());
 it('renders search console results and opens the shared role editor',async()=>{configure();const f=TestBed.createComponent(AssignmentsPage);f.detectChanges();await f.whenStable();const el=f.nativeElement as HTMLElement;expect(el.querySelectorAll('#assignments tbody tr').length).toBe(3);(el.querySelector('#assignments button') as HTMLButtonElement).click();f.detectChanges();expect(el.querySelector('app-roles-rights')).toBeTruthy();expect(el.querySelector('aside')?.getAttribute('role')).toBe('dialog');});
 it('keeps Roles catalogue read only on main while allowing inspection',async()=>{const d=configure();d.s.branch.set('main');const f=TestBed.createComponent(RolesAdminPage);f.detectChanges();await f.whenStable();const el=f.nativeElement as HTMLElement;expect((el.querySelector('#role-create') as HTMLButtonElement).disabled).toBe(true);expect((el.querySelector('#role-table button') as HTMLButtonElement).disabled).toBe(false);});
 it('blocks staging roles on main and shows the policy caveat',async()=>{const d=configure();d.s.branch.set('main');const f=TestBed.createComponent(RolesRights);f.componentRef.setInput('userId','demo-bob');f.detectChanges();await f.whenStable();let el=f.nativeElement as HTMLElement;expect([...el.querySelectorAll('button')].find(b=>b.textContent==='Stage assignment')?.disabled).toBe(true);([...el.querySelectorAll('[role=tab]')][1] as HTMLButtonElement).click();f.detectChanges();expect(el.textContent).toContain('not a guarantee of access');expect(d.stage).not.toHaveBeenCalled();});
 it('selects scope, prevents conflicting cells and reviews removals',async()=>{const d=configure();const f=TestBed.createComponent(AssignmentMatrixPage);f.detectChanges();await f.whenStable();const c=f.componentInstance as any;c.chooseUser('demo-bob',true);c.chooseRole('payment-creator',true);c.chooseRole('payment-approver',true);c.step.set(2);f.detectChanges();const el=f.nativeElement as HTMLElement;const input=el.querySelector('[aria-label="demo-bob / payment-approver"]') as HTMLInputElement;expect(input.disabled).toBe(true);c.toggle('demo-bob','payment-creator',false);f.detectChanges();expect(input.disabled).toBe(false);expect(c.ops()).toEqual([{identity:'demo-bob',role:'payment-creator',assigned:false}]);expect(d.stage).not.toHaveBeenCalled();c.chooseRole('payment-creator',false);expect(c.ops()).toEqual([]);});
 it('clears local matrix edits when the working branch changes',async()=>{const d=configure();const f=TestBed.createComponent(AssignmentMatrixPage);f.detectChanges();await f.whenStable();const c=f.componentInstance as any;c.chooseUser('demo-bob',true);c.toggle('demo-bob','payment-creator',false);d.s.branchEpoch.update(n=>n+1);f.detectChanges();expect(c.selectedUsers().size).toBe(0);expect(c.ops()).toEqual([]);});
});
