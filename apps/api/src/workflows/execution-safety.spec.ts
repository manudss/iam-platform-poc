import 'reflect-metadata';
import {describe,it,mock} from 'node:test';
import assert from 'node:assert/strict';
import {validateGraph,externalBlock} from './model.js';
import {loadPluginModule} from '../plugins/v1/loader.js';
const {createWorkflowEngine} = loadPluginModule('workflows-iga','engine.mjs') as any;
interface Step { run_id: string; node_id: string; status: string; simulated: boolean; attempts: number; error: string | null; log: string[]; input: unknown; output: Record<string, unknown> | null; started_at: string | null; finished_at: string | null }

function makeHarness(graphInput: unknown, run: Record<string, unknown> = {}, tweak?: (store: any, row: any) => void) {
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
    transitionRun: async (_id: string, patch: Record<string, unknown>, from: string[]) => { if (!from.includes(row.status as string)) return false; Object.assign(row, patch); return true; },
    runningRuns: async () => [],
    step: async (_r: string, nodeId: string) => steps.get(nodeId) ?? null,
    steps: async () => [...steps.values()],
    patchStep: async (_r: string, nodeId: string, patch: Record<string, unknown>) => { Object.assign(steps.get(nodeId)!, patch); },
  };
  if (tweak) tweak(store, row);
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

  it('a returned creation without provider receipt stays uncertain instead of clearing the marker',async()=>{
    const b=externalBlock('jira-create-issue')!;const stub=mock.method(b,'run',async()=>({}));
    try{const h=await settle(makeHarness({nodes:[node('a','jira-create-issue',{...config,executionMode:'real',connectionId:'conn-test',realConfirmed:true})],edges:[]}));assert.equal(h.row.status,'failed');assert.equal(st(h,'a').error,'EXTERNAL_EFFECT_REVIEW_REQUIRED');}finally{stub.mock.restore();}
  });

});
describe('run control: cancel versus concurrent kicks',()=>{
  it('a cancel recorded mid-pass survives a concurrent kick and ends the run; a late cancelFlag never crashes',async()=>{
    const h=makeHarness({nodes:[node('a','wait',{seconds:1}),node('b','wait',{seconds:0})],edges:[{from:'a',to:'b'}]});
    h.engine.kick('run-test');
    // wait for the pass to be truly in flight (step a running), then cancel AND kick concurrently
    for(let i=0;i<2000&&st(h,'a').status!=='running';i++) await new Promise((r)=>setImmediate(r));
    assert.equal(st(h,'a').status,'running','the pass is mid-flight');
    h.engine.cancelFlag('run-test');
    h.engine.kick('run-test'); // concurrent kick: must NOT erase the pending cancel (rekick only)
    const until=Date.now()+8000;
    for(;;){ if(['completed','failed','canceled'].includes(h.row.status as string)) break; if(Date.now()>until) throw new Error('did not settle'); await new Promise((r)=>setTimeout(r,20)); }
    assert.equal(h.row.status,'canceled','the cancel survives the concurrent kick');
    assert.notEqual(st(h,'b').status,'done','the walk stopped before the next step');
    h.engine.cancelFlag('run-test'); // no live entry held after the run ended: robust, no crash
    await new Promise((r)=>setTimeout(r,50));
    h.engine.kick('run-test'); // a terminal run is not re-executed and arms no stale flag
    await new Promise((r)=>setTimeout(r,100));
    assert.equal(h.row.status,'canceled');
    assert.notEqual(st(h,'b').status,'done');
  });
  it('a crash landing after a cancel never overwrites the canceled state (cancel/commit race)',async()=>{
    // CI race from the e2e suite: cancel commits while the pass is mid-flight; the pass's next meta write
    // then fails with a dolt serialization conflict. The late crash handler must keep the canceled state.
    const h=makeHarness({nodes:[node('a','wait',{seconds:0})],edges:[]},{},(store:any,row:any)=>{
      const patch=store.patchStep.bind(store);
      let armed=true;
      store.patchStep=async(r:string,n:string,p:Record<string,unknown>)=>{
        if(armed){armed=false;row.status='canceled';throw new Error('serialization failure: this transaction conflicts with a committed transaction from another client');}
        return patch(r,n,p);
      };
    });
    h.engine.kick('run-test');
    const until=Date.now()+4000;
    while(h.row.status!=='canceled'&&Date.now()<until) await new Promise((r)=>setTimeout(r,20));
    assert.equal(h.row.status,'canceled','the cancel landed mid-pass');
    await new Promise((r)=>setTimeout(r,300)); // let the crash handler settle
    assert.equal(h.row.status,'canceled','the late crash did not overwrite the canceled run');
    assert.equal(h.row.error,null,'no internal error recorded on a canceled run');
  });
  it('cancelFlag on a COMPLETED run arms nothing and never re-runs it',async()=>{
    const h=makeHarness({nodes:[node('a','wait',{seconds:0})],edges:[]});
    await settle(h);
    assert.equal(h.row.status,'completed');
    h.engine.cancelFlag('run-test');
    await new Promise((r)=>setTimeout(r,50));
    h.engine.kick('run-test');
    await new Promise((r)=>setTimeout(r,100));
    assert.equal(h.row.status,'completed','a finished run is never disturbed');
    assert.equal(st(h,'a').attempts,1,'no extra execution pass');
  });
});

