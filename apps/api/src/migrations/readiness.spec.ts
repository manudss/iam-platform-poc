import {it} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
it('durable application event handlers wait for migration/publication readiness, without a no-bus bypass',()=>{
 const program=`
  import assert from 'node:assert/strict';
  import {ApplicationBus} from './dist/events/application-bus.service.js';
  import {dataReady,releaseDataReady} from './dist/migrations/readiness.js';
  const bus=new ApplicationBus();let handler,calls=0;
  assert.equal(dataReady(),false);
  bus.consumeOnBus('workflow',['user.created'],()=>{calls++;});
  bus.attachBus(()=>{},async(_a,_k,h)=>{handler=h;});await bus.ready();
  const delivered=handler({kind:'user.created',tenant:'acme-demo',payload:{subject:'test'}});
  await new Promise(r=>setTimeout(r,15));assert.equal(calls,0);
  releaseDataReady();await delivered;assert.equal(calls,1);assert.equal(dataReady(),true);
  const absent=new ApplicationBus();assert.throws(()=>absent.emit({type:'user.created',tenant:'t',branch:'main',payload:{},at:''}),/bus required/);
 `;
 const r=spawnSync(process.execPath,['--input-type=module','-e',program],{env:{...process.env,IAM_DATA_MIGRATIONS:'1'},encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
});
