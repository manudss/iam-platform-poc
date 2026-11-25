import test from 'node:test';
import assert from 'node:assert/strict';
import {capture,diagnostic} from './release-backlog.mjs';
function fake({move=false,omit=false}={}){
 let ref='',roots=0;
 return {async query(sql){
  if(sql.startsWith('USE `')){ref=sql.slice(5,-1);return [{affectedRows:0}];}
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
 const v=await capture(fake());assert.equal(v.entries.length,4);assert(v.inventory_complete);assert.equal(v.external_coverage,'unverified');assert.equal(v.complete,undefined);assert(v.entries.some(e=>e.branch==='personal/demo-alice'));
 assert(!JSON.stringify(v).includes('PRIVATE-ID'));assert(!JSON.stringify(v).includes('SECRET-CREDENTIAL'));
 assert(v.entries.every(e=>e.tables.every(t=>t.rows===1&&/^[a-f0-9]{64}$/.test(t.sha256))));
});
test('moving working roots refuse rather than claim coherent evidence',async()=>{await assert.rejects(capture(fake({move:true})),/changed during capture/);});
test('runtime table missing is not empty backlog',async()=>{await assert.rejects(capture(fake({omit:true})),/coverage absent/);});
test('query failure is not empty backlog',async()=>{await assert.rejects(capture({query:async()=>{throw Error('offline');}}),/offline/);});

test('at the row ceiling capture refuses, never reports a possibly partial inventory',async()=>{
 const c=fake(),query=c.query.bind(c);c.query=async(sql,...args)=>sql.startsWith('SELECT *')?[Array(100000).fill({id:1})]:query(sql,...args);
 await assert.rejects(capture(c),/row bound exceeded/);
});

test('finite diagnostic distinguishes SQL stage without leaking raw SQL messages',async()=>{
 for(const fail of ['branches','session','root','rows']){
  const c=fake(),query=c.query.bind(c);c.query=async(sql,...args)=>{
   if((fail==='branches'&&sql.includes('dolt_branches'))||(fail==='root'&&sql.includes('DOLT_HASHOF_DB'))||(fail==='rows'&&sql.startsWith('SELECT *')))throw Object.assign(Error('PRIVATE SQL WITH SECRET'),{code:'ER_PARSE_ERROR'});
   return query(sql,...args);
  };
  if(fail==='session'){const prev=c.query;c.query=async(sql,...args)=>{if(sql.startsWith('USE `'))throw Error('PRIVATE PASSWORD');return prev(sql,...args);};}
  try{await capture(c);assert.fail('expected refusal');}catch(e){const d=diagnostic(e);assert.equal(d.stage,{branches:'branches',session:'change-session',root:'working-root',rows:'rows'}[fail]);assert(!JSON.stringify(d).includes('PRIVATE'));}
 }
 assert.equal(diagnostic({code:'SECRET',message:'SECRET'}).category,'refused-or-unknown');
});

test('branch session is selected using USE and independently checked, never COM_CHANGE_USER',async()=>{
 const c=fake(),query=c.query.bind(c),uses=[];c.query=async(sql,...a)=>{if(sql.startsWith('USE `'))uses.push(sql);return query(sql,...a);};
 await capture(c);assert.equal(uses.length,8);assert(uses.some(s=>s==='USE `iam/personal/demo-alice`'));
 const bad=fake(),prev=bad.query.bind(bad);bad.query=async(sql,...a)=>sql==='SELECT DATABASE() AS d'?[[{d:'wrong'}]]:prev(sql,...a);
 await assert.rejects(capture(bad),/session branch differs/);
});
