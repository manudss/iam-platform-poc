import 'reflect-metadata';
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VersioningService } from '../versioning/versioning.service.js';
import { WorkflowStore } from './store.js';
import { WorkflowConnections } from './connections.js';
import { branchContext } from '../workspace/context.js';
const bin = process.env.DOLT_BIN ?? '', have = existsSync(bin);
describe('connection metadata on real Dolt', {skip:!have && 'DOLT_BIN missing'}, () => {
  let dir:string, process_:ChildProcess, service:WorkflowConnections, versioning:VersioningService;
  const saved:Record<string,string|undefined> = {};
  before(async () => {
    dir=mkdtempSync(join(tmpdir(),'wf-connections-')); const home=join(dir,'h'), data=join(dir,'d');mkdirSync(home);mkdirSync(data); const env={...process.env,HOME:home};
    for(const [k,v] of [['user.name','test'],['user.email','test@example.invalid']]) assert.equal(spawnSync(bin,['config','--global','--add',k,v],{env}).status,0);
    assert.equal(spawnSync(bin,['sql'],{cwd:data,env,input:readFileSync(resolve('../../data/demo/01-schema.sql'))}).status,0);
    process_=spawn(bin,['sql-server','--host','127.0.0.1','--port','14377','--data-dir',data],{env,cwd:data,stdio:'ignore'});
    for(let i=0;i<100;i++){if(spawnSync(bin,['--host','127.0.0.1','--port','14377','--no-tls','-u','root','sql','-q','select 1'],{env}).status===0)break;await new Promise(r=>setTimeout(r,100));}
    for(const k of ['DOLT_PORT','DOLT_DATABASE','IAM_WORKSPACE_MODE'])saved[k]=process.env[k];Object.assign(process.env,{DOLT_PORT:'14377',DOLT_DATABASE:'iam'});delete process.env.IAM_WORKSPACE_MODE;
    versioning=new VersioningService();const store=new WorkflowStore(versioning);const secrets=new Map<string,any>();service=new WorkflowConnections(store,{enabled:true,put:async(p:string,d:any)=>{secrets.set(p,d);},get:async(p:string)=>secrets.get(p)} as any);
    await service.list('tenant-a'); // startup migration commits only tables, never credentials/content
    await versioning.createBranch('connections-edit','main');
  });
  after(async()=>{process_?.kill();await new Promise(r=>setTimeout(r,500));if(dir)rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});for(const k of Object.keys(saved)){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}});
  it('versions metadata on a working branch without plaintext credentials, cross-tenant leaks or a dirty main',async()=>{
    process.env.IAM_WORKSPACE_MODE='1';
    const body={name:'Jira',provider:'jira',config:{instanceUrl:'https://team.atlassian.net',email:'tester@example.invalid'},secret:'FICTIONAL-TEST-SECRET'};
    const created=await branchContext.run({branch:'connections-edit'},()=>service.save('tenant-a',undefined,body));
    assert.equal((await branchContext.run({branch:'connections-edit'},()=>service.list('tenant-a'))).connections.length,1);
    assert.equal((await branchContext.run({branch:'main'},()=>service.list('tenant-a'))).connections.length,0);
    assert.equal((await branchContext.run({branch:'connections-edit'},()=>service.list('tenant-b'))).connections.length,0);
    await assert.rejects(()=>branchContext.run({branch:'main'},()=>service.save('tenant-a',undefined,body)),/main is read only/);
    await versioning.at('connections-edit',async c=>{const [r]=await c.query('select metadata from workflow_connections');assert.equal(JSON.stringify(r).includes('FICTIONAL-TEST-SECRET'),false);const [dirty]=await c.query('select * from dolt_status');assert.deepEqual(dirty,[]);});
    await versioning.at('main',async c=>{const [dirty]=await c.query('select * from dolt_status');assert.deepEqual(dirty,[]);});
    await branchContext.run({branch:'connections-edit'},()=>service.remove('tenant-a',created.connection.id));
  });
});
