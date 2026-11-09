import 'reflect-metadata';
import { SEEDS } from './demo-seed.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blockCatalogue, externalBlock, externalEvent, stepPlaceholderRefs, substituteStepOutputs, validateGraph, validateStepPlaceholders, validateTrigger, WfBlockCtx, WfNode } from './model.js';

// The workflow-connectors spike plugin: its block catalogue is merged into the workflow model at boot.
// These tests exercise the REAL contributed blocks against their simulated contexts (demo sheet, dry-run,
// fake branch db) - no Google, Jira or network credential involved.

const node = (id: string, type: string, config: Record<string, unknown> = {}, name = id): WfNode => ({ id, type, name, config });
const ctx = (over: Partial<WfBlockCtx> = {}): WfBlockCtx & { lines: string[] } => {
  const lines: string[] = [];
  return {
    tenant: 'acme', config: {}, settings: {}, dryRun: false,
    log: (l) => lines.push(l), outputs: {},
    branchWrite: async (fn) => { await fn({ query: async (sql: string) => sql.startsWith('show columns') ? [[{ Field: 'id' }, { Field: 'email' }, { Field: 'login_enabled' }, { Field: 'credential_revision' }], undefined] as [unknown, unknown] : [[{ n: 0 }], undefined] as [unknown, unknown] }); },
    lines,
    ...over,
  } as WfBlockCtx & { lines: string[] };
};

describe('contributed block catalogue (workflow-connectors)', () => {
  it('every shipped demo graph and trigger validates, including HR step-output identities', () => {
    for (const seed of SEEDS) {
      const { graph, order } = validateGraph({ nodes: seed.nodes, edges: seed.edges });
      validateStepPlaceholders(graph, order);
      validateTrigger(seed.trigger);
    }
  });
  it('merges the plugin blocks and trigger events into the workflow model', () => {
    for (const t of ['http-request', 'text-transform', 'google-sheets-read', 'google-sheets-update', 'jira-create-issue', 'lyam-create-user']) {
      const b = externalBlock(t);
      assert.ok(b, `${t} merged`);
      assert.equal(b!.pluginId, 'workflow-connectors');
    }
    assert.equal(externalBlock('nope'), undefined);
    assert.ok(externalEvent('http.webhook-received'));
    assert.ok(externalEvent('google-sheets.row-ready')!.poll, 'the sheet trigger carries its poll function');
  });
  it('exposes them in the editor catalogue after the built-ins', () => {
    const cat = blockCatalogue();
    assert.equal(cat[0].provider, null);
    const lyam = cat.find((b) => b.type === 'lyam-create-user');
    assert.ok(lyam && lyam.provider === 'workflow-connectors' && lyam.fields.length > 0);
  });
  it('validates contributed step config inside a graph and rejects unknown keys', () => {
    const { order } = validateGraph({ nodes: [node('a', 'text-transform', { operation: 'lower', text: 'X' }), node('b', 'notify', { recipient: 'hr', message: '{{steps.a.value}}' })], edges: [{ from: 'a', to: 'b' }] });
    assert.deepEqual(order, ['a', 'b']);
    assert.throws(() => validateGraph({ nodes: [node('a', 'text-transform', { operation: 'explode', text: 'x' })], edges: [] }), /unknown/);
    assert.throws(() => validateGraph({ nodes: [node('a', 'http-request', { url: 'https://example.com', hack: 1 })], edges: [] }), /unknown config key/);
  });
  it('validates contributed trigger config (webhook token required)', () => {
    assert.throws(() => validateTrigger({ event: 'http.webhook-received' }), /token/);
    const t = validateTrigger({ event: 'http.webhook-received', config: { token: 'a-long-enough-token' } });
    assert.equal(t!.config!.token, 'a-long-enough-token');
    const sheet = validateTrigger({ event: 'google-sheets.row-ready', config: { source: 'demo-sheet' } });
    assert.equal(sheet!.config!.source, 'demo-sheet');
  });
});

describe('step output placeholders', () => {
  it('collects {{steps.<id>.<key>}} references', () => {
    assert.deepEqual(stepPlaceholderRefs('mail {{steps.lower.value}} et {{event.prenom}}'), [{ node: 'lower', key: 'value' }]);
  });
  it('refuses references to unknown or later steps', () => {
    const { graph, order } = validateGraph({ nodes: [node('a', 'text-transform', { operation: 'lower', text: 'X' }), node('b', 'notify', { recipient: 'hr', message: '{{steps.ghost.value}}' })], edges: [{ from: 'a', to: 'b' }] });
    assert.throws(() => validateStepPlaceholders(graph, order), /ghost/);
    const fwd = validateGraph({ nodes: [node('a', 'notify', { recipient: 'hr', message: '{{steps.b.value}}' }), node('b', 'text-transform', { operation: 'lower', text: 'X' })], edges: [{ from: 'a', to: 'b' }] });
    assert.throws(() => validateStepPlaceholders(fwd.graph, fwd.order), /later|before|upstream/);
  });
  it('substitutes upstream outputs into downstream config at run time', () => {
    const n: WfNode = node('b', 'notify', { recipient: 'hr', message: 'user {{steps.lower.value}} created' });
    const out = substituteStepOutputs(n, { lower: { value: 'martin.camille' } });
    assert.equal(out.config.message, 'user martin.camille created');
  });
});

