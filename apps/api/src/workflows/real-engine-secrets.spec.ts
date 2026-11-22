import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateGraph } from './model.js';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { RunSecrets } from './run-secrets.js';
// The REAL workflow engine (plugins/workflows-iga) with the real blocks and the real RunSecrets; only the store, the data versioning and the user service are fakes. No mail, no data store.
const { createWorkflowEngine } = loadPluginModule('workflows-iga', 'engine.mjs') as any;
const node = (id: string, type: string, config: object = {}) => ({ id, type, name: id, config });
const edge = (from: string, to: string) => ({ from, to });
const GRAPH = (nodes: any[]) => ({ nodes, edges: nodes.slice(1).map((n, i) => edge(nodes[i].id, n.id)) });

function harness(nodes: any[], opts: { secrets?: RunSecrets; preDone?: Record<string, any>; failSet?: boolean } = {}) {
  const { graph, order } = validateGraph(GRAPH(nodes));
  const row: any = { id: 'run-sec', tenant: 'acme-demo', definition_id: 'wf-def', name: 't', graph, branch: 'workflow/sec', base_branch: null, status: 'queued', error: null, started_by: 'tester', started_at: 'now', finished_at: null, test: false };
  const steps = new Map<string, any>();
  for (const id of order) steps.set(id, { run_id: row.id, node_id: id, status: 'pending', simulated: false, attempts: 0, error: null, log: [], input: null, output: null, started_at: null, finished_at: null, ...(opts.preDone?.[id] ?? {}) });
  const store = {
    getRunById: async (id: string) => (id === row.id ? row : null), updateRun: async (_i: string, p: any) => { Object.assign(row, p); }, transitionRun: async (_i: string, p: any, from: string[]) => { if (!from.includes(row.status as string)) return false; Object.assign(row, p); return true; }, runningRuns: async () => [],
    step: async (_r: string, n: string) => steps.get(n) ?? null, steps: async () => [...steps.values()], patchStep: async (_r: string, n: string, p: any) => { Object.assign(steps.get(n), p); },
  };
  const secrets = opts.secrets ?? new RunSecrets();
  const setCalls: any[] = [];
  const deps = {
    store, secrets,
    versioning: { createBranch: async () => ({}), writeOn: async (_b: string, fn: any) => fn({ query: async () => [[]] }), defaultBranch: 'main' },
    authorOf: (a: string) => a, branchRun: async (_b: string, fn: any) => fn(), settingsFor: async () => ({}), log: { warn() {}, error() {} },
    users: { firstAccess: async () => ({ required: false }), emailOf: async () => null, setTemporary: async (_t: string, a: any) => { if (opts.failSet) throw new Error('policy refused'); setCalls.push(a); return { revision: 'rev-1', expiresAt: Date.now() + a.hours * 3_600_000 }; } },
  };
  return { row, steps, setCalls, secrets, engine: createWorkflowEngine(deps) };
}
async function settle(h: ReturnType<typeof harness>) {
  h.engine.kick('run-sec');
  for (const until = Date.now() + 8000; ; ) {
    if (['completed', 'failed', 'canceled'].includes(h.row.status)) return h;
    if (Date.now() > until) throw new Error(`no settle (${h.row.status})`);
    await new Promise((r) => setTimeout(r, 30));
  }
}
const dump = (h: ReturnType<typeof harness>) => JSON.stringify([...h.steps.values()]) + JSON.stringify(h.row);

describe('real engine: run-scoped secrets', () => {
  it('generate then set-temporary: the value reaches only the user service; no step, log, input, output or run row holds it', async () => {
    const h = harness([node('g', 'lyam-generate-password'), node('s', 'lyam-set-temporary-password', { subject: 'bao', passwordRef: '{{steps.g.passwordRef}}', hours: '24' })]);
    await settle(h);
    assert.equal(h.row.status, 'completed', JSON.stringify(h.row.error));
    assert.equal(h.setCalls.length, 1);
    const canary = h.setCalls[0].password as string;
    assert.equal(canary.length, 20);
    assert.equal(h.setCalls[0].runId, 'run-sec');
    assert.equal(dump(h).includes(canary), false);
    assert.match(String(h.steps.get('g').output.passwordRef), /^secret:[0-9a-f]{24}$/);
  });
  it('a failed set-temporary (policy refusal) stops the run, stores no value and leaves the reference unusable for another effect', async () => {
    const h = harness([node('g', 'lyam-generate-password'), node('s', 'lyam-set-temporary-password', { subject: 'bao', passwordRef: '{{steps.g.passwordRef}}', hours: '24' })], { failSet: true });
    await settle(h);
    assert.equal(h.row.status, 'failed');
    const [value] = h.secrets.valuesOf('run-sec');
    assert.equal(typeof value, 'string');
    assert.equal(dump(h).includes(value), false);
  });
  it('restart: a done generate step whose in-memory secret is gone makes set-temporary fail closed; nothing is regenerated, nothing is set', async () => {
    const ref = 'secret:' + 'ab'.repeat(12);
    const h = harness([node('g', 'lyam-generate-password'), node('s', 'lyam-set-temporary-password', { subject: 'bao', passwordRef: '{{steps.g.passwordRef}}', hours: '24' })],
      { secrets: new RunSecrets(), preDone: { g: { status: 'done', output: { passwordRef: ref }, attempts: 1 } } });
    await settle(h);
    assert.equal(h.row.status, 'failed');
    assert.equal(h.setCalls.length, 0, 'no credential written');
    assert.equal(h.secrets.valuesOf('run-sec').length, 0, 'no new secret was generated on resume');
    assert.equal(h.steps.get('g').output.passwordRef, ref, 'the generate step was not re-run');
    assert.equal(h.steps.get('s').status, 'failed'); assert.equal(h.steps.get('g').status, 'done');
  });
  it('expired secret (TTL) behaves like a lost one', async () => {
    let t = 1_000_000; const secrets = new RunSecrets(() => t, 1000);
    const ref = secrets.create('run-sec', ['set-temporary', 'mail']); t += 5000;
    const h = harness([node('g', 'lyam-generate-password'), node('s', 'lyam-set-temporary-password', { subject: 'bao', passwordRef: '{{steps.g.passwordRef}}', hours: '24' })], { secrets, preDone: { g: { status: 'done', output: { passwordRef: ref }, attempts: 1 } } });
    await settle(h);
    assert.equal(h.row.status, 'failed'); assert.equal(h.setCalls.length, 0);
  });
});
