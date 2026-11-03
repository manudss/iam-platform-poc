import 'reflect-metadata';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { MainPublication } from './main-publication.js';
const HEAD='0123456789abcdef';
function setup({ sod=false, constraints=false, current='', state='applied' } = {}) {
  const calls: string[]=[]; const prs: { mainPublisher?: (...args: any[])=>Promise<unknown> }={};
  const v={branches:async()=>({branches:[{name:'main',commit:HEAD},{name:'work',commit:HEAD}]}),at:async(_r:string,f:any)=>f({query:async(q:string)=>[q.includes('constraint')?(constraints?[{violations:1}]:[]):(sod?[{}]:[])]})};
  const activation={applyEnabled:true,activate:async(_t:string,h:string)=>{calls.push(h);return {state};}};
  const registries={drop:()=>{},get:async()=>{calls.push('registry');}};
  const modules={get:()=>({apply:async()=>({applied:true,commit:HEAD})})};
  const service=new MainPublication(v as never,prs as never,activation as never,registries as never,modules as never);
  process.env.IAM_CORE_URL='http://core'; delete process.env.IAM_AUTO_ACTIVATE_MAIN;
  const original=globalThis.fetch;
  globalThis.fetch=(async()=>({ok:!!current,status:current?200:404,json:async()=>({commit:current})})) as any;
  return {service,calls,prs,restore:()=>{globalThis.fetch=original;delete process.env.IAM_AUTO_ACTIVATE_MAIN;}};
}
it('startup activates checked main by default',async()=>{const t=setup();try{await t.service.start();assert.deepEqual(t.calls,['registry',HEAD]);}finally{t.restore();}});
it('startup skips an already live main',async()=>{const t=setup({current:HEAD});try{await t.service.start();assert.deepEqual(t.calls,['registry']);}finally{t.restore();}});
it('startup option can be disabled',async()=>{const t=setup();try{process.env.IAM_AUTO_ACTIVATE_MAIN='0';await t.service.start();assert.deepEqual(t.calls,[]);}finally{t.restore();}});
for(const k of ['sod','constraints'])it(`startup fails closed on ${k}`,async()=>{const t=setup({[k]:true});try{await assert.rejects(t.service.start(),/refused/);assert.deepEqual(t.calls,[]);}finally{t.restore();}});
it('startup activation failure stops readiness',async()=>{const t=setup({state:'failed'});try{await assert.rejects(t.service.start(),/activation failed/);}finally{t.restore();}});
it('human PR publication delegates to Apply',async()=>{const t=setup();try{t.service.onModuleInit();assert.deepEqual(await t.prs.mainPublisher!('acme-demo','work','demo-alice'),{commit:HEAD});}finally{t.restore();}});
