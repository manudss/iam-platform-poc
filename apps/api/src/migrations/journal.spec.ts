import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hash, MigrationJournal, migrate, readManifest } from './journal.js';
const versions = ['0001', '0002', '0003'].map(id=>({id,name:'test '+id,checksum:hash(id)}));
const fresh = () => new MigrationJournal(mkdtempSync(join(tmpdir(),'migration-unit-')), versions);
const actions = (calls: string[], fail?: string) => versions.map(v=>({id:v.id,run:async()=>{calls.push(v.id);if(fail===v.id)throw Error('injected failure');},verify:async()=>{calls.push('verify'+v.id);}}));
describe('persistent application migration journal', () => {
 it('requires explicit adoption for existing data',()=>assert.throws(()=>fresh().assertBoot('boot'),/adoption/));
 it('runs missing versions in order, verifies before recording, never replays on restart',async()=>{
  const j=fresh(), calls:string[]=[];j.initialize(); await migrate(j,'one',actions(calls));
  assert.deepEqual(calls,['0001','verify0001','0002','verify0002','0003','verify0003']);
  await migrate(new MigrationJournal(j.home,versions),'two',actions(calls)); assert.equal(calls.length,6);
 });
 it('adopts v1 without running it, then runs ONLY missing migrations',async()=>{
  const j=fresh(), calls:string[]=[];j.adopt(hash('reviewed copy')); await migrate(j,'one',actions(calls));
  assert.deepEqual(calls,['0002','verify0002','0003','verify0003']);assert.equal(j.read()?.entries[0].disposition,'adopted');
 });
 it('failure retains pending phase and refuses restart, never automatically retries',async()=>{
  const j=fresh(),calls:string[]=[];j.adopt(hash('backup'));await assert.rejects(migrate(j,'one',actions(calls,'0002')),/injected/);
  assert.equal(j.read()?.entries.length,1);assert.equal(j.read()?.pending?.id,'0002');
  await assert.rejects(migrate(j,'two',actions(calls)),/interrupted/);assert.deepEqual(calls,['0002']);
 });
 it('a refused preflight leaves no pending marker, so the previous image still starts and the next boot retries',async()=>{
  const j=fresh(),calls:string[]=[];j.adopt(hash('backup'));let refuse=true;
  const acts=[{id:'0002',preflight:async()=>{if(refuse)throw Error('policy_rules dirty');},run:async()=>{calls.push('run');},verify:async()=>{}},{id:'0003',run:async()=>{},verify:async()=>{}}];
  await assert.rejects(migrate(j,'one',acts),/dirty/);assert.equal(j.read()?.pending,undefined);assert.equal(j.read()?.entries.length,1);assert.deepEqual(calls,[]);
  refuse=false;await migrate(j,'two',acts);assert.equal(j.read()?.entries.length,3);assert.deepEqual(calls,['run']);
 });
 it('verification failure never records success',async()=>{
  const j=fresh();j.adopt(hash('backup'));await assert.rejects(migrate(j,'one',[{id:'0002',run:async()=>{},verify:async()=>{throw Error('verify');}}]));
  assert.equal(j.read()?.pending?.phase,'verify');assert.equal(j.read()?.entries.length,1);
 });
 it('refuses changed checksums, gaps, unknown newer versions, malformed JSON and pending',()=>{
  for(const mutation of [(j:any)=>j.entries[0].checksum=hash('changed'),(j:any)=>j.entries[0].id='0002',(j:any)=>j.format=2,(j:any)=>j.pending={id:'9999'}]){
   const j=fresh();j.adopt(hash('backup'));const data=j.read()!;mutation(data);writeFileSync(j.file,JSON.stringify(data));assert.throws(()=>j.read());
  }
  const j=fresh();j.adopt(hash('backup'));writeFileSync(j.file,'broken');assert.throws(()=>j.read(),/unreadable/);
 });
 it('Docker runtime migration-source copies satisfy the complete manifest',()=>{
  const root=resolve('../..'), image=mkdtempSync(join(tmpdir(),'migration-image-'));
  try {
   const docker=readFileSync(join(root,'demo/Dockerfile'),'utf8');
   const copies=[...docker.matchAll(/^COPY ([^ ]+) (\/app\/migration-source\/[^ ]+)$/gm)];
   assert.ok(copies.length>0,'runtime migration sources must be copied');
   for(const [,from,to] of copies) cpSync(join(root,from),join(image,to.slice('/app/migration-source/'.length)),{recursive:true});
   const manifest=readManifest(image);
   assert.equal(manifest.versions.length,readManifest(root).versions.length);
   rmSync(join(image,'apps/api/src/migrations/v0003'),{recursive:true});
   assert.throws(()=>readManifest(image),/ENOENT/,'missing runtime source must refuse boot');
  }finally{rmSync(image,{recursive:true,force:true});}
 });
 it('manifest verifies all initial frozen source files, SQL and dispatcher',()=>{
  const root=resolve('../..');const m=readManifest(root);assert.equal(m.versions[0].id,'0001');
  assert.ok(Object.keys(m.versions[0].files).includes('apps/api/src/migrations/v0001/run.ts'));
  const copy=mkdtempSync(join(tmpdir(),'migration-manifest-'));
  try{for(const f of ['data/migrations', 'apps/api/src/migrations/v0001'])cpSync(join(root,f),join(copy,f),{recursive:true});
   writeFileSync(join(copy,'data/migrations/0001-initial.sql'),'changed');assert.throws(()=>readManifest(copy),/checksum/);
  }finally{rmSync(copy,{recursive:true,force:true});}
 });
});
