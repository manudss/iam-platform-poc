// MCP server end-to-end: REAL Dolt (branches, commits) + REAL Rust core (tokens, Cedar) + real NestJS API.
// Skipped with a clear message when the dolt or core binary is missing (CI provides both).
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { createServer, Server } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { branchContext } from '../workspace/context.js';
import type { Request, Response, NextFunction } from 'express';
import { startTestBus, TestBus } from '../testing/test-bus.js';
process.env.IAM_AI_KEY_SECRET ??= 'test-only-secret-0123456789abcdef';
process.env.IAM_AI_LOCAL_ENDPOINTS = '127.0.0.1:*,localhost:*,ollama:11434'; // fake model servers on random ports (the default list is exact host:port)

// Step 3 cleanup (decision 6): AppModule requires a reachable bus - one nats+core pair for this spec file.
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const root = resolve(process.cwd(), '../..');
const coreBin = resolve(root, 'core/target/debug/iam-core');
const which = spawnSync('sh', ['-c', 'command -v dolt']).stdout.toString().trim();
const doltBin = process.env.DOLT_BIN ?? (which || '/tmp/dolt-linux-amd64/bin/dolt');
const have = existsSync(doltBin) && existsSync(coreBin);
const DOLT_PORT = 13481, CORE = 'http://127.0.0.1:18181', API = 'http://127.0.0.1:13181';
const ADMIN = 'local-demo-admin-token', PW = 'demo-only-not-a-secret', REDIRECT = 'http://localhost:4200/callback';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (url: string, body: object, h: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
async function login(user: string): Promise<string> {
  const v = randomBytes(40).toString('base64url'), ch = createHash('sha256').update(v).digest('base64url');
  const { code } = (await (await post(`${CORE}/authorize`, { client_id: 'demo-web', redirect_uri: REDIRECT, code_challenge: ch, username: user, password: PW })).json()) as { code: string };
  return ((await (await post(`${CORE}/token`, { code, code_verifier: v, redirect_uri: REDIRECT, client_id: 'demo-web' })).json()) as { id_token: string }).id_token;
}

// AI assistant end-to-end: REAL Dolt + REAL Rust core + real NestJS API + a scripted fake model endpoint on 127.0.0.1.
// The assistant acts through the MCP tool surface as a branch-confined session; changes wait for the administrator.
const MODEL_PORT = 13482;
type Turn = { text?: string; calls?: { name: string; args: object }[] };
let script: Turn[] = [];
const modelSeen: { body: any; auth: string | undefined }[] = [];
let modelServer: Server;
let callId = 0;
const startModel = () => new Promise<void>((ok) => {
  modelServer = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
      const body = JSON.parse(raw); modelSeen.push({ body, auth: req.headers.authorization });
      const t = script.shift() ?? { text: 'done' };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: t.calls ? 'tool_calls' : 'stop', message: { content: t.text ?? '', ...(t.calls ? { tool_calls: t.calls.map((c) => ({ id: `call_${++callId}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}) } }] }));
    });
  }).listen(MODEL_PORT, '127.0.0.1', ok);
});

describe('AI assistant (real Dolt + real core): chat on the branch-confined MCP surface', { skip: !have && 'dolt or core binary missing' }, () => {
  let dolt: ChildProcess, core: ChildProcess, app: Awaited<ReturnType<typeof NestFactory.create>>, dir: string;
  let adminToken: string, bobToken: string, modelId = '', convId = '', branch = '';
  const H = () => ({ authorization: `Bearer ${adminToken}`, 'x-api-admin-token': ADMIN });
  const url = (p: string) => `${API}/tenants/acme-demo/ai/${p}`;
  type Reply = { status: string; messages: { role: string; content: string; toolCalls?: { id: string; name: string }[] }[]; pending: { id: string; name: string; kind: string; args: object }[]; trace: { tool: string; outcome: string }[] };
  const send = async (content: string) => (await post(url(`conversations/${convId}/messages`), { content }, H()));
  const sendOk = async (content: string) => { const r = await send(content); assert.equal(r.status, 201, await r.clone().text()); return (await r.json()) as Reply; };
  const decide = async (decisions: Record<string, string>) => { const r = await post(url(`conversations/${convId}/decisions`), { decisions }, H()); assert.equal(r.status, 201, await r.clone().text()); return (await r.json()) as Reply; };
  const bobAccountant = (t: string) => /\{[^{}]*demo-bob[^{}]*accountant[^{}]*\}|\{[^{}]*accountant[^{}]*demo-bob[^{}]*\}/.test(t);
  const assignments = async (b: string) => { const r = await fetch(`${API}/tenants/acme-demo/versioning/tables/assignments?limit=1000&ref=${encodeURIComponent(b)}`, { headers: H() }); return r.text(); };

  before(async () => {
    await startModel();
    dir = mkdtempSync(join(tmpdir(), 'iam-ai-'));
    const home = join(dir, 'home'), data = join(dir, 'data'); mkdirSync(home); mkdirSync(data);
    const env = { ...process.env, HOME: home };
    for (const [k, val] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(doltBin, ['config', '--global', '--add', k, val], { env });
    assert.equal(spawnSync(doltBin, ['sql'], { cwd: data, env, input: readFileSync(resolve(root, 'data/demo/01-schema.sql')) }).status, 0, 'seed failed');
    dolt = spawn(doltBin, ['sql-server', '--host', '127.0.0.1', '--port', String(DOLT_PORT), '--data-dir', data], { cwd: data, env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { if (spawnSync(doltBin, ['--host', '127.0.0.1', '--port', String(DOLT_PORT), '--no-tls', '-u', 'root', 'sql', '-q', 'select 1'], { env }).status === 0) break; await sleep(150); }
    core = spawn(coreBin, [], { cwd: resolve(root, 'core'), env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18181', IAM_CORE_NATS_URL: `127.0.0.1:${testBus!.natsPort}`, IAM_CORE_NATS_PASSWORD: 'core-dev', IAM_ISSUER: CORE, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar'), IAM_CORE_ADMIN_TOKEN: ADMIN }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${CORE}/health`)).ok) break; } catch { await sleep(100); } }
    delete process.env.IAM_PG_URL; delete process.env.IAM_CORE_GRPC_ADDR;
    Object.assign(process.env, { DOLT_PORT: String(DOLT_PORT), DOLT_DATABASE: 'iam', IAM_WORKSPACE_MODE: '1', IAM_CORE_URL: CORE, IAM_ISSUER: CORE, IAM_API_ADMIN_TOKEN: ADMIN, IAM_CORE_ADMIN_TOKEN: ADMIN, IAM_CREDENTIAL_FILE: join(dir, 'creds.json') });
    app = await NestFactory.create(AppModule, { logger: false });
    app.use((req: Request, _res: Response, next: NextFunction) => branchContext.run({ branch: typeof req.headers['x-iam-branch'] === 'string' ? req.headers['x-iam-branch'] : undefined }, next));
    await app.listen(13181);
    adminToken = await login('demo-alice'); bobToken = await login('demo-bob');
    // Same activation as the MCP spec: seeded main is applied once so Cedar decides the session calls.
    const hh = { ...H(), 'x-iam-branch': 'bootstrap-main' };
    const main = ((await (await fetch(`${API}/tenants/acme-demo/versioning/branches`, { headers: hh })).json()) as { branches: { name: string; commit: string }[] }).branches.find((b) => b.name === 'main')!.commit;
    await post(`${API}/tenants/acme-demo/versioning/branches`, { name: 'bootstrap-main', from: 'main' }, hh);
    assert.equal((await post(`${API}/tenants/acme-demo/workspace/apply`, { confirm: true, expectedHead: main }, hh)).status, 201);
  });
  after(async () => { await app?.close(); core?.kill(); dolt?.kill(); modelServer?.close(); await sleep(800); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

  it('is off until the plugins are enabled: the API answers 503, not a default', async () => {
    assert.equal((await fetch(url('models'), { headers: H() })).status, 503);
    const reg = app.get(PluginRegistry);
    for (const id of ['mcp-gateway', 'ai-assistant']) { await reg.install('acme-demo', id, {}); await reg.enable('acme-demo', id, {}); }
    assert.equal((await fetch(url('models'), { headers: H() })).status, 200);
  });

  it('only administrators reach it', async () => {
    assert.equal((await fetch(url('models'), { headers: { authorization: `Bearer ${bobToken}` } })).status >= 400, true);
    assert.equal((await fetch(url('models'))).status >= 400, true);
  });

  it('registers an external-style model: the key is sealed, never returned; the guard rails apply', async () => {
    const bad = await post(url('models'), { name: 'remote', kind: 'openai-compatible', model: 'gpt-x', baseUrl: 'http://api.example.com/v1', apiKey: 'sk-test-12345', acknowledgeDataSharing: true }, H());
    assert.equal(bad.status, 400, 'http to a remote host is refused');
    const noAck = await post(url('models'), { name: 'remote', kind: 'openai-compatible', model: 'gpt-x', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test-12345' }, H());
    assert.equal(noAck.status, 400, 'remote needs the data-sharing acknowledgement');
    const ok = await post(url('models'), { name: 'Scripted local', kind: 'openai-compatible', model: 'scripted', baseUrl: `http://127.0.0.1:${MODEL_PORT}/v1`, apiKey: 'sk-local-key-9999' }, H());
    assert.equal(ok.status, 201, await ok.clone().text());
    const m = (await ok.json()) as { id: string };
    modelId = m.id;
    const list = await (await fetch(url('models'), { headers: H() })).text();
    assert.ok(!list.includes('sk-local-key-9999'), 'the key is never returned');
    script = [{ text: 'ok' }];
    const t = (await (await post(url(`models/${modelId}/test`), {}, H())).json()) as { ok: boolean };
    assert.equal(t.ok, true);
    assert.equal(modelSeen.at(-1)!.auth, 'Bearer sk-local-key-9999', 'the stored key is used towards the endpoint');
  });

  it('a conversation owns a branch cut from main; a read tool runs without confirmation and is traced', async () => {
    const c = await post(url('conversations'), { modelId, title: 'Who are the users' }, H());
    assert.equal(c.status, 201, await c.clone().text());
    const created = (await c.json()) as { conversation: { id: string }; branch: string };
    convId = created.conversation.id; branch = created.branch;
    assert.match(branch, /^ai\/mcp-[0-9a-f]{12}$/);
    script = [{ calls: [{ name: 'list_users', args: {} }] }, { text: 'I found the users.' }];
    const r = await sendOk('List the users');
    assert.equal(r.status, 'done');
    assert.equal(r.messages.at(-1)!.content, 'I found the users.');
    assert.ok(r.messages.some((m) => m.role === 'tool' && /demo-alice/.test(m.content)), 'the tool result carries real data');
    const tools = modelSeen.at(-1)!.body.tools.map((t: { function: { name: string } }) => t.function.name);
    for (const forbidden of ['approve_pull_request', 'merge_pull_request', 'apply', 'merge']) assert.ok(!tools.includes(forbidden), forbidden);
    assert.ok(tools.includes('list_users') && tools.includes('submit_pull_request'));
    const act = (await (await fetch(`${API}/tenants/acme-demo/mcp-sessions/${branch.slice(3)}/activity`, { headers: H() })).json()) as { entries: { tool: string; allow: boolean }[] };
    assert.ok(act.entries.some((e) => e.tool === 'list_users' && e.allow), 'the call is in the MCP activity trace');
  });

  it('a change waits for the administrator: nothing is written until approved, then only on the branch', async () => {
    script = [{ calls: [{ name: 'assign_role', args: { identity: 'demo-bob', role: 'accountant' } }] }, { text: 'Role assigned on my branch.' }];
    const before = await assignments(branch);
    const r1 = await sendOk('Give demo-bob the accountant role');
    assert.equal(r1.status, 'needs_confirmation');
    assert.equal(r1.pending[0].name, 'assign_role'); assert.equal(r1.pending[0].kind, 'write');
    assert.equal(await assignments(branch), before, 'nothing written while waiting');
    const blocked = await send('another message while waiting');
    assert.equal(blocked.status, 409, 'a new message cannot skip the pending decision');
    const r2 = await decide({ [r1.pending[0].id]: 'approve' });
    assert.equal(r2.status, 'done');
    assert.equal(bobAccountant(await assignments(branch)), true, 'written on the session branch');
    assert.equal(bobAccountant(await assignments('main')), false, 'main is untouched');
  });

  it('a declined change is never executed', async () => {
    script = [{ calls: [{ name: 'assign_role', args: { identity: 'demo-alice', role: 'accountant' } }] }, { text: 'Understood, not done.' }];
    const r1 = await sendOk('Give demo-alice accountant');
    const r2 = await decide({ [r1.pending[0].id]: 'deny' });
    assert.equal(r2.status, 'done'); assert.equal(r2.trace[0].outcome, 'declined');
  });

  it('INJECTION: a poisoned tool result cannot make the assistant publish or read secrets', async () => {
    // The model "obeys" instructions hidden in data: it asks for tools that do not exist and for a write on a sensitive table.
    script = [
      { calls: [{ name: 'approve_pull_request', args: { id: 1 } }, { name: 'merge_to_main', args: {} }, { name: 'execute_write', args: { sql: "insert into credentials values ('x','y')" } }] },
      { text: 'Those were refused.' }];
    const r1 = await sendOk('Summarise the pending data');
    assert.equal(r1.status, 'needs_confirmation', 'the only known tool still needs the administrator');
    assert.equal(r1.pending.length, 1); assert.equal(r1.pending[0].name, 'execute_write');
    assert.equal(r1.trace.filter((t) => t.outcome === 'unknown-tool').length, 2);
    const r2 = await decide({ [r1.pending[0].id]: 'approve' });
    assert.equal(r2.messages.find((m) => m.role === 'tool')!.content.includes('not writable through MCP') || /Error|refus/i.test(r2.messages.find((m) => m.role === 'tool')!.content), true, 'even approved, the MCP confinement refuses a secret-like table');
    const act = (await (await fetch(`${API}/tenants/acme-demo/mcp-sessions/${branch.slice(3)}/activity`, { headers: H() })).json()) as { entries: { tool: string; allow: boolean }[] };
    assert.ok(act.entries.some((e) => e.tool === 'execute_write' && !e.allow), 'the refusal is traced as a denial');
  });

  it('another administrator cannot read the conversation, and deleting it revokes its session', async () => {
    assert.ok((await fetch(url(`conversations/${convId}`), { headers: { authorization: `Bearer ${bobToken}`, 'x-api-admin-token': ADMIN } })).status >= 404 - 0);
    const d = await fetch(url(`conversations/${convId}`), { method: 'DELETE', headers: H() });
    assert.equal(d.status, 200);
    const s = (await (await fetch(`${API}/tenants/acme-demo/mcp-sessions`, { headers: H() })).json()) as { sessions: { branch: string; revoked: boolean }[] };
    assert.equal(s.sessions.find((x) => x.branch === branch)!.revoked, true);
  });
});
