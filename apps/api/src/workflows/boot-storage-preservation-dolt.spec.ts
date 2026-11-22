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
describe('workflow boot preservation on real Dolt', { skip: !existsSync(bin) && 'DOLT_BIN missing' }, () => {
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
    assert.equal(await present(),0,'previous release has no task/campaign tables');
  });
  after(async () => { if (proc && proc.exitCode === null) { const closed = new Promise<void>(r => proc.once('exit',()=>r())); proc.kill(); await closed; } if (dir) rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200}); for (const [k,v] of Object.entries(saved)) { if(v===undefined) delete process.env[k]; else process.env[k]=v; } });
  it('the real overdue scheduler path leaves a previous-release working root unchanged',async()=>{
    const before=await root(), store=fresh(); await store.prepareMigrationStorage();
    const cron = new WorkflowCronService(store, {} as never, {} as never, new WorkflowTasksService(store));
    await cron.tick(); await cron.tick();
    assert.equal(await root(),before,'a background read must not create a task table');
    assert.equal(await present(),0);
  });
  it('task and IGA reads of a never-written store do not create tables',async()=>{
    const before=await root(), store=fresh();
    assert.deepEqual(await store.listDueTasks('2099-01-01 00:00:00'),[]);
    assert.deepEqual(await store.listTasksByCampaign('demo','missing'),[]);
    assert.deepEqual(await store.igaListCampaigns('demo'),[]);
    assert.equal(await store.igaGetCampaign('demo','missing'),null);
    assert.deepEqual(await store.igaListItems('demo','missing'),[]);
    assert.equal(await root(),before); assert.equal(await present(),0);
  });
  it('first explicit task and campaign writes still persist and survive restart',async()=>{
    const store=fresh(), at='2026-01-01 00:00:00';
    const tasks = new WorkflowTasksService(store);
    const task=await tasks.request({tenant:'demo',kind:'approval',title:'Fictional review',assignee:'reviewer',runId:'fixture-run',nodeId:'review'});
    assert.equal((await fresh().getTask(task.id))?.status,'open');
    await store.igaPutCampaign({id:'fixture-campaign',tenant:'demo',kind:'user-access',name:'Fictional campaign',ref:'main',status:'open',scope:{},created_by:'reviewer',created_at:at},[{id:'fixture-item',identity:'fictional-user',kind:'user-access',action:'review',payload:{roles:[]}}]);
    assert.equal((await fresh().igaGetCampaign('demo','fixture-campaign'))?.id,'fixture-campaign');
    assert.equal((await fresh().igaListItems('demo','fixture-campaign')).length,1);
    const before=await root(); const restarted=fresh(); await restarted.prepareMigrationStorage();
    assert.deepEqual(await restarted.listDueTasks('2099-01-01 00:00:00'),[]);
    assert.equal(await root(),before,'restart reads of populated stores preserve all data');
    assert.equal(await present(),3);
  });
  it('unexpected query failures still reject instead of masquerading as an empty store',async()=>{
    const store=fresh(), fault=Object.assign(new Error('fixture access denied'),{code:'ER_ACCESS_DENIED_ERROR'});
    let closed=0;
    Object.assign(store,{meta:async()=>({query:async()=>{throw fault;},end:async()=>{closed++;}})});
    const reads=[()=>store.listDueTasks('2099-01-01 00:00:00'),()=>store.listTasksByCampaign('demo','missing'),()=>store.igaListCampaigns('demo'),()=>store.igaGetCampaign('demo','missing'),()=>store.igaListItems('demo','missing')];
    for(const read of reads) await assert.rejects(read,error=>error===fault);
    assert.equal(closed,reads.length,'every connection is closed on failure');
  });

});
