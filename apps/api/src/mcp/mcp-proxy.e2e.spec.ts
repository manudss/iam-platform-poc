// MCP gateway (P1) end-to-end: REAL Dolt + REAL Rust core + REAL NestJS API + the fake upstream MCP
// (scripts/fake-upstream-mcp.mjs, a real child process). Skipped with a clear message when binaries are missing.
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

const root = resolve(process.cwd(), '../..');
const coreBin = resolve(root, 'core/target/debug/iam-core');
const which = spawnSync('sh', ['-c', 'command -v dolt']).stdout.toString().trim();
const doltBin = process.env.DOLT_BIN ?? (which || '/tmp/dolt-linux-amd64/bin/dolt');
const have = existsSync(doltBin) && existsSync(coreBin);
const DOLT_PORT = 13473, CORE = 'http://127.0.0.1:18173', API = 'http://127.0.0.1:13173', UP_PORT = 14103;
const UP_TOKEN = 'e2e-upstream-secret-token-DO-NOT-LEAK';
const ADMIN = 'local-demo-admin-token', PW = 'demo-only-not-a-secret', REDIRECT = 'http://localhost:4200/callback';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (url: string, body: object, h: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
async function login(user: string): Promise<string> {
  const v = randomBytes(40).toString('base64url'), ch = createHash('sha256').update(v).digest('base64url');
  const { code } = (await (await post(`${CORE}/authorize`, { client_id: 'demo-web', redirect_uri: REDIRECT, code_challenge: ch, username: user, password: PW })).json()) as { code: string };
  return ((await (await post(`${CORE}/token`, { code, code_verifier: v, redirect_uri: REDIRECT, client_id: 'demo-web' })).json()) as { id_token: string }).id_token;
}
let rpcId = 0;
async function rpc(secret: string | undefined, method: string, params: unknown = {}, expectStatus = 200) {
  const res = await fetch(`${API}/tenants/acme-demo/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  assert.equal(res.status, expectStatus, `${method} -> ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('text/event-stream')) {
    const events = (await res.text()).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    return events.map((d) => { try { return JSON.parse(d); } catch { return null; } }).filter(Boolean).pop() ?? {};
  }
  return res.json();
}
const callTool = (secret: string | undefined, name: string, args: object = {}) => rpc(secret, 'tools/call', { name, arguments: args });
const textOf = (r: { result?: { content?: { text: string }[] } }) => r.result?.content?.[0]?.text ?? '';

describe('MCP gateway P1 (real Dolt + core + fake upstream): registry, relay, trace', { skip: !have && 'dolt or core binary missing' }, () => {
  let dolt: ChildProcess, core: ChildProcess, upstream: ChildProcess, app: Awaited<ReturnType<typeof NestFactory.create>>, dir: string;
  let adminToken: string, bobToken: string, secret = '', sessionId = '', upstreamId = '';
  const adminH = () => ({ authorization: `Bearer ${adminToken}`, 'x-api-admin-token': ADMIN });
  const upstreamsUrl = `${API}/tenants/acme-demo/mcp-upstreams`;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-mcp-proxy-'));
    const home = join(dir, 'home'), data = join(dir, 'data'); mkdirSync(home); mkdirSync(data);
    const env = { ...process.env, HOME: home };
    for (const [k, val] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(doltBin, ['config', '--global', '--add', k, val], { env });
    assert.equal(spawnSync(doltBin, ['sql'], { cwd: data, env, input: readFileSync(resolve(root, 'data/demo/01-schema.sql')) }).status, 0, 'seed failed');
    dolt = spawn(doltBin, ['sql-server', '--host', '127.0.0.1', '--port', String(DOLT_PORT), '--data-dir', data], { cwd: data, env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { if (spawnSync(doltBin, ['--host', '127.0.0.1', '--port', String(DOLT_PORT), '--no-tls', '-u', 'root', 'sql', '-q', 'select 1'], { env }).status === 0) break; await sleep(150); }
    core = spawn(coreBin, [], { cwd: resolve(root, 'core'), env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18173', IAM_ISSUER: CORE, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar'), IAM_CORE_ADMIN_TOKEN: ADMIN }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${CORE}/health`)).ok) break; } catch { await sleep(100); } }
    upstream = spawn(process.execPath, [resolve(root, 'scripts/fake-upstream-mcp.mjs'), '--port', String(UP_PORT), '--token', UP_TOKEN], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${UP_PORT}/health`)).ok) break; } catch { await sleep(100); } }
    delete process.env.IAM_PG_URL; delete process.env.IAM_CORE_GRPC_ADDR;
    Object.assign(process.env, { DOLT_PORT: String(DOLT_PORT), DOLT_DATABASE: 'iam', IAM_WORKSPACE_MODE: '1', IAM_CORE_URL: CORE, IAM_ISSUER: CORE, IAM_API_ADMIN_TOKEN: ADMIN, IAM_CORE_ADMIN_TOKEN: ADMIN, IAM_CREDENTIAL_FILE: join(dir, 'creds.json') });
    app = await NestFactory.create(AppModule, { logger: false });
    app.use((req: Request, _res: Response, next: NextFunction) => branchContext.run({ branch: typeof req.headers['x-iam-branch'] === 'string' ? req.headers['x-iam-branch'] : undefined }, next));
    await app.listen(13173);
    adminToken = await login('demo-alice'); bobToken = await login('demo-bob');
  });
  after(async () => { await app?.close(); core?.kill(); dolt?.kill(); upstream?.kill(); await sleep(800); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

  it('activation: a human Apply publishes seeded main (needed for per-call decisions)', async () => {
    const headers = { ...adminH(), 'x-iam-branch': 'bootstrap-main' };
    const branchesUrl = `${API}/tenants/acme-demo/versioning/branches`;
    const mainBefore = ((await (await fetch(branchesUrl, { headers })).json()) as { branches: { name: string; commit: string }[] }).branches.find(b => b.name === 'main')!.commit;
    assert.equal((await post(branchesUrl, { name: 'bootstrap-main', from: 'main' }, headers)).status, 201);
    const applied = await post(`${API}/tenants/acme-demo/workspace/apply`, { confirm: true, expectedHead: mainBefore }, headers);
    assert.equal(applied.status, 201, JSON.stringify(await applied.json()));
  });

  it('registry: an admin registers the upstream; the token is never returned anywhere', async () => {
    const created = await post(upstreamsUrl, { name: 'fake', url: `http://127.0.0.1:${UP_PORT}`, token: UP_TOKEN }, adminH());
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json().catch(() => ({}))));
    const body = (await created.json()) as { id: string; name: string; url: string };
    upstreamId = body.id;
    assert.match(upstreamId, /^up-[0-9a-f]{12}$/);
    assert.ok(!JSON.stringify(body).includes(UP_TOKEN), 'creation response leaks the token');
    const list = await (await fetch(upstreamsUrl, { headers: adminH() })).json() as { upstreams: Record<string, unknown>[] };
    assert.equal(list.upstreams.length, 1);
    assert.ok(!JSON.stringify(list).includes(UP_TOKEN), 'list leaks the token');
    assert.ok(!JSON.stringify(list).match(/token_enc/i), 'list leaks the encrypted column');
  });

  it('registry validation: SSRF shapes and duplicates are refused', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data', 'http://intranet.example/mcp', 'ftp://x', 'https://user:pw@example.com/mcp', 'not-a-url'])
      assert.equal((await post(upstreamsUrl, { name: 'evil', url, token: 'x'.repeat(8) }, adminH())).status, 400, url);
    assert.equal((await post(upstreamsUrl, { name: 'fake', url: 'https://example.com', token: 'x'.repeat(8) }, adminH())).status, 400, 'duplicate name');
    assert.equal((await post(upstreamsUrl, { name: 'Bad Name', url: 'https://example.com', token: 'x'.repeat(8) }, adminH())).status, 400, 'bad name');
    assert.equal((await post(upstreamsUrl, { name: 'other', url: 'https://example.com', token: 'x' }, adminH())).status, 400, 'short token');
  });

  it('registry routes require an admin: the AI session secret gets 401 there', async () => {
    assert.equal((await fetch(upstreamsUrl)).status, 401);
    const s = await post(`${API}/tenants/acme-demo/mcp-sessions`, { label: 'gateway demo' }, adminH());
    const created = (await s.json()) as { secret: string; id: string };
    secret = created.secret; sessionId = created.id;
    const asAgent = await fetch(upstreamsUrl, { headers: { authorization: `Bearer ${secret}` } });
    assert.equal(asAgent.status, 401, 'an MCP session secret must not open admin routes');
  });

  it('test endpoint: ok against the fake upstream, and refreshes the tool count', async () => {
    const t = await post(`${upstreamsUrl}/${upstreamId}/test`, {}, adminH());
    const body = (await t.json()) as { ok: boolean; tools: string[]; error: string | null };
    assert.equal(t.status, 201); assert.equal(body.ok, true, body.error ?? '');
    assert.deepEqual(body.tools.sort(), ['createIssue', 'getIssue', 'searchIssues']);
    assert.ok(!JSON.stringify(body).includes(UP_TOKEN));
  });

  it('relay: upstream tools appear as <name>__<tool> in tools/list, with real schemas', async () => {
    const init = await rpc(secret, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
    assert.equal(init.result?.serverInfo?.name, 'iam-platform-poc');
    const list = await rpc(secret, 'tools/list');
    const tools = (list.result?.tools ?? []) as { name: string; description: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }[];
    const names = tools.map((t) => t.name);
    for (const t of ['fake__searchIssues', 'fake__getIssue', 'fake__createIssue']) assert.ok(names.includes(t), `${t} in ${names.join(',')}`);
    const get = tools.find((t) => t.name === 'fake__getIssue')!;
    assert.match(get.description, /^\[relay -> fake\]/, 'relayed descriptions are marked as untrusted upstream content');
    assert.ok(get.inputSchema?.properties?.key, 'upstream schema is served to the agent');
    assert.deepEqual(get.inputSchema?.required, ['key']);
    assert.ok(!JSON.stringify(list).includes(UP_TOKEN), 'tools/list leaks the upstream token');
  });

  it('relay: a proxied call returns upstream data and is traced with kind proxy (args hashed)', async () => {
    const r = await callTool(secret, 'fake__getIssue', { key: 'FAKE-101' });
    assert.notEqual(r.result?.isError, true, textOf(r));
    assert.match(textOf(r), /Migrate off the legacy IdP/);
    const w = await callTool(secret, 'fake__createIssue', { summary: 'Provision access for pilot', description: 'created by the AI through the gateway' });
    assert.notEqual(w.result?.isError, true, textOf(w));
    assert.match(textOf(r) + textOf(w), /FAKE-20/);
    const activity = await (await fetch(`${API}/tenants/acme-demo/mcp-sessions/${sessionId}/activity?limit=50`, { headers: adminH() })).json() as { entries: Record<string, unknown>[] };
    const proxied = activity.entries.filter((e) => e.kind === 'proxy');
    assert.ok(proxied.length >= 2, JSON.stringify(activity.entries.map((e) => e.kind)));
    assert.ok(proxied.every((e) => e.allow === true));
    assert.ok(proxied.some((e) => String(e.tool) === 'fake__getIssue' && String(e.detail).includes('args sha256:')));
    assert.ok(String(proxied[0].targets).includes(`127.0.0.1:${UP_PORT}`));
    const whole = JSON.stringify(activity);
    assert.ok(!whole.includes(UP_TOKEN), 'activity trace leaks the upstream token');
    assert.ok(!whole.includes('created by the AI through the gateway'), 'arguments are never traced in clear');
  });

  it('relay: an upstream error comes back as a tool error, traced, without the token', async () => {
    const r = await callTool(secret, 'fake__getIssue', { key: 'NOPE-1' });
    assert.equal(r.result?.isError, true);
    assert.match(textOf(r), /unknown issue key/);
    assert.ok(!textOf(r).includes(UP_TOKEN));
  });

  it('policy: a session without mcp-operator is denied on a proxied tool too (mcp:proxy)', async () => {
    const s = await post(`${API}/tenants/acme-demo/mcp-sessions`, { label: 'bob gateway' }, { authorization: `Bearer ${bobToken}`, 'x-api-admin-token': ADMIN });
    const bobSecret = ((await s.json()) as { secret: string }).secret;
    const r = await callTool(bobSecret, 'fake__getIssue', { key: 'FAKE-101' });
    assert.equal(r.result?.isError, true);
    assert.match(textOf(r), /denied/);
  });

  it('a bad-token upstream reports ok:false on test and its tools never appear', async () => {
    const bad = await post(upstreamsUrl, { name: 'bad', url: `http://127.0.0.1:${UP_PORT}`, token: 'wrong-token-entirely' }, adminH());
    const badId = ((await bad.json()) as { id: string }).id;
    const t = (await (await post(`${upstreamsUrl}/${badId}/test`, {}, adminH())).json()) as { ok: boolean; error: string | null };
    assert.equal(t.ok, false); assert.match(String(t.error), /HTTP 401/);
    assert.ok(!String(t.error).includes('wrong-token-entirely'));
    const list = await rpc(secret, 'tools/list');
    const names = ((list.result?.tools ?? []) as { name: string }[]).map((x) => x.name);
    assert.ok(!names.some((n) => n.startsWith('bad__')), 'unreachable upstream tools stay absent');
    assert.ok(names.includes('fake__getIssue'), 'other upstreams are unaffected');
    await fetch(`${upstreamsUrl}/${badId}`, { method: 'DELETE', headers: adminH() });
  });

  it('deleting the upstream removes its tools from the next tools/list', async () => {
    const res = await fetch(`${upstreamsUrl}/${upstreamId}`, { method: 'DELETE', headers: adminH() });
    assert.equal(res.status, 200);
    const list = await rpc(secret, 'tools/list');
    const names = ((list.result?.tools ?? []) as { name: string }[]).map((x) => x.name);
    assert.ok(!names.some((n) => n.startsWith('fake__')), JSON.stringify(names));
    const r = await callTool(secret, 'fake__getIssue', { key: 'FAKE-101' });
    assert.ok(r.error || r.result?.isError, 'calling a gone tool fails');
  });
});
