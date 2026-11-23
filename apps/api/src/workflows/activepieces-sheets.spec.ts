import 'reflect-metadata';
import{describe,it,afterEach}from'node:test';
import assert from'node:assert/strict';
import nock from'nock';
import{loadPluginModule}from'../plugins/v1/loader.js';
import{externalBlock,validateGraph,validateTrigger}from'./model.js';
const full=loadPluginModule('workflow-connectors','google-sheets-full.mjs')as any;
const adapter=loadPluginModule('workflow-connectors','adapter.mjs')as any;
afterEach(()=>{nock.cleanAll();nock.enableNetConnect();});
const cfg=(a:any)=>Object.fromEntries(Object.entries(a.props).filter(([,p]:any)=>p.type!=='MARKDOWN').map(([k,p]:any)=>[k,p.defaultValue??(p.type==='CHECKBOX'?false:p.type==='NUMBER'?1:['JSON','OBJECT','DYNAMIC'].includes(p.type)?'{}':p.type==='ARRAY'?'[]':p.options?.options?.[0]?.value??'fictional')]));
const runtime={store:{get:async()=>null,put:async()=>{},delete:async()=>{}},files:{write:async()=>'/private/test'}};
const settings={googleScope:'account',googleServiceAccount:'FICTIONAL'};
describe('complete installed Google Sheets catalogue, no live Google',()=>{
 it('covers every installed action and trigger, preserving native property keys and simulation without effects',async()=>{
  const p=adapter.piece('@activepieces/piece-google-sheets');assert.equal(full.GOOGLE_SHEETS_BLOCKS.length,Object.keys(p._actions).length);assert.equal(Object.keys(full.GOOGLE_SHEETS_EVENTS).length,Object.keys(p._triggers).length);
  for(const[key,a]of Object.entries(p._actions)as any){const b=externalBlock(full.sheetBlockType(key))!;assert.ok(b,key);assert.deepEqual(b.fields.map(x=>x.key),Object.entries(a.props).filter(([,p]:any)=>p.type!=='MARKDOWN').map(([k])=>k));const config=b.validate(cfg(a));assert.deepEqual(await b.run({config,dryRun:true,settings:new Proxy({},{get(){throw Error('no credential read');}})}as any),{confirmed:false,dryRun:true});validateGraph({nodes:[{id:'test',name:'Test',type:b.type,config}],edges:[]});}
  for(const[key,e]of Object.entries(full.GOOGLE_SHEETS_EVENTS)as any){assert.equal(validateTrigger({event:key,config:{connectionId:'conn-test',...cfg(p._triggers[e.activepiecesTrigger])}})!.event,key);}
 });
 it('an upstream native read uses its installed implementation and exact output shape',async()=>{
  nock.disableNetConnect();nock('https://sheets.googleapis.com').persist().get('/v4/spreadsheets/fictional').reply(200,{sheets:[{properties:{sheetId:0,title:'Source'}}]});nock('https://sheets.googleapis.com').persist().get(/\/values\//).reply(function(uri:string){return [200,{values:decodeURIComponent(uri).includes('A1:ZZZ1')?[['name']]:[['Camille']]}];});
  // OAuth fixture goes directly through the installed action, not a fake implementation.
  const result=await adapter.runPieceAction('@activepieces/piece-google-sheets','get-many-rows',{auth:{type:'OAUTH2',access_token:'FICTIONAL'},propsValue:{spreadsheetId:'fictional',sheetId:0,first_row_headers:true},runtime});assert.deepEqual(result,[{row:2,values:{name:'Camille'}}]);
 });
 it('generic wrapper refuses missing runtime/scope before effects and uses durable intent for mutation',async()=>{
  const b=externalBlock(full.sheetBlockType('delete_row'))!,config=b.validate({spreadsheetId:'fictional',sheetId:'0',rowId:2});
  await assert.rejects(()=>b.run({config,dryRun:false,settings:{googleServiceAccount:'FICTIONAL'},pieceRuntime:runtime}as any),/account-scoped/);
  await assert.rejects(()=>b.run({config,dryRun:false,settings}as any),/runtime/);
  let called=false;await assert.rejects(()=>b.run({config,dryRun:false,settings,pieceRuntime:runtime,markEffectPending:async()=>{called=true;throw Error('store failed');}}as any),/store failed/);assert.ok(called);
 });
 it('custom API cannot redirect credentials outside Sheets or override auth headers',()=>{
  for(const url of ['https://evil.invalid/','http://sheets.googleapis.com/v4/','https://sheets.googleapis.com.evil.invalid/v4/','https://sheets.googleapis.com:444/v4/'])assert.throws(()=>full.validateCustomCall({url:{url}}));
  assert.throws(()=>full.validateCustomCall({url:{url:'/v4/spreadsheets'},followRedirects:true}));assert.throws(()=>full.validateCustomCall({url:{url:'/v4/spreadsheets'},headers:{Authorization:'bad'}}));
  const good={url:{url:'/v4/spreadsheets/fictional'}};full.validateCustomCall(good);assert.equal(good.url.url,'https://sheets.googleapis.com/v4/spreadsheets/fictional');
 });
});

import{ActivepiecesSheetsService}from'./activepieces-sheets.js';
describe('native trigger runtime with persisted fixtures, not live Google',()=>{
 function harness(key='new-worksheet'){
  const memory=new Map<string,unknown>();const d:any={id:'wf-fictional',tenant:'t',active:true,trigger:{event:Object.entries(full.GOOGLE_SHEETS_EVENTS).find(([,e]:any)=>e.activepiecesTrigger===key)![0],config:{connectionId:'conn-test',spreadsheetId:'fictional'}}};
  const store:any={liveRef:'main',pieceClaim:async()=>true,pieceRelease:async()=>{},pieceGet:async(t:string,s:string,k:string)=>memory.get(t+s+k)??null,piecePut:async(t:string,s:string,k:string,v:unknown)=>{memory.set(t+s+k,structuredClone(v));},pieceDelete:async(t:string,s:string,k:string)=>{memory.delete(t+s+k);},getDefinition:async()=>d};
  const runs:any[]=[];const service:any=new ActivepiecesSheetsService(store,{resolve:async()=>({settings})}as any,{start:async(...args:any[])=>{runs.push(args);return{};}}as any,{isActive:()=>true}as any,{}as any);
  const state:any={key,config:d.trigger.config,fingerprint:'fictional',token:'fixture-token',lastRenew:Date.now(),status:'active'};return{service,memory,d,state,runs,store};
 }
 it('staged native cursor and pending event envelope survives interrupted application without losing an event',async()=>{
  const h=harness();await h.store.piecePut('t','trigger:wf-fictional','lyam:batch-envelope',{batch:2,staged:{worksheets:'[0,3]'},pending:[{id:'event-fixture',data:{title:'New worksheet'}}]});
  await h.service.recoverEnvelope(h.d);await h.service.drain(h.d);assert.equal(h.runs.length,1);assert.equal(h.runs[0][3].eventId,'event-fixture');assert.equal(await h.store.pieceGet('t','trigger:wf-fictional','worksheets'),'[0,3]');assert.equal(await h.store.pieceGet('t','trigger:wf-fictional','lyam:batch-envelope'),null);
 });
 it('delivery failure keeps pending data for retry with the same event id',async()=>{
  const h=harness();await h.store.piecePut('t','trigger:wf-fictional','lyam:pending',[{id:'stable',data:{id:'new'}}]);h.service.wf.start=async()=>{throw Error('database unavailable');};await assert.rejects(()=>h.service.drain(h.d));assert.equal((await h.store.pieceGet('t','trigger:wf-fictional','lyam:pending')as any[]).length,1);h.service.wf.start=async(...a:any[])=>h.runs.push(a);await h.service.drain(h.d);assert.equal(h.runs[0][3].eventId,'stable');
 });
 it('unknown, stale and wrong-token webhooks cannot invoke native triggers',async()=>{
  const h=harness('googlesheets_new_row_added');await assert.rejects(()=>h.service.webhook('t',h.d.id,'wrong',{},{}));await h.store.piecePut('t','trigger:wf-fictional','lyam:subscription',h.state);await assert.rejects(()=>h.service.webhook('t',h.d.id,'wrong',{},{}));assert.equal(h.runs.length,0);
 });
 it('installed polling trigger consumes persistent cursor and emits only new worksheet objects',async()=>{
  nock.disableNetConnect();nock('https://sheets.googleapis.com').get('/v4/spreadsheets/fictional').reply(200,{sheets:[{properties:{sheetId:0,title:'Existing'}},{properties:{sheetId:4,title:'New'}}]});
  const p=adapter.piece('@activepieces/piece-google-sheets'),mem=new Map([['worksheets','[0]']]);const event=await p._triggers['new-worksheet'].run({auth:{type:'OAUTH2',access_token:'FICTIONAL'},propsValue:{spreadsheetId:'fictional'},store:{get:async(k:string)=>mem.get(k),put:async(k:string,v:string)=>mem.set(k,v)}});assert.deepEqual(event,[{properties:{sheetId:4,title:'New'}}]);assert.deepEqual(JSON.parse(mem.get('worksheets')!),[4,0]);
 });
});

describe('native lifecycle and dynamic property contracts, intercepted transport',()=>{
 it('native New Row webhook lifecycle registers and stops a Drive channel, persisted cursor receives later rows',async()=>{
  nock.disableNetConnect();const p=adapter.piece('@activepieces/piece-google-sheets'),t=p._triggers.googlesheets_new_row_added;let data=[['name'],['One']];
  nock('https://sheets.googleapis.com').persist().get('/v4/spreadsheets/fictional').reply(200,{sheets:[{properties:{sheetId:0,title:'Source'}}]});
  nock('https://sheets.googleapis.com').persist().get(/\/values\//).reply(function(uri:string){const range=decodeURIComponent(uri.split('/values/')[1]);return[200,{values:range.endsWith('!3:3')?[data[2]]:data}];});
  const watch=nock('https://www.googleapis.com').post('/drive/v3/files/fictional/watch').query(true).reply(200,{id:'native-channel',resourceId:'native-resource'});
  const mem=new Map<string,unknown>(),ctx:any={auth:{type:'OAUTH2',access_token:'FICTIONAL'},propsValue:{spreadsheetId:'fictional',sheetId:0,includeTeamDrives:false},webhookUrl:'https://example.invalid/hook',store:{get:async(k:string)=>mem.get(k),put:async(k:string,v:unknown)=>mem.set(k,v)}};
  await t.onEnable(ctx);assert.ok(watch.isDone());assert.equal(mem.get('0'),2);data.push(['Two']);
  const rows=await t.run({...ctx,payload:{headers:{'x-goog-resource-state':'update','x-goog-changed':'content'}}});assert.equal(rows.length,1);assert.equal(rows[0].row,3);assert.equal(rows[0].values.A,'Two');
  const stop=nock('https://www.googleapis.com').post('/drive/v3/channels/stop',{id:'native-channel',resourceId:'native-resource'}).reply(204);
  await t.onDisable(ctx);assert.ok(stop.isDone());
 });
 it('dynamic fields use the upstream resolver with native auth context and column-letter keys',async()=>{
  nock.disableNetConnect();nock('https://sheets.googleapis.com').persist().get('/v4/spreadsheets/fictional').reply(200,{sheets:[{properties:{sheetId:0,title:'Source'}}]});nock('https://sheets.googleapis.com').persist().get(/\/values\//).reply(200,{values:[['Name','Email']]});
  const p=adapter.piece('@activepieces/piece-google-sheets'),out=await p._actions.insert_row.props.values.props({auth:{type:'OAUTH2',access_token:'FICTIONAL'},spreadsheetId:'fictional',sheetId:0,first_row_headers:true},{});assert.deepEqual(Object.keys(out),['A','B']);assert.equal(out.B.displayName,'Email');
 });
});

describe('complete catalogue dispatch into native action objects (action doubles, not provider proof)',()=>{
 it('every action forwards native props/auth and returns native result through one wrapper',async()=>{
  for(const[key,a]of Object.entries(full.SHEETS_ACTIONS)as any){
   const original=a.run;let received:any;
   a.run=async(c:any)=>{received=c;return {native:key};};
   try{
    const b=externalBlock(full.sheetBlockType(key))!,input=cfg(a);
    if(key==='custom_api_call')input.url='{"url":"/v4/spreadsheets/fictional"}';
    let pending=false;const result=await b.run({config:b.validate(input),settings,pieceRuntime:runtime,dryRun:false,markEffectPending:async()=>{pending=true;}}as any);
    assert.equal((result!.result as any).native,key);assert.equal(result!.confirmed,true);assert.equal(received.auth.type,'CUSTOM_AUTH');assert.equal(received.store,runtime.store);assert.equal(pending,full.sheetsMutates(key,received.propsValue)||['get_next_rows','sheets_get_next_rows'].includes(key));
   }finally{a.run=original;}
  }
 });
});


describe('native exports and custom API HTTP contracts, no live account',()=>{
 it('installed export writes its exact bytes to the host file service',async()=>{
  nock.disableNetConnect();const bytes=Buffer.from('name,status\nCamille,OK\n');let file:any;
  nock('https://docs.google.com').get('/spreadsheets/d/fictional/export').query({format:'csv',id:'fictional',gid:'0'}).reply(200,bytes);
  const result=await adapter.runPieceAction('@activepieces/piece-google-sheets','export_sheet',{auth:{type:'OAUTH2',access_token:'FICTIONAL'},propsValue:{spreadsheetId:'fictional',sheetId:0,format:'csv',returnAsText:false},runtime:{files:{write:async(f:any)=>{file=f;return '/private/fixture.csv';}}}});
  assert.deepEqual(file.data,bytes);assert.equal(file.fileName,'exported_sheet.csv');assert.deepEqual(result,{file:'/private/fixture.csv',filename:'exported_sheet.csv',format:'csv'});
 });
 it('installed custom API preserves URL and response with controlled OAuth fixture',async()=>{
  nock.disableNetConnect();const request=nock('https://sheets.googleapis.com').get('/v4/spreadsheets/fictional').query({fields:'spreadsheetId'}).matchHeader('authorization','Bearer FICTIONAL').reply(200,{spreadsheetId:'fictional'});
  const props={url:{url:'/v4/spreadsheets/fictional'},method:'GET',queryParams:{fields:'spreadsheetId'},followRedirects:false};full.validateCustomCall(props);
  const out=await adapter.runPieceAction('@activepieces/piece-google-sheets','custom_api_call',{auth:{type:'OAUTH2',access_token:'FICTIONAL'},propsValue:props,runtime});assert.ok(request.isDone());assert.equal(out.status,200);assert.deepEqual(out.body,{spreadsheetId:'fictional'});
 });
 it('custom API query parameters cannot replace connection authentication',()=>{
  assert.throws(()=>full.validateCustomCall({url:{url:'/v4/spreadsheets?access_token=bad'}}));assert.throws(()=>full.validateCustomCall({url:{url:'/v4/spreadsheets'},queryParams:{key:'bad'}}));
 });
});
