import{test}from'node:test';import assert from'node:assert/strict';import{inspectProduction}from'./render-prod-state.mjs';
test('read-only exact-service metadata excludes secrets and unrelated services',async()=>{
 const calls=[];const result=await inspectProduction({key:'synthetic-test-secret',fetcher:async(url,options)=>{
 calls.push({url,options});assert.equal(options.method,'GET');
 return{ok:true,json:async()=>url.includes('/deploys?')?[{deploy:{status:'live'}},{deploy:{status:'queued',secret:'never-output'}}]:[{service:{id:'synthetic-id',name:'iam-poc',envVars:['never-output'],deployHook:'never-output',repo:'https://github.com/manudss/iam-platform-poc',branch:'main',autoDeploy:'no',serviceDetails:{runtime:'image'},image:{imagePath:'ghcr.io/manudss/iam-platform-poc:latest'}}}]};
 }});assert.equal(result.runtime,'image');assert.deepEqual(result.activeDeployments,[{status:'queued'}]);assert.doesNotMatch(JSON.stringify(result),/never-output|synthetic-id|synthetic-test-secret/);assert.equal(calls.length,2);
});
test('absent exact service is UNKNOWN, never scans all services',async()=>{
 let n=0;await assert.rejects(inspectProduction({key:'fake',fetcher:async()=>{n++;return{ok:true,json:async()=>[]}}}),/UNKNOWN/);assert.equal(n,1);
});
