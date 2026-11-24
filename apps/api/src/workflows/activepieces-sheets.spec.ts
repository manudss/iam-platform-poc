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
  const store:any={liveRef:'main',pieceClaim:async()=>true,pieceRelease:async()=>{},pieceGet:async(t:string,s:string,k:string)=>memory.get(t+s+k)??null,piecePut:async(t:string,s:string,k:string,v:unknown)=>{memory.set(t+s+k,structuredClone(v));},pieceDelete:async(t:string,s:string,k:string)=>{memory.delete(t+s+k);},pieceEnqueue:async(t:string,s:string,v:unknown)=>{memory.set(t+s+'lyam:inbox:notification',structuredClone(v));},pieceDeleteExact:async(t:string,s:string,k:string,v:unknown)=>{if(JSON.stringify(memory.get(t+s+k))===JSON.stringify(v))memory.delete(t+s+k);},getDefinition:async()=>d,prunePieceFiles:async()=>{},listAllDefinitions:async()=>[d],pieceSubscriptions:async()=>[],pieceInbox:async(t:string,scope:string)=>[...memory.entries()].filter(([k])=>k.startsWith(t+scope+'lyam:inbox:')).map(([k,value])=>({key:k.slice((t+scope).length),value}))};
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
 it('failed native enable is retained for review and never automatically enabled a second time',async()=>{
  const h=harness();const trigger=full.SHEETS_TRIGGERS[h.state.key],old=trigger.onEnable;let enables=0;trigger.onEnable=async()=>{enables++;throw Error('provider response lost');};
  try{await h.service.tick();assert.equal((await h.store.pieceGet('t','trigger:wf-fictional','lyam:subscription')as any).status,'review');await h.service.tick();assert.equal(enables,1);}finally{trigger.onEnable=old;}
 });
 it('failed native disable persists disabling and cannot duplicate remote teardown',async()=>{
  const h=harness();h.d.active=false;h.state.fingerprint='old';await h.store.piecePut('t','trigger:wf-fictional','lyam:subscription',h.state);const trigger=full.SHEETS_TRIGGERS[h.state.key],old=trigger.onDisable;let disables=0;trigger.onDisable=async()=>{disables++;throw Error('stop response lost');};
  try{await h.service.tick();assert.equal((await h.store.pieceGet('t','trigger:wf-fictional','lyam:subscription')as any).status,'disabling');await h.service.tick();assert.equal(disables,1);}finally{trigger.onDisable=old;}
 });
 it('durable mutex rejection prevents native execution and releases no foreign owner',async()=>{
  const h=harness();let release=0;h.store.pieceClaim=async()=>false;h.store.pieceRelease=async()=>{release++;};await assert.rejects(()=>h.service.locked('t','wf-fictional',()=>{throw Error('must not execute');}),/crash reconciliation/);assert.equal(release,0);
 });
 it('verified webhook is durably queued even while a worker lock is busy, then drained after restart',async()=>{
  const h=harness('googlesheets_new_row_added');h.state.fingerprint=(await import('node:crypto')).createHash('sha256').update(JSON.stringify([h.state.key,h.d.trigger.config])).digest('hex');await h.store.piecePut('t','trigger:wf-fictional','lyam:subscription',h.state);await h.store.piecePut('t','trigger:wf-fictional',h.state.key,{id:'channel',resourceId:'resource'});h.store.pieceClaim=async()=>false;
  assert.deepEqual(await h.service.webhook('t',h.d.id,'fixture-token',{'x-goog-channel-id':'channel','x-goog-resource-id':'resource','x-goog-resource-state':'update','x-goog-message-number':'1'},{}),{received:true,queued:true});assert.equal((await h.store.pieceInbox('t','trigger:wf-fictional')).length,1);
  let collect=0;h.service.collect=async()=>{collect++;};await h.service.drainInbox(h.d,h.state);assert.equal(collect,1);assert.equal((await h.store.pieceInbox('t','trigger:wf-fictional')).length,0);
 });
 it('two coalesced notifications collect once and a notification arriving during collection survives exact deletion',async()=>{
  const h=harness();const scope='trigger:wf-fictional';await h.store.pieceEnqueue('t',scope,{fingerprint:h.state.fingerprint,headers:{'x-goog-message-number':'1'}});await h.store.pieceEnqueue('t',scope,{fingerprint:h.state.fingerprint,headers:{'x-goog-message-number':'2'}});let calls=0;h.service.collect=async()=>{calls++;await h.store.pieceEnqueue('t',scope,{fingerprint:h.state.fingerprint,headers:{'x-goog-message-number':'3'}});};await h.service.drainInbox(h.d,h.state);assert.equal(calls,1);assert.equal((await h.store.pieceInbox('t',scope)).length,1);h.service.collect=async()=>{calls++;};await h.service.drainInbox(h.d,h.state);assert.equal(calls,2);assert.equal((await h.store.pieceInbox('t',scope)).length,0);
 });
 it('inbox rejection refuses acknowledgement and exposes a recoverable review reason',async()=>{
  const h=harness('googlesheets_new_row_added');h.state.fingerprint=(await import('node:crypto')).createHash('sha256').update(JSON.stringify([h.state.key,h.d.trigger.config])).digest('hex');await h.store.piecePut('t','trigger:wf-fictional','lyam:subscription',h.state);await h.store.piecePut('t','trigger:wf-fictional',h.state.key,{id:'channel',resourceId:'resource'});h.store.pieceEnqueue=async()=>{throw Error('quota');};await assert.rejects(()=>h.service.webhook('t',h.d.id,'fixture-token',{'x-goog-channel-id':'channel','x-goog-resource-id':'resource','x-goog-message-number':'1'},{}),/quota/);assert.equal((await h.store.pieceGet('t','trigger:wf-fictional','lyam:delivery-status')as any).reason,'Inbox storage failed; notification not accepted');
 });
 it('failed inbox collect retains notification and exposes review state without advancing delivery',async()=>{
  const h=harness();await h.store.pieceEnqueue('t','trigger:wf-fictional',{fingerprint:h.state.fingerprint,headers:{'x-goog-message-number':'1'}});h.service.collect=async()=>{throw Error('poison row');};await assert.rejects(()=>h.service.drainInbox(h.d,h.state),/review/);assert.equal((await h.store.pieceInbox('t','trigger:wf-fictional')).length,1);assert.equal((await h.store.pieceGet('t','trigger:wf-fictional','lyam:delivery-status')as any).status,'review');
 });
 it('old subscription inbox is dropped without native collection and native lifecycle cannot touch host keys',async()=>{
  const h=harness();await h.store.pieceEnqueue('t','trigger:wf-fictional',{fingerprint:'old',headers:{'x-goog-message-number':'1'}});h.service.collect=async()=>{throw Error('must not collect');};await h.service.drainInbox(h.d,h.state);assert.equal((await h.store.pieceInbox('t','trigger:wf-fictional')).length,0);const store=h.service.nativeStore('t',h.d.id);assert.throws(()=>store.get('lyam:lock'));assert.throws(()=>store.put('lyam:subscription',{}));assert.throws(()=>store.delete('lyam:batch'));
 });
 it('crash after collect/envelope before inbox deletion resumes native cursor without duplicate workflow run',async()=>{
  const h=harness();const scope='trigger:wf-fictional';await h.store.pieceEnqueue('t',scope,{fingerprint:h.state.fingerprint,headers:{'x-goog-message-number':'1'}});let deliveries=0;
  h.service.collect=async()=>{const cursor=await h.store.pieceGet('t',scope,'native-cursor');if(!cursor){await h.store.piecePut('t',scope,'lyam:batch-envelope',{batch:1,staged:{'native-cursor':'seen'},pending:[{id:'stable-event',data:{row:2}}]});await h.service.recoverEnvelope(h.d);await h.service.drain(h.d);deliveries++;}};
  const original=h.store.pieceDeleteExact;h.store.pieceDeleteExact=async()=>{throw Error('process interrupted before inbox delete');};await assert.rejects(()=>h.service.drainInbox(h.d,h.state));assert.equal(h.runs.length,1);h.store.pieceDeleteExact=original;await h.service.drainInbox(h.d,h.state);assert.equal(h.runs.length,1);assert.equal(deliveries,1);assert.equal((await h.store.pieceInbox('t',scope)).length,0);
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
 it('native trigger_column E ignores its own email/ticket/intermediate/final marker writes',async()=>{
  nock.disableNetConnect();const t=adapter.piece('@activepieces/piece-google-sheets')._triggers['google-sheets-new-or-updated-row'];let rows=[['nom','prenom','departement','role','process','cree','badge-fait','email','ticket'],['Nom','Camille','IT','Member','','','','','']];
  nock('https://sheets.googleapis.com').persist().get('/v4/spreadsheets/fictional').reply(200,{sheets:[{properties:{sheetId:0,title:'Source'}}]});nock('https://sheets.googleapis.com').persist().get(/\/values\//).reply(()=>[200,{values:rows}]);
  nock('https://www.googleapis.com').post('/drive/v3/files/fictional/watch').query(true).reply(200,{id:'channel',resourceId:'resource'});
  const mem=new Map<string,any>(),ctx:any={auth:{type:'OAUTH2',access_token:'FICTIONAL'},propsValue:{spreadsheetId:'fictional',sheetId:0,trigger_column:'E'},webhookUrl:'https://fixture.invalid/hook',store:{get:async(k:string)=>mem.get(k),put:async(k:string,v:any)=>{mem.set(k,v);}},payload:{headers:{'x-goog-resource-state':'update','x-goog-changed':'content'}}};
  await t.onEnable(ctx);rows[1][4]='OK';const events=await t.run(ctx);assert.equal(events.length,1);assert.equal(events[0].row,2);assert.equal(events[0].values.E,'OK');
  rows[1][7]='camille@example.invalid';assert.deepEqual(await t.run(ctx),[]);rows[1][8]='DEMO-1';assert.deepEqual(await t.run(ctx),[]);rows[1][5]='ok';rows[1][6]='ok';assert.deepEqual(await t.run(ctx),[]);assert.deepEqual(await t.run(ctx),[]);
  rows[1][4]='CHANGED';assert.equal((await t.run(ctx)).length,1);
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
 it('native Find Rows and Get Row retain exact array/object forms and letter-keyed values',async()=>{
  nock.disableNetConnect();nock('https://sheets.googleapis.com').persist().get('/v4/spreadsheets/fictional').reply(200,{sheets:[{properties:{sheetId:0,title:'Source'}}]});nock('https://sheets.googleapis.com').persist().get(/\/values\//).reply(function(uri:string){return[200,{values:decodeURIComponent(uri).includes('A1:ZZZ1')?[['Name','State']]:[['Camille','OK']]}];});
  const auth={type:'OAUTH2',access_token:'FICTIONAL'},props={spreadsheetId:'fictional',sheetId:0,headerRow:1,useHeaderNames:false};
  const found=await adapter.runPieceAction('@activepieces/piece-google-sheets','find_rows',{auth,propsValue:{...props,columnName:'A',searchValue:'Camille',matchCase:true,numberOfRows:2},runtime});assert.deepEqual(found,[{row:1,values:{A:'Camille',B:'OK'}}]);
  const row=await adapter.runPieceAction('@activepieces/piece-google-sheets','find_row_by_num',{auth,propsValue:{...props,rowNumber:2},runtime});assert.deepEqual(row,{found:true,row:2,values:{A:'Camille',B:'OK'}});
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

import{ActivepiecesSheetsController}from'./activepieces-sheets.controller.js';
describe('native operational status read only',()=>{
 it('returns only tenant-scoped safe status and recovery guidance, never invokes a provider',async()=>{
  let tenant='';const ctrl=new ActivepiecesSheetsController({webhook:()=>{throw Error('must not run');}}as any,{}as any,{pieceStatuses:async(t:string)=>{tenant=t;return[{scope:'trigger:fixture',subscription:{status:'review'},locked:true,pending:2}];}}as any);
  const result=await ctrl.status('tenant-fixture');assert.equal(tenant,'tenant-fixture');assert.equal(result.entries[0].pending,2);assert.match(result.recovery,/stop the former worker/);assert.equal(JSON.stringify(result).includes('token'),false);
 });
});

import{substituteStepOutputs}from'./model.js';
describe('generic typed nested native results, no provider or business-specific transformation',()=>{
 const source={read:{result:[{row:2,values:{A:'Camille "Quote"',B:false,C:7}}]}};
 it('resolves nested array paths and typed JSON values without injecting JSON syntax',()=>{
  const node:any={id:'update',type:full.sheetBlockType('update_row'),config:{row_id:'{{steps.read.result.0.row}}',values:'{"A":"{{steps.read.result.0.values.A}}","B":"{{steps.read.result.0.values.B}}","C":"{{steps.read.result.0.values.C}}"}'}};
  const result=substituteStepOutputs(node,source);assert.equal(result.config.row_id,'2');assert.deepEqual(JSON.parse(String(result.config.values)),{A:'Camille "Quote"',B:false,C:7});
 });
 it('rejects prototype paths and missing nested native outputs',()=>{
  for(const path of ['result.99.row','result.constructor','result.__proto__'])assert.throws(()=>substituteStepOutputs({id:'n',config:{v:'{{steps.read.'+path+'}}'}}as any,source));
 });
 it('generic JSON operations count and filter native arrays without flattening them',async()=>{
  const b=externalBlock('json-values')!;const rows=[{fields:{status:{name:'Done'}}},{fields:{status:{name:'Open'}}}];
  const result=await b.run({config:b.validate({input:JSON.stringify(rows),operation:'filter-equals',field:'fields.status.name',equals:'Done'}),dryRun:true}as any);assert.equal(result!.count,1);assert.deepEqual(result!.value,[rows[0]]);
 });
});

import{substituteEventPayload}from'./model.js';
describe('native JSON placeholders and busy-lock safety regressions',()=>{
 it('event cell text cannot inject native JSON fields',()=>{
  const graph:any={nodes:[{id:'write',type:full.sheetBlockType('update_row'),config:{values:'{"A":"{{event.data}}"}'}}],edges:[]};const attack='x","I":"UNAUTHORIZED';const out=substituteEventPayload(graph,{data:attack});assert.deepEqual(JSON.parse(String(out.nodes[0].config.values)),{A:attack});
 });
 it('native unquoted JSON placeholders fail closed and event strings cannot inject second-order step lookups',()=>{
  const type=full.sheetBlockType('update_row');assert.throws(()=>substituteEventPayload({nodes:[{id:'n',type,config:{values:'{"A":{{event.data}}}'}}],edges:[]}as any,{data:'"x","I":"bad"'}));
  const graph:any={nodes:[{id:'n',type,config:{values:'{"A":"{{event.data}}"}'}}],edges:[]};const first=substituteEventPayload(graph,{data:'{{steps.secret.result}}'});const final=substituteStepOutputs(first.nodes[0],{secret:{result:'DO_NOT_READ'}});assert.deepEqual(JSON.parse(String(final.config.values)),{A:'{{steps.secret.result}}'});
 });
 it('preserves arbitrary braces and Unicode event strings exactly after the step pass',()=>{
  const type=full.sheetBlockType('update_row');for(const value of ['plain{{braces}}','{{steps.secret.result}}','{{','}}','{{{{','unicode\uE000marker','\uE0000\uE0001{{x}}','quoted " braces{{x}}\nline']){
   const graph:any={nodes:[{id:'n',type,config:{values:'{"A":"{{event.data}}"}'}}],edges:[]};const first=substituteEventPayload(graph,{data:value});const final=substituteStepOutputs(first.nodes[0],{secret:{result:'DO_NOT_READ'}});assert.deepEqual(JSON.parse(String(final.config.values)),{A:value});
  }
 });
 it('protects nested native event values without changing literal config or step output Unicode',()=>{
  const type=full.sheetBlockType('update_row');const literal='literal\uE0000\uE0001{{other}}';
  const data={x:['{{steps.secret.result}}','\uE0001{{braces}}']};const graph:any={nodes:[{id:'n',type,config:{obj:'{"A":"{{event.data}}","B":"{{steps.read.result}}"}',literal}}],edges:[]};const first=substituteEventPayload(graph,{data}as any);const final=substituteStepOutputs(first.nodes[0],{read:{result:'\uE0001{{no-reparse}}'},secret:{result:'BAD'}});assert.deepEqual(JSON.parse(String(final.config.obj)),{A:data,B:'\uE0001{{no-reparse}}'});assert.equal(final.config.literal,literal);
  assert.equal(substituteStepOutputs({id:'n',type,config:{literal}}as any,{}).config.literal,literal);
 });
 it('keeps nonnative event recursion top-level only and preserves nested literals',()=>{
  const nested={v:'\uE0001{{event.data}}'};const graph:any={nodes:[{id:'n',type:'http-request',config:{nested,top:'{{event.data}}'}}],edges:[]};const first=substituteEventPayload(graph,{data:'{{steps.secret.result}}'});assert.deepEqual(first.nodes[0].config.nested,nested);const final=substituteStepOutputs(first.nodes[0],{secret:{result:'BAD'}});assert.equal(final.config.top,'{{steps.secret.result}}');assert.deepEqual(final.config.nested,nested);
 });
 it('literal nonnative HTTP/Jira/mail JSON stays byte exact including large numbers and spacing',()=>{
  for(const type of ['http-request','jira-create-issue','lyam-send-mail']){const input=' {"id":9007199254740993123, "spaces" : true}';const node:any={id:'n',type,config:{body:input}};assert.equal(substituteStepOutputs(node,{}).config.body,input);assert.equal(substituteEventPayload({nodes:[node],edges:[]},{data:'x'}).nodes[0].config.body,input);}
 });
 it('busy durable action mutex refuses before effect marker and provider invocation',async()=>{
  const b=externalBlock(full.sheetBlockType('delete_row'))!;let marks=0,calls=0;const action=full.SHEETS_ACTIONS.delete_row,old=action.run;action.run=async()=>{calls++;};try{await assert.rejects(()=>b.run({config:b.validate({spreadsheetId:'fictional',sheetId:'0',rowId:2}),settings,dryRun:false,pieceRuntime:{...runtime,withLock:async()=>{throw Error('busy');}},markEffectPending:async()=>{marks++;}}as any),/busy/);assert.equal(marks,0);assert.equal(calls,0);}finally{action.run=old;}
 });
 it('custom read requests cannot smuggle method override headers',()=>{for(const header of ['X-HTTP-Method-Override','X-Method-Override','X-HTTP-Method'])assert.throws(()=>full.validateCustomCall({url:{url:'/v4/spreadsheets/fictional'},method:'GET',headers:{[header]:'DELETE'}}));});
});

import{WorkflowEngine}from'./engine.js';
import{WorkflowsController}from'./workflows.controller.js';
describe('native private export and action-store boundary',()=>{
 it('sets seven-day expiry, refuses expired downloads, isolates tenant and guards every host-key operation',async()=>{
  let saved:any;const now=Date.now(),store:any={piecePut:async(...a:any[])=>{saved=a;},getRunById:async()=>({tenant:'t'}),pieceGet:async()=>saved[3]};
  const runtime=(WorkflowEngine.prototype as any).pieceRuntime.call({store},'t','d','run','n');for(const method of ['get','put','delete'])assert.throws(()=>runtime.store[method]('lyam:lock',{}),/Reserved/);
  await runtime.files.write({fileName:'test.csv',data:Buffer.from('fixture')});assert.ok(saved[3].expiresAt>=now+7*86400_000&&saved[3].expiresAt<=Date.now()+7*86400_000);
  const controller=new WorkflowsController({}as any,store),sent:any[]=[];const response:any={setHeader(){},send(v:any){sent.push(v);}};await controller.connectorFile('t','run','f',response);assert.equal(sent[0].toString(),'fixture');await assert.rejects(()=>controller.connectorFile('other','run','f',response));saved[3].expiresAt=Date.now()-1;await assert.rejects(()=>controller.connectorFile('t','run','f',response));assert.equal(sent.length,1);
 });
});

describe('storage migration refuses wrong primary key',()=>{
 it('checks ordered unique composite key, not just columns',async()=>{
  const verify=(await import('./store.js')).WorkflowStore.prototype.verifyPieceStorage;let ended=0;const base=['tenant','scope_id','state_key'];const fake=(key:string[])=>({meta:async()=>({end:async()=>{ended++;},query:async(q:string)=>[q.startsWith('SHOW COLUMNS')?[...base,'value_json'].map(Field=>({Field})):key.map((Column_name,i)=>({Column_name,Key_name:'PRIMARY',Seq_in_index:i+1,Non_unique:0}))]})});
  await verify.call(fake(base)as any);for(const key of [['scope_id','tenant','state_key'],['tenant','scope_id'],[]])await assert.rejects(()=>verify.call(fake(key)as any),/primary key/);assert.equal(ended,4);
 });
});
