import 'reflect-metadata';
import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {externalBlock} from './model.js';
import {loadPluginModule} from '../plugins/v1/loader.js';
const api=loadPluginModule('workflow-connectors','mail-api.mjs') as any;
const block=()=>externalBlock('lyam-send-template-mail')!;
class Fake {static calls:any[]=[];static mode='ok';emails={send:async(payload:any)=>{Fake.calls.push(payload);if(Fake.mode==='throw')throw Error('unknown outcome');return {data:{id:'message-fixture'}};}};}
const REV='a'.repeat(64);
function fixture(secret=false){
 const history:any[]=[];
 const tpl={revision:REV,variables:secret?[{name:'password',type:'temporary-password',required:true},{name:'expiry',type:'text',required:true}]:[{name:'person',type:'text',required:true}],effective:{text:'{{password}} until {{expiry}}'}};
 const c:any={tenant:'fictional',runId:'run-fixture',nodeId:'mail',config:{to:'owner@example.test',templateKey:'custom.welcome',templateRevision:REV,...(secret?{param_password:'secret:'+'a'.repeat(24),param_expiry:'caller expiry ignored',account:'bao',hours:'24',revision:'credential-fixture',ownerRun:'creator',sourceHead:'published-head'}:{param_person:'Alice'})},settings:{},dryRun:false,outputs:{},log:(v:any)=>history.push(v),liveMailSettings:async()=>({mailAllowedRecipients:'owner@example.test'}),markEffectPending:async(v:any)=>history.push(v),reads:{workflowMailTemplate:async()=>tpl,renderWorkflowMail:async(_t:any,_r:any,_k:any,_rev:any,data:any)=>({subject:'Welcome',text:secret?data.password+' until '+data.expiry:'Hello '+data.person,...(secret?{}:{html:'<p>Hello '+data.person+'</p>'})})},secrets:{reveal:()=> 'CANARY<SECRET>',drop:()=>history.push('dropped')},workspace:{proof:async()=>({activation:'applied',containsHead:true,activationCommit:'commit',mainCommit:'commit'})},users:{firstAccess:async()=>({required:true,expired:false,revision:'credential-fixture',expiresAt:Date.now()+3600000}),emailOf:async()=>'owner@example.test'},accounts:{activeBlocks:async()=>[{setBy:'workflow:creator'}]}};
 return {c,tpl,history};
}
const withMail=async(fn:()=>Promise<void>)=>{const old=process.env.RESEND_API_KEY;process.env.RESEND_API_KEY='fixture-not-real';api.mailClient.Ctor=Fake;Fake.calls=[];Fake.mode='ok';try{await fn();}finally{api.mailClient.Ctor=null;if(old===undefined)delete process.env.RESEND_API_KEY;else process.env.RESEND_API_KEY=old;}};
describe('generic template mail safety',()=>{
 it('sends ordinary text/html without imposing temporary-password account guards',async()=>withMail(async()=>{const {c,history}=fixture();delete c.users;delete c.accounts;delete c.workspace;const out:any=await block().run(c);assert.equal(out.accepted,true);assert.equal(Fake.calls[0].text,'Hello Alice');assert.equal(Fake.calls[0].html,'<p>Hello Alice</p>');assert.equal(history[0].template,'custom.welcome');}));
 it('fails closed on changed revision, rendering refusal, unknown recipient and secret reference in plain data',async()=>withMail(async()=>{
  for(const change of [(f:any)=>f.tpl.revision='b'.repeat(64),(f:any)=>f.c.reads.renderWorkflowMail=async()=>{throw Error('bad template');},(f:any)=>f.c.liveMailSettings=async()=>({}),(f:any)=>f.c.config.param_person='secret:'+'a'.repeat(24)]){const f=fixture();change(f);await assert.rejects(()=>block().run(f.c));}assert.equal(Fake.calls.length,0);
 }));
 it('keeps secret values out of renderer payload, logs, durable intent and output; uses recorded expiry',async()=>withMail(async()=>{const {c,history}=fixture(true);let rendered:any;c.reads.renderWorkflowMail=async(_t:any,_r:any,_k:any,_rev:any,data:any)=>{rendered={...data};return {subject:'Your access',text:data.password+' until '+data.expiry,};};const out=await block().run(c);assert.equal(rendered.password,'[[password]]');assert.notEqual(rendered.expiry,'caller expiry ignored');assert.equal(Fake.calls[0].text.includes('CANARY<SECRET>'),true);assert.equal(Fake.calls[0].html,undefined);assert.ok(!JSON.stringify([history,out,rendered]).includes('CANARY'));}));
 it('requires fresh real-state secret guards and refuses plaintext secret values before send',async()=>withMail(async()=>{for(const mutate of [(c:any)=>delete c.workspace,(c:any)=>c.users.emailOf=async()=>'other@example.test',(c:any)=>c.accounts.activeBlocks=async()=>[{setBy:'workflow:other'}],(c:any)=>c.config.param_password='plaintext-not-allowed']){const {c}=fixture(true);mutate(c);await assert.rejects(()=>block().run(c));}assert.equal(Fake.calls.length,0);}));
 it('marks uncertain effect before the provider and returns no acceptance on network uncertainty',async()=>withMail(async()=>{const {c,history}=fixture();Fake.mode='throw';await assert.rejects(()=>block().run(c),/unknown/);assert.equal(history[0].template,'custom.welcome');assert.equal(Fake.calls.length,1);}));
 it('tests do not read templates, secrets, state or provider',async()=>withMail(async()=>{const {c}=fixture(true);c.test=true;c.reads=new Proxy({},{get(){throw Error('read');}});c.secrets=new Proxy({},{get(){throw Error('secret');}});assert.equal((await block().run(c))!.accepted,false);assert.equal(Fake.calls.length,0);}));
});
