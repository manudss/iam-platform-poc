import test from 'node:test';
import assert from 'node:assert/strict';
import {capture} from './release-backlog.mjs';
function fake({move=false,omit=false}={}){
 let ref='',roots=0;
 return {async changeUser(x){ref=x.database;},async query(sql){
  if(sql==='SHOW DATABASES')return [[{Database:'iam'},{Database:'iam_meta'}]];
  if(sql.includes('dolt_branches'))return [[{name:'main',hash:'head'},{name:'personal/demo-alice',hash:'branch'}]];
  if(sql==='SELECT DATABASE() AS d')return [[{d:ref}]];
  if(sql.includes('DOLT_HASHOF_DB'))return [[{root:move&&++roots>4?'changed':'stable'}]];
  if(sql.startsWith('SHOW TABLES'))return [[{table:omit?'workflow_definitions':'workflow_runs'},{table:'workflow_piece_state'}]];
  if(sql.startsWith('SELECT *'))return [[{id:'PRIVATE-ID',value_json:'SECRET-CREDENTIAL'}]];
  throw Error('unexpected query');
 }};
}
test('covers both databases and every branch without exposing row values',async()=>{
 const v=await capture(fake());assert.equal(v.entries.length,4);assert(v.complete);assert(v.entries.some(e=>e.branch==='personal/demo-alice'));
 assert(!JSON.stringify(v).includes('PRIVATE-ID'));assert(!JSON.stringify(v).includes('SECRET-CREDENTIAL'));
 assert(v.entries.every(e=>e.tables.every(t=>t.rows===1&&/^[a-f0-9]{64}$/.test(t.sha256))));
});
test('moving working roots refuse rather than claim coherent evidence',async()=>{await assert.rejects(capture(fake({move:true})),/changed during capture/);});
test('runtime table missing is not empty backlog',async()=>{await assert.rejects(capture(fake({omit:true})),/coverage absent/);});
test('query failure is not empty backlog',async()=>{await assert.rejects(capture({query:async()=>{throw Error('offline');}}),/offline/);});
