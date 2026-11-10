import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Unit tests of the branching engine (if/switch/loop/merge + error links) with an in-memory store: no
// Dolt, no bus, so they run everywhere. The plugin engine is imported directly (the loader is exercised
// by the e2e suites); graphs are validated by the real model first, like the service does.
const pluginDir = pathToFileURL(resolve(process.cwd(), '../../plugins/workflows-iga')).href;
const { createWorkflowEngine } = await import(`${pluginDir}/engine.mjs`);
const { validateGraph } = await import(`${pluginDir}/model.mjs`);

interface Step { run_id: string; node_id: string; status: string; simulated: boolean; attempts: number; error: string | null; log: string[]; input: unknown; output: Record<string, unknown> | null; started_at: string | null; finished_at: string | null }

function makeHarness(graphInput: unknown, run: Record<string, unknown> = {}) {
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
    log: { warn: () => {}, error: () => {} },
  };
  return { row, steps, engine: createWorkflowEngine(deps) };
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

describe('workflow engine: branching', () => {
  it('still runs a plain linear graph end to end and records each step input', async () => {
    const h = makeHarness({ nodes: [node('a', 'wait', { seconds: 0 }), node('b', 'notify', { recipient: 'hr', message: 'hello' })], edges: [{ from: 'a', to: 'b' }] });
    await settle(h);
    assert.equal(h.row.status, 'completed');
    assert.equal(st(h, 'a').status, 'done');
    assert.equal(st(h, 'b').status, 'done');
    assert.deepEqual(st(h, 'b').input, { recipient: 'hr', message: 'hello' });
  });

  it('if: takes the true or the false link and skips the other side', async () => {
    const graph = (left: string, right: string) => ({
      nodes: [node('cond', 'if', { left, op: 'equals', right }), node('t', 'notify', { recipient: 'x', message: 'yes' }), node('f', 'notify', { recipient: 'x', message: 'no' })],
      edges: [{ from: 'cond', to: 't', label: 'true' }, { from: 'cond', to: 'f', label: 'false' }],
    });
    const hTrue = await settle(makeHarness(graph('a', 'a')));
    assert.equal(hTrue.row.status, 'completed');
    assert.equal(st(hTrue, 't').status, 'done');
    assert.equal(st(hTrue, 'f').status, 'skipped');
    assert.equal(st(hTrue, 'cond').output?.branch, 'true');
    const hFalse = await settle(makeHarness(graph('a', 'b')));
    assert.equal(st(hFalse, 't').status, 'skipped');
    assert.equal(st(hFalse, 'f').status, 'done');
    assert.equal(st(hFalse, 'cond').output?.branch, 'false');
  });

  it('merge: joins both branches and runs when one side arrives', async () => {
    const h = makeHarness({
      nodes: [node('cond', 'if', { left: 'x', op: 'equals', right: 'x' }), node('t', 'notify', { recipient: 'x', message: 'yes' }), node('f', 'notify', { recipient: 'x', message: 'no' }), node('m', 'merge'), node('end', 'notify', { recipient: 'x', message: 'joined' })],
      edges: [{ from: 'cond', to: 't', label: 'true' }, { from: 'cond', to: 'f', label: 'false' }, { from: 't', to: 'm' }, { from: 'f', to: 'm' }, { from: 'm', to: 'end' }],
    });
    await settle(h);
    assert.equal(h.row.status, 'completed');
    assert.equal(st(h, 't').status, 'done');
    assert.equal(st(h, 'f').status, 'skipped');
    assert.equal(st(h, 'm').status, 'done');
    assert.deepEqual(st(h, 'm').output?.arrived, ['t']);
    assert.equal(st(h, 'end').status, 'done');
  });

  it('switch: takes the matching case, or default', async () => {
    const graph = (value: string) => ({
      nodes: [node('sw', 'switch', { value, cases: 'blue\ngreen' }), node('b', 'notify', { recipient: 'x', message: 'blue' }), node('g', 'notify', { recipient: 'x', message: 'green' }), node('d', 'notify', { recipient: 'x', message: 'other' })],
      edges: [{ from: 'sw', to: 'b', label: 'blue' }, { from: 'sw', to: 'g', label: 'green' }, { from: 'sw', to: 'd', label: 'default' }],
    });
    const hCase = await settle(makeHarness(graph('green')));
    assert.equal(st(hCase, 'g').status, 'done');
    assert.equal(st(hCase, 'b').status, 'skipped');
    assert.equal(st(hCase, 'd').status, 'skipped');
    const hDef = await settle(makeHarness(graph('red')));
    assert.equal(st(hDef, 'd').status, 'done');
    assert.equal(st(hDef, 'g').status, 'skipped');
  });

  it('loop: runs its body once per item, then the done path', async () => {
    const h = makeHarness({
      nodes: [node('l', 'loop', { items: '["ann","bob"]' }), node('body', 'notify', { recipient: 'hr', message: 'welcome {{steps.l.item}}' }), node('after', 'notify', { recipient: 'hr', message: 'done' })],
      edges: [{ from: 'l', to: 'body', label: 'each' }, { from: 'l', to: 'after', label: 'done' }],
    });
    await settle(h);
    assert.equal(h.row.status, 'completed');
    assert.equal(st(h, 'l').status, 'done');
    assert.equal(st(h, 'l').output?.count, 2);
    assert.equal(st(h, 'body').status, 'done');
    assert.equal(st(h, 'body').attempts, 2);
    assert.ok(st(h, 'body').log.some((l) => l.includes('welcome ann')));
    assert.ok(st(h, 'body').log.some((l) => l.includes('welcome bob')));
    assert.equal(st(h, 'after').status, 'done');
  });

  it('error link: a failed step routes to its error path instead of failing the run', async () => {
    const h = makeHarness({
      nodes: [node('risky', 'fail', { mode: 'always', message: 'boom' }), node('ok', 'notify', { recipient: 'x', message: 'all good' }), node('rescue', 'notify', { recipient: 'x', message: 'caught' }), node('end', 'merge')],
      edges: [{ from: 'risky', to: 'ok' }, { from: 'risky', to: 'rescue', label: 'error' }, { from: 'ok', to: 'end' }, { from: 'rescue', to: 'end' }],
    });
    await settle(h);
    assert.equal(h.row.status, 'completed');
    assert.equal(st(h, 'risky').status, 'failed');
    assert.equal(st(h, 'ok').status, 'skipped');
    assert.equal(st(h, 'rescue').status, 'done');
    assert.equal(st(h, 'end').status, 'done');
  });

  it('without an error link, a failed step fails the run and skips the rest', async () => {
    const h = makeHarness({
      nodes: [node('risky', 'fail', { mode: 'always', message: 'boom' }), node('after', 'notify', { recipient: 'x', message: 'later' })],
      edges: [{ from: 'risky', to: 'after' }],
    });
    await settle(h);
    assert.equal(h.row.status, 'failed');
    assert.match(String(h.row.error), /boom/);
    assert.equal(st(h, 'after').status, 'skipped');
  });
});

