import 'reflect-metadata';
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createConnection, type Connection } from 'mysql2/promise';
import { VersioningService } from '../versioning/versioning.service.js';
import { externalBlock } from './model.js';

const bin=process.env.DOLT_BIN ?? '';
describe('badge identity provenance on real Dolt', {skip:!existsSync(bin)&&'DOLT_BIN missing'},()=>{
 let dir:string, proc:ChildProcess, port:number;
 const saved:Record<string,string|undefined>={};
 async function on<T>(branch:string,fn:(c:Connection)=>Promise<T>):Promise<T>{
  const c=await createConnection({host:'127.0.0.1',port,user:'root',password:'',database:'iam'});
  try {await c.query('CALL DOLT_CHECKOUT(?)',[branch]);return await fn(c);}finally{await c.end();}
 }
 const root=(branch:string)=>on(branch,async c=>{const [r]=await c.query("SELECT DOLT_HASHOF_DB('WORKING') h");return (r as {h:string}[])[0].h;});
 async function commit(c:Connection){const [s]=await c.query('SELECT count(*) n FROM dolt_status');if(Number((s as {n:number}[])[0].n)){await c.query("CALL DOLT_ADD('-A')");await c.query("CALL DOLT_COMMIT('-m','fictional badge fixture','--author','Fixture <fixture@example.invalid>')");}}
 async function branch(name:string){await on('main',async c=>{await c.query('CALL DOLT_BRANCH(?)',[name]);});}
 const block=()=>externalBlock('lyam-create-user')!;
 const context=(name:string,runId='fixture-run',fail=false)=>({
  tenant:'fictional',runId,nodeId:'create',config:{identity:'fictional.badge',displayName:'Fictional Badge',email:'badge@example.invalid'},settings:{},outputs:{},dryRun:false,log:()=>undefined,
  branchWrite:async(fn:(c:Connection)=>Promise<void>)=>new VersioningService().writeOn(name,async c=>{await fn(c);if(fail)throw Error('fixture crash before commit');await commit(c);}),
 } as never);
 before(async()=>{
  port=await new Promise<number>((accept,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const a=s.address();if(!a||typeof a==='string'){s.close();reject(Error('fixture address'));return;}s.close(e=>e?reject(e):accept(a.port));});});
  dir=mkdtempSync(join(tmpdir(),'badge-provenance-'));const home=join(dir,'home'),data=join(dir,'data');mkdirSync(home);mkdirSync(data);
  const env={...process.env,HOME:home};
  for(const [k,v]of[['user.name','Fixture'],['user.email','fixture@example.invalid']])assert.equal(spawnSync(bin,['config','--global','--add',k,v],{env}).status,0);
  const init=spawnSync(bin,['sql'],{cwd:data,env,input:readFileSync(resolve('../../data/demo/01-schema.sql'))});assert.equal(init.status,0,init.stderr.toString());
  proc=spawn(bin,['sql-server','--host','127.0.0.1','--port',String(port),'--data-dir',data],{cwd:data,env,stdio:['ignore','pipe','pipe']});
  let diagnostic='';for(const s of[proc.stdout,proc.stderr])s?.on('data',c=>{diagnostic=(diagnostic+c).slice(-2000);});
  let ready=false;for(let i=0;i<100;i++){assert.equal(proc.exitCode,null,diagnostic);try{await on('main',async()=>undefined);ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}}assert.ok(ready,diagnostic);
  for(const k of['DOLT_PORT','DOLT_DATABASE','IAM_WORKSPACE_MODE'])saved[k]=process.env[k];
  Object.assign(process.env,{DOLT_PORT:String(port),DOLT_DATABASE:'iam',IAM_WORKSPACE_MODE:'0'});
  await on('main',commit);
 });
 after(async()=>{if(proc&&proc.exitCode===null){const done=new Promise<void>(r=>proc.once('exit',()=>r()));proc.kill();await done;}if(dir)rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});for(const[k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 it('commits provenance with the identity on its own branch, then a fresh service retries without a new commit',async()=>{
  await branch('workflow/owned');const main=await root('main');await block().run(context('workflow/owned'));
  const own=await root('workflow/owned');const output=await block().run(context('workflow/owned'));
  assert.equal(output?.email,'badge@example.invalid');assert.equal(await root('workflow/owned'),own);assert.equal(await root('main'),main);
  await on('workflow/owned',async c=>{const[r]=await c.query('SELECT workflow_creation_ref FROM identities WHERE id=?',['fictional.badge']);assert.match((r as {workflow_creation_ref:string}[])[0].workflow_creation_ref,/^[a-f0-9]{64}$/);});
  await assert.rejects(()=>block().run(context('workflow/owned','different-run')),/refusing to adopt/);assert.equal(await root('workflow/owned'),own);
 });
 it('refuses an unmarked historical identity without adding a column or changing its root',async()=>{
  await branch('workflow/foreign');await on('workflow/foreign',async c=>{await c.query('INSERT INTO identities (id,display_name) VALUES (?,?)',['fictional.badge','Existing Fictional']);await commit(c);});
  const before=await root('workflow/foreign');await assert.rejects(()=>block().run(context('workflow/foreign')),/refusing to adopt/);assert.equal(await root('workflow/foreign'),before);
  await on('workflow/foreign',async c=>{const[r]=await c.query('SHOW COLUMNS FROM identities');assert.ok(!(r as {Field:string}[]).some(x=>x.Field==='workflow_creation_ref'));});
 });
 it('a crash before branch commit resets both identity and provenance schema, and a retry can create',async()=>{
  await branch('workflow/crash');const before=await root('workflow/crash');await assert.rejects(()=>block().run(context('workflow/crash','fixture-run',true)),/fixture crash/);assert.equal(await root('workflow/crash'),before);
  await on('workflow/crash',async c=>{const[r]=await c.query('SELECT count(*) n FROM identities WHERE id=?',['fictional.badge']);assert.equal(Number((r as {n:number}[])[0].n),0);});
  await block().run(context('workflow/crash'));assert.notEqual(await root('workflow/crash'),before);
 });
});