describe('cancel flag lifecycle across a relaunch',()=>{
  it('a cancel parked on a waiting run does not re-cancel its retry; a cancel stamped after the relaunch claim still wins',async()=>{
    const h=makeHarness({nodes:[node('a','notify',{recipient:'x',message:'y'})],edges:[]},{status:'waiting'});
    // The cancel lands while no pass holds the live entry (the run was parked on a task): the flag stays in the map.
    h.engine.cancelFlag('run-test');
    await new Promise((r)=>setTimeout(r,50));
    h.row.status='canceled';
    // The retry claims the run, then clears only flags stamped BEFORE the claim.
    const claimedAt=Date.now();
    h.row.status='queued';
    h.engine.clearStaleCancel('run-test',claimedAt);
    await settle(h);
    assert.equal(h.row.status,'completed','the stale cancel flag must not kill the retried run');
    assert.equal(st(h,'a').status,'done');
    // A cancel stamped AFTER the claim is a fresh, concurrent cancellation: clearing with the old claim must keep it.
    h.row.status='queued';st(h,'a').status='pending';st(h,'a').output=null;
    h.engine.cancelFlag('run-test');
    await new Promise((r)=>setTimeout(r,50));
    h.engine.clearStaleCancel('run-test',claimedAt);
    await settle(h);
    assert.equal(h.row.status,'canceled','a fresh concurrent cancel still stops the run');
  });
});



describe('badge ticket then sheet trace recovery', () => {
  it('a failed trace cannot recreate the already persisted ticket on restart', async () => {
    let tickets = 0, writes = 0;
    const jira = mock.method(externalBlock('jira-create-issue')!, 'run', async () => { tickets++; return { key: 'KAN-99' }; });
    const sheet = mock.method(externalBlock('google-sheets-update')!, 'run', async () => { writes++; throw Error('sheet response lost'); });
    const real = { executionMode: 'real', connectionId: 'conn-test', realConfirmed: true };
    try {
      const h = await settle(makeHarness({ nodes: [node('ticket', 'jira-create-issue', { ...config, ...real }), node('trace', 'google-sheets-update', { source: 'google', spreadsheetId: 'fictional-sheet', sheetId: 7, keyColumn: 'email', keyValue: 'fiction@example.test', column: 'ticket', value: '{{steps.ticket.key}}', ...real })], edges: [{ from: 'ticket', to: 'trace' }] }));
      assert.equal(h.row.status, 'failed'); assert.equal(st(h, 'ticket').status, 'done');
      assert.equal(st(h, 'trace').error, 'External action failed; check connection and provider status.');
      // A cell set is repeatable. Requeue the failed step in the SAME run, not a new run.
      assert.equal(tickets, 1); assert.equal(writes, 1);
      sheet.mock.restore();
      const recovered = mock.method(externalBlock('google-sheets-update')!, 'run', async () => { writes++; return { updated: true }; });
      try { Object.assign(st(h, 'trace'), { status: 'pending', error: null }); h.row.status = 'queued'; await settle(h); assert.equal(h.row.status, 'completed'); assert.equal(tickets, 1); assert.equal(writes, 2); }
      finally { recovered.mock.restore(); }
    } finally { jira.mock.restore(); sheet.mock.restore(); }
  });
});

