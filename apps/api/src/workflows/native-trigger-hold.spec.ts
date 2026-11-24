import {it} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
it('startup HOLD blocks native scheduler timer, tick and webhook before store/provider access',()=>{
 const url=new URL('./activepieces-sheets.js',import.meta.url).href;
 const result=spawnSync(process.execPath,['--input-type=module','-e',`
 import assert from 'node:assert/strict';
 const {ActivepiecesSheetsService}=await import(${JSON.stringify(url)});
 const {releaseDataReady}=await import(${JSON.stringify(new URL('../migrations/readiness.js',import.meta.url).href)});
 releaseDataReady();
 const calls=[];const blocked=new Proxy({}, {get:(_,k)=>{calls.push(String(k));throw Error('unexpected access');}});
 globalThis.fetch=async()=>{calls.push('fetch');throw Error('unexpected provider');};
 const service=new ActivepiecesSheetsService(blocked,blocked,blocked,blocked,blocked);
 service.onModuleInit();assert.equal(service.timer,undefined);
 await service.tick();await assert.rejects(()=>service.webhook('t','d','token',{},{}),e=>e.getStatus?.()===503);
 assert.deepEqual(calls,[]);service.onModuleDestroy();
 `],{env:{...process.env,IAM_AUTOMATION_HOLD:'1'},encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stdout+result.stderr);
});
