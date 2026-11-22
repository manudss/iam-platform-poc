import 'reflect-metadata';
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection, type Connection } from 'mysql2/promise';
import { VersioningService } from '../versioning/versioning.service.js';
import { checkSql } from '../versioning/guards.js';
import { externalBlock } from './model.js';
import '../plugins/v1/branch-registries.js'; // Load the existing registry/users cycle in the normal module order.
import { UsersService } from '../users/users.service.js';
import { branchContext } from '../workspace/context.js';
import { WorkspacePublisher } from '../workspace/workspace-publisher.js';
import { ActivationService } from '../activation/activation.service.js';
import { DoltService } from '../dolt/dolt.service.js';
import { startTestBus, type TestBus } from '../testing/test-bus.js';
import { localTestPort } from '../testing/local-test-port.js';

// Real Dolt, publisher, snapshot exporter and local Rust core/NATS. The registry and directory validation
// are doubles: this isolates column preservation, not full plugin/SoD/authn or external badge delivery.
const bin = process.env.DOLT_BIN ?? '';
describe('badge provenance across profile, publication and undo', { skip: !existsSync(bin) && 'DOLT_BIN missing' }, () => {
  let dir: string, proc: ChildProcess, port: number, bus: TestBus;
  const saved: Record<string, string | undefined> = {};
  const v = new VersioningService();
  async function on<T>(branch: string, fn: (c: Connection) => Promise<T>): Promise<T> {
    const c = await createConnection({ host: '127.0.0.1', port, user: 'root', password: '', database: 'iam' });
    try { await c.query('CALL DOLT_CHECKOUT(?)', [branch]); return await fn(c); } finally { await c.end(); }
  }
  const root = (branch: string) => on(branch, async c => ((await c.query("SELECT DOLT_HASHOF_DB('WORKING') h"))[0] as { h: string }[])[0].h);
  const marker = (branch: string) => on(branch, async c => ((await c.query('SELECT workflow_creation_ref FROM identities WHERE id=?', ['fictional.badge']))[0] as { workflow_creation_ref: string }[])[0].workflow_creation_ref);
  const head = async (branch: string) => (await v.branches()).branches.find(x => x.name === branch)!.commit;
  async function commit(c: Connection) { const [s] = await c.query('SELECT count(*) n FROM dolt_status'); if (Number((s as { n: number }[])[0].n)) { await c.query("CALL DOLT_ADD('-A')"); await c.query("CALL DOLT_COMMIT('-m','fictional badge fixture','--author','Fixture <fixture@example.invalid>')"); } }
  async function branch(name: string) { await on('main', async c => { await c.query('CALL DOLT_BRANCH(?)', [name]); }); }
  const context = (name: string, identity = 'fictional.badge') => ({
    tenant: 'fictional', runId: 'fixture-run', nodeId: 'create', config: { identity, displayName: 'Fictional Badge', email: 'badge@example.invalid' }, settings: {}, outputs: {}, dryRun: false, log: () => undefined,
    branchWrite: async (fn: (c: Connection) => Promise<void>) => v.writeOn(name, async c => { await fn(c); await commit(c); }),
  } as never);
  before(async () => {
    bus = await startTestBus(import.meta.url); port = await localTestPort();
    dir = mkdtempSync(join(tmpdir(), 'badge-paths-')); const home = join(dir, 'home'), data = join(dir, 'data'); mkdirSync(home); mkdirSync(data);
    const env = { ...process.env, HOME: home };
    for (const [k, value] of [['user.name', 'Fixture'], ['user.email', 'fixture@example.invalid']]) assert.equal(spawnSync(bin, ['config', '--global', '--add', k, value], { env }).status, 0);
    const init = spawnSync(bin, ['sql'], { cwd: data, env, input: readFileSync(resolve('../../data/demo/01-schema.sql')) }); assert.equal(init.status, 0, init.stderr.toString());
    proc = spawn(bin, ['sql-server', '--host', '127.0.0.1', '--port', String(port), '--data-dir', data], { cwd: data, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostic = ''; for (const stream of [proc.stdout, proc.stderr]) stream?.on('data', c => { diagnostic = (diagnostic + c).slice(-2000); });
    let ready = false; for (let i = 0; i < 100; i++) { assert.equal(proc.exitCode, null, diagnostic); try { await on('main', async () => undefined); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); } } assert.ok(ready, diagnostic);
    for (const key of ['DOLT_PORT', 'DOLT_DATABASE', 'IAM_WORKSPACE_MODE', 'IAM_CREDENTIAL_FILE']) saved[key] = process.env[key];
    Object.assign(process.env, { DOLT_PORT: String(port), DOLT_DATABASE: 'iam', IAM_WORKSPACE_MODE: '0', IAM_CREDENTIAL_FILE: join(dir, 'fixture-credentials.json') });
    await on('main', commit); await branch('workflow/owned'); await externalBlock('lyam-create-user')!.run(context('workflow/owned'));
  });
  after(async () => {
    await bus?.close(); if (proc && proc.exitCode === null) { const stopped = new Promise<void>(r => proc.once('exit', () => r())); proc.kill(); await stopped; }
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  it('named UsersService upsert keeps the marker and excludes it from profiles and application events', async () => {
    process.env.IAM_WORKSPACE_MODE = '1'; const events: unknown[] = [];
    const registry = { callSlot: async () => ({ result: { valid: true } }) };
    const users = new UsersService(v, { get: () => ({ get: async () => registry }) } as never, { emit: (event: unknown) => events.push(event) } as never);
    users.init = async () => undefined; // The schema is the actual create-block result, not a boot-migration test.
    const before = await marker('workflow/owned');
    try {
      const result = await branchContext.run({ branch: 'workflow/owned' }, () => users.save('fictional.badge', { display_name: 'Updated Fictional', department: 'updated', workflow_creation_ref: 'not-adopted' }, false, undefined, 'fictional'));
      assert.ok(result); assert.equal(Object.hasOwn(result!, 'workflow_creation_ref'), false); assert.equal(await marker('workflow/owned'), before);
      assert.ok(events.length); assert.equal(JSON.stringify(events).includes(before), false); assert.equal(JSON.stringify(events).includes('workflow_creation_ref'), false);
    } finally { process.env.IAM_WORKSPACE_MODE = '0'; }
  });
  it('Dolt merge and local core activation preserve the marker, which is absent from the permission snapshot', async () => {
    process.env.IAM_WORKSPACE_MODE = '1'; const activation = new ActivationService({ get: async () => undefined } as never, new DoltService());
    const publisher = new WorkspacePublisher(v, { drop: () => undefined, get: async () => ({}) } as never, activation);
    try {
      const source = await head('workflow/owned'), before = await marker('workflow/owned');
      const result = await publisher.publishForRun({ tenant: 'fictional', runId: 'fixture-run', workflowId: 'fixture-workflow', branch: 'workflow/owned', expectedHead: source });
      assert.equal(result.published, true); assert.deepEqual(result.tables, ['identities']); assert.equal((await activation.current('fictional'))!.state, 'applied');
      const version = await (await fetch(`${bus.coreUrl}/v1/version?tenant=fictional`)).json() as { commit: string }; assert.equal(version.commit, result.mainCommit);
      assert.equal(await marker('main'), before); assert.equal(JSON.stringify(await new DoltService().snapshotAt(result.mainCommit, 'fictional')).includes('workflow_creation_ref'), false);
      const proof = await publisher.liveProof('fictional', source); assert.equal(proof.containsHead, true); assert.equal(proof.activation, 'applied');
    } finally { await activation.onModuleDestroy(); process.env.IAM_WORKSPACE_MODE = '0'; }
  });
  it('actual diffSummary table names still forbid publishing runtime settings before any merge', async () => {
    await branch('workflow/forbidden'); await on('workflow/forbidden', async c => { await c.query('CREATE TABLE plugin_runtime_settings (id varchar(20) primary key, value text)'); await commit(c); });
    process.env.IAM_WORKSPACE_MODE = '1'; const before = await root('main');
    const publisher = new WorkspacePublisher(v, { drop: () => undefined, get: async () => ({}) } as never, { applyEnabled: true } as never);
    try {
      const source = await head('workflow/forbidden');
      await assert.rejects(() => publisher.publishForRun({ tenant: 'fictional', runId: 'fixture-run', workflowId: 'fixture-workflow', branch: 'workflow/forbidden', expectedHead: source }), /plugin_runtime_settings/);
      assert.equal(await root('main'), before);
    } finally { process.env.IAM_WORKSPACE_MODE = '0'; }
  });
  it('named-column undo restores a removed marked row; cancelling a newly added identity removes its marker too', async () => {
    await branch('workflow/undo'); const before = await marker('main'), mainRoot = await root('main');
    await on('workflow/undo', async c => { await c.query('DELETE FROM identities WHERE id=?', ['fictional.badge']); await commit(c); });
    await v.discardChange('workflow/undo', 'main', 'identities', { id: 'fictional.badge' }, { expectedHead: await head('workflow/undo') }, 'fixture');
    assert.equal(await marker('workflow/undo'), before);
    await branch('workflow/cancel'); await externalBlock('lyam-create-user')!.run(context('workflow/cancel', 'fictional.cancel'));
    await v.discardChange('workflow/cancel', 'main', 'identities', { id: 'fictional.cancel' }, { expectedHead: await head('workflow/cancel') }, 'fixture');
    await on('workflow/cancel', async c => { const [r] = await c.query('SELECT count(*) n FROM identities WHERE id=?', ['fictional.cancel']); assert.equal(Number((r as { n: number }[])[0].n), 0); });
    assert.equal(await root('main'), mainRoot);
  });
  it('real Dolt deletion and both rename directions are refused before merge, and a failed real diff read also refuses', async () => {
    await on('main', async c => { await c.query('CREATE TABLE plugin_runtime_settings (id varchar(20) primary key, value text)'); await c.query('CREATE TABLE fixture_other_settings (id varchar(20) primary key, value text)'); await c.query("INSERT INTO plugin_runtime_settings VALUES ('fixture','original')"); await c.query("INSERT INTO fixture_other_settings VALUES ('fixture','other')"); await commit(c); });
    for (const [name, sql] of [
      ['workflow/removed', 'DROP TABLE plugin_runtime_settings'],
      ['workflow/renamed-away', 'RENAME TABLE plugin_runtime_settings TO fixture_renamed_settings'],
      ['workflow/renamed-toward', 'DROP TABLE plugin_runtime_settings; RENAME TABLE fixture_other_settings TO plugin_runtime_settings'],
    ]) {
      await branch(name); await on(name, async c => { for (const statement of sql.split(';')) await c.query(statement); await commit(c); });
      const source = await head(name), main = await root('main'); process.env.IAM_WORKSPACE_MODE = '1';
      const publisher = new WorkspacePublisher(v, { drop: () => undefined, get: async () => ({}) } as never, { applyEnabled: true } as never);
      try {
        const summary = await v.diffSummary('main', name, false); assert.ok(summary.tables.some(row => row.table === 'plugin_runtime_settings' || row.from === 'plugin_runtime_settings'), JSON.stringify(summary.tables));
        await assert.rejects(() => publisher.publishForRun({ tenant: 'fictional', runId: 'fixture-run', workflowId: 'fixture-workflow', branch: name, expectedHead: source }), /plugin_runtime_settings/);
        assert.equal(await root('main'), main, name);
      } finally { process.env.IAM_WORKSPACE_MODE = '0'; }
    }
    const bad = new VersioningService(), read = bad.diffSummary.bind(bad); bad.diffSummary = (_from, to, three) => read('fixture-missing-diff-ref', to, three);
    process.env.IAM_WORKSPACE_MODE = '1'; const main = await root('main');
    try {
      const publisher = new WorkspacePublisher(bad, { drop: () => undefined, get: async () => ({}) } as never, { applyEnabled: true } as never);
      const source = await head('workflow/removed');
      await assert.rejects(() => publisher.publishForRun({ tenant: 'fictional', runId: 'fixture-run', workflowId: 'fixture-workflow', branch: 'workflow/removed', expectedHead: source }), /could not be read/);
      assert.equal(await root('main'), main);
    } finally { process.env.IAM_WORKSPACE_MODE = '0'; }
  });
  it('typed editing and named SQL cannot write provenance; read-only operator inspection remains available', async () => {
    const before = await root('workflow/owned');
    assert.throws(() => v.editRows('workflow/owned', 'identities', [{ op: 'update', key: { id: 'fictional.badge' }, values: { workflow_creation_ref: 'forged' } }], undefined, 'fixture'), /provenance/);
    await assert.rejects(() => v.editRowChecked('workflow/owned', 'identities', { id: 'fictional.badge' }, { WORKFLOW_CREATION_REF: 'forged' }, undefined, undefined, 'fixture'), /provenance/);
    assert.throws(() => checkSql("UPDATE identities SET workflow_creation_ref='forged' WHERE id='fictional.badge'", 'write'), /provenance/);
    assert.doesNotThrow(() => checkSql('SELECT workflow_creation_ref FROM identities', 'read'));
    assert.equal(await root('workflow/owned'), before);
  });
});
