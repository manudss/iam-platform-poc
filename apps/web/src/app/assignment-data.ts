import { Injectable, effect, inject, signal } from '@angular/core';
import { UserProfile, VersioningClient } from './api';
import { Assignment, Session } from './session';
import type { Rule } from './policies';

export interface Role { id: string; label: string; is_sensitive: boolean; assigned: number }
export interface SodRule { role_a: string; role_b: string }
export interface AssignmentOp { identity: string; role: string; assigned: boolean }
export interface Membership { subject: string; org_id: string }
export type QuickView = 'all' | 'none' | 'conflicts' | 'staged';
export interface AssignmentFilter { q: string; department: string; organization: string; role: string; status: string; view: QuickView }
export const roleIds = (as: Assignment[], id: string) => as.filter(a => a.identity_id === id).map(a => a.role_id);
export const conflicts = (ids: string[], rules: SodRule[]) => rules.filter(r => ids.includes(r.role_a) && ids.includes(r.role_b));
export const wouldConflict = (ids: string[], role: string, rules: SodRule[]) => conflicts([...ids, role], rules).some(r => r.role_a === role || r.role_b === role);
export function filterAssignments(users: UserProfile[], assignments: Assignment[], rules: SodRule[], members: Membership[], staged: Set<string>, f: AssignmentFilter) {
 const q = f.q.trim().toLowerCase();
 return users.filter(u => {
  const ids = roleIds(assignments,u.id);
  return (!q || [u.id,u.display_name,u.email ?? '',u.department,...ids].some(s => s.toLowerCase().includes(q)))
   && (!f.department || u.department === f.department)
   && (!f.organization || members.some(m => m.subject === u.id && m.org_id === f.organization))
   && (!f.role || ids.includes(f.role))
   && (!f.status || (f.status === 'no-credential' ? !u.hasCredential : f.status === 'enabled' ? u.hasCredential && u.login_enabled : u.hasCredential && !u.login_enabled))
   && (f.view === 'all' || f.view === 'none' && !ids.length || f.view === 'conflicts' && !!conflicts(ids,rules).length || f.view === 'staged' && staged.has(u.id));
 }).sort((a,b) => a.display_name.localeCompare(b.display_name));
}
/** Reference search, NOT a Cedar evaluator. Keep conditions, forbid rules and the source visible. */
export function policyReferences(rules: Rule[], ids: string[]) {
 return rules.filter(r => ids.some(id => r.text.includes(`context.roles.contains("${id}")`) || r.text.includes(`Role::"${id}"`)));
}
export function referencedActions(rule: Rule): string[] { return [...new Set([...rule.text.matchAll(/Action::"([^"]+)"/g)].map(m => m[1]))]; }

export interface StagedRow { identity: string; role: string; change: 'added' | 'removed' }
export interface Offending { identity: string; role: string; change: string; why: string }

@Injectable({ providedIn: 'root' })
export class AssignmentData {
 readonly s = inject(Session);
 readonly users = signal<UserProfile[]>([]); readonly roles = signal<Role[]>([]); readonly rules = signal<SodRule[]>([]);
 readonly assignments = signal<Assignment[]>([]); readonly orgs = signal<{id:string;name:string}[]>([]); readonly members = signal<Membership[]>([]);
 readonly policies = signal<Rule[]>([]); readonly policyNote = signal(''); readonly orgNote = signal('');
 readonly staged = signal<Set<string>>(new Set()); readonly stagedNote = signal('');
 /** Rows staged on the working branch (assignments table diff against main). */
 readonly stagedRows = signal<StagedRow[]>([]); readonly offending = signal<Offending[]>([]); readonly refusal = signal(''); readonly merging = signal(false);
 readonly loading = signal(false); readonly busy = signal(false); readonly error = signal(''); readonly note = signal('');
 private generation = 0;
 constructor() { effect(() => { this.s.branchEpoch(); this.s.adminToken(); this.note.set(''); void this.load(); }); }
 h(): Record<string,string> { return this.s.adminToken() ? {'x-api-admin-token':this.s.adminToken()} : {}; }
 async request<T>(method:string,path:string,body?:object):Promise<T> {
  const r=await this.s.api.raw<T & {message?:string|string[]}>(method,path,body,this.h());
  if(r.status>=400)throw new Error(Array.isArray(r.data.message)?r.data.message.join(' '):r.data.message ?? `HTTP ${r.status}`);
  return r.data;
 }
 async load() {
  const n=++this.generation, branch=this.s.branch(); this.loading.set(true); this.error.set('');
  this.users.set([]); this.roles.set([]); this.assignments.set([]); this.rules.set([]); this.staged.set(new Set());
  try {
   const [u,r,a,o,p,d]=await Promise.all([
    this.request<{users:UserProfile[]}>('GET','/users'),this.request<{roles:Role[];sodRules:SodRule[]}>('GET','/roles'),this.s.api.assignments(),
    this.request<{orgs:{id:string;name:string}[];members:Membership[]}>('GET','/organizations').catch(e=>({orgs:[],members:[],error:e.message})),
    this.request<{rules:Rule[]}>('GET','/policies').catch(e=>({rules:[],error:e.message})),
    this.diff(branch)
   ]);
   if(n!==this.generation || branch!==this.s.branch())return;
   this.users.set(u.users); this.roles.set(r.roles); this.rules.set(r.sodRules); this.assignments.set(a);this.s.assignments.set(a);
   this.orgs.set(o.orgs);this.members.set(o.members);this.orgNote.set('error' in o ? 'Organizations unavailable: '+o.error : '');
   this.policies.set(p.rules);this.policyNote.set('error' in p ? 'Policy catalogue unavailable: '+p.error : '');
   this.staged.set(d.ids);this.stagedNote.set(d.note);this.stagedRows.set(d.rows);
  } catch(e) {if(n===this.generation)this.error.set((e as Error).message);} finally {if(n===this.generation)this.loading.set(false);}
 }
 private async diff(branch:string) {
  if(branch==='main')return {ids:new Set<string>(),note:'',rows:[] as StagedRow[]};
  try {const v=new VersioningClient(this.s.api);v.adminToken=this.s.adminToken();const d=await v.diffTable('assignments','main',branch,true);return {ids:new Set(d.rows.flatMap(r=>[r.from?.['identity_id'],r.to?.['identity_id']].filter(Boolean).map(String))),note:d.truncated?'Staged view is limited to the first diff page.':'',rows:d.rows.map(r=>({identity:String((r.to??r.from)?.['identity_id']??''),role:String((r.to??r.from)?.['role_id']??''),change:(r.to?'added':'removed') as 'added'|'removed'}))};}
  catch(e){return {ids:new Set<string>(),note:'Staged comparison unavailable: '+(e as Error).message,rows:[] as StagedRow[]};}
 }
 /** One click for people who are not administrators: merge into main and activate (linked). A foreign row refuses everything and is named. */
 async mergeMine() {
  if(this.merging())return;
  this.merging.set(true);this.refusal.set('');this.offending.set([]);this.error.set('');
  try {
   const r=await this.s.api.raw<{applied?:boolean;message?:string|string[];offending?:Offending[]}>('POST','/workspace/apply',{confirm:true},this.h());
   if(r.status>=400||!r.data?.applied){const m=r.data?.message;this.refusal.set(Array.isArray(m)?m.join(' '):m||'Merge refused.');this.offending.set(r.data?.offending??[]);return;}
   this.note.set('Merged into main and activated.');await this.load();
  } catch(e){this.refusal.set((e as Error).message);} finally{this.merging.set(false);}
 }
 ids(id:string) {return roleIds(this.assignments(),id);}
 label(id:string) {return this.roles().find(r=>r.id===id)?.label ?? id;}
 conflict(id:string) {return conflicts(this.ids(id),this.rules());}
 refs(ids:string[]) {return policyReferences(this.policies(),ids);}
 async stage(ops:AssignmentOp[]) {
  if(this.busy())return false;
  this.busy.set(true);this.error.set('');const branch=this.s.branch();
  try {
   const r=await this.request<{branch:string;violations:{identity:string;roleA:string;roleB:string}[]}>('POST','/workspace/assignments',{ops});
   if(branch!==this.s.branch())return false;

   this.note.set(`${ops.length} change(s) staged on ${branch}. Live only after Review & Apply.`);
   this.s.say(r.violations.length ? `Simulation: ${r.violations.length} SoD violation(s), Apply will be refused.`:'Simulation OK: no SoD violation, mergeable.',r.violations.length?'error':'info');
   await this.load();return true;
  }catch(e){this.error.set((e as Error).message);return false;}finally{this.busy.set(false);}
 }
}
