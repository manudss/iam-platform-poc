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
 it('completes every seed component once; preserves edits, credentials and personal branch on second boot', {timeout:360000}, async()=>{
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
   const journal=new MigrationJournal(home,readManifest(root).versions);assert.equal(journal.read()?.entries.length,2);assert.equal(journal.read()?.pending,undefined);
   assert.match(dolt(['--use-db=iam','sql','-q',"SELECT count(*) AS n FROM policy_rules WHERE id='screen-account-blocks'"]),/\b1\b/);
   assert.match(dolt(['--use-db=iam','sql','-q',"SELECT message FROM dolt_log WHERE message LIKE 'migration 0002%'"]),/migration 0002/);
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
   assert.equal(journal.read()?.entries.length,2);
   // An existing tenant: baseline 0001 adopted (not seeded), a customised policy, no account-blocks rule yet. Boot adds the rule on main only.
   const legacy=async(customScreenRule:boolean)=>{
    dolt(['--use-db=iam','sql','-q',`DELETE FROM policy_rules WHERE id='screen-account-blocks'; UPDATE policy_rules SET cedar=CONCAT(cedar,'\n// tenant edit') WHERE set_name='default' AND id=(SELECT id FROM (SELECT id FROM policy_rules WHERE set_name='default' ORDER BY id LIMIT 1) x);`+(customScreenRule?`INSERT INTO policy_rules (set_name,id,cedar) VALUES ('default','tenant-own-blocks','permit(principal, action, resource == Screen::"account-blocks");');`:'')+` CALL DOLT_ADD('-A'); CALL DOLT_COMMIT('-m','tenant policy customisation');`]);
    rmSync(join(home,'migrations','journal.json'));new MigrationJournal(home,readManifest(root).versions).adopt('a'.repeat(64));
    const others=dolt(['--use-db=iam','sql','-r','json','-q',"SELECT id, cedar FROM policy_rules WHERE id<>'screen-account-blocks' ORDER BY id"]);
    env.IAM_MIGRATION_BOOT_ID=customScreenRule?'fourth':'third';
    const prep=spawnSync(process.execPath,['dist/migrations/cli.js','prepare','populated'],{env,encoding:'utf8'});assert.equal(prep.status,0,prep.stderr);
    await start();await stop(api);await stop(server);
    assert.equal(dolt(['--use-db=iam','sql','-r','json','-q',"SELECT id, cedar FROM policy_rules WHERE id<>'screen-account-blocks' ORDER BY id"]),others,'tenant policy rows are untouched');
    assert.match(dolt(['--use-db=iam','sql','-q',"SELECT cedar FROM policy_rules WHERE set_name='default' AND cedar LIKE '%tenant edit%'"]),/tenant edit/);
    assert.equal(new MigrationJournal(home,readManifest(root).versions).read()?.entries.length,2);
    return Number(JSON.parse(dolt(['--use-db=iam','sql','-r','json','-q',"SELECT count(*) AS n FROM policy_rules WHERE id='screen-account-blocks'"])).rows[0].n);
   };
   assert.equal(await legacy(false),1,'a customised tenant without the rule receives it, nothing else changes');
   assert.equal(await legacy(true),0,'a tenant that wrote its own rule for the screen keeps its choice');
   // Refusal before the journal starts: uncommitted policy edits on main stop 0002 with no pending marker, so the previous image could still start.
   rmSync(join(home,'migrations','journal.json'));new MigrationJournal(home,readManifest(root).versions).adopt('b'.repeat(64));
   dolt(['--use-db=iam','sql','-q',"DELETE FROM policy_rules WHERE id='tenant-own-blocks'; CALL DOLT_ADD('-A'); CALL DOLT_COMMIT('-m','remove test rule'); INSERT INTO policy_rules (set_name,id,cedar) VALUES ('default','uncommitted-edit','permit(principal, action, resource);');"]);
   env.IAM_MIGRATION_BOOT_ID='fifth';
   const prep5=spawnSync(process.execPath,['dist/migrations/cli.js','prepare','populated'],{env,encoding:'utf8'});assert.equal(prep5.status,0,prep5.stderr);
   await assert.rejects(start());await stop(api);await stop(server);
   const stuck=new MigrationJournal(home,readManifest(root).versions).read();assert.equal(stuck?.pending,undefined);assert.equal(stuck?.entries.length,1);
   assert.match(dolt(['--use-db=iam','sql','-q',"SELECT id FROM policy_rules WHERE id='uncommitted-edit'"]),/uncommitted-edit/);
   dolt(['--use-db=iam','sql','-q',"CALL DOLT_CHECKOUT('policy_rules')"]);
   env.IAM_MIGRATION_BOOT_ID='sixth';
   const prep6=spawnSync(process.execPath,['dist/migrations/cli.js','prepare','populated'],{env,encoding:'utf8'});assert.equal(prep6.status,0,prep6.stderr);
   await start();await stop(api);await stop(server);
   assert.equal(new MigrationJournal(home,readManifest(root).versions).read()?.entries.length,2);
  }catch(e){console.error('migration phase:',new MigrationJournal(home,readManifest(root).versions).read());console.error(readFileSync(join(home,'api.log'),'utf8'));throw e;}finally{const keepAlive=setInterval(()=>{},100);try{await stop(api);await stop(server);await bus.close();}finally{clearInterval(keepAlive);}rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
 });
});