describe('Jira writes and Sheets column creation stop on uncertain external effects', () => {
  const real = { executionMode: 'real', connectionId: 'conn-test', realConfirmed: true };
  const cfgs: Record<string, object> = {
    'jira-update-issue': { project: 'KAN', issueKey: 'KAN-1', summary: 'Fictional update', ...real },
    'google-sheets-create-column': { source: 'google', spreadsheetId: 'fictional-sheet', sheetId: 1, columnName: 'receipt', ...real },
    'jira-add-comment': { project: 'KAN', issueKey: 'KAN-1', comment: 'hello', ...real },
    'jira-transition-issue': { project: 'KAN', issueKey: 'KAN-1', transitionId: '31', ...real },
  };
  for (const type of Object.keys(cfgs)) {
    it(`${type}: marker before the call, never re-run after an interruption`, async () => {
      let calls = 0;
      const stub = mock.method(externalBlock(type)!, 'run', async () => { calls++; throw Error('lost response'); });
      try {
        const h = await settle(makeHarness({ nodes: [node('a', type, cfgs[type])], edges: [] }));
        assert.equal(h.row.status, 'failed'); assert.equal(st(h, 'a').error, 'EXTERNAL_EFFECT_REVIEW_REQUIRED');
        h.row.status = 'queued'; await settle(h); assert.equal(calls, 1);
      } finally { stub.mock.restore(); }
    });
    it(`${type}: a result without provider receipt stays uncertain`, async () => {
      const stub = mock.method(externalBlock(type)!, 'run', async () => ({}));
      try {
        const h = await settle(makeHarness({ nodes: [node('a', type, cfgs[type])], edges: [] }));
        assert.equal(h.row.status, 'failed'); assert.equal(st(h, 'a').error, 'EXTERNAL_EFFECT_REVIEW_REQUIRED');
      } finally { stub.mock.restore(); }
    });
  }
  it('jira-get-issue is a read: no marker, completes', async () => {
    const stub = mock.method(externalBlock('jira-get-issue')!, 'run', async () => ({ key: 'KAN-1', status: 'Done' }));
    try {
      const h = await settle(makeHarness({ nodes: [node('a', 'jira-get-issue', { project: 'KAN', issueKey: 'KAN-1', ...real })], edges: [] }));
      assert.equal(h.row.status, 'completed'); assert.equal(st(h, 'a').error, null);
    } finally { stub.mock.restore(); }
  });
});


describe('candidate email initializer effect boundary (engine with block double)',()=>{
  const cfg={source:'google',spreadsheetId:'fictional',sheetId:0,email:'camille.martin@dss.name',nom:'Martin',prenom:'Camille',departement:'IT',role:'',executionMode:'real',connectionId:'conn-test',realConfirmed:true};
  it('a readonly refusal leaves no uncertain marker; an uncertain write blocks restart and error continuation',async()=>{
    const block=externalBlock('google-sheets-initialize-email')!;let calls=0;
    const stub=mock.method(block,'run',async(ctx:any)=>{calls++;if(calls===1)throw Error('precheck refused');await ctx.markEffectPending({kind:'sheet-email-initialization'});throw Error('lost write response');});
    try {
      const read=await settle(makeHarness({nodes:[node('a',block.type,cfg)],edges:[]}));assert.equal(read.row.status,'failed');assert.notEqual(st(read,'a').error,'EXTERNAL_EFFECT_REVIEW_REQUIRED');
      const write=await settle(makeHarness({nodes:[node('a',block.type,cfg),node('b','notify',{recipient:'x',message:'never continue'})],edges:[{from:'a',to:'b',label:'error'}]}));
      assert.equal(st(write,'a').error,'EXTERNAL_EFFECT_REVIEW_REQUIRED');assert.equal(st(write,'b').status,'skipped');write.row.status='queued';await settle(write);assert.equal(calls,2);
    }finally{stub.mock.restore();}
  });
  it('only initialized true can complete, including the already-initialized no-write path',async()=>{
    const block=externalBlock('google-sheets-initialize-email')!;
    for(const initialized of [false,true]){
      const stub=mock.method(block,'run',async(ctx:any)=>{if(!initialized)await ctx.markEffectPending({kind:'sheet-email-initialization'});return {email:cfg.email,initialized,written:false};});
      try{const h=await settle(makeHarness({nodes:[node('a',block.type,cfg)],edges:[]}));assert.equal(h.row.status,initialized?'completed':'failed');assert.equal(st(h,'a').error,initialized?null:'EXTERNAL_EFFECT_REVIEW_REQUIRED');}finally{stub.mock.restore();}
    }
  });
  it('test runs cannot initialize a source row even for a confirmed real graph',async()=>{
    const block=externalBlock('google-sheets-initialize-email')!;let called=false;
    const stub=mock.method(block,'run',async(ctx:any)=>{called=true;assert.equal(ctx.dryRun,true);return {initialized:false,written:false};});
    try{const h=await settle(makeHarness({nodes:[node('a',block.type,cfg)],edges:[]},{test:true}));assert.equal(h.row.status,'completed');assert.equal(h.reads,0);assert.ok(called);}finally{stub.mock.restore();}
  });
});
