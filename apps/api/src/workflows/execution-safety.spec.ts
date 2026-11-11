import 'reflect-metadata';
import {describe,it,mock} from 'node:test';
import assert from 'node:assert/strict';
import {validateGraph,externalBlock} from './model.js';
import {loadPluginModule} from '../plugins/v1/loader.js';
const {createWorkflowEngine} = loadPluginModule('workflows-iga','engine.mjs') as any;
interface Step { run_id: string; node_id: string; status: string; simulated: boolean; attempts: number; error: string | null; log: string[]; input: unknown; output: Record<string, unknown> | null; started_at: string | null; finished_at: string | null }

function makeHarness(graphInput: unknown, run: Record<string, unknown> = {}) {
  let hReads = 0;
  const { graph, order } = validateGraph(graphInput);
  const row = { id: 'run-test', tenant: 'acme-demo', definition_id: 'wf-def-test', name: 'test', graph, branch: null, base_branch: null, status: 'queued', error: null, started_by: 'tester', started_at: 'now', finished_at: null, ...run };
  const steps = new Map<string, Step>();
  for (const nodeId of order) {
    const n = graph.nodes.find((x: { id: string }) => x.id === nodeId)!;
    steps.set(nodeId, { run_id: row.id, node_id: nodeId, status: 'pending', simulated: true, attempts: 0, error: null, log: [], input: null, output: null, started_at: null, finished_at: null });
  }
  const store = {
    getRunById: async (id: string) => (id === row.id ? row : null),
    updateRun: async (id: string, patch: Record<string, unknown>) => { Object.assign(row, patch); },
    runningRuns: async () => [],
    step: async (_r: string, nodeId: string) => steps.get(nodeId) ?? null,
    steps: async () => [...steps.values()],
    patchStep: async (_r: string, nodeId: string, patch: Record<string, unknown>) => { Object.assign(steps.get(nodeId)!, patch); },
  };
  const deps = {
    store,
    versioning: {
      createBranch: async () => ({}),
      writeOn: async (_b: string, fn: (c: unknown) => Promise<unknown>) => fn({ query: async () => [ [] ] }),
      defaultBranch: 'main',
    },
    authorOf: (a: string) => a,
    branchRun: async (_b: string, fn: () => Promise<unknown>) => fn(),
    settingsFor: async () => ({}),
    connectionFor: async () => { hReads++; return { settings: {jiraEmail: "tester@example.invalid", jiraApiToken: "TEST-SECRET-VALUE"}, secret:"TEST-SECRET-VALUE" }; },
    log: { warn: () => {}, error: () => {} },
  };
  return { row, steps, engine: createWorkflowEngine(deps), get reads() { return hReads; } };
}

