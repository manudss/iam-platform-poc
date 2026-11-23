import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '../plugins/v1/plugins-v1.module.js';
import { directoryAccountStatus, DirectoryAccountStatusController } from './directory-status.controller.js';
import { screensFor } from '../auth/screens.js';
import { Block } from './blocks.js';
const block: Block = { id:'secret-ref',subject:'a',kind:'suspended',message:'Private reason',origin:'workflow',setBy:'run-private',setAt:1,hold:true,until:10 };
describe('read-only scoped directory account status',()=>{
  it('returns operational types and expiry only, not reasons, actor, run, references or credential revision',()=>{
    const s=directoryAccountStatus({login_enabled:false,hasCredential:true},[block]);
    assert.deepEqual(s,{published:true,loginEnabled:false,hasCredential:true,blocks:[{kind:'suspended',until:10,hold:true}]});
    assert.deepEqual(directoryAccountStatus(undefined,[]),{published:false,loginEnabled:false,hasCredential:false,blocks:[]});
  });
  it('keeps list reads on users permission and all block writes on their separate right',()=>{
    assert.deepEqual(screensFor('GET','directory-account-status'),['users']);
    assert.deepEqual(screensFor('POST','accounts/a/blocks'),['account-blocks']);
    assert.deepEqual(screensFor('DELETE','accounts/a/blocks/b'),['account-blocks']);
  });
  it('reads both working and published profiles without substituting a branch draft for live state',async()=>{
    const old=process.env.IAM_SCREEN_ACCESS;process.env.IAM_SCREEN_ACCESS='0';
    try{
      const calls:any[]=[];
      const users={list:async(ref?:string)=>{calls.push(ref??'working');return ref==='main'?[{id:'a',login_enabled:false,hasCredential:true}]:[{id:'a',login_enabled:true,hasCredential:true},{id:'draft',login_enabled:true,hasCredential:true}];}};
      const authn={blocks:{list:async(_t:string,id:string)=>id==='a'?[block]:[]}};
      const c=new DirectoryAccountStatusController(users as never,authn as never);
      (c as any).scope=async(_t:string,_s:string,_a:string,rows:any[])=>rows;
      const result=await c.list('acme-demo',{user:{sub:'admin'}});
      assert.deepEqual(calls,['working','main']);assert.equal(result.accounts.a.loginEnabled,false);assert.equal(result.accounts.draft.published,false);
      assert.equal(JSON.stringify(result).includes('Private reason'),false);
    }finally{if(old===undefined)delete process.env.IAM_SCREEN_ACCESS;else process.env.IAM_SCREEN_ACCESS=old;}
  });
  it('never returns hidden people or reference-only manager rows',async()=>{
    const reads:string[]=[];
    const users={list:async()=>[{id:'visible',login_enabled:true,hasCredential:true},{id:'hidden',login_enabled:true,hasCredential:true}]};
    const authn={blocks:{list:async(_t:string,id:string)=>{reads.push(id);return[];}}};
    const c=new DirectoryAccountStatusController(users as never,authn as never);
    (c as any).scope=async(_t:string,_s:string,_a:string,rows:any[])=>rows.filter(u=>u.id==='visible');
    const result=await c.list('acme-demo',{user:{sub:'manager'}});
    assert.deepEqual(Object.keys(result.accounts),['visible']);assert.deepEqual(reads,['visible']);
  });
});
