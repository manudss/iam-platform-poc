import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspacePublisher, workflowActor } from '../workspace/workspace-publisher.js';
import { WorkflowEngine } from './engine.js';
import { externalBlock } from './model.js';
import { branchContext } from '../workspace/context.js';
import { SECURITY_SETTING_KEYS } from '../accounts/security-config.js';

// Stubs only: no Dolt, no activation, no network.
const HEAD = 'aaaaaaaaaaaa1111', MAIN0 = 'bbbbbbbbbbbb2222', MAIN1 = 'cccccccccccc3333';
function setup(o: { diffTables?: string[]; diffRows?: unknown[]; invalidSummary?: boolean; diffFails?: boolean; branchHead?: string; selfMerge?: boolean; activationState?: string; applyEnabled?: boolean; mergedCommit?: string; mainAfter?: string } = {}) {
  const calls: { merge: number; activate: number; maxParallel: number; parallel: number; actors: string[]; messages: string[] } = { merge: 0, activate: 0, maxParallel: 0, parallel: 0, actors: [], messages: [] };
  let main = MAIN0; const head = { v: o.branchHead ?? HEAD };
  const v = {
    defaultBranch: 'main',
    branches: async () => ({ branches: [{ name: 'main', commit: main }, { name: 'workflow/abc', commit: head.v }] }),
    diffSummary: async () => { if (o.diffFails) throw new Error('diff failed'); return o.invalidSummary ? {} : { tables: o.diffRows ?? (o.diffTables ?? ['identities']).map((table) => ({ table, from: table })) };},
    mergeInto: async (_s: string, _t: string, message: string, actor: string) => { calls.parallel++; calls.maxParallel = Math.max(calls.maxParallel, calls.parallel); calls.merge++; calls.actors.push(actor); calls.messages.push(message); await new Promise((r) => setTimeout(r, 10)); main = o.mainAfter ?? MAIN1; calls.parallel--; return { mergeable: true, commit: o.mergedCommit ?? MAIN1, reasons: [], violations: [] }; },
  };
  const state = o.activationState ?? 'applied';
  const activation = { applyEnabled: o.applyEnabled ?? true, current: async () => ({ state, commit: main, requestId: `workspace-${main}` }), activate: async (_t: string, commit: string) => { calls.activate++; return { state, commit }; } };
  const registries = { drop: () => undefined, get: async () => ({}) };
  const protection = { effective: () => ({ protected: o.selfMerge === false, selfMerge: o.selfMerge !== false }) };
  const pub = new WorkspacePublisher(v as never, registries as never, activation as never, undefined, protection as never);
  return { pub, calls, head };
}
const A = { tenant: 'acme-demo', runId: 'run-1', workflowId: 'wf-badge', branch: 'workflow/abc', expectedHead: HEAD };
const run = async <T>(fn: () => Promise<T>) => { process.env.IAM_WORKSPACE_MODE = '1'; return branchContext.run({ branch: 'workflow/abc' }, fn); };

