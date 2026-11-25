import 'reflect-metadata';
import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {loadPluginModule} from '../plugins/v1/loader.js';
import {externalBlock} from './model.js';
const api=loadPluginModule('workflow-connectors','sheets-api.mjs') as any;
const expected={nom:'Martin',prenom:'Camille',departement:'IT',role:'',process:'OK',cree:'',ticket:'','badge-fait':''};
const names=[...Object.keys(expected),'email','badge'];
const letters=names.map((_,i)=>String.fromCharCode(65+i));
const header={row:1,values:Object.fromEntries(names.map((k,i)=>[letters[i],k]))};
const row=(n=2,over:any={})=>({row:n,values:Object.fromEntries(names.map((k,i)=>[letters[i],String(({...expected,email:'',badge:'',...over} as any)[k])]))});
const email='camille.martin@dss.name',source={spreadsheetId:'fictional',sheetId:0};
function fixture(over:any={}) {
 let rows=[structuredClone(header),row()],reads=0,pending=0,writes:any[]=[];
 const run=async(_p:string,action:string,args:any)=>{
  if(action==='get-many-rows'){reads++;over.beforeRead?.(reads,rows);return structuredClone(rows);}
  writes.push(args.propsValue);if(over.throwBefore)throw Error('uncertain provider');
  const target=rows.find(x=>x.row===args.propsValue.row_id)!;Object.assign(target.values,args.propsValue.values);
  if(over.throwAfter)throw Error('lost response');over.afterWrite?.(rows);return {};
 };
 return {run,rows,mark:async()=>{pending++;},writes,pending:()=>pending};
}
const options=(e:any,v:string,r:string[])=>({matches:{nom:e.nom,prenom:e.prenom,departement:e.departement,role:e.role},checks:{process:e.process,cree:e.cree,ticket:e.ticket,'badge-fait':e['badge-fait']},column:'email',value:v,requiredColumns:r,uniqueValue:true,requireExpected:true,expectedValue:''});
const initialize=(_a:any,src:any,e:any,v:string,r:string[],m:any,run:any)=>api.updateGoogleCellChecked(_a,src,options(e,v,r),m,run);
describe('generic checked cell updates, local action fixtures',()=>{
 it('fresh unique row writes only email then verifies, with durable intent before write',async()=>{
  const f=fixture();let marked=false;const wrapped=async(p:string,a:string,x:any)=>{if(a==='update_row')assert.ok(marked);return f.run(p,a,x);};
  const out=await initialize({},source,expected,email,['badge'],async()=>{marked=true;},wrapped);
  assert.deepEqual(out,{value:email,updated:true,written:true});assert.deepEqual(f.writes[0].values,{I:email});
 });
 it('resolves a moved row on the final read, never reuses trigger position',async()=>{
  const f=fixture({beforeRead:(n:number,rows:any[])=>{if(n===2)rows[1].row=9;}});
  await initialize({},source,expected,email,[],f.mark,f.run);assert.equal(f.writes[0].row_id,9);
 });
 it('same-name people differing in department are allowed, identical identities are refused',async()=>{
  const f=fixture();f.rows.push(row(3,{departement:'Sales'}));await initialize({},source,expected,email,[],f.mark,f.run);assert.equal(f.writes.length,1);
  const g=fixture();g.rows.push(row(3));await assert.rejects(()=>initialize({},source,expected,email,[],g.mark,g.run),/exactly one/);assert.equal(g.writes.length,0);
 });
 it('refuses changed row, changed headers, foreign email, collision and missing or duplicate header without write',async()=>{
  const cases=[
   fixture({beforeRead:(n:number,r:any[])=>{if(n===2)r[1].values.J='changed';}}),
   fixture({beforeRead:(n:number,r:any[])=>{if(n===2)r[0].values.Z='other';}}),
   fixture({beforeRead:(_n:number,r:any[])=>{r[1].values.I='foreign@dss.name';}}),
   fixture({beforeRead:(_n:number,r:any[])=>{if(r.length===2)r.push(row(3,{prenom:'Alex',email:email.toUpperCase()}));}}),
   fixture({beforeRead:(_n:number,r:any[])=>{delete r[0].values.I;}}),
   fixture({beforeRead:(_n:number,r:any[])=>{r[0].values.Z='email';}}),
  ];
  for(const f of cases){await assert.rejects(()=>initialize({},source,expected,email,[],f.mark,f.run));assert.equal(f.writes.length,0);assert.equal(f.pending(),0);}
 });
 it('identity homonyms remain ambiguous even when only one is eligible; changed eligibility is refused',async()=>{
  const f=fixture();f.rows.push(row(3,{process:'En cours'}));await assert.rejects(()=>initialize({},source,expected,email,[],f.mark,f.run),/exactly one/);assert.equal(f.writes.length,0);
  for(const over of [{process:'En cours'},{cree:'ok'},{ticket:'KAN-1'},{'badge-fait':'ok'}]){const g=fixture();g.rows[1]=row(2,over);await assert.rejects(()=>initialize({},source,expected,email,[],g.mark,g.run),/precondition/);assert.equal(g.writes.length,0);}
 });
 it('failed intent persistence prevents a write, and trailing absent empty cells are equivalent',async()=>{
  const f=fixture();await assert.rejects(()=>initialize({},source,expected,email,[],async()=>{throw Error('store unavailable');},f.run));assert.equal(f.writes.length,0);
  const g=fixture({beforeRead:(n:number,r:any[])=>{if(n>1)delete r[1].values.J;}});await initialize({},source,expected,email,[],g.mark,g.run);assert.equal(g.writes.length,1);
 });
 it('already-same email is idempotent without write, fresh reads still detect changed source',async()=>{
  const f=fixture();f.rows[1]=row(2,{email});assert.deepEqual(await initialize({},source,expected,email,[],f.mark,f.run),{value:email,updated:true,written:false});assert.equal(f.writes.length,0);assert.equal(f.pending(),0);
 });
 it('uncertain provider or readback differences never report success, intent stays for review',async()=>{
  for(const opts of [{throwBefore:true},{throwAfter:true},{afterWrite:(rows:any[])=>{rows[1].values.A='Changed';}}]){
   const f=fixture(opts);await assert.rejects(()=>initialize({},source,expected,email,[],f.mark,f.run));assert.equal(f.pending(),1);assert.equal(f.writes.length,1);
  }
 });
 it('a retry with reconciled provider outcome reads the existing value and performs no second write',async()=>{
  const f=fixture({throwAfter:true});await assert.rejects(()=>initialize({},source,expected,email,[],f.mark,f.run));
  assert.equal((await initialize({},source,expected,email,[],f.mark,f.run)).written,false);assert.equal(f.writes.length,1);
 });
 it('same helper writes a ticket or OK marker, not only an email',async()=>{
  for(const [column,value] of [['ticket','KAN-1'],['cree','ok'],['badge-fait','ok']]){
   const f=fixture();const out=await api.updateGoogleCellChecked({},source,{matches:{nom:'Martin',prenom:'Camille'},column,value,requireExpected:true,expectedValue:''},f.mark,f.run);
   assert.equal(out.value,value);assert.equal(out.updated,true);assert.equal(f.writes.length,1);
  }
 });
 it('target may be a selector or precondition, verified readback and same-value continuation remain safe',async()=>{
  const f=fixture();f.rows[1]=row(2,{email:'old@dss.name'});
  const out=await api.updateGoogleCellChecked({},source,{matches:{email:'old@dss.name'},column:'email',value:email,uniqueValue:true,requireExpected:true,expectedValue:'old@dss.name'},f.mark,f.run);assert.equal(out.updated,true);
  const g=fixture();const opts={matches:{nom:'Martin'},checks:{ticket:''},column:'ticket',value:'KAN-1',requireExpected:true,expectedValue:''};
  await api.updateGoogleCellChecked({},source,opts,g.mark,g.run);const again=await api.updateGoogleCellChecked({},source,opts,g.mark,g.run);assert.equal(again.written,false);assert.equal(g.writes.length,1);
 });
 it('all-empty selectors and required missing headers fail before intent or writes',async()=>{
  for(const opts of [{matches:{nom:''},column:'status',value:'ok'},{matches:{nom:'Martin'},column:'email',value:email,requiredColumns:['missing']}]){
   const f=fixture();await assert.rejects(()=>api.updateGoogleCellChecked({},source,opts,f.mark,f.run));assert.equal(f.writes.length,0);assert.equal(f.pending(),0);
  }
 });
 it('generic block validates independent selectors/conditions, simulations never read providers',async()=>{
  assert.equal(externalBlock('google-sheets-initialize-email'),undefined);
  const b=externalBlock('google-sheets-update')!;
  const cfg={source:'google',spreadsheetId:'fictional',sheetId:0,checked:true,matchColumn1:'nom',matchValue1:'Martin',column:'email',value:email};
  const valid=b.validate(cfg);
  for(const bad of [{...cfg,checked:false},{...cfg,matchColumn1:'',matchValue1:''},{...cfg,matchColumn2:'nom'},{...cfg,keyColumn:'email',keyValue:email}])assert.throws(()=>b.validate(bad));
  await assert.rejects(()=>b.run({config:{...valid,matchValue1:'{{event.nom}}'},dryRun:false,log(){},settings:{}} as any),/Unresolved/);
  const out=await b.run({config:valid,dryRun:true,log(){},settings:new Proxy({},{get(){throw Error('no settings read');}})} as any);assert.equal(out!.updated,false);
  await assert.rejects(()=>b.run({config:valid,dryRun:false,log(){},settings:{}} as any),/managed Google/);
 });
});
