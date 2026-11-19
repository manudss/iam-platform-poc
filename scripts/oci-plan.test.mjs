import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
const script=resolve('scripts/oci-plan.mjs');
test('plans every first-parent main commit, including a multicommit push, rejects divergent baseline',()=>{
 const dir=mkdtempSync(join(tmpdir(),'oci-plan-'));const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8'}).trim();
 git('init');git('config','user.name','test');git('config','user.email','test@example.invalid');
 const shas=[];for(let i=0;i<4;i++){writeFileSync(join(dir,'data'),String(i));git('add','.');git('commit','-m','test'+i);shas.push(git('rev-parse','HEAD'));}
 const result=spawnSync(process.execPath,[script,'plan',shas[0],shas[3],join(dir,'plan.json')],{cwd:dir,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout).include.map(e=>e.sha),shas.slice(1));
 git('checkout','--orphan','other');git('commit','--allow-empty','-m','other');
 assert.notEqual(spawnSync(process.execPath,[script,'plan',git('rev-parse','HEAD'),shas[3],join(dir,'bad.json')],{cwd:dir}).status,0);
});
test('requires one exact immutable receipt for every qualified commit',()=>{
 const dir=mkdtempSync(join(tmpdir(),'oci-receipts-'));mkdirSync(join(dir,'receipts'));
 const sha='a'.repeat(40);const plan={format:1,base:'b'.repeat(40),entries:[{sha,parent:'b'.repeat(40)}]};
 writeFileSync(join(dir,'plan.json'),JSON.stringify(plan));
 const run=()=>spawnSync(process.execPath,[script,'receipts',join(dir,'plan.json'),join(dir,'receipts'),join(dir,'qualified.json')],{encoding:'utf8'});
 assert.notEqual(run().status,0);writeFileSync(join(dir,'receipts','image.json'),JSON.stringify({sha,digest:'sha256:'+'c'.repeat(64)}));assert.equal(run().status,0);
 assert.equal(JSON.parse(readFileSync(join(dir,'qualified.json'))).entries[0].digest,'sha256:'+'c'.repeat(64));
 writeFileSync(join(dir,'receipts','duplicate.json'),JSON.stringify({sha,digest:'sha256:'+'d'.repeat(64)}));assert.notEqual(run().status,0);
});