describe('workflow model: branching validation', () => {
  it('refuses unlabeled or mislabeled links out of logic steps', () => {
    assert.throws(() => validateGraph({ nodes: [node('c', 'if', { left: 'a', op: 'equals', right: 'a' }), node('t', 'notify', { recipient: 'x', message: 'y' })], edges: [{ from: 'c', to: 't' }] }), /needs a label/);
    assert.throws(() => validateGraph({ nodes: [node('c', 'if', { left: 'a', op: 'equals', right: 'a' }), node('t', 'notify', { recipient: 'x', message: 'y' })], edges: [{ from: 'c', to: 't', label: 'maybe' }] }), /true or false/);
    assert.throws(() => validateGraph({ nodes: [node('w', 'wait'), node('t', 'notify', { recipient: 'x', message: 'y' })], edges: [{ from: 'w', to: 't', label: 'true' }] }), /only meaningful on if\/switch\/loop/);
    assert.throws(() => validateGraph({ nodes: [node('s', 'switch', { value: 'x', cases: 'blue' }), node('t', 'notify', { recipient: 'x', message: 'y' })], edges: [{ from: 's', to: 't', label: 'red' }] }), /not a case/);
  });
  it('refuses loops without a body and nested loops', () => {
    assert.throws(() => validateGraph({ nodes: [node('l', 'loop', { items: '[1]' }), node('t', 'notify', { recipient: 'x', message: 'y' })], edges: [{ from: 'l', to: 't', label: 'done' }] }), /labeled each/);
    assert.throws(() => validateGraph({
      nodes: [node('l1', 'loop', { items: '[1]' }), node('l2', 'loop', { items: '[2]' }), node('t', 'notify', { recipient: 'x', message: 'y' })],
      edges: [{ from: 'l1', to: 'l2', label: 'each' }, { from: 'l2', to: 't', label: 'each' }],
    }), /nested loops/);
  });
  it('validates the logic step configs', () => {
    assert.throws(() => validateGraph({ nodes: [node('c', 'if', { left: 'a', op: 'maybe', right: 'b' })], edges: [] }), /if.op/);
    assert.throws(() => validateGraph({ nodes: [node('s', 'switch', { value: 'x', cases: '' })], edges: [] }), /1 to 10/);
    assert.throws(() => validateGraph({ nodes: [node('l', 'loop', { items: '[1]', maxItems: 500 })], edges: [] }), /maxItems/);
    assert.throws(() => validateGraph({ nodes: [node('m', 'merge', { bogus: 1 })], edges: [] }), /unknown config key/);
    const { graph } = validateGraph({ nodes: [node('l', 'loop', { items: '["a"]' }), node('t', 'notify', { recipient: 'x', message: 'y' })], edges: [{ from: 'l', to: 't', label: 'each' }] });
    assert.equal(graph.nodes[0].config.maxItems, 10); // default cap
  });
});
