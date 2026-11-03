import { Body, Controller, Delete, Get, Post, Req, UseGuards, BadRequestException, ConflictException } from '@nestjs/common';
import { AuthGuard, assertNotBranchTest } from '../auth/auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { VersioningService } from '../versioning/versioning.service.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { currentBranch, applyContext, workspaceMode } from './context.js';
import { ActivationService } from '../activation/activation.service.js';
import { Param } from '@nestjs/common';
import { SOD_SQL } from '../dolt/dolt.service.js';
import { PersonalBranchService } from './personal-branch.service.js';
import { BranchTestService } from './branch-test.js';
@UseGuards(AuthGuard,AdminGuard)
@Controller('tenants/:tenant/workspace')
export class WorkspaceController {
 private chain:Promise<unknown>=Promise.resolve();
 private pending=new Map<string,{source:string;commit:string}>();
 constructor(private readonly v:VersioningService,private readonly registries:BranchRegistries,private readonly activation:ActivationService,private readonly personal:PersonalBranchService,private readonly branchTest:BranchTestService){}
 @Post('personal') ensurePersonal(@Param('tenant')tenant:string,@Req()req:{user:{sub:string;branch?:string}}){assertNotBranchTest(req);return this.personal.ensure(tenant,req.user?.sub);}
 @Post('personal/rename') renamePersonal(@Param('tenant')tenant:string,@Body()b:{name?:string},@Req()req:{user:{sub:string;branch?:string}}){assertNotBranchTest(req);return this.personal.rename(tenant,req.user?.sub,b?.name);}
 @Post('personal/release') releasePersonal(@Param('tenant')tenant:string,@Req()req:{user:{sub:string;branch?:string}}){assertNotBranchTest(req);return this.personal.release(tenant,req.user?.sub);}
 @Get() async status(){const branch=currentBranch();return {branch,main:'main',readOnly:branch==='main',diff:branch==='main'?null:await this.v.diffSummary('main',branch,true)};}
 @Post('apply') apply(@Body() b:{confirm?:boolean;expectedHead?:string},@Req()req:{user:{sub:string;branch?:string}},@Param('tenant')tenant:string){
 assertNotBranchTest(req);
 const run=this.chain.then(()=>this.applyOnce(b,req,tenant));this.chain=run.catch(()=>undefined);return run;
 }
 /** Issues the short-lived ticket that opens a sign-in test of one data branch (docs/branch-test.md). Administrators only. */
 @Post('branch-test') createBranchTest(@Param('tenant')tenant:string,@Body()b:{branch?:string;stable?:boolean;label?:string},@Req()req:{user:{sub:string;branch?:string}}){assertNotBranchTest(req);void tenant;return this.branchTest.create(req.user?.sub,String(b?.branch??''),{stable:b?.stable===true,label:typeof b?.label==='string'?b.label:''});}
 @Get('branch-test') listBranchTests(@Param('tenant')tenant:string,@Req()req:{user?:{branch?:string}}){assertNotBranchTest(req);void tenant;return this.branchTest.list();}
 @Delete('branch-test/:id') revokeBranchTest(@Param('tenant')tenant:string,@Param('id')id:string,@Req()req:{user?:{branch?:string}}){assertNotBranchTest(req);void tenant;return this.branchTest.revoke(id);}
 private async applyOnce(b:{confirm?:boolean;expectedHead?:string},req:{user:{sub:string}},tenant:string){
  const branch=currentBranch(true);if(!workspaceMode()||b?.confirm!==true)throw new BadRequestException('Explicit Apply confirmation required');
  const info=(await this.v.branches()).branches.find(x=>x.name===branch);if(!info)throw new BadRequestException('unknown branch');
  if(b.expectedHead && b.expectedHead!==info.commit)throw new ConflictException('Working branch changed. Review again before Apply.');
  // Read registry first: unknown providers/grants are never manufactured by a merge.
  this.registries.drop(branch);await this.registries.get(branch);
  const latest=await this.activation.current(tenant);
  const retry=this.pending.get(branch)??(latest?.state==='failed'&&latest.requestId===`workspace-${latest.commit}`&&latest.commit===(await this.v.branches()).branches.find(x=>x.name==='main')?.commit&&(await this.v.diffSummary('main',branch,false)).tables.length===0?{source:info.commit,commit:latest.commit}:undefined);
  if(!this.activation.applyEnabled)throw new BadRequestException('Apply requires a configured live permission engine');
  let r=retry&&retry.source===info.commit?{mergeable:true,commit:retry.commit,reasons:[],violations:[]}:await applyContext.run(true,()=>this.v.mergeInto(branch,'main',`Apply workspace ${branch}`,req.user.sub,b.expectedHead));
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
  const activation=await this.activation.activate(tenant,r.commit,`workspace-${r.commit}`);
  if(activation.state!=='applied')return {applied:false,merged:true,retryRequired:true,branch,commit:r.commit,activation,message:'Data merged into main, but permission activation failed. Retry Apply on this branch; no second merge is needed.'};
  this.pending.delete(branch);return {applied:true,branch,commit:r.commit,activation};
 }
 @Post('assignment') async assignment(@Body()b:{identity?:string;role?:string}){
  const branch=currentBranch(true);if(!/^[a-z0-9-]{1,32}$/.test(b?.identity??'')||!/^[a-z0-9-]{1,32}$/.test(b?.role??''))throw new BadRequestException('invalid identity or role');
  return this.v.writeOn(branch,async c=>{const [r]=await c.query('select (select count(*) from identities where id=?) i,(select count(*) from roles where id=?) r',[b.identity,b.role]);const k=(r as any[])[0];if(!k.i||!k.r)throw new BadRequestException('unknown identity or role');await c.query('insert ignore into assignments values (?,?)',[b.identity,b.role]);const [dirty]=await c.query('select * from dolt_status');if((dirty as any[]).length){await c.query("call dolt_add('assignments')");await c.query("call dolt_commit('-m',?)",[`assignment: ${b.identity} / ${b.role}`]);}const [violations]=await c.query(SOD_SQL);return {branch,violations,staged:true};});
 }
}
