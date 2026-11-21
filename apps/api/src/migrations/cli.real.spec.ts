import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { adoptionSnapshot } from './cli.js';
import { MigrationJournal, readManifest } from './journal.js';
const root = resolve('../..'), bin = process.env.DOLT_BIN;
const cli = resolve('dist/migrations/cli.js');
describe('migration CLI on real Dolt, including every dirty branch', { skip: !bin && 'DOLT_BIN required' }, () => {
 it('refuses a partial dataset with a missing sentinel table instead of seeding it',()=>{
  const home=mkdtempSync(join(tmpdir(),'migration-partial-'));mkdirSync(join(home,'dolt'));
  const env={...process.env,HOME:home,DOLT_BIN:bin,IAM_DEMO_HOME:home,IAM_MIGRATION_SOURCE_ROOT:root,IAM_MIGRATION_BOOT_ID:'partial'};
  try {
   for(const [key,value] of [['user.name','test'],['user.email','test@example.invalid']]) assert.equal(spawnSync(bin!,['config','--global','--add',key,value],{env}).status,0);
   const data=spawnSync(bin!,['sql','-q','CREATE DATABASE iam; USE iam; CREATE TABLE custom_work (id int); INSERT INTO custom_work VALUES (42)'],{cwd:join(home,'dolt'),env});assert.equal(data.status,0);
   const result=spawnSync(process.execPath,[cli,'prepare','empty'],{env});assert.notEqual(result.status,0);
   assert.equal(new MigrationJournal(home,readManifest(root).versions).read(),undefined);
   const kept=spawnSync(bin!,['sql','-q','SELECT id FROM iam.custom_work'],{cwd:join(home,'dolt'),env,encoding:'utf8'});assert.equal(kept.status,0);assert.match(kept.stdout,/42/);
  }finally{rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:300});}
 });

 it('initializes fresh preview once, refuses interrupted retry and never reseeds populated data; adoption is read-only',()=>{
  const home=mkdtempSync(join(tmpdir(),'migration-dolt-'));mkdirSync(join(home,'dolt'));
  const old=process.env.DOLT_BIN;process.env.DOLT_BIN=bin;
  const env={...process.env,HOME:home,IAM_DEMO_HOME:home,IAM_MIGRATION_SOURCE_ROOT:root,IAM_MIGRATION_BOOT_ID:'first',DOLT_BIN:bin};
  const dolt=(args:string[],input?:string)=>{const r=spawnSync(bin!,args,{cwd:join(home,'dolt'),env,input,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout;};
  const run=(args:string[],extra={})=>spawnSync(process.execPath,[cli,...args],{cwd:root,env:{...env,...extra},encoding:'utf8'});
  try{
   dolt(['config','--global','--add','user.name','migration-test']);dolt(['config','--global','--add','user.email','migration@example.invalid']);
   assert.notEqual(run(['prepare','empty'],{IAM_DEMO_SEED_MODE:'never'}).status,0);
   assert.equal(run(['prepare','empty']).status,0);
   const j=new MigrationJournal(home,readManifest(root).versions);assert.equal(j.read()?.pending?.phase,'initial-api');
   assert.notEqual(run(['prepare','populated'],{IAM_MIGRATION_BOOT_ID:'second'}).status,0);
   // Emulate the API half for isolated CLI qualification. Full API seed has its own integration test.
   j.complete('first');assert.equal(run(['prepare','populated'],{IAM_MIGRATION_BOOT_ID:'second'}).status,0);
   dolt(['--use-db=iam','sql','-q',"ALTER TABLE identities ADD COLUMN email varchar(254), ADD COLUMN login_enabled boolean, ADD COLUMN credential_revision varchar(40); CREATE TABLE organizations(id int); CREATE TABLE org_memberships(id int); CREATE TABLE app_connectors(id int); CALL DOLT_ADD('-A'); CALL DOLT_COMMIT('-m','fixture'); CALL DOLT_BRANCH('personal/kept');"]);
   dolt(['--use-db=iam/personal/kept','sql','-q',"INSERT INTO roles VALUES('custom-role','kept',false)"]);
   // CLI snapshot inherits process environment, not the per-child env object.
   const priorHome=process.env.HOME;process.env.HOME=home;
   const before=adoptionSnapshot(home);assert.ok(before.some(b=>b.branch==='personal/kept'));
   rmSync(join(home,'migrations'),{recursive:true});
   assert.notEqual(run(['prepare','populated']).status,0,'no auto-adoption');
   const backup=join(home,'MANIFEST'),plan=join(home,'plan.json');writeFileSync(backup,'fixture of operator-reviewed recovery evidence');
   assert.equal(run(['plan-adoption',plan,backup]).status,0);
   const fingerprints=JSON.stringify(adoptionSnapshot(home));
   assert.equal(run(['adopt-existing-v1',plan,'--confirm-reviewed-backup-and-existing-v1']).status,0);
   assert.equal(JSON.stringify(adoptionSnapshot(home)),fingerprints,'adoption must change no working root or branch head');
   assert.equal(j.read()?.entries[0].disposition,'adopted');
   assert.notEqual(run(['adopt-existing-v1',plan,'--confirm-reviewed-backup-and-existing-v1']).status,0);
   // Drift in a dirty personal branch invalidates an otherwise identical plan.
   rmSync(join(home,'migrations'),{recursive:true});
   dolt(['--use-db=iam/personal/kept','sql','-q',"UPDATE roles SET label='changed' WHERE id='custom-role'"]);
   assert.notEqual(run(['adopt-existing-v1',plan,'--confirm-reviewed-backup-and-existing-v1']).status,0);
   if(priorHome===undefined)delete process.env.HOME;else process.env.HOME=priorHome;
  } finally { if(old===undefined)delete process.env.DOLT_BIN;else process.env.DOLT_BIN=old;rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:300}); }
 });
});
