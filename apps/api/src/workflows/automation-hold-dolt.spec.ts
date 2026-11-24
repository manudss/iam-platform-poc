import 'reflect-metadata';
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createConnection } from 'mysql2/promise';
import { VersioningService } from '../versioning/versioning.service.js';
import { WorkflowStore } from './store.js';
import { WorkflowCronService } from './cron.js';
import { WorkflowTasksService } from './tasks.js';
import { releaseDataReady } from '../migrations/readiness.js';

const bin = process.env.DOLT_BIN ?? '';
describe('automation hold preservation on real Dolt', { skip: !existsSync(bin) && 'DOLT_BIN missing' }, () => {
  let dir: string, proc: ChildProcess, port: number;
  const saved: Record<string, string | undefined> = {};
  const connection = () => createConnection({ host: '127.0.0.1', port, user: 'root', password: '', database: 'iam_meta', dateStrings: true });
  const fresh = () => new WorkflowStore(new VersioningService());
  async function root() { const c = await connection(); try { const [r] = await c.query("SELECT DOLT_HASHOF_DB('WORKING') AS h"); return (r as {h:string}[])[0].h; } finally { await c.end(); } }
  async function present() { const c = await connection(); try { const [r] = await c.query("SHOW TABLES WHERE Tables_in_iam_meta IN ('workflow_tasks','iga_campaigns','iga_items')"); return (r as unknown[]).length; } finally { await c.end(); } }
  before(async () => {
    port = await new Promise<number>((accept, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const a = s.address(); if (!a || typeof a === 'string') { s.close(); reject(Error('fixture address')); return; } s.close(e => e ? reject(e) : accept(a.port)); }); });
    dir = mkdtempSync(join(tmpdir(), 'wf-boot-preserve-')); const home = join(dir,'home'), data = join(dir,'data'); mkdirSync(home); mkdirSync(data);
    const env = { ...process.env, HOME: home };
    for (const [k,v] of [['user.name','test'],['user.email','test@example.invalid']]) assert.equal(spawnSync(bin, ['config','--global','--add',k,v], {env}).status, 0);
    assert.equal(spawnSync(bin, ['sql'], {cwd:data,env,input:readFileSync(resolve('../../data/demo/01-schema.sql'))}).status,0);
    proc = spawn(bin,['sql-server','--host','127.0.0.1','--port',String(port),'--data-dir',data],{cwd:data,env,stdio:['ignore','pipe','pipe']});
    let diagnostic = ''; for (const stream of [proc.stdout,proc.stderr]) stream?.on('data',chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
    let ready = false;
    for (let i=0;i<100;i++) { assert.equal(proc.exitCode,null,'fixture exited: '+diagnostic); try { const c = await createConnection({host:'127.0.0.1',port,user:'root',password:'',connectTimeout:500}); try { await c.query('SELECT 1'); } finally { await c.end(); } ready=true;break; } catch { await new Promise(r=>setTimeout(r,100)); } }
    assert.equal(ready,true,'Dolt readiness: '+diagnostic);
    for (const k of ['DOLT_PORT','DOLT_DATABASE']) saved[k]=process.env[k]; Object.assign(process.env,{DOLT_PORT:String(port),DOLT_DATABASE:'iam'});
    releaseDataReady(); await fresh().prepareMigrationStorage();

  });
  after(async () => { if (proc && proc.exitCode === null) { const closed = new Promise<void>(r => proc.once('exit',()=>r())); proc.kill(); await closed; } if (dir) rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200}); for (const [k,v] of Object.entries(saved)) { if(v===undefined) delete process.env[k]; else process.env[k]=v; } });
  it('retains SQL runs/tasks/cron marker across a held service startup and inspection GETs', async () => {
    const store=fresh(), at='2026-01-01 00:00:00';
    const graph={nodes:[{id:'mail',type:'lyam-send-mail',name:'Mail',config:{to:'nobody@example.invalid',subject:'Fictional',text:'No delivery'}}],edges:[]};
    const definition={id:'held-def',tenant:'demo',name:'Held fixture',description:'',graph,trigger:null,active:true,tags:[],created_by:'fixture',created_at:at,updated_at:at};
    await store.putDefinition(definition,'main');
    for(const [id,status,started_by] of [['queued','queued','fixture'],['running','running','fixture'],['parent','waiting','fixture'],['mail-child','queued','workflow:parent']] as const) {
      await store.createRun({id,tenant:'demo',definition_id:definition.id,name:id,graph,branch:null,base_branch:'main',status,error:null,started_by,started_at:at,finished_at:null,test:false},[{run_id:id,node_id:'mail',status:'pending',simulated:false,attempts:0,error:null,log:[],input:null,output:null,started_at:null,finished_at:null}]);
    }
    await new WorkflowTasksService(store).request({tenant:'demo',kind:'approval',title:'Retained',assignee:'reviewer',runId:'parent',nodeId:'mail'});
    await store.setMeta('cron-fired:demo:held-def','old-minute');
    const before=await root();
    const child=spawnSync(process.execPath,['--input-type=module','-e',`
      import assert from 'node:assert/strict';
      await import('./dist/plugins/v1/registry.js');
      const {WorkflowStore}=await import('./dist/workflows/store.js');
      const {VersioningService}=await import('./dist/versioning/versioning.service.js');
      const {WorkflowEngine}=await import('./dist/workflows/engine.js');
      const {WorkflowsService}=await import('./dist/workflows/workflows.service.js');
      const {WorkflowTasksService}=await import('./dist/workflows/tasks.js');
      const {WorkflowsController}=await import('./dist/workflows/workflows.controller.js');
      const {WorkflowTasksController}=await import('./dist/workflows/tasks.controller.js');
      const {WorkflowCronService}=await import('./dist/workflows/cron.js');
      const {releaseDataReady}=await import('./dist/migrations/readiness.js');
      let storeCalls=0;const realStore=new WorkflowStore(new VersioningService());
      const store=new Proxy(realStore,{get:(target,key)=>{const value=Reflect.get(target,key,target);return typeof value==='function'? (...args)=>{storeCalls++;return value.apply(target,args);}:value;}});
      let providerCalls=0;const registry={isActive:()=>true,resolve:()=>{providerCalls++;throw Error('engine/provider called')}};
      globalThis.fetch=async()=>{providerCalls++;throw Error('network forbidden')};
      const engine=new WorkflowEngine(store,{defaultBranch:'main'},registry);
      const wf=new WorkflowsService(store,engine,{},registry);
      const tasks=new WorkflowTasksService(store);const cron=new WorkflowCronService(store,wf,registry,tasks,engine);
      await engine.onModuleInit();releaseDataReady();await engine.onModuleInit();await engine.scanChildWaits();await cron.tick();
      for(const id of ['queued','running','parent','mail-child'])engine.kick(id);
      const refused=fn=>assert.rejects(fn,e=>e.getStatus?.()===503);
      await refused(()=>wf.retry('demo','running'));await refused(()=>wf.start('demo','held-def','fixture'));
      assert.equal(storeCalls,0,'held boot/cron/kick must not read or mutate even the real SQL store');
      const task=(await store.listTasks('demo',{}))[0];await refused(()=>tasks.decide('demo',task.id,'reviewer','approve','no delivery'));await refused(()=>tasks.delegate('demo',task.id,'reviewer','other'));
      // Functional read handlers remain usable, including status. They do not dispatch.
      const c=new WorkflowsController(wf);assert.equal((await c.list('demo')).definitions.length,1);assert.equal((await c.get('demo','held-def')).definition.id,'held-def');
      assert.equal((await c.runs('demo')).runs.length,4);assert.equal((await c.run('demo','parent')).run.status,'waiting');
      assert.ok((await c.templates('demo')).templates.length);assert.ok((await c.blocks('demo')).blocks.length);assert.ok(c.events().events.length);
      const tc=new WorkflowTasksController(tasks);assert.equal((await tc.inbox('demo',{user:{sub:'reviewer'}})).tasks.length,1);
      assert.ok((await wf.dryRun('demo','held-def')).steps.length);
      await new Promise(r=>setTimeout(r,30));assert.equal(providerCalls,0);engine.onModuleDestroy();
      assert.equal(await store.getMeta('cron-fired:demo:held-def'),'old-minute');
    `],{env:{...process.env,IAM_AUTOMATION_HOLD:'1',IAM_DATA_MIGRATIONS:'1'},encoding:'utf8',timeout:20000});
    assert.equal(child.status,0,child.stdout+'\n'+child.stderr);
    assert.equal(await root(),before,'held startup and GETs preserve real SQL working root');
    assert.equal((await fresh().getRun('demo','parent'))?.status,'waiting');
    assert.equal((await fresh().getRun('demo','mail-child'))?.status,'queued');
  });
  it('the same persisted fixture without hold attempts provider resolution and writes resume review markers', async () => {
    const before=await root();
    const env: NodeJS.ProcessEnv={...process.env,WF_RESUME_RETRY_DELAYS_MS:'1'};delete env.IAM_AUTOMATION_HOLD;
    const child=spawnSync(process.execPath,['--input-type=module','-e',`
      import assert from 'node:assert/strict';
      await import('./dist/plugins/v1/registry.js');
      const {WorkflowStore}=await import('./dist/workflows/store.js');
      const {VersioningService}=await import('./dist/versioning/versioning.service.js');
      const {WorkflowEngine}=await import('./dist/workflows/engine.js');
      const {releaseDataReady}=await import('./dist/migrations/readiness.js');
      let calls=0;const store=new WorkflowStore(new VersioningService());
      const engine=new WorkflowEngine(store,{defaultBranch:'main'},{resolve:()=>{calls++;throw Error('fictional unavailable engine');}});
      releaseDataReady();await engine.onModuleInit();
      for(let i=0;i<100;i++){if((await store.getRun('demo','queued')).error)break;await new Promise(r=>setTimeout(r,10));}
      assert.ok(calls>0,'unheld same fixture must attempt provider resolution');
      assert.match((await store.getRun('demo','queued')).error,/RESUME_FAILED/);
      console.log('unheld fixture provider resolution attempts:',calls);engine.onModuleDestroy();
    `],{env,encoding:'utf8',timeout:20000});
    assert.equal(child.status,0,child.stdout+'\n'+child.stderr);
    assert.notEqual(await root(),before,'unheld resume markers change the real SQL working root');
  });
});
