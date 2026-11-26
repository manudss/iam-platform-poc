import 'reflect-metadata';
import {describe,it} from 'node:test';
import assert from 'node:assert/strict';

const BASE='https://api.atlassian.com/ex/jira/9963bb3b-629b-4729-b37a-c71e6fc94882';
const metadata={fields:[{fieldId:'summary',key:'summary',name:'Summary',schema:{type:'string'}},{fieldId:'description',key:'description',name:'Description',schema:{type:'string',system:'description'}},{fieldId:'labels',key:'labels',name:'Labels',schema:{type:'array',items:'string'}}]};
let failAfterCreate=false; let calls:{method:string;path:string;body:any}[]=[];
 globalThis.fetch=(async(url:any,opts:any)=>{const u=new URL(String(url));const method=opts?.method??'GET';const body=JSON.parse(opts?.body??'{}');calls.push({method,path:u.pathname,body});
 let data:any={};let status=200;
 if(u.pathname.endsWith('/project/KAN'))data={id:'10000',key:'KAN'};
 else if(u.pathname.includes('/createmeta/'))data=metadata;
 else if(method==='POST'){data={id:'111',key:'KAN-7'};status=201;}
 else if(failAfterCreate){status=503;data={errorMessages:['fixture read failed']};}
 else data={id:'111',key:'KAN-7',fields:{summary:'Fixture',labels:['badge-demo']}};
 return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
 }) as typeof fetch;
async function fixture(fail=false){
 failAfterCreate=fail; calls=[];
 const {externalBlock}=await import('./model.js');
 const b=externalBlock('jira-create-issue')!;
 {
 const invoke=()=>b.run({config:b.validate({project:'KAN',issueTypeId:'10003',summary:'Fixture',description:'Fixture description',labels:'badge-demo',dryRun:false}),settings:{jiraInstanceUrl:BASE,jiraEmail:'fictional@example.invalid',jiraApiToken:'FICTIONAL'},log:()=>{}} as any);
 if(failAfterCreate)await assert.rejects(invoke);else assert.equal((await invoke())?.key,'KAN-7');
 const writes=calls.filter(c=>c.method==='POST');assert.equal(writes.length,1);assert.deepEqual(writes[0].body.fields.project,{id:'10000'});assert.equal(writes[0].body.fields.summary,'Fixture');assert.equal(writes[0].body.fields.description.type,'doc');assert.deepEqual(writes[0].body.fields.labels,['badge-demo']);assert.ok(calls[0].path.endsWith('/project/KAN'));
 }
}
describe('legacy Jira create block with real pinned native action and mock HTTP transport',()=>{
 it('resolves project key before supplying numeric ID to native create',()=>fixture());
 it('201 followed by read failure throws, with exactly one creation and no retry',()=>fixture(true));
});