describe('workflow publication: WorkspacePublisher.publishForRun', () => {
  it('read-only preflight checks workspace mode, live-engine configuration and self-merge without any merge or activation', () => {
    const prior = process.env.IAM_WORKSPACE_MODE;
    try {
      process.env.IAM_WORKSPACE_MODE = '0'; const off = setup(); assert.throws(() => off.pub.preflightForRun(), /workspace mode/); assert.equal(off.calls.merge, 0);
      process.env.IAM_WORKSPACE_MODE = '1'; const disabled = setup({ applyEnabled: false }); assert.throws(() => disabled.pub.preflightForRun(), /live permission engine/); assert.equal(disabled.calls.activate, 0);
      const protectedMain = setup({ selfMerge: false }); assert.throws(() => protectedMain.pub.preflightForRun(), /self-merge/); assert.equal(protectedMain.calls.merge, 0);
      const ready = setup(); assert.doesNotThrow(() => ready.pub.preflightForRun()); assert.equal(ready.calls.merge, 0); assert.equal(ready.calls.activate, 0);
    } finally { if (prior === undefined) delete process.env.IAM_WORKSPACE_MODE; else process.env.IAM_WORKSPACE_MODE = prior; }
  });
  it('publishes, reads the real state back, and uses a short reserved actor with run, workflow and head in the message', async () => {
    const t = setup(); const r = await run(() => t.pub.publishForRun(A));
    assert.deepEqual(r, { published: true, branch: 'workflow/abc', sourceHead: HEAD, mainCommit: MAIN1, activation: 'applied', tables: ['identities'] });
    assert.equal(t.calls.merge, 1); assert.equal(t.calls.activate, 1);
    assert.match(t.calls.actors[0], /^wf-[0-9a-f]{10}$/); assert.ok(!t.calls.actors[0].includes(':'));
    assert.match(t.calls.messages[0], /run-1/); assert.match(t.calls.messages[0], /wf-badge/); assert.match(t.calls.messages[0], /aaaaaaaaaaaa/);
  });
  it('refuses main, a missing or malformed head, a moved branch: no merge, no activation', async () => {
    for (const [name, over, re] of [['main', { branch: 'main' }, /never main/], ['no head', { expectedHead: '' }, /expectedHead is required/], ['odd head', { expectedHead: 'x y' }, /expectedHead is required/], ['no workflow', { workflowId: '' }, /workflow identity/]] as const) {
      const t = setup(); await assert.rejects(() => run(() => t.pub.publishForRun({ ...A, ...over })), re, name); assert.equal(t.calls.merge, 0, name);
    }
    const moved = setup({ branchHead: 'dddddddddddd4444' });
    await assert.rejects(() => run(() => moved.pub.publishForRun(A)), /moved since the run recorded its head/); assert.equal(moved.calls.merge, 0); assert.equal(moved.calls.activate, 0);
  });
  it('refuses when main is protected without self-merge (no separate reviewer exists for a workflow)', async () => {
    const t = setup({ selfMerge: false }); await assert.rejects(() => run(() => t.pub.publishForRun(A)), /self-merge/); assert.equal(t.calls.merge, 0);
  });
  it('a failed activation or a main that does not match the activated commit is never reported as published', async () => {
    const failed = setup({ activationState: 'failed' }); await assert.rejects(() => run(() => failed.pub.publishForRun(A)));
    const odd = setup({ mainAfter: 'eeeeeeeeeeee5555' }); await assert.rejects(() => run(() => odd.pub.publishForRun(A)), /not confirmed by the real state/);
  });
  it('two publications at once are serialized: one merge at a time', async () => {
    const t = setup(); await Promise.allSettled([run(() => t.pub.publishForRun(A)), run(() => t.pub.publishForRun({ ...A, runId: 'run-2' }))]);
    assert.equal(t.calls.maxParallel, 1);
  });
  it('refuses a branch that changes the publication settings, and an unreadable diff: nothing merged', async () => {
    const t = setup({ diffTables: ['identities', 'plugin_runtime_settings'] });
    await assert.rejects(() => run(() => t.pub.publishForRun(A)), /plugin_runtime_settings/); assert.equal(t.calls.merge, 0);
    const u = setup({ diffFails: true }); await assert.rejects(() => run(() => u.pub.publishForRun(A)), /could not be read/); assert.equal(u.calls.merge, 0);
  });
  it('both rename sides and removed tables are forbidden, while malformed or legacy-name-only summaries fail closed', async () => {
    for (const row of [{table:'renamed_settings',from:'plugin_runtime_settings'}, {table:'plugin_runtime_settings',from:'other_settings'}, {table:'',from:'plugin_runtime_settings'}, {table:'PLUGIN_RUNTIME_SETTINGS',from:null}]) {
      const t=setup({diffRows:[row]}); await assert.rejects(()=>run(()=>t.pub.publishForRun(A)),/plugin_runtime_settings/i); assert.equal(t.calls.merge,0); assert.equal(t.calls.activate,0);
    }
    for (const row of [{name:'plugin_runtime_settings'}, {}, {table:7}, {table:null,from:null}, 'identities']) {
      const t=setup({diffRows:[row]}); await assert.rejects(()=>run(()=>t.pub.publishForRun(A)),/could not be read/); assert.equal(t.calls.merge,0);
    }
    const missing=setup({invalidSummary:true}); await assert.rejects(()=>run(()=>missing.pub.publishForRun(A)),/could not be read/); assert.equal(missing.calls.merge,0);
  });
  it('a human Apply can never carry the reserved workflow identity prefix', async () => {
    const t = setup();
    for (const actor of ['wf-0123456789', 'WF-abc', 'wf-']) await assert.rejects(() => run(() => t.pub.publish('acme-demo', 'workflow/abc', actor, { confirm: true, expectedHead: HEAD })), /reserved for workflow publication/, actor);
    assert.equal(t.calls.merge, 0);
  });
  it('a pending publication is keyed by branch AND head: a retry of the same head does not merge twice, a moved head is a new publication', async () => {
    const t = setup({ activationState: 'failed' });
    const a = () => run(() => t.pub.publish('acme-demo', 'workflow/abc', 'alice', { confirm: true, expectedHead: t.head.v }));
    const r1: any = await a(); assert.equal(r1.retryRequired, true); assert.equal(t.calls.merge, 1);
    await a(); assert.equal(t.calls.merge, 1, 'same head: resumes the activation only');
    t.head.v = 'ffffffffffff6666'; await a(); assert.equal(t.calls.merge, 2, 'moved head: merged again, never the old pending commit');
  });
  it('workflowActor is stable, has no colon, and two ids never share it', () => {
    assert.equal(workflowActor('wf-a'), workflowActor('wf-a')); assert.notEqual(workflowActor('wf-a'), workflowActor('wf-b'));
    assert.ok(!workflowActor('wf:with:colons').includes(':')); assert.ok(workflowActor('x'.repeat(500)).length < 20);
  });
});

