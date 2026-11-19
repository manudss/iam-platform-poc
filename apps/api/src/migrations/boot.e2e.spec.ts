// Full new-preview baseline, then second boot with customized data. Uses real Dolt, core and NATS.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startTestBus, testBusBinsPresent } from '../testing/test-bus.js';
import { MigrationJournal, readManifest } from './journal.js';
const root=resolve('../..'), bin=process.env.DOLT_BIN, port=13987, apiPort=13988;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
describe('full versioned baseline and no-reseed reboot', {skip:!(bin&&testBusBinsPresent)&&'real Dolt + core + NATS required'},()=>{
 it('completes every seed component once; preserves edits, credentials and personal branch on second boot', {timeout:180000}, async()=>{
  const home=mkdtempSync(join(tmpdir(),'migration-api-'));mkdirSync(join(home,'dolt'));mkdirSync(join(home,'core-state'));
  const bus=await startTestBus(import.meta.url);let server:ChildProcess|undefined,api:ChildProcess|undefined;
  const env={...process.env,HOME:home,IAM_DEMO_HOME:home,IAM_MIGRATION_SOURCE_ROOT:root,IAM_DATA_MIGRATIONS:'1',IAM_MIGRATION_BOOT_ID:'first',
    IAM_WORKSPACE_MODE:'1',IAM_PLUGIN_STORE:'dolt',IAM_CREDENTIAL_FILE:join(home,'core-state/credentials.json'),IAM_AUTO_ACTIVATE_MAIN:'0',
    DOLT_BIN:bin,DOLT_PORT:String(port),DOLT_HOST:'127.0.0.1',DOLT_USER:'root',DOLT_PASSWORD:'',DOLT_DATABASE:'iam',API_PORT:String(apiPort)};
  const dolt=(args:string[],input?:string)=>{const r=spawnSync(bin!,args,{cwd:join(home,'dolt'),env,input,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout;};
  const stop=async(p?:ChildProcess)=>{if(p&&p.exitCode===null&&p.signalCode===null){const done=once(p,'exit');p.kill('SIGTERM');await done;}};
  const start=async()=>{
   server=spawn(bin!,['sql-server','-H','127.0.0.1','-P',String(port)],{cwd:join(home,'dolt'),env,stdio:'ignore'});
   for(let i=0;i<80;i++){if(spawnSync(bin!,['--host','127.0.0.1','--port',String(port),'--no-tls','-u','root','sql','-q','select 1'],{env}).status===0)break;await sleep(100);}
   const fd=openSync(join(home,'api.log'),'w');api=spawn(process.execPath,['dist/main.js'],{cwd:resolve('.'),env,stdio:['ignore',fd,fd]});closeSync(fd);
   for(let i=0;i<300;i++){
    if(api.exitCode!==null)throw Error('API baseline failed: '+readFileSync(join(home,'api.log'),'utf8'));
    try{if((await fetch(`http://127.0.0.1:${apiPort}/health`)).ok)return;}catch{}await sleep(200);
   }throw Error('API did not start: '+readFileSync(join(home,'api.log'),'utf8'));
  };
  try{
   dolt(['config','--global','--add','user.name','migration-test']);dolt(['config','--global','--add','user.email','migration@example.invalid']);
   const prepared=spawnSync(process.execPath,['dist/migrations/cli.js','prepare','empty'],{env,encoding:'utf8'});assert.equal(prepared.status,0,prepared.stderr);
   await start();
   const journal=new MigrationJournal(home,readManifest(root).versions);assert.equal(journal.read()?.entries.length,1);assert.equal(journal.read()?.pending,undefined);
   await stop(api);await stop(server);
   dolt(['--use-db=iam','sql','-q',"UPDATE identities SET display_name='Customized Alice' WHERE id='demo-alice'; CALL DOLT_ADD('-A'); CALL DOLT_COMMIT('-m','user customization'); CALL DOLT_BRANCH('personal/keep');"]);
   dolt(['--use-db=iam/personal/keep','sql','-q',"INSERT INTO roles VALUES('keep','Personal dirty work',false)"]);
   const creds=readFileSync(env.IAM_CREDENTIAL_FILE),authn=readFileSync(join(home,'core-state/iam-poc-authn-enrollments.json'));
   const state=dolt(['--use-db=iam','sql','-r','json','-q',"SELECT name, hash FROM dolt_branches ORDER BY name"]);
   const dirty=dolt(['--use-db=iam/personal/keep','sql','-r','json','-q',"SELECT DOLT_HASHOF_DB('WORKING') AS root"]);
   env.IAM_MIGRATION_BOOT_ID='second';
   const prepared2=spawnSync(process.execPath,['dist/migrations/cli.js','prepare','populated'],{env,encoding:'utf8'});assert.equal(prepared2.status,0,prepared2.stderr);
   await start();await stop(api);await stop(server);
   assert.deepEqual(readFileSync(env.IAM_CREDENTIAL_FILE),creds);assert.deepEqual(readFileSync(join(home,'core-state/iam-poc-authn-enrollments.json')),authn);
   assert.equal(dolt(['--use-db=iam','sql','-r','json','-q',"SELECT name, hash FROM dolt_branches ORDER BY name"]),state);
   assert.equal(dolt(['--use-db=iam/personal/keep','sql','-r','json','-q',"SELECT DOLT_HASHOF_DB('WORKING') AS root"]),dirty);
   assert.match(dolt(['--use-db=iam','sql','-q',"SELECT display_name FROM identities WHERE id='demo-alice'"]),/Customized Alice/);
   assert.equal(journal.read()?.entries.length,1);
  }finally{await stop(api);await stop(server);await bus.close();rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
 });
});