async function settle(h: ReturnType<typeof makeHarness>, timeoutMs = 8000) {
  h.engine.kick('run-test');
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (['completed', 'failed', 'canceled'].includes(h.row.status as string)) return h;
    if (Date.now() > until) throw new Error(`run did not settle (status ${h.row.status})`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

const node = (id: string, type: string, config: object = {}, name = id) => ({ id, type, name, config });
const st = (h: ReturnType<typeof makeHarness>, id: string) => h.steps.get(id)!;


const config = {project:'KAN',issueTypeId:'10001',summary:'Test issue'};
describe('external execution safety boundary',()=>{
  it('defaults to Simulation and does not resolve any connection or secret',async()=>{
    const b=externalBlock('jira-create-issue')!;let calls=0;
    const stub=mock.method(b,'run',async(ctx:any)=>{if(!ctx.dryRun)calls++;return {dryRun:ctx.dryRun};});
    try{const h=await settle(makeHarness({nodes:[node('a','jira-create-issue',config)],edges:[]}));assert.equal(h.row.status,'completed');assert.equal(h.reads,0);assert.equal(calls,0);assert.equal(st(h,'a').output?.dryRun,true);}finally{stub.mock.restore();}
  });
  it('forces editor tests to Simulation even when a submitted graph says confirmed Real',async()=>{
    const b=externalBlock('jira-create-issue')!;let calls=0;
    const stub=mock.method(b,'run',async(ctx:any)=>{if(!ctx.dryRun)calls++;return {dryRun:ctx.dryRun};});
    try{const h=await settle(makeHarness({nodes:[node('a','jira-create-issue',{...config,executionMode:'real',connectionId:'conn-test',realConfirmed:true})],edges:[]},{test:true}));assert.equal(h.row.status,'completed');assert.equal(h.reads,0);assert.equal(calls,0);}finally{stub.mock.restore();}
  });
  it('requires connection plus explicit Real confirmation at server validation',()=>{
    for(const c of [{executionMode:'real'},{executionMode:'real',connectionId:'conn-test'},{executionMode:'real',connectionId:'../bad',realConfirmed:true}])assert.throws(()=>validateGraph({nodes:[node('a','jira-create-issue',{...config,...c})],edges:[]}));
  });
  it('persists an uncertainty marker before the call; errors cannot take an error route or disclose credentials',async()=>{
    const b=externalBlock('jira-create-issue')!;let calls=0;
    const stub=mock.method(b,'run',async(ctx:any)=>{calls++;ctx.log('token TEST-SECRET-VALUE');throw Error('remote body TEST-SECRET-VALUE');});
    try{const h=await settle(makeHarness({nodes:[node('a','jira-create-issue',{...config,executionMode:'real',connectionId:'conn-test',realConfirmed:true}),node('b','notify',{recipient:'hr',message:'unsafe to continue'})],edges:[{from:'a',to:'b',label:'error'}]}));assert.equal(h.row.status,'failed');assert.equal(calls,1);assert.equal(st(h,'a').error,'EXTERNAL_EFFECT_REVIEW_REQUIRED');assert.equal(st(h,'b').status,'skipped');assert.equal(JSON.stringify([...h.steps.values()]).includes('TEST-SECRET-VALUE'),false);
    // Same persisted interrupted/error state on restart: not called again.
    h.row.status='queued';await settle(h);assert.equal(calls,1);assert.equal(h.row.status,'failed');}finally{stub.mock.restore();}
  });
  it('clears the uncertainty marker only once done + redacted output are persisted',async()=>{
    const b=externalBlock('jira-create-issue')!;
    const stub=mock.method(b,'run',async(ctx:any)=>{assert.equal(ctx.dryRun,false);assert.equal(ctx.config.dryRun,false);return {key:'TEST-1',echo:ctx.settings.jiraApiToken};});
    try{const h=await settle(makeHarness({nodes:[node('a','jira-create-issue',{...config,executionMode:'real',connectionId:'conn-test',realConfirmed:true})],edges:[]}));assert.equal(h.row.status,'completed');assert.equal(st(h,'a').error,null);assert.equal(st(h,'a').output?.echo,'[redacted]');}finally{stub.mock.restore();}
  });
  it('an uncertain creation inside a loop cannot escape through the loop error route',async()=>{
    const b=externalBlock('jira-create-issue')!; let calls=0;const stub=mock.method(b,'run',async()=>{calls++;throw Error('lost response');});
    try {const h=await settle(makeHarness({nodes:[node('loop','loop',{items:'[1,2]',maxItems:2}),node('a','jira-create-issue',{...config,executionMode:'real',connectionId:'conn-test',realConfirmed:true}),node('end','notify',{recipient:'hr',message:'must not continue'})],edges:[{from:'loop',to:'a',label:'each'},{from:'loop',to:'end',label:'error'}]}));assert.equal(h.row.status,'failed');assert.equal(calls,1);assert.equal(st(h,'loop').error,'EXTERNAL_EFFECT_REVIEW_REQUIRED');assert.notEqual(st(h,'end').status,'done');} finally {stub.mock.restore();}
  });

});
