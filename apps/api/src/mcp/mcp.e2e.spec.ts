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
    core = spawn(coreBin, [], { cwd: resolve(root, 'core'), env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18171', IAM_ISSUER: CORE, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar'), IAM_CORE_ADMIN_TOKEN: ADMIN }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${CORE}/health`)).ok) break; } catch { await sleep(100); } }
    // tenant data as on main after the demo seed: alice is the MCP operator, bob is not
    const act = await post(`${CORE}/v1/activate`, { tenant: 'acme-demo', seq: 1, commit: 'seed', snapshot: { assignments: [{ identity_id: 'demo-alice', role_id: 'mcp-operator' }, { identity_id: 'demo-bob', role_id: 'payment-creator' }], sod_rules: [{ role_a: 'payment-creator', role_b: 'payment-approver' }] } }, { 'x-core-admin-token': ADMIN });
    assert.equal(act.status, 200);
    delete process.env.IAM_PG_URL; delete process.env.IAM_CORE_GRPC_ADDR;
    Object.assign(process.env, { DOLT_PORT: String(DOLT_PORT), DOLT_DATABASE: 'iam', IAM_WORKSPACE_MODE: '1', IAM_CORE_URL: CORE, IAM_ISSUER: CORE, IAM_API_ADMIN_TOKEN: ADMIN, IAM_CREDENTIAL_FILE: join(dir, 'creds.json') });
    app = await NestFactory.create(AppModule, { logger: false }); await app.listen(13171);
    adminToken = await login('demo-alice'); bobToken = await login('demo-bob');
  });
  after(async () => { await app?.close(); core?.kill(); dolt?.kill(); await sleep(800); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

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
    for (const t of ['list_users', 'query', 'read_table', 'execute_write', 'upsert_user', 'assign_role', 'request_new_branch', 'rebase_on_main', 'submit_pull_request', 'diff_vs_main', 'list_branches', 'list_pull_requests', 'session_status']) assert.ok(names.includes(t), t);
    for (const t of names) assert.ok(!/approve|merge|close|apply|checkout/i.test(t), t);
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
    for (const t of ['list_users', 'query', 'execute_write', 'submit_pull_request']) assert.ok(tools.includes(t), t);
    assert.ok(entries.some((e) => e.tool === 'query' && e.targets.includes('roles')));
    assert.ok(entries.every((e) => ['read', 'write', 'lifecycle'].includes(e.kind)));
    const denied = entries.filter((e) => !e.allow);
    assert.ok(denied.length >= 5); // the confinement refusals above
  });
});
