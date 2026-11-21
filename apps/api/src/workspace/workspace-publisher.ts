import { Injectable, Optional, BadRequestException, ConflictException } from '@nestjs/common';
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
@Injectable()
export class WorkspacePublisher {
 private chain:Promise<unknown>=Promise.resolve();
 private pending=new Map<string,{source:string;commit:string}>();
 constructor(private readonly v:VersioningService,private readonly registries:BranchRegistries,private readonly activation:ActivationService,@Optional() private readonly authn?:AuthnService){}
 /** Runs fn after every earlier queued publication or rebase, one at a time. */
 serialize<T>(fn:()=>Promise<T>):Promise<T>{const run=this.chain.then(fn);this.chain=run.catch(()=>undefined);return run;}
 /** `branch` may be a function: it is then read INSIDE the queue, as the controller always did (a refusal is a rejection, never a synchronous throw). */
 publish(tenant:string,branch:string|(()=>string),actor:string,b:{confirm?:boolean;expectedHead?:string}){return this.serialize(()=>this.publishOnce(typeof branch==='function'?branch():branch,b,actor,tenant));}
 private async publishOnce(branch:string,b:{confirm?:boolean;expectedHead?:string},actor:string,tenant:string){
  if(!workspaceMode()||b?.confirm!==true)throw new BadRequestException('Explicit Apply confirmation required');
  const info=(await this.v.branches()).branches.find(x=>x.name===branch);if(!info)throw new BadRequestException('unknown branch');
  if(b.expectedHead && b.expectedHead!==info.commit)throw new ConflictException('Working branch changed. Review again before Apply.');
  // Read registry first: unknown providers/grants are never manufactured by a merge.
  this.registries.drop(branch);await this.registries.get(branch);
  // Refused before anything is merged: a level nobody can reach would lock the administrators out. The live rule is untouched.
  const blocked=await this.authn?.applyBlocker(tenant,branch);if(blocked)throw new ConflictException({code:'unreachable-level',message:`Apply refused: ${blocked}`,reasons:[blocked],violations:[]});
  const latest=await this.activation.current(tenant);
  const retry=this.pending.get(branch)??(latest?.state==='failed'&&latest.requestId===`workspace-${latest.commit}`&&latest.commit===(await this.v.branches()).branches.find(x=>x.name==='main')?.commit&&(await this.v.diffSummary('main',branch,false)).tables.length===0?{source:info.commit,commit:latest.commit}:undefined);
  if(!this.activation.applyEnabled)throw new BadRequestException('Apply requires a configured live permission engine');
  let r=retry&&retry.source===info.commit?{mergeable:true,commit:retry.commit,reasons:[],violations:[]}:await applyContext.run(true,()=>this.v.mergeInto(branch,'main',`Apply workspace ${branch}`,actor,b.expectedHead));
  // Fresh seeded workspaces still need a first live permissions snapshot. Keep the normal
  // merge checks (including SoD/constraints); only the exact no-op result can bootstrap main.
  if(!r.mergeable && r.reasons.length===1 && r.reasons[0]==='nothing to merge: the target already contains the source'){
   const main=(await this.v.branches()).branches.find(x=>x.name==='main');
   if(main && !(latest?.state==='applied' && latest.commit===main.commit)){
    r={...r,mergeable:true,commit:main.commit,reasons:[]};
   }
  }
  if(!r.mergeable||!r.commit)throw new ConflictException({message:`Apply refused: ${r.reasons.join('; ')}`,reasons:r.reasons,violations:r.violations});
  this.pending.set(branch,{source:info.commit,commit:r.commit});
  this.registries.drop('main');await this.registries.get('main');
  // main also carries what other merged branches brought: check the exact version about to go live.
  const blockedMain=await this.authn?.applyBlocker(tenant,'main');if(blockedMain)throw new ConflictException({code:'unreachable-level',message:`Apply refused: ${blockedMain}. The data is merged but not live; the active rule is unchanged.`,reasons:[blockedMain],violations:[]});
  const activation=await this.activation.activate(tenant,r.commit,`workspace-${r.commit}`);
  if(activation.state!=='applied')return {applied:false,merged:true,retryRequired:true,branch,commit:r.commit,activation,message:'Data merged into main, but permission activation failed. Retry Apply on this branch; no second merge is needed.'};
  this.pending.delete(branch);return {applied:true,branch,commit:r.commit,activation};
 }
}
