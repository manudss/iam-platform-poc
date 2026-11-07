// End-to-end login/methods flow on the SHIPPED image layout: plugins, trust store and the createRequire
// anchor live outside the repository tree, exactly like the Docker image (/app/plugins + /app/api). This is
// the regression test for the preview 502 on GET /tenants/acme-demo/signin/options.
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, cpSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { DoltService } from '../dolt/dolt.service.js';
import { AppModule } from '../app.module.js';
import { startTestBus, TestBus } from '../testing/test-bus.js';

let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const root = resolve(process.cwd(), '../..');
const bin = resolve(root, 'core/target/debug/iam-core');
const CORE = 'http://127.0.0.1:18083';
const API = 'http://127.0.0.1:13001';
const REDIRECT = 'http://localhost:4200/callback';
const DEMO_PASSWORD = 'demo-only-not-a-secret'; // fictional, local demo only

const post = (url: string, body: object) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function token(user: string, password: string): Promise<{ status: number; idToken?: string }> {
  const verifier = randomBytes(40).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const a = await post(`${CORE}/authorize`, { client_id: 'demo-web', redirect_uri: REDIRECT, code_challenge: challenge, username: user, password });
  if (a.status !== 200) return { status: a.status };
  const { code } = (await a.json()) as { code: string };
  const t = await post(`${CORE}/token`, { code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: 'demo-web' });
  return { status: 200, idToken: ((await t.json()) as { id_token: string }).id_token };
}

async function waitUp(url: string) {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${url}/health`)).ok) return; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)); }
}

describe('sign-in methods and login on the shipped image layout', { skip: !existsSync(bin) && 'core binary not built' }, () => {
  let core: ChildProcess;
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  const img = join(tmpdir(), `iam-image-layout-${process.pid}`);
  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string) => { if (!(k in saved)) saved[k] = process.env[k]; process.env[k] = v; };

  before(async () => {
    // The image layout: /app/plugins (signed plugins), /app/conf (public trust store), /app/api (package.json
    // anchor + node_modules the plugins resolve their dependencies from - symlinked here, installed in the image).
    mkdirSync(join(img, 'api'), { recursive: true });
    mkdirSync(join(img, 'conf'), { recursive: true });
    cpSync(resolve(root, 'plugins'), join(img, 'plugins'), { recursive: true });
    cpSync(resolve(root, 'conf/plugin-trust.json'), join(img, 'conf/plugin-trust.json'));
    writeFileSync(join(img, 'api/package.json'), JSON.stringify({ name: '@iam/api', version: '0.0.1' }));
    symlinkSync(resolve(process.cwd(), 'node_modules'), join(img, 'api/node_modules'), 'dir');
    setEnv('IAM_PLUGINS_DIR', join(img, 'plugins'));
    setEnv('IAM_PLUGIN_TRUST', join(img, 'conf/plugin-trust.json'));
    setEnv('IAM_API_PACKAGE_JSON', join(img, 'api/package.json'));

    core = spawn(bin, [], { env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18083', IAM_ISSUER: CORE, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar'), IAM_CORE_NATS_URL: `127.0.0.1:${testBus!.natsPort}`, IAM_CORE_NATS_PASSWORD: 'core-dev', IAM_CORE_ADMIN_TOKEN: 'signin-flow-spec-admin' }, stdio: 'ignore' });
    await waitUp(CORE);
    setEnv('IAM_CORE_URL', CORE); setEnv('IAM_ISSUER', CORE);
    setEnv('IAM_CORE_ADMIN_TOKEN', 'signin-flow-spec-admin'); setEnv('IAM_API_ADMIN_TOKEN', 'signin-flow-api-admin');
    app = await NestFactory.create(AppModule, { logger: false });
    app.get(DoltService).snapshotAt = async () => ({ assignments: [], sod_rules: [], mcp_grants: [] }); // no Dolt in this suite
    await app.listen(13001);
  });
  after(async () => {
    await app?.close(); core?.kill();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(img, { recursive: true, force: true });
  });

  it('the shipped plugins load from the image layout (auth-password among them)', async () => {
    const alice = await token('demo-alice', DEMO_PASSWORD);
    assert.ok(alice.idToken, 'demo-alice login failed');
    const r = await fetch(`${API}/tenants/acme-demo/plugins`, { headers: { authorization: `Bearer ${alice.idToken}` } });
    const text = await r.text();
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${text}`);
    const body = JSON.parse(text) as { plugins?: { id: string; enabled?: boolean }[] } | { id: string; enabled?: boolean }[];
    const list = Array.isArray(body) ? body : (body.plugins ?? []);
    assert.ok(list.some((p) => p.id === 'auth-password'), `auth-password missing from ${JSON.stringify(list.map((p) => p.id))}`);
  });

  it('GET /tenants/acme-demo/signin/options answers 200 with the offered methods (preview 502 regression)', async () => {
    const r = await fetch(`${API}/tenants/acme-demo/signin/options`);
    const text = await r.text();
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${text}`);
    const body = JSON.parse(text) as { mode: string; chains?: { id: string; steps: { name: string; type: string }[] }[] };
    assert.ok(body.mode === 'choice' || body.mode === 'legacy', `unexpected mode ${body.mode}`);
    if (body.mode === 'choice') {
      assert.ok(body.chains!.length > 0, 'choice mode without chains');
      for (const c of body.chains!) for (const s of c.steps) { assert.ok(s.name && s.type, 'every step names its method'); }
    }
  });

  it('demo-alice signs in end to end; a wrong password is refused', async () => {
    const bad = await token('demo-alice', 'wrong-password');
    assert.notEqual(bad.status, 200, 'a wrong password must be refused');
    const good = await token('demo-alice', DEMO_PASSWORD);
    assert.ok(good.idToken, 'expected an id_token');
  });
});
