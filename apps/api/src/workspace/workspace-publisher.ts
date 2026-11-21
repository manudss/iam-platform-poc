import { createHash } from 'node:crypto';
import { Injectable, Optional, BadRequestException, ConflictException } from '@nestjs/common';
import { BranchProtectionService } from '../versioning/branch-protection.service.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { ActivationService } from '../activation/activation.service.js';
import { AuthnService } from '../authn/flow.service.js';
import { applyContext, workspaceMode } from './context.js';

/**
 * The one checked path from a working branch to main (merge, then permission activation). Moved out of WorkspaceController WITHOUT any change of behaviour:
 * same refusals, same pre and post checks, same retry after a failed activation. The single-writer queue and the pending map live here so that
 * every caller (the human Apply, the rebase, a future workflow block) is serialized through the same queue. The branch is an explicit argument.
 */
/** Tables a workflow publication may never change (minimum list; a per-workflow whitelist of publishable tables is the stricter form, to settle with the reviewer). */
export const FORBIDDEN_WORKFLOW_TABLES=['plugin_runtime_settings'];
@Injectable()
export class WorkspacePublisher {
 private chain:Promise<unknown>=Promise.resolve();
 /** Keyed by branch AND the exact head being published: a retry only ever resumes the publication of that very head. */
 private pending=new Map<string,{source:string;commit:string}>();
 private pendingKey(branch:string,head:string){return `${branch}@${head}`;}
 constructor(private readonly v:VersioningService,private readonly registries:BranchRegistries,private readonly activation:ActivationService,@Optional() private readonly authn?:AuthnService,@Optional() private readonly protection?:BranchProtectionService){}
 /** Runs fn after every earlier queued publication or rebase, one at a time. */
 serialize<T>(fn:()=>Promise<T>):Promise<T>{const run=this.chain.then(fn);this.chain=run.catch(()=>undefined);return run;}
 /** `branch` may be a function: it is then read INSIDE the queue, as the controller always did (a refusal is a rejection, never a synchronous throw). */
 publish(tenant:string,branch:string|(()=>string),actor:string,b:{confirm?:boolean;expectedHead?:string}){
  // The `wf-` identity is reserved for workflow publication: a person signing in under such an id is refused, so a human Apply can never pass as a workflow.
  if(/^wf-/i.test(String(actor??'')))throw new BadRequestException('This identity prefix is reserved for workflow publication');
  return this.serialize(()=>this.publishOnce(typeof branch==='function'?branch():branch,b,actor,tenant));}
 /**
  * Publication by a workflow run (the only non-human caller). Stricter than the human Apply, never looser: the branch AND its head are explicit and frozen by the run
  * (a branch that moved since is refused, never "the current head"), the actor is a short reserved identity (no ':' and under every truncation limit, so two workflows never share an author),
  * run, workflow and head go into the commit message, a protected main that forbids self-merge refuses (this path passes no author, so that rule could not be evaluated), and the result is read back from
  * the real state: main moved to the commit that was activated and the activation is `applied`. Anything else throws: never a degraded success. A repeat after a crash is safe:
  * when the branch has nothing left to merge the existing path only completes a missing activation, and an already applied one is returned as done.
  */
 publishForRun(a:{tenant:string;runId:string;workflowId:string;branch:string;expectedHead:string}){
  const branch=String(a.branch??''),head=String(a.expectedHead??'');
  if(!branch||branch==='main'||branch===this.v.defaultBranch)throw new BadRequestException('Nothing to publish: a workflow publishes a working branch, never main');
  if(!/^[0-9a-z]{8,64}$/i.test(head))throw new BadRequestException('expectedHead is required: the head the run recorded');
  if(!a.workflowId||typeof a.workflowId!=='string')throw new BadRequestException('workflow identity is required');
  return this.serialize(async()=>{
   const prot=this.protection?.effective(this.v.defaultBranch);
   if(prot&&prot.protected&&prot.selfMerge===false)throw new ConflictException('Publication by a workflow refused: main does not allow self-merge and a workflow has no separate reviewer');
   const info=(await this.v.branches()).branches.find(x=>x.name===branch);
   if(!info)throw new BadRequestException('unknown branch');
   if(info.commit!==head)throw new ConflictException('The working branch moved since the run recorded its head: nothing published');
   // A workflow publishes a whole branch, so it must not carry configuration that widens what workflows may do (the publication whitelist lives in plugin_runtime_settings), and an unreadable diff is a refusal.
   let tables:string[];
   try{tables=((await this.v.diffSummary(this.v.defaultBranch,branch,false)).tables??[]).map((t:any)=>String(t?.name??t));}catch{throw new ConflictException('Publication by a workflow refused: the difference between main and the branch could not be read');}
   const forbidden=tables.filter(t=>FORBIDDEN_WORKFLOW_TABLES.includes(t));
   if(forbidden.length)throw new ConflictException(`Publication by a workflow refused: the branch changes ${forbidden.join(', ')}, which only a person may apply`);
   const r:any=await this.publishOnce(branch,{confirm:true,expectedHead:head},workflowActor(a.workflowId),a.tenant,`Publish workflow run ${a.runId} (workflow ${a.workflowId}) from ${branch}@${head.slice(0,12)} tables: ${tables.join(',')}`.slice(0,300));
   const main=(await this.v.branches()).branches.find(x=>x.name===this.v.defaultBranch);
   const cur=await this.activation.current(a.tenant);
   if(!r?.applied||!main||r.commit!==main.commit||cur?.state!=='applied'||cur.commit!==main.commit)throw new ConflictException('Publication not confirmed by the real state: data merged but not live, or main moved. Nothing is reported as published');
   return {published:true,branch,sourceHead:head,mainCommit:main.commit,activation:cur.state,tables};
  });
 }

