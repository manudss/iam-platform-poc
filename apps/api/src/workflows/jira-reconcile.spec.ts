import 'reflect-metadata';
import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {WorkflowsService} from './workflows.service.js';
const uncertain='EXTERNAL_EFFECT_REVIEW_REQUIRED';
function setup(){const r:any={id:'run-fixture',tenant:'acme',test:false,status:'failed',base_branch:'main',graph:{nodes:[{id:'ticket',type:'jira-create-issue',name:'Ticket',config:{}}],edges:[]}};
 const st:any={node_id:'ticket',status:'failed',error:uncertain,input:{project:'KAN',issueTypeId:'10003',summary:'Fixture',labels:['badge-demo'],connectionId:'conn-fixture'}};const audit:any[]=[];
 const store:any={liveRef:'main',getRun:async()=>r,steps:async()=>[st],reconcileJiraStep:async(...args:any[])=>audit.push(args)};
 const svc=new WorkflowsService(store,{} as any,{} as any,{} as any,undefined,undefined,{resolve:async()=>({settings:{jiraInstanceUrl:'https://team.atlassian.net',jiraEmail:'fictional@example.invalid',jiraApiToken:'FICTIONAL'}})} as any);
 svc.runView=async()=>({run:r,steps:[st]});return {r,st,svc,audit};}
const evidence={confirm:true,evidence:'Provider project search checked all results at fixture time.',outcome:'not-created'};
describe('explicit Jira-create reconciliation',()=>{
 it('records non-created evidence and does not queue, kick, recreate or reset earlier steps',async()=>{const h=setup();await h.svc.reconcileJira('acme','run-fixture','ticket',evidence,'admin');assert.equal(h.audit.length,1);assert.equal(h.audit[0][3].actor,'admin');assert.equal(h.audit[0][3].outcome,'not-created');assert.equal(h.audit[0][4],null);assert.equal(h.r.status,'failed');});
 it('refuses missing confirmation/evidence, wrong node, live or test runs',async()=>{for(const mode of ['confirm','evidence','node','status','test']){const h=setup();const b:any={...evidence};if(mode==='confirm')b.confirm=false;if(mode==='evidence')b.evidence='short';if(mode==='status')h.r.status='running';if(mode==='test')h.r.test=true;await assert.rejects(()=>h.svc.reconcileJira('acme','run-fixture',mode==='node'?'other':'ticket',b,'admin'));assert.equal(h.audit.length,0);}});
 it('accepts an existing ticket only after server readback matches project, type, summary and labels',async()=>{const old=fetch;try{for(const match of [false,true]){const h=setup();globalThis.fetch=(async()=>new Response(JSON.stringify({key:'KAN-7',fields:{project:{key:'KAN'},issuetype:{id:'10003'},summary:match?'Fixture':'Other',labels:['badge-demo']}}),{status:200})) as typeof fetch;const fn=()=>h.svc.reconcileJira('acme','run-fixture','ticket',{...evidence,outcome:'created',issueKey:'KAN-7'},'admin');if(match){await fn();assert.deepEqual(h.audit[0][4],{key:'KAN-7',url:null});}else{await assert.rejects(fn);assert.equal(h.audit.length,0);}}}finally{globalThis.fetch=old;}});
});

import {WorkflowStore} from './store.js';
describe('reconciliation store atomic settlement',()=>{
 it('writes decision and settlement together, then refuses a second settlement',async()=>{
  const s:any=new WorkflowStore();let row:any={status:'failed',error:uncertain,log:['original']};let commits=0,rollbacks=0;
  s.meta=async()=>({beginTransaction:async()=>{},commit:async()=>{commits++;},rollback:async()=>{rollbacks++;},end:async()=>{},query:async(sql:string,values:any[])=>{
   if(sql.includes('from workflow_runs'))return [[{status:'failed'}]];
   if(sql.includes('select status,error,log'))return [[row]];
   if(sql.startsWith('update workflow_steps')){row={status:values[0],error:values[1],output:values[2],log:JSON.parse(values[3])};return [{}];}throw Error('unexpected query');}});
  const decision={actor:'admin',outcome:'not-created',evidence:'Full provider check at fixture time',at:'fixture'};
  await s.reconcileJiraStep('acme','run-fixture','ticket',decision,null);
  assert.equal(commits,1);assert.equal(row.error,'JIRA_EFFECT_CONFIRMED_NOT_CREATED');assert.equal(row.log[0],'original');assert.ok(row.log[1].includes('"actor":"admin"'));
  await assert.rejects(()=>s.reconcileJiraStep('acme','run-fixture','ticket',decision,null));assert.equal(commits,1);assert.equal(rollbacks,1);
 });
});
