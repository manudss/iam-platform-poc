import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceController } from './workspace.controller.js';
import { branchContext } from './context.js';
function setup(unknown = '') {
 process.env.IAM_WORKSPACE_MODE='1';
 const queries: {sql:string;args:unknown[]}[]=[];
 const c={query:async(sql:string,args:unknown[]=[])=>{queries.push({sql,args});return sql.startsWith('select (select')?[[{i:args[0]===unknown?0:1,r:1}]]:sql==='select * from dolt_status'?[[{table_name:'assignments'}]]:[[]];}};
 const v={writeOn:async(branch:string,fn:(c:unknown)=>unknown)=>{assert.equal(branch,'work');return fn(c);}};
 const controller=new WorkspaceController(v as never,{} as never,{} as never,{} as never,{} as never);
 const run=(ops:any)=>branchContext.run({branch:'work'},()=>controller.assignments({ops}));
 return {controller,queries,run};
}
describe('workspace assignment staging',()=>{
 it('validates every entry before writing a mixed bulk batch',async()=>{const t=setup('missing');await assert.rejects(t.run([{identity:'demo-alice',role:'employee',assigned:true},{identity:'missing',role:'employee',assigned:false}]),/unknown identity/);assert.equal(t.queries.some(q=>q.sql.startsWith('insert')||q.sql.startsWith('delete')),false);});
 it('adds and removes with parameterized SQL and one assignment commit',async()=>{const t=setup();const r=await t.run([{identity:'demo-alice',role:'employee',assigned:true},{identity:'demo-bob',role:'employee',assigned:false}]);assert.equal(r.staged,true);assert.deepEqual(t.queries.find(q=>q.sql.startsWith('delete'))?.args,['demo-bob','employee']);assert.equal(t.queries.filter(q=>q.sql.startsWith('call dolt_commit')).length,1);});
 it('rejects malformed flags, identifiers, empty and oversized requests',async()=>{const t=setup();for(const ops of [[],Array(1001).fill({}),[{identity:'alice',role:'employee',assigned:'false'}],[{identity:123,role:'employee',assigned:true}],[{identity:"a'",role:'employee',assigned:true}]])await assert.rejects(t.run(ops));assert.equal(t.queries.length,0);});
 it('refuses main before any write',async()=>{const t=setup();process.env.IAM_WORKSPACE_MODE='1';await assert.rejects(branchContext.run({branch:'main'},()=>t.controller.unassignment({identity:'demo-alice',role:'employee'})),/read.only|working branch/i);assert.equal(t.queries.length,0);});
});