describe('workflow publication: the server gate and the block', () => {
  const engineWith = (allowed: unknown, throwRead = false) => {
    const t = setup(); const published: unknown[] = [];
    const pub = { preflightForRun: () => undefined, publishForRun: async (a: unknown) => { published.push(a); return { published: true, branch: 'b', sourceHead: HEAD, mainCommit: MAIN1, activation: 'applied' }; } };
    const v = { defaultBranch: 'main', branches: async () => ({ branches: [] }), createBranch: async () => undefined, writeOn: async () => undefined, deleteBranch: async () => undefined };
    const e: any = new WorkflowEngine({} as never, v as never, {} as never, undefined, undefined, undefined, undefined, pub as never);
    e.settingsFor = async () => { if (throwRead) throw new Error('unreadable'); return allowed === undefined ? {} : { publishAllowedWorkflows: allowed }; };
    return { effects: e.deps.workspace, published, t };
  };
  const call = (w: ReturnType<typeof engineWith>, id = 'wf-badge') => w.effects.publish('acme-demo', { runId: 'run-1', workflowId: id, branch: 'workflow/abc', expectedHead: HEAD });
  it('absent, empty, unreadable, partial or prefix matches refuse before any publication', async () => {
    for (const [name, w] of [['absent', engineWith(undefined)], ['empty', engineWith('')], ['unreadable', engineWith('wf-badge', true)], ['other', engineWith('wf-other')], ['prefix', engineWith('wf-bad')], ['superstring', engineWith('wf-badge-2')], ['array', engineWith(['wf-badge'])], ['number', engineWith(7)]] as const) {
      await assert.rejects(() => call(w), /not authorized|cannot be read/, name); assert.equal(w.published.length, 0, name);
    }
  });
  it('read-only preflight applies the same exact main authorization and does not publish', async () => {
    const yes = engineWith('wf-badge'); await yes.effects.preflight('acme-demo', { workflowId: 'wf-badge' }); assert.equal(yes.published.length, 0);
    for (const value of [undefined, '', ['wf-badge'], 7, 'wf-other']) {
      const no = engineWith(value); await assert.rejects(() => no.effects.preflight('acme-demo', { workflowId: 'wf-badge' }), /not authorized|cannot be read/); assert.equal(no.published.length, 0);
    }
  });
  it('an exactly listed workflow id passes (several ids, spaces tolerated)', async () => {
    const w = engineWith(' wf-other , wf-badge '); const r = await call(w); assert.equal(r.published, true); assert.equal(w.published.length, 1);
  });
  it('the block is registered, publishes nothing in a test run, and refuses without a branch or without the server effect', async () => {
    const b: any = externalBlock('lyam-publish-workspace'); assert.ok(b); assert.equal(b.family, 'lyam');
    const lines: string[] = [];
    assert.deepEqual(await b.run({ test: true, log: (l: string) => lines.push(l) }), { published: false }); assert.ok(lines[0].includes('nothing published'));
    await assert.rejects(() => b.run({ log: () => undefined }), /not available on this server/);
    await assert.rejects(() => b.run({ workspace: {}, hasRunBranch: false, log: () => undefined }), /no working branch/);
  });
  it('the block returns published only from a confirmed result', async () => {
    const b: any = externalBlock('lyam-publish-workspace');
    const ok = await b.run({ workspace: { publish: async () => ({ published: true, branch: 'b', sourceHead: HEAD, mainCommit: MAIN1, activation: 'applied' }) }, hasRunBranch: true, publishIntent: { branch: 'b', head: HEAD }, workflowId: 'wf-badge', tenant: 't', runId: 'r', log: () => undefined });
    assert.deepEqual(ok, { published: true, mainCommit: MAIN1, sourceHead: HEAD });
    await assert.rejects(() => b.run({ workspace: { publish: async () => ({ published: false }) }, hasRunBranch: true, publishIntent: { branch: 'b', head: HEAD }, workflowId: 'w', tenant: 't', runId: 'r', log: () => undefined }), /not confirmed/);
  });
  it('ticket peek is read-only, tenant-bound and available only to an open link or its current claimant', async () => {
    let row: any = { status:'open', account:'fictional', phase1_run:'run-one', source:'google', spreadsheet_id:'sheet', sheet_id:0, key_column:'email', key_value:'fictional@example.invalid' };
    const reads:unknown[]=[];let writes=0;
    const effects=(WorkflowEngine.prototype as any).linkEffects({getTicketLink:async(k:unknown)=>{reads.push(k);return row;},claimTicketLink:async()=>{writes++;return row;}});
    const key={connectionId:'fixture-jira',project:'FIX',issueKey:'FIX-1'};
    assert.equal((await effects.peek('fixture-tenant',key,'run-two')).account,'fictional');assert.deepEqual(reads[0],{tenant:'fixture-tenant',...key});assert.equal(writes,0);
    row={...row,status:'claimed',claimed_run:'run-two'};assert.ok(await effects.peek('fixture-tenant',key,'run-two'));assert.equal(await effects.peek('fixture-tenant',key,'another-run'),null);
    row={...row,status:'done'};assert.equal(await effects.peek('fixture-tenant',key,'run-two'),null);row=null;assert.equal(await effects.peek('fixture-tenant',key,'run-two'),null);assert.equal(writes,0);
  });
  it('the security-setting block can change no publication setting: its keys are the security ones only', () => {
    for (const k of SECURITY_SETTING_KEYS) assert.doesNotMatch(k, /publish|allowed|workflow/i, k);
  });
});