 private async publishOnce(branch:string,b:{confirm?:boolean;expectedHead?:string},actor:string,tenant:string,message?:string){
  if(!workspaceMode()||b?.confirm!==true)throw new BadRequestException('Explicit Apply confirmation required');
  const info=(await this.v.branches()).branches.find(x=>x.name===branch);if(!info)throw new BadRequestException('unknown branch');
  if(b.expectedHead && b.expectedHead!==info.commit)throw new ConflictException('Working branch changed. Review again before Apply.');
  // Read registry first: unknown providers/grants are never manufactured by a merge.
  this.registries.drop(branch);await this.registries.get(branch);
  // Refused before anything is merged: a level nobody can reach would lock the administrators out. The live rule is untouched.
  const blocked=await this.authn?.applyBlocker(tenant,branch);if(blocked)throw new ConflictException({code:'unreachable-level',message:`Apply refused: ${blocked}`,reasons:[blocked],violations:[]});
  const latest=await this.activation.current(tenant);
  const retry=this.pending.get(this.pendingKey(branch,info.commit))??(latest?.state==='failed'&&latest.requestId===`workspace-${latest.commit}`&&latest.commit===(await this.v.branches()).branches.find(x=>x.name==='main')?.commit&&(await this.v.diffSummary('main',branch,false)).tables.length===0?{source:info.commit,commit:latest.commit}:undefined);
  if(!this.activation.applyEnabled)throw new BadRequestException('Apply requires a configured live permission engine');
  let r=retry&&retry.source===info.commit?{mergeable:true,commit:retry.commit,reasons:[],violations:[]}:await applyContext.run(true,()=>this.v.mergeInto(branch,'main',message??`Apply workspace ${branch}`,actor,b.expectedHead));
  // Fresh seeded workspaces still need a first live permissions snapshot. Keep the normal
  // merge checks (including SoD/constraints); only the exact no-op result can bootstrap main.
  if(!r.mergeable && r.reasons.length===1 && r.reasons[0]==='nothing to merge: the target already contains the source'){
   const main=(await this.v.branches()).branches.find(x=>x.name==='main');
   if(main && !(latest?.state==='applied' && latest.commit===main.commit)){
    r={...r,mergeable:true,commit:main.commit,reasons:[]};
   }
  }
  if(!r.mergeable||!r.commit)throw new ConflictException({message:`Apply refused: ${r.reasons.join('; ')}`,reasons:r.reasons,violations:r.violations});
  this.pending.set(this.pendingKey(branch,info.commit),{source:info.commit,commit:r.commit});
  this.registries.drop('main');await this.registries.get('main');
  // main also carries what other merged branches brought: check the exact version about to go live.
  const blockedMain=await this.authn?.applyBlocker(tenant,'main');if(blockedMain)throw new ConflictException({code:'unreachable-level',message:`Apply refused: ${blockedMain}. The data is merged but not live; the active rule is unchanged.`,reasons:[blockedMain],violations:[]});
  const activation=await this.activation.activate(tenant,r.commit,`workspace-${r.commit}`);
  if(activation.state!=='applied')return {applied:false,merged:true,retryRequired:true,branch,commit:r.commit,activation,message:'Data merged into main, but permission activation failed. Retry Apply on this branch; no second merge is needed.'};
  this.pending.delete(this.pendingKey(branch,info.commit));return {applied:true,branch,commit:r.commit,activation};
 }
}

/** Short, stable author for a workflow publication: `wf-` plus a hash of the full workflow id. No ':' and 13 characters, so authorOf and the protection checks never truncate or merge it. */
export function workflowActor(workflowId:string):string{return `wf-${createHash('sha256').update(workflowId).digest('hex').slice(0,10)}`;}