describe('contributed block runs (simulated contexts)', () => {
  it('text-transform: concat + unaccent + lower build the login', async () => {
    const t = externalBlock('text-transform')!;
    const join = await t.run(ctx({ config: t.validate({ operation: 'concat', values: 'Márton\n.\nÉlodie', separator: '' }) }));
    assert.equal(join!.value, 'Márton.Élodie');
    const clean = await t.run(ctx({ config: t.validate({ operation: 'unaccent', text: String(join!.value) }) }));
    assert.equal(clean!.value, 'Marton.Elodie');
    const lower = await t.run(ctx({ config: t.validate({ operation: 'lower', text: String(clean!.value) }) }));
    assert.equal(lower!.value, 'marton.elodie');
  });
  it('http-request: dry-run sends nothing, private hosts are refused (SSRF guard)', async () => {
    const h = externalBlock('http-request')!;
    const c = ctx({ dryRun: true });
    const out = await h.run({ ...c, config: h.validate({ method: 'GET', url: 'https://example.com/x' }) });
    assert.equal(out!.status, 0);
    assert.ok(c.lines[0].startsWith('DRY-RUN'));
    assert.throws(() => h.validate({ method: 'GET', url: 'http://127.0.0.1/admin' }), /SSRF|loopback/);
  });
  it('google-sheets read/update on the DEMO sheet, and the row watcher finds ready rows', async () => {
    const read = externalBlock('google-sheets-read')!;
    const all = await read.run(ctx({ config: read.validate({ source: 'demo-sheet', mode: 'all-rows' }) }));
    assert.equal(all!.count, 3);
    const found = await read.run(ctx({ config: read.validate({ source: 'demo-sheet', mode: 'find-row', columnName: 'nom', searchValue: 'Martin' }) }));
    assert.equal((found!.row as Record<string, string>).prenom, 'Camille');

    const poll = externalEvent('google-sheets.row-ready')!.poll!;
    const ready = await poll({ source: 'demo-sheet' }, { settings: {} });
    assert.deepEqual(ready.map((r) => r.values.nom), ['Martin', 'Dubois']); // Bernard is "En cours"

    const update = externalBlock('google-sheets-update')!;
    const c = ctx({ config: update.validate({ source: 'demo-sheet', rowNumber: '2', column: 'cree', value: 'ok' }) });
    assert.equal((await update.run(c))!.updated, true);
    assert.ok(c.lines[0].includes('DEMO sheet'));
    assert.equal((await poll({ source: 'demo-sheet' }, { settings: {} })).map((r) => r.values.nom).join(','), 'Dubois'); // Martin is done now
    await assert.rejects(() => update.run(ctx({ config: update.validate({ source: 'demo-sheet', rowNumber: '1', column: 'cree', value: 'x' }) })), /integer >= 2/);
  });
  it('jira-create-issue: dryRun default logs instead of creating', async () => {
    const j = externalBlock('jira-create-issue')!;
    const c = ctx({ config: j.validate({ project: 'KAN', issueTypeId: '10001', summary: 'Onboard martin.camille' }) });
    const out = await j.run(c);
    assert.equal(out!.key, null);
    assert.ok(c.lines[0].startsWith('DRY-RUN'));
  });
  it('google-sheets-add-row appends on the DEMO sheet and refuses bad lines', async () => {
    const add = externalBlock('google-sheets-add-row')!;
    const c = ctx({ config: add.validate({ source: 'demo-sheet', values: 'nom = Petit\nprenom = Zoé\nprocess = En cours' }) });
    const out = await add.run(c);
    assert.equal(out!.rowNumber, 5);
    assert.ok(c.lines[0].includes('DEMO sheet'));
    await assert.rejects(() => add.run(ctx({ config: add.validate({ source: 'demo-sheet', values: 'just text' }) })), /column = value/);
  });
  it('jira-search-issues: dryRun default logs the JQL instead of calling', async () => {
    const j = externalBlock('jira-search-issues')!;
    const c = ctx({ config: j.validate({ jql: 'project = KAN', maxResults: 5000 }) });
    assert.equal(c.config.maxResults, 100, 'capped');
    const out = await j.run(c);
    assert.equal(out!.count, 0);
    assert.ok(c.lines[0].startsWith('DRY-RUN'));
  });
  it('lyam-create-user writes the identity on the run branch, idempotent on retry', async () => {
    const l = externalBlock('lyam-create-user')!;
    const cfg = l.validate({ identity: 'martin.camille', displayName: 'Camille Martin', email: 'martin.camille@lyam.demo', department: 'finance' });
    const inserted: unknown[][] = [];
    let exists = 0;
    const db = { query: async (sql: string, params?: unknown[]) => { if (sql.startsWith('show columns')) return [[{ Field: 'id' }], undefined] as [unknown, unknown]; if (sql.startsWith('select')) return [[{ n: exists }], undefined] as [unknown, unknown]; if (sql.startsWith('insert')) inserted.push(params ?? []); return [{}, undefined] as [unknown, unknown] } };
    const c = ctx({ config: cfg, branchWrite: async (fn) => { await fn(db); } });
    const out = await l.run(c);
    assert.equal(out!.identity, 'martin.camille');
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0][3], 'martin.camille@lyam.demo');
    exists = 1; // retry: the row is already on the branch
    const c2 = ctx({ config: cfg, branchWrite: async (fn) => { await fn(db); } });
    await l.run(c2);
    assert.equal(inserted.length, 1);
    assert.ok(c2.lines[0].includes('idempotent'));
    assert.throws(() => l.validate({ identity: 'Bad Id', displayName: 'x' }), /lowercase/);
  });
});
