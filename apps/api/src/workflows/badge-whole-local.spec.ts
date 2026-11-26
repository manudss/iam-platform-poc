import 'reflect-metadata';
import '../authn/flow.service.js';
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import nock from 'nock';
import { VersioningService } from '../versioning/versioning.service.js';
import { UsersService } from '../users/users.service.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { WorkflowEngine } from './engine.js';
import { WorkflowStore, type RunRow, type StepRow } from './store.js';
import { BlockStore } from '../accounts/block-store.js';
import { canSignIn } from '../accounts/blocks.js';
import { branchContext } from '../workspace/context.js';
import { WorkspacePublisher } from '../workspace/workspace-publisher.js';
import { ActivationService } from '../activation/activation.service.js';
import { DoltService } from '../dolt/dolt.service.js';
import { RunSecrets } from './run-secrets.js';
import { OFFICIAL_TEMPLATES } from './templates-catalog.js';
import { externalEvent, substituteEventPayload, validateGraph } from './model.js';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { localTestPort } from '../testing/local-test-port.js';
import { startTestBus, type TestBus } from '../testing/test-bus.js';
// Whole official two-phase graph with real local Dolt/meta-store/users/account blocks/publisher/core.
// Boundaries: managed-connection resolution and directory validation are fixtures, provider HTTP is
// intercepted with fictional responses, mail transport is a double. No live provider or browser sign-in.
const bin = process.env.DOLT_BIN ?? '';
const engineApi = loadPluginModule('workflows-iga', 'engine.mjs') as any;
const mailApi = loadPluginModule('workflow-connectors', 'mail-api.mjs') as any;
const T = 'acme-demo', EMAIL = 'badge@example.invalid', ID = 'fixture.badge';
describe('whole badge graphs with real local state and provider network fixtures', { skip: !existsSync(bin) && 'DOLT_BIN missing' }, () => {
  let dir: string, proc: ChildProcess, bus: TestBus, v: VersioningService, users: UsersService, store: WorkflowStore, blocks: BlockStore, activation: ActivationService;
  let googleSecret: string, engine: any, mailPassword = '', mails = 0, tickets = 0;
  const saved: Record<string, string | undefined> = {};
  const columns = ['nom', 'prenom', 'departement', 'role', 'process', 'email', 'ticket', 'badge', 'cree'];
  const values = ['Fixture', 'Badge', 'IT', 'employee', 'OK', EMAIL, '', '', ''];
  const writes: string[] = [];
  const settings = { mailAllowedRecipients: EMAIL, publishAllowedWorkflows: 'badge-phase1,badge-phase2' };
  const graph = (template: string, event: Record<string, unknown>) => {
    const t = structuredClone(OFFICIAL_TEMPLATES.find(x => x.id === template)!);
    for (const node of t.nodes) {
      if (/^(google-sheets-|jira-)/.test(node.type)) Object.assign(node.config, { executionMode: 'real', realConfirmed: true, connectionId: node.type.startsWith('jira-') ? 'jira-demo' : 'sheets-demo' });
      if (node.config.spreadsheetId === 'REPLACE-WITH-SPREADSHEET-ID') node.config.spreadsheetId = 'fictional-badge-sheet';
    }
    return substituteEventPayload(validateGraph({ nodes: t.nodes, edges: t.edges }).graph, Object.fromEntries(Object.entries(event).map(([k,v]) => [k, String(v)])));
  };
  async function run(id: string, definition: string, g: any, expected = 'completed') {
    const now = new Date().toISOString().slice(0, 23).replace('T', ' ');
    const r: RunRow = { id, tenant: T, definition_id: definition, name: definition, graph: g, branch: null, base_branch: 'main', status: 'queued', error: null, started_by: 'fixture-trigger', started_at: now, finished_at: null, test: false };
    const steps: StepRow[] = g.nodes.map((n: any) => ({ run_id: id, node_id: n.id, status: 'pending', simulated: false, attempts: 0, error: null, log: [], input: null, output: null, started_at: null, finished_at: null }));
    await store.createRun(r, steps); engine.kick(id);
    for (const end = Date.now() + 60000; Date.now() < end;) {
      const current = (await store.getRunById(id))!;
      if (['completed', 'failed', 'canceled'].includes(current.status)) {
        assert.equal(current.status, expected, JSON.stringify({ error: current.error, steps: (await store.steps(id)).map(s => ({ id: s.node_id, status: s.status, error: s.error, log: s.log })) })); return current;
      }
      await new Promise(r => setTimeout(r, 60));
    }
    assert.fail('local badge run timed out');
  }
  before(async () => {
    bus = await startTestBus(import.meta.url);
    dir = mkdtempSync(join(tmpdir(), 'whole-badge-')); const home = join(dir, 'home'), data = join(dir, 'data'); mkdirSync(home); mkdirSync(data);
    const env = { ...process.env, HOME: home };
    for (const [key, val] of [['user.name', 'Fixture'], ['user.email', 'fixture@example.invalid']]) assert.equal(spawnSync(bin, ['config', '--global', '--add', key, val], { env }).status, 0);
    assert.equal(spawnSync(bin, ['sql'], { cwd: data, env, input: readFileSync(resolve('../../data/demo/01-schema.sql')) }).status, 0);
    const port = await localTestPort(); proc = spawn(bin, ['sql-server', '--host', '127.0.0.1', '--port', String(port), '--data-dir', data], { cwd: data, env, stdio: 'ignore' });
    for (const key of ['DOLT_PORT', 'DOLT_DATABASE', 'IAM_CREDENTIAL_FILE', 'IAM_DIRECTORY_AUTH', 'IAM_WORKSPACE_MODE', 'IAM_WORKFLOW_REAL_CONNECTIONS', 'RESEND_API_KEY']) saved[key] = process.env[key];
    Object.assign(process.env, { DOLT_PORT: String(port), DOLT_DATABASE: 'iam', IAM_CREDENTIAL_FILE: join(dir, 'credentials.json'), IAM_DIRECTORY_AUTH: '1', IAM_WORKFLOW_REAL_CONNECTIONS: '1', RESEND_API_KEY: 'fictional-mail-fixture' });
    delete process.env.IAM_WORKSPACE_MODE;
    v = new VersioningService();
    for (let i = 0; i < 100; i++) { try { await v.at('main', async () => undefined); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    const registry = { resolve: () => { throw Error('no password policy plugin in fixture'); }, isActive: () => false, callSlot: async () => ({ result: { valid: true } }) };
    const modules = { get: (type: unknown) => type === BranchRegistries ? { get: () => registry } : type === PluginRegistry ? registry : undefined };
    users = new UsersService(v, modules as never); await users.init();
    store = new WorkflowStore(v); await store.prepareMigrationStorage();
    blocks = new BlockStore(join(dir, 'blocks.json'));
    activation = new ActivationService({ get: async () => undefined } as never, new DoltService());
    const publisher = new WorkspacePublisher(v, { drop() {}, get: async () => ({}) } as never, activation);
    const proto = WorkflowEngine.prototype as any;
    const fx = { users, publisher, settingsFor: async () => settings, authn: { blocks }, events: { emit() {} } };
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    googleSecret = JSON.stringify({ type: 'service_account', client_email: 'fixture@fictional.iam.gserviceaccount.com', private_key: privateKey, token_uri: 'https://oauth2.googleapis.com/token' });
    nock.disableNetConnect(); nock.enableNetConnect(/127\.0\.0\.1/);
    for (const base of ['https://oauth2.googleapis.com', 'https://www.googleapis.com']) nock(base).persist().post(/token/).reply(200, { access_token: 'fictional-google-fixture', token_type: 'Bearer', expires_in: 3600 });
    nock('https://sheets.googleapis.com').persist().get('/v4/spreadsheets/fictional-badge-sheet').reply(200, { sheets: [{ properties: { sheetId: 0, title: 'Candidates' } }] });
    nock('https://sheets.googleapis.com').persist().get(/\/values\//).reply((uri: string) => {
      const range = decodeURIComponent(uri.split('/values/')[1]); return [200, { values: range.includes('A1:ZZZ1') ? [columns] : range.includes('A2:ZZZ') ? [values] : [columns, values] }];
    });
    nock('https://sheets.googleapis.com').persist().put(/\/values\//).query(true).reply((_uri: string, body: any) => {
      body.values[0].forEach((val: unknown, index: number) => { if (val !== null) { values[index] = String(val); writes.push(columns[index]); } }); return [200, { updatedCells: 1 }];
    });
    nock('https://fictional.atlassian.net').persist().get('/rest/api/3/project/KAN').reply(200, {id:'10000',key:'KAN'});
    nock('https://fictional.atlassian.net').persist().get(/\/createmeta\//).query(true).reply(200, { fields: [], startAt: 0, maxResults: 100, total: 0 });
    nock('https://fictional.atlassian.net').persist().post(/\/issue$/).reply(201, () => { tickets++; return { id: '123', key: 'KAN-123', self: 'https://fictional.atlassian.net/rest/api/3/issue/123' }; });
    nock('https://fictional.atlassian.net').persist().get('/rest/api/3/issue/123').reply(200, { id: '123', key: 'KAN-123', fields: { summary: 'Fixture badge' } });
    nock('https://fictional.atlassian.net').persist().post('/rest/api/3/search/jql').reply(200, { issues: [{ id: '123', key: 'KAN-123', fields: { summary: 'Untrusted summary not used for identity', status: { name: 'Done' }, updated: '2026-11-22T00:00:00Z' } }] });
    mailApi.mailClient.Ctor = class { emails = { send: async (payload: any) => {
      mails++; assert.equal(payload.to, EMAIL); assert.equal(canSignIn(await blocks.list(T, ID), Date.now()), false, 'still suspended while mail is accepted');
      const match = payload.text.match(/Mot de passe temporaire : ([^ ]+)\./); assert.ok(match); mailPassword = match[1];
      return { data: { id: 'fictional-mail-accepted' } };
    } }; };
    process.env.IAM_WORKSPACE_MODE = '1';
    engine = engineApi.createWorkflowEngine({ store, versioning: v, authorOf: () => 'Fixture <fixture@example.invalid>', branchRun: (branch: string, fn: any) => branchContext.run({ branch }, fn), settingsFor: async () => settings,
      connectionFor: async (_tenant: string, _ref: string, id: string) => id === 'jira-demo' ? { settings: { jiraInstanceUrl: 'https://fictional.atlassian.net', jiraEmail: EMAIL, jiraApiToken: 'fictional-jira-fixture' }, secret: 'fictional-jira-fixture' } : { settings: { googleServiceAccount: googleSecret }, secret: googleSecret },
      users: proto.userEffects.call(fx), accounts: proto.accountEffects.call(fx), workspace: proto.workspaceEffects.call(fx, v), links: proto.linkEffects.call(fx, store), secrets: new RunSecrets(), log: { warn() {}, error() {} },
    });
  });
  after(async () => {
    mailApi.mailClient.Ctor = null; nock.cleanAll(); nock.enableNetConnect();
    await activation?.onModuleDestroy(); await bus?.close(); proc?.kill(); await new Promise(r => setTimeout(r, 500));
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    for (const [key, val] of Object.entries(saved)) { if (val === undefined) delete process.env[key]; else process.env[key] = val; }
  });
  it('ready row -> disabled account -> ticket -> Done -> published enabled credential -> accepted mail -> owned unblock -> first-access change', async () => {
    const ready = await externalEvent('google-sheets.row-ready')!.poll!({ source: 'google', spreadsheetId: 'fictional-badge-sheet', sheetId: 0, watchColumn: 'process', watchValue: 'OK', doneColumn: 'cree', doneValue: 'ok' }, { settings: { googleServiceAccount: googleSecret }, log() {} });
    assert.equal(ready.length, 1);
    await run('badge-p1-unique', 'badge-phase1', graph('badge-request-from-sheet', ready[0].values));
    const noReady = await externalEvent('google-sheets.row-ready')!.poll!({ source: 'google', spreadsheetId: 'fictional-badge-sheet', sheetId: 0, watchColumn: 'process', watchValue: 'OK', doneColumn: 'cree', doneValue: 'ok' }, { settings: { googleServiceAccount: googleSecret }, log() {} });
    assert.equal(noReady.length, 0, 'phase 1 done marker prevents selecting the same row again');
    assert.equal(tickets, 1); assert.equal(mails, 0); assert.equal(values[6], 'KAN-123'); assert.equal(values[8], 'ok');
    assert.equal(!!(await users.list('main')).find(x => x.id === ID)!.login_enabled, false);
    assert.equal(canSignIn(await blocks.list(T, ID), Date.now()), false);
    const link = { tenant: T, connectionId: 'jira-demo', project: 'KAN', issueKey: 'KAN-123' };
    assert.equal((await store.getTicketLink(link))!.status, 'open');
    const done = await externalEvent('jira.issue-done')!.poll!({ project: 'KAN', label: 'badge-demo' }, { settings: { jiraInstanceUrl: 'https://fictional.atlassian.net', jiraEmail: EMAIL, jiraApiToken: 'fictional-jira-fixture' }, log() {} });
    assert.equal(done.length, 1);
    await run('badge-p2-unique', 'badge-phase2', graph('badge-done-temporary-password', done[0].values));
    assert.equal(mails, 1); assert.equal(values[7], 'badge fait / mail envoyé'); assert.deepEqual(writes, ['ticket', 'cree', 'badge']);
    assert.equal((await store.getTicketLink(link))!.status, 'done'); assert.equal(canSignIn(await blocks.list(T, ID), Date.now()), true);
    assert.ok(mailPassword); assert.equal(await users.authenticate(T, ID, mailPassword), true);
    const st = await users.firstAccessState(T, ID); assert.equal(st.required, true);
    assert.deepEqual(await users.completeFirstAccess(T, ID, 'Replacement-Fictional-123!', st.required ? st.revision : ''), { ok: true });
    assert.equal(await users.authenticate(T, ID, mailPassword), false); assert.equal(await users.authenticate(T, ID, 'Replacement-Fictional-123!'), true);
    assert.deepEqual(await users.firstAccessState(T, ID), { required: false });
    const dump = JSON.stringify([await store.getRunById('badge-p2-unique'), await store.steps('badge-p2-unique')]);
    assert.equal(dump.includes(mailPassword), false);
    assert.equal(readFileSync(join(dir, 'credentials.json'), 'utf8').includes(mailPassword), false);
    const replay = await run('badge-p2-replay', 'badge-phase2', graph('badge-done-temporary-password', done[0].values), 'failed');
    assert.ok(replay.error); assert.equal(mails, 1); assert.equal(tickets, 1); assert.deepEqual(writes, ['ticket', 'cree', 'badge']);
    assert.ok((await store.steps('badge-p2-replay')).filter(s => ['gen','set','enable','publish','mail','unblock'].includes(s.node_id)).every(s => s.status === 'skipped'));
    mailPassword = '';
    const current = await activation.current(T); assert.equal(current!.state, 'applied');
    assert.equal((await (await fetch(`${bus.coreUrl}/v1/version?tenant=${T}`)).json() as any).commit, current!.commit);
  });
});
