// MCP server end-to-end: REAL Dolt (branches, commits) + REAL Rust core (tokens, Cedar) + real NestJS API.
// Skipped with a clear message when the dolt or core binary is missing (CI provides both).
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { branchContext } from '../workspace/context.js';
import type { Request, Response, NextFunction } from 'express';
import { startTestBus, TestBus } from '../testing/test-bus.js';

// Step 3 cleanup (decision 6): AppModule requires a reachable bus - one nats+core pair for this spec file.
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const root = resolve(process.cwd(), '../..');
const coreBin = resolve(root, 'core/target/debug/iam-core');
const which = spawnSync('sh', ['-c', 'command -v dolt']).stdout.toString().trim();
const doltBin = process.env.DOLT_BIN ?? (which || '/tmp/dolt-linux-amd64/bin/dolt');
const have = existsSync(doltBin) && existsSync(coreBin);
const DOLT_PORT = 13471, CORE = 'http://127.0.0.1:18171', API = 'http://127.0.0.1:13171';
const ADMIN = 'local-demo-admin-token', PW = 'demo-only-not-a-secret', REDIRECT = 'http://localhost:4200/callback';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (url: string, body: object, h: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
async function login(user: string): Promise<string> {
  const v = randomBytes(40).toString('base64url'), ch = createHash('sha256').update(v).digest('base64url');
  const { code } = (await (await post(`${CORE}/authorize`, { client_id: 'demo-web', redirect_uri: REDIRECT, code_challenge: ch, username: user, password: PW })).json()) as { code: string };
  return ((await (await post(`${CORE}/token`, { code, code_verifier: v, redirect_uri: REDIRECT, client_id: 'demo-web' })).json()) as { id_token: string }).id_token;
}
/** Minimal JSON-RPC client for the stateless streamable HTTP endpoint: parses plain JSON and SSE replies. */
let rpcId = 0;
async function rpc(secret: string | undefined, method: string, params: unknown = {}, expectStatus = 200) {
  const res = await fetch(`${API}/tenants/acme-demo/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  assert.equal(res.status, expectStatus, `${method} -> ${res.status}`);
  if (expectStatus >= 400) return { status: res.status, authenticate: res.headers.get('www-authenticate') };
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('text/event-stream')) {
    const textEvents = (await res.text()).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    const last = textEvents.map((d) => { try { return JSON.parse(d); } catch { return null; } }).filter(Boolean).pop();
    return last ?? {};
  }
  return res.json();
}
const callTool = (secret: string | undefined, name: string, args: object = {}) => rpc(secret, 'tools/call', { name, arguments: args });
const textOf = (r: { result?: { content?: { text: string }[] } }) => r.result?.content?.[0]?.text ?? '';

describe('MCP server (real Dolt + real core): branch-confined, human-gated AI access', { skip: !have && 'dolt or core binary missing' }, () => {
  let dolt: ChildProcess, core: ChildProcess, app: Awaited<ReturnType<typeof NestFactory.create>>, dir: string;
  let adminToken: string, bobToken: string, secret = '', sessionId = '', branch = '';

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-mcp-'));
    const home = join(dir, 'home'), data = join(dir, 'data'); mkdirSync(home); mkdirSync(data);
    const env = { ...process.env, HOME: home };
    for (const [k, val] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(doltBin, ['config', '--global', '--add', k, val], { env });
    assert.equal(spawnSync(doltBin, ['sql'], { cwd: data, env, input: readFileSync(resolve(root, 'data/demo/01-schema.sql')) }).status, 0, 'seed failed');
    dolt = spawn(doltBin, ['sql-server', '--host', '127.0.0.1', '--port', String(DOLT_PORT), '--data-dir', data], { cwd: data, env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { if (spawnSync(doltBin, ['--host', '127.0.0.1', '--port', String(DOLT_PORT), '--no-tls', '-u', 'root', 'sql', '-q', 'select 1'], { env }).status === 0) break; await sleep(150); }
    core = spawn(coreBin, [], { cwd: resolve(root, 'core'), env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18171', IAM_CORE_NATS_URL: `127.0.0.1:${testBus!.natsPort}`, IAM_CORE_NATS_PASSWORD: 'core-dev', IAM_ISSUER: CORE, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar'), IAM_CORE_ADMIN_TOKEN: ADMIN }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${CORE}/health`)).ok) break; } catch { await sleep(100); } }
    delete process.env.IAM_PG_URL; delete process.env.IAM_CORE_GRPC_ADDR;
    Object.assign(process.env, { DOLT_PORT: String(DOLT_PORT), DOLT_DATABASE: 'iam', IAM_WORKSPACE_MODE: '1', IAM_CORE_URL: CORE, IAM_ISSUER: CORE, IAM_API_ADMIN_TOKEN: ADMIN, IAM_CORE_ADMIN_TOKEN: ADMIN, IAM_CREDENTIAL_FILE: join(dir, 'creds.json') });
    app = await NestFactory.create(AppModule, { logger: false });
    // Match main.ts: administration routes resolve the selected working branch from the header.
    app.use((req: Request, _res: Response, next: NextFunction) => branchContext.run({ branch: typeof req.headers['x-iam-branch'] === 'string' ? req.headers['x-iam-branch'] : undefined }, next));
    await app.listen(13171);
    adminToken = await login('demo-alice'); bobToken = await login('demo-bob');
  });
  after(async () => { await app?.close(); core?.kill(); dolt?.kill(); await sleep(800); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

  it('first human Apply activates seeded main without a fake data change (real core + Dolt)', async () => {
    const headers = { authorization: `Bearer ${adminToken}`, 'x-api-admin-token': ADMIN, 'x-iam-branch': 'bootstrap-main' };
    const branchesUrl = `${API}/tenants/acme-demo/versioning/branches`;
    const branches = async () => (await (await fetch(branchesUrl, { headers })).json()) as { branches: { name: string; commit: string }[] };
    const mainBefore = (await branches()).branches.find(b => b.name === 'main')!.commit;
    assert.equal((await fetch(`${CORE}/v1/version?tenant=acme-demo`)).status, 404, 'no version active initially');
    assert.equal((await post(branchesUrl, { name: 'bootstrap-main', from: 'main' }, headers)).status, 201);
    const apply = `${API}/tenants/acme-demo/workspace/apply`;
    assert.equal((await post(apply, {}, headers)).status, 400, 'human confirmation is still required');
    assert.equal((await post(apply, { confirm: true, expectedHead: 'changed-head' }, headers)).status, 409, 'stale review rejected');
    const response = await post(apply, { confirm: true, expectedHead: mainBefore }, headers);
    const result = await response.json() as { applied: boolean; commit: string; activation: { state: string } };
    assert.equal(response.status, 201, JSON.stringify(result));
    assert.equal(result.applied, true, JSON.stringify(result));
    assert.equal(result.activation.state, 'applied');
    assert.equal(result.commit, mainBefore, 'activation reuses main, no manufactured commit');
    assert.equal((await branches()).branches.find(b => b.name === 'main')!.commit, mainBefore, 'main did not move');
    const live = await (await fetch(`${CORE}/v1/version?tenant=acme-demo`)).json() as { commit: string };
    assert.equal(live.commit, mainBefore, 'real core loaded seeded main');
    assert.equal((await post(apply, { confirm: true }, headers)).status, 409, 'already active no-op is not re-published');
  });

  it('human merge of an MCP-authored PR publishes through Apply, never through MCP', async () => {
    const headers = { authorization: `Bearer ${adminToken}`, 'x-api-admin-token': ADMIN, 'x-iam-branch': 'human-pr' };
    const url = `${API}/tenants/acme-demo/versioning`;
    assert.equal((await post(`${url}/branches`, { name: 'human-pr', from: 'main' }, headers)).status, 201);
    assert.equal((await post(`${API}/tenants/acme-demo/workspace/assignment`, { identity: 'demo-alice', role: 'accountant' }, headers)).status, 201);
    const created = await post(`${url}/pulls`, { source: 'human-pr', target: 'main', title: 'Human-reviewed change' }, headers);
    const pr = await created.json() as { id: number };
    assert.equal(created.status, 201, JSON.stringify(pr));
    const merged = await post(`${url}/pulls/${pr.id}/merge`, {}, headers);
    const result = await merged.json() as { commit: string };
    assert.equal(merged.status, 201, JSON.stringify(result));
    const live = await (await fetch(`${CORE}/v1/version?tenant=acme-demo`)).json() as { commit: string };
    assert.equal(live.commit, result.commit, 'human PR merge activates the resulting main commit');
  });

  it('the MCP endpoint requires a session bearer token, with RFC 9728 discovery on 401', async () => {
    const noAuth = await rpc(undefined, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } }, 401);
    assert.match(String(noAuth.authenticate), /resource_metadata=.*\.well-known\/oauth-protected-resource/);
    const meta = await (await fetch(`${API}/.well-known/oauth-protected-resource/tenants/acme-demo/mcp`)).json() as { resource: string; bearer_methods_supported: string[] };
    assert.ok(meta.resource.endsWith('/tenants/acme-demo/mcp'));
    assert.deepEqual(meta.bearer_methods_supported, ['header']);
  });

  it('an admin creates a session: secret once, branch cut from main immediately', async () => {
    const res = await post(`${API}/tenants/acme-demo/mcp-sessions`, { label: 'Claude demo', ttl_seconds: 3600 }, { authorization: `Bearer ${adminToken}`, 'x-api-admin-token': ADMIN });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: string; secret: string; branch: string };
    secret = body.secret; sessionId = body.id; branch = body.branch;
    assert.match(sessionId, /^mcp-[0-9a-f]{12}$/); assert.equal(branch, sessionId);
    const branches = (await (await fetch(`${API}/tenants/acme-demo/versioning/branches`, { headers: { authorization: `Bearer ${adminToken}`, 'x-api-admin-token': ADMIN } })).json()) as { branches: { name: string }[] };
    assert.ok(branches.branches.some((x) => x.name === branch));
    // the secret is not retrievable afterwards
    const list = (await (await fetch(`${API}/tenants/acme-demo/mcp-sessions`, { headers: { authorization: `Bearer ${adminToken}`, 'x-api-admin-token': ADMIN } })).json()) as { sessions: Record<string, unknown>[] };
    assert.ok(!JSON.stringify(list).includes(secret));
  });

  it('handshake + tools/list: no approval, merge, close, apply or branch-picking tool exists', async () => {
    const init = await rpc(secret, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
    assert.equal(init.result?.serverInfo?.name, 'iam-platform-poc');
    const list = await rpc(secret, 'tools/list');
    const names = (list.result?.tools ?? []).map((t: { name: string }) => t.name);
    for (const t of ['list_users', 'query', 'read_table', 'execute_write', 'upsert_user', 'assign_role', 'request_new_branch', 'rebase_on_main', 'submit_pull_request', 'diff_vs_main', 'list_branches', 'list_pull_requests', 'session_status',
      'unassign_role', 'save_role', 'delete_role', 'add_sod_rule', 'remove_sod_rule', 'save_profile_config', 'create_organization', 'update_organization', 'delete_organization', 'assign_organizations',
      'install_plugin', 'configure_plugin', 'set_plugin_enabled', 'list_roles', 'list_organizations', 'list_plugins', 'list_event_records',
      'list_workflows', 'get_workflow', 'list_workflow_runs', 'save_workflow', 'delete_workflow', 'test_workflow', 'get_authn_config', 'save_authn_config']) assert.ok(names.includes(t), t);
    for (const t of names) assert.ok(!/approve|merge|close|apply|checkout/i.test(t), t);
    for (const t of names) assert.ok(!/start|cancel|publish|enroll|provision/i.test(t), t); // runs, publications and credentials stay human
  });

  it('reads: users without credential fields, arbitrary business data via read-only SQL', async () => {
    const users = JSON.parse(textOf(await callTool(secret, 'list_users'))) as { users: Record<string, unknown>[] };
    assert.ok(users.users.some((u) => u.id === 'demo-alice'));
    assert.ok(!JSON.stringify(users).match(/credential|password|hasCredential/i));
    const q = JSON.parse(textOf(await callTool(secret, 'query', { sql: 'select * from roles' }))) as { rows: { id: string }[] };
    assert.ok(q.rows.some((r) => r.id === 'mcp-operator'));
  });

  it('read confinement: outbox, credentials, meta database and information_schema are refused (adversarial shapes included)', async () => {
    for (const sql of ['select * from outbox', 'with x as (select * from outbox) select * from x', 'select credential_revision from identities', 'select * from iam_meta.mcp_sessions', 'select * from information_schema.tables']) {
      const r = await callTool(secret, 'query', { sql });
      assert.equal(r.result?.isError, true, sql);
    }
  });

  it('a session owned WITHOUT mcp-operator is denied by the policy engine, and the denial is traced', async () => {
    const res = await post(`${API}/tenants/acme-demo/mcp-sessions`, { label: 'bob session' }, { authorization: `Bearer ${bobToken}`, 'x-api-admin-token': ADMIN });
    const bobSecret = ((await res.json()) as { secret: string }).secret;
    const r = await callTool(bobSecret, 'list_users');
    assert.equal(r.result?.isError, true);
    assert.match(textOf(r), /denied/);
  });

  it('writes land ONLY on the session branch: main stays untouched', async () => {
    const w = await callTool(secret, 'execute_write', { sql: "insert into roles values ('auditor','Auditor',false)", message: 'add auditor role' });
    assert.notEqual(w.result?.isError, true, textOf(w));
    assert.ok(JSON.parse(textOf(w)).committed);
    const onMain = JSON.parse(textOf(await callTool(secret, 'query', { sql: "select count(*) n from roles where id='auditor'" }))) as { rows: { n: number }[] };
    assert.equal(Number(onMain.rows[0].n), 1); // on the session branch
    const direct = await post(`${API}/tenants/acme-demo/versioning/sql`, { ref: 'main', sql: "select count(*) n from roles where id='auditor'" }, { authorization: `Bearer ${adminToken}`, 'x-api-admin-token': ADMIN });
    assert.equal(Number(((await direct.json()) as { rows: { n: number }[] }).rows[0].n), 0); // main does not have it
  });

  it('upsert_user creates a user with login disabled and no known password', async () => {
    const r = JSON.parse(textOf(await callTool(secret, 'upsert_user', { id: 'mcp-carol', display_name: 'Carol MCP', department: 'sales' }))) as { created: boolean; user: { login_enabled: boolean } };
    assert.equal(r.created, true); assert.equal(r.user.login_enabled, false);
  });

  it('assign_role on the branch does NOT change live decisions: escalation only counts after a human merges+activates', async () => {
    await callTool(secret, 'assign_role', { identity: 'demo-bob', role: 'mcp-operator' });
    // live core still computes bob's roles from the ACTIVE version: bob still cannot use MCP
    const res = await post(`${API}/tenants/acme-demo/mcp-sessions`, { label: 'bob again' }, { authorization: `Bearer ${bobToken}`, 'x-api-admin-token': ADMIN });
    const bobSecret = ((await res.json()) as { secret: string }).secret;
    assert.equal((await callTool(bobSecret, 'list_users')).result?.isError, true);
  });

  it('request_new_branch cuts a FRESH branch from main (previous work stays behind)', async () => {
    const r = JSON.parse(textOf(await callTool(secret, 'request_new_branch', { reason: 'start over' }))) as { branch: string; from: string };
    assert.equal(r.from, 'main'); assert.notEqual(r.branch, branch);
    const direct = await post(`${API}/tenants/acme-demo/versioning/sql`, { ref: r.branch, sql: "select count(*) n from roles where id='auditor'" }, { authorization: `Bearer ${adminToken}`, 'x-api-admin-token': ADMIN });
    assert.equal(Number(((await direct.json()) as { rows: { n: number }[] }).rows[0].n), 0); // fresh from main: no auditor role
    branch = r.branch;
  });

  it('rebase_on_main merges main into the session branch and reports the result', async () => {
    const r = JSON.parse(textOf(await callTool(secret, 'rebase_on_main'))) as { mergeable: boolean };
    assert.equal(r.mergeable, true);
  });


  it('roles + SoD: full editing on the branch, main untouched, removals gated', async () => {
    const c = await callTool(secret, 'save_role', { id: 'auditor', label: 'Auditor', is_sensitive: false });
    assert.notEqual(c.result?.isError, true, textOf(c));
    const roles = JSON.parse(textOf(await callTool(secret, 'list_roles'))) as { roles: { id: string; label: string }[]; sodRules: unknown[] };
    assert.ok(roles.roles.some((r) => r.id === 'auditor'));
    await callTool(secret, 'save_role', { id: 'auditor', label: 'Auditor (read only)', is_sensitive: true });
    const onMain = await post(`${API}/tenants/acme-demo/versioning/sql`, { ref: 'main', sql: "select count(*) n from roles where id='auditor'" }, { authorization: `Bearer ${adminToken}`, 'x-api-admin-token': ADMIN });
    assert.equal(Number(((await onMain.json()) as { rows: { n: number }[] }).rows[0].n), 0); // main untouched
    await callTool(secret, 'add_sod_rule', { role_a: 'auditor', role_b: 'payment-approver' });
    assert.equal((await callTool(secret, 'delete_role', { id: 'auditor' })).result?.isError, true); // still named in a rule
    const noConfirm = await callTool(secret, 'remove_sod_rule', { role_a: 'auditor', role_b: 'payment-approver' });
    assert.ok(noConfirm.error || noConfirm.result?.isError, 'confirm=true is required'); // loosening a control needs confirmation
    await callTool(secret, 'remove_sod_rule', { role_a: 'auditor', role_b: 'payment-approver', confirm: true });
    assert.notEqual((await callTool(secret, 'delete_role', { id: 'auditor' })).result?.isError, true);
    await callTool(secret, 'assign_role', { identity: 'demo-bob', role: 'accountant' });
    const u = await callTool(secret, 'unassign_role', { identity: 'demo-bob', role: 'accountant' });
    assert.notEqual(u.result?.isError, true, textOf(u));
    const chk = JSON.parse(textOf(await callTool(secret, 'query', { sql: "select count(*) n from assignments where identity_id='demo-bob' and role_id='accountant'" }))) as { rows: { n: number }[] };
    assert.equal(Number(chk.rows[0].n), 0);
  });

  it('plugins + organizations: install/enable/configure on the branch only, unknown plugins and settings refused', async () => {
    assert.equal((await callTool(secret, 'install_plugin', { id: 'no-such-plugin' })).result?.isError, true);
    const inst = await callTool(secret, 'install_plugin', { id: 'organizations' });
    assert.notEqual(inst.result?.isError, true, textOf(inst));
    // organizations declares a packaged component screen: enabling it takes the uiComponents grant, which is console-only
    // by design (mcp-gateway's set_plugin_enabled never grants sensitive grants) — the MCP enable is refused fail-closed...
    assert.equal((await callTool(secret, 'set_plugin_enabled', { id: 'organizations', enabled: true })).result?.isError, true);
    // ...and the human path grants it explicitly through the admin API, on the same working branch.
    const en = await post(`${API}/tenants/acme-demo/plugins/organizations/enable`, { grants: { uiComponents: true } }, { authorization: `Bearer ${adminToken}`, 'x-api-admin-token': ADMIN, 'x-iam-branch': branch });
    assert.equal(en.status, 201);
    assert.equal((await callTool(secret, 'configure_plugin', { id: 'organizations', settings: { nope: 1 } })).result?.isError, true); // manifest has no such setting
    const onMain = await post(`${API}/tenants/acme-demo/versioning/sql`, { ref: 'main', sql: "select count(*) n from plugin_config where plugin='organizations'" }, { authorization: `Bearer ${adminToken}`, 'x-api-admin-token': ADMIN });
    assert.equal(Number(((await onMain.json()) as { rows: { n: number }[] }).rows[0].n), 0); // main untouched
    const plugs = JSON.parse(textOf(await callTool(secret, 'list_plugins'))) as { plugins: { id: string; enabled?: boolean; active?: boolean }[] };
    assert.ok(plugs.plugins.some((x) => x.id === 'organizations' && (x.enabled ?? x.active)));
    // organizations CRUD (plugin now enabled on the branch)
    const badId = await callTool(secret, 'create_organization', { id: 'BAD', name: 'x' });
    assert.ok(badId.error || badId.result?.isError, 'invalid org id refused');
    await callTool(secret, 'create_organization', { id: 'engineering', name: 'Engineering' });
    await callTool(secret, 'create_organization', { id: 'platform', name: 'Platform', parent_id: 'engineering' });
    await callTool(secret, 'update_organization', { id: 'platform', name: 'Platform team' });
    const orgs = JSON.parse(textOf(await callTool(secret, 'list_organizations'))) as { orgs: { id: string; name: string }[] };
    assert.deepEqual(orgs.orgs.map((o) => o.id).sort(), ['engineering', 'platform']);
    assert.equal(orgs.orgs.find((o) => o.id === 'platform')?.name, 'Platform team');
    await callTool(secret, 'assign_organizations', { subject: 'demo-bob', org_ids: ['platform'] });
    assert.equal((await callTool(secret, 'delete_organization', { id: 'engineering' })).result?.isError, true); // has a child
    assert.equal((await callTool(secret, 'delete_organization', { id: 'platform' })).result?.isError, true); // has a member
    await callTool(secret, 'assign_organizations', { subject: 'demo-bob', org_ids: [] });
    assert.notEqual((await callTool(secret, 'delete_organization', { id: 'platform' })).result?.isError, true);
    // live (main): no organization rows there at all
    const orgsMain = (await (await post(`${API}/tenants/acme-demo/versioning/sql`, { ref: 'main', sql: "select count(*) n from organizations where tenant='acme-demo'" }, { authorization: `Bearer ${adminToken}`, 'x-api-admin-token': ADMIN })).json()) as { rows?: { n: number }[] };
    assert.equal(Number(orgsMain.rows?.[0]?.n ?? 0), 0); // on main the table is empty or does not even exist yet
  });

  it('profile fields configuration: validated replace on the branch, unknown fields refused', async () => {
    assert.equal((await callTool(secret, 'save_profile_config', { config: { fields: { 'no.such-field': { enabled: true } } } })).result?.isError, true);
    const r = await callTool(secret, 'save_profile_config', { config: { fields: { 'base.department': { enabled: true, selfView: true, selfEdit: false, adminEdit: true } }, selfEditPolicy: 'review' } });
    assert.notEqual(r.result?.isError, true, textOf(r));
    const saved = JSON.parse(textOf(r)) as { fields: Record<string, unknown>; selfEditPolicy?: string };
    assert.equal(saved.selfEditPolicy, 'review');
    const onMain = await post(`${API}/tenants/acme-demo/versioning/sql`, { ref: 'main', sql: "select count(*) n from plugin_config where plugin='core-profile-fields'" }, { authorization: `Bearer ${adminToken}`, 'x-api-admin-token': ADMIN });
    assert.equal(Number(((await onMain.json()) as { rows: { n: number }[] }).rows[0].n), 0); // main untouched
  });

  it('sign-in configuration: read + replace on the branch, live sign-in unchanged, unknown methods refused', async () => {
    const beforeCfg = JSON.parse(textOf(await callTool(secret, 'get_authn_config'))) as { methods: unknown[] };
    assert.ok(Array.isArray(beforeCfg.methods));
    const cfg = { methods: [{ id: 'pin-keypad', type: 'digit-code', name: 'PIN keypad', enabled: true, level: 3, config: { length: 6 } }], chains: [{ id: 'pin-only', name: 'PIN only', enabled: true, steps: ['pin-keypad'], level: 3 }], defaultChain: 'pin-only' };
    const r = await callTool(secret, 'save_authn_config', { config: cfg });
    assert.notEqual(r.result?.isError, true, textOf(r));
    const afterCfg = JSON.parse(textOf(await callTool(secret, 'get_authn_config'))) as { methods: { id: string }[] };
    assert.equal(afterCfg.methods[0]?.id, 'pin-keypad');
    const onMain = await post(`${API}/tenants/acme-demo/versioning/sql`, { ref: 'main', sql: "select count(*) n from plugin_config where plugin='core-authn'" }, { authorization: `Bearer ${adminToken}`, 'x-api-admin-token': ADMIN });
    assert.equal(Number(((await onMain.json()) as { rows: { n: number }[] }).rows[0].n), 0); // nothing written to main
    assert.equal((await callTool(secret, 'save_authn_config', { config: { methods: [{ id: 'x', type: 'magic', name: 'x', enabled: true, level: 1, config: {} }], chains: [], defaultChain: null } })).result?.isError, true);
  });

  it('workflows: definitions are versioned - prepared on the branch, invisible live, runs not startable; feature gate applies', async () => {
    // feature gate: the workflows plugin is off on this fresh branch
    assert.equal((await callTool(secret, 'list_workflows')).result?.isError, true);
    await callTool(secret, 'install_plugin', { id: 'workflows-iga' });
    assert.notEqual((await callTool(secret, 'set_plugin_enabled', { id: 'workflows-iga', enabled: true })).result?.isError, true);
    const g = { nodes: [{ id: 'tell', type: 'notify', name: 'Inform', config: { recipient: 'ops', message: 'hello' } }], edges: [] };
    const c = await callTool(secret, 'save_workflow', { name: 'Notify ops', graph: g, trigger: null });
    assert.notEqual(c.result?.isError, true, textOf(c));
    const id = (JSON.parse(textOf(c)) as { definition: { id: string } }).definition.id;
    const got = JSON.parse(textOf(await callTool(secret, 'get_workflow', { id }))) as { definition: { id: string } };
    assert.equal(got.definition.id, id);
    assert.equal((await callTool(secret, 'save_workflow', { name: 'broken', graph: { nodes: [], edges: [{ from: 'x', to: 'y' }] } })).result?.isError, true); // invalid graph
    // main has no such definition, and the live console does not show it
    const onMain = await post(`${API}/tenants/acme-demo/versioning/sql`, { ref: 'main', sql: `select count(*) n from workflow_definitions where id='${id}'` }, { authorization: `Bearer ${adminToken}`, 'x-api-admin-token': ADMIN });
    assert.equal(Number(((await onMain.json()) as { rows: { n: number }[] }).rows[0].n), 0);
    await callTool(secret, 'save_workflow', { id, name: 'Notify ops v2', graph: g });
    assert.notEqual((await callTool(secret, 'delete_workflow', { id })).result?.isError, true);
    assert.notEqual((await callTool(secret, 'list_workflows')).result?.isError, true);
    assert.notEqual((await callTool(secret, 'list_workflow_runs', {})).result?.isError, true);
  });

  it('test_workflow: dry-run of the branch definition with zero effect (no run, no branch, no write)', async () => {
    const g = { nodes: [
      { id: 'grant', type: 'assign-role', name: 'Grant', config: { identity: '{{event.subject}}', role: 'accountant' } },
      { id: 'tell', type: 'notify', name: 'Inform', config: { recipient: 'ops', message: '{{event.subject}} granted' } },
    ], edges: [{ from: 'grant', to: 'tell' }] };
    const c = await callTool(secret, 'save_workflow', { name: 'Joiner test', graph: g, trigger: { event: 'user.created' } });
    assert.notEqual(c.result?.isError, true, textOf(c));
    const id = (JSON.parse(textOf(c)) as { definition: { id: string } }).definition.id;
    const countBob = async () => Number((JSON.parse(textOf(await callTool(secret, 'query', { sql: "select count(*) n from assignments where identity_id='demo-bob' and role_id='accountant'" }))) as { rows: { n: number }[] }).rows[0].n);
    const before = await countBob();
    const dry = JSON.parse(textOf(await callTool(secret, 'test_workflow', { id }))) as { executed: boolean; autoFilledEventKeys: string[]; steps: { step: string; simulated: boolean; would: string }[]; dataSteps: number };
    assert.equal(dry.executed, false);
    assert.ok(dry.autoFilledEventKeys.includes('subject')); // no payload given: trigger keys auto-filled
    assert.equal(dry.steps.length, 2);
    assert.equal(dry.steps[0].simulated, false); // a real data step: described, not executed
    assert.match(dry.steps[0].would, /NOT executed/);
    assert.equal(dry.steps[1].simulated, true);
    const dry2 = JSON.parse(textOf(await callTool(secret, 'test_workflow', { id, event: { subject: 'demo-bob' } }))) as { steps: { config: Record<string, unknown> }[]; autoFilledEventKeys: string[] };
    assert.equal(dry2.steps[0].config.identity, 'demo-bob');
    assert.ok(!dry2.autoFilledEventKeys.includes('subject')); // the provided key is used as-is
    // zero effect: no assignment written, no run recorded, no wf-* branch created
    assert.equal(await countBob(), before);
    const runs = JSON.parse(textOf(await callTool(secret, 'list_workflow_runs', { definition: id }))) as { runs: unknown[] };
    assert.equal(runs.runs.length, 0);
    const branches = JSON.parse(textOf(await callTool(secret, 'list_branches'))) as { branches: { name: string }[] };
    assert.ok(!branches.branches.some((x) => x.name.startsWith('wf-')));
    assert.notEqual((await callTool(secret, 'delete_workflow', { id })).result?.isError, true);
  });

  it('event bus: read-only scrubbed observability', async () => {
    const r = await callTool(secret, 'list_event_records', {});
    assert.notEqual(r.result?.isError, true, textOf(r));
    const b = JSON.parse(textOf(r)) as { records: unknown[]; enabled: boolean };
    assert.ok(Array.isArray(b.records));
    assert.ok(!JSON.stringify(b.records).match(/password|secret/i));
  });

  it('submit_pull_request opens a human-reviewed PR; the session then refuses more writes', async () => {
    await callTool(secret, 'execute_write', { sql: "insert into roles values ('auditor','Auditor',false)", message: 'add auditor role' });
    const r = JSON.parse(textOf(await callTool(secret, 'submit_pull_request', { title: 'AI: auditor role', body: 'prepared by MCP session' }))) as { pullRequest: { id: number; source: string; target: string; status: string } };
    assert.equal(r.pullRequest.source, branch); assert.equal(r.pullRequest.target, 'main'); assert.equal(r.pullRequest.status, 'open');
    assert.equal((await callTool(secret, 'execute_write', { sql: "insert into roles values ('x','X',false)" })).result?.isError, true);
  });

  it('the MCP secret opens NOTHING else: admin and publishing routes keep requiring the IdP', async () => {
    for (const path of ['/tenants/acme-demo/versioning/pulls', '/tenants/acme-demo/mcp-sessions']) {
      assert.equal((await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${secret}` } })).status, 401);
    }
    assert.equal((await post(`${API}/tenants/acme-demo/versioning/pulls/1/merge`, {}, { authorization: `Bearer ${secret}` })).status, 401);
    assert.equal((await post(`${API}/tenants/acme-demo/workspace/apply`, { confirm: true }, { authorization: `Bearer ${secret}` })).status, 401);
  });

  it('a revoked session is dead immediately', async () => {
    const del = await fetch(`${API}/tenants/acme-demo/mcp-sessions/${sessionId}`, { method: 'DELETE', headers: { authorization: `Bearer ${adminToken}`, 'x-api-admin-token': ADMIN } });
    assert.equal(del.status, 200);
    await rpc(secret, 'tools/list', {}, 401);
  });

  it('the activity trace records tools, target tables, denials and errors', async () => {
    const res = await fetch(`${API}/tenants/acme-demo/mcp-sessions/${sessionId}/activity?limit=100`, { headers: { authorization: `Bearer ${adminToken}`, 'x-api-admin-token': ADMIN } });
    const entries = ((await res.json()) as { entries: { tool: string; kind: string; targets: string[]; allow: boolean }[] }).entries;
    const tools = entries.map((e) => e.tool);
    for (const t of ['list_users', 'query', 'execute_write', 'submit_pull_request', 'save_role', 'create_organization', 'save_workflow', 'save_authn_config', 'install_plugin', 'list_event_records']) assert.ok(tools.includes(t), t);
    assert.ok(entries.some((e) => e.tool === 'query' && e.targets.includes('roles')));
    assert.ok(entries.every((e) => ['read', 'write', 'lifecycle'].includes(e.kind)));
    const denied = entries.filter((e) => !e.allow);
    assert.ok(denied.length >= 5); // the confinement refusals above
  });
});
