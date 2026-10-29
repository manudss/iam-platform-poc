// End-to-end with a REAL Dolt SQL server (no Docker): simulate on a branch, SoD refusal, merge, activation of the merged commit.
// Skipped with a clear message if the dolt binary or the core binary is missing (set DOLT_BIN to the dolt path).
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const root = resolve(process.cwd(), '../..');
const coreBin = resolve(root, 'core/target/debug/iam-core');
const which = spawnSync('sh', ['-c', 'command -v dolt']).stdout.toString().trim();
const doltBin = process.env.DOLT_BIN ?? (which || '/tmp/dolt-linux-amd64/bin/dolt');
const have = existsSync(coreBin) && existsSync(doltBin);
const CORE = 'http://127.0.0.1:18091', API = 'http://127.0.0.1:13010', REDIRECT = 'http://localhost:4200/callback';
const PW = 'demo-only-not-a-secret'; // fictional, local demo only

process.env.IAM_API_ADMIN_TOKEN ??= 'local-demo-simulation-token'; // admin capability for the mutating routes
const j = (url: string, method: string, token?: string, body?: object) =>
  fetch(url, { method, headers: { 'content-type': 'application/json', ...(process.env.IAM_API_ADMIN_TOKEN ? { 'x-api-admin-token': process.env.IAM_API_ADMIN_TOKEN } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });

async function login(): Promise<string> {
  const v = randomBytes(40).toString('base64url');
  const ch = createHash('sha256').update(v).digest('base64url');
  const { code } = (await (await j(`${CORE}/authorize`, 'POST', undefined, { client_id: 'demo-web', redirect_uri: REDIRECT, code_challenge: ch, username: 'demo-alice', password: PW })).json()) as { code: string };
  return ((await (await j(`${CORE}/token`, 'POST', undefined, { code, code_verifier: v, redirect_uri: REDIRECT, client_id: 'demo-web' })).json()) as { id_token: string }).id_token;
}

describe('e2e api + real Dolt', { skip: !have && 'dolt or core binary missing' }, () => {
  let dolt: ChildProcess, core: ChildProcess, app: Awaited<ReturnType<typeof NestFactory.create>>, dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-dolt-'));
    const home = join(dir, 'home'), data = join(dir, 'data'); mkdirSync(home); mkdirSync(data);
    const env = { ...process.env, HOME: home };
    for (const [k, v] of [['user.name', 'poc'], ['user.email', 'poc@example.invalid']]) spawnSync(doltBin, ['config', '--global', '--add', k, v], { env });
    const seed = spawnSync(doltBin, ['sql'], { cwd: data, env, input: readFileSync(resolve(root, 'data/demo/01-schema.sql')) });
    assert.equal(seed.status, 0, 'seed failed: ' + seed.stderr);
    dolt = spawn(doltBin, ['sql-server', '--host', '127.0.0.1', '--port', '13307', '--data-dir', data], { cwd: data, env, stdio: 'ignore' });
    core = spawn(coreBin, [], { env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18091', IAM_ISSUER: CORE, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar') }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { // wait for both
      try { if ((await fetch(`${CORE}/health`)).ok && spawnSync(doltBin, ['--host', '127.0.0.1', '--port', '13307', '--no-tls', '-u', 'root', 'sql', '-q', 'select 1'], { env }).status === 0) break; } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    Object.assign(process.env, { IAM_CORE_URL: CORE, IAM_ISSUER: CORE, DOLT_PORT: '13307', DOLT_DATABASE: 'iam' });
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(13010);
  });
  after(async () => { await app?.close(); dolt?.kill(); core?.kill(); await new Promise((r) => setTimeout(r, 800)); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

  const T = 'tenants/acme-demo';
  it('reads seeded assignments from Dolt', async () => {
    const r = await j(`${API}/${T}/assignments`, 'GET', await login());
    assert.deepEqual(await r.json(), [{ identity_id: 'demo-bob', role_id: 'payment-creator' }]);
  });
  it('simulation on a branch finds the SoD violation, main stays untouched, merge is refused', async () => {
    const t = await login();
    const sim = (await (await j(`${API}/${T}/changes`, 'POST', t, { identity: 'demo-bob', role: 'payment-approver' })).json()) as { branch: string; mergeable: boolean; violations: unknown[] };
    assert.equal(sim.mergeable, false);
    assert.equal(sim.violations.length, 1);
    assert.equal(((await (await j(`${API}/${T}/assignments`, 'GET', t)).json()) as unknown[]).length, 1);
    assert.equal((await j(`${API}/${T}/changes/${sim.branch}/merge`, 'POST', t)).status, 409);
    assert.equal(((await (await j(`${API}/${T}/assignments`, 'GET', t)).json()) as unknown[]).length, 1);
  });
  it('conflict-free change merges and the merged commit can be activated', async () => {
    const t = await login();
    const sim = (await (await j(`${API}/${T}/changes`, 'POST', t, { identity: 'demo-alice', role: 'accountant' })).json()) as { branch: string; mergeable: boolean };
    assert.equal(sim.mergeable, true);
    const m = await j(`${API}/${T}/changes/${sim.branch}/merge`, 'POST', t);
    assert.equal(m.status, 201);
    const { commit } = (await m.json()) as { commit: string };
    assert.equal(((await (await j(`${API}/${T}/assignments`, 'GET', t)).json()) as unknown[]).length, 2);
    const act = (await (await j(`${API}/${T}/activations`, 'POST', t, {})).json()) as { seq: number; commit: string };
    assert.equal(act.commit, commit);
  });
  it('rejects unknown identity, bad names, no token and wrong tenant', async () => {
    const t = await login();
    assert.equal((await j(`${API}/${T}/changes`, 'POST', t, { identity: 'ghost', role: 'accountant' })).status, 400);
    assert.equal((await j(`${API}/${T}/changes`, 'POST', t, { identity: "x'; drop table roles;--", role: 'accountant' })).status, 400);
    assert.equal((await j(`${API}/${T}/changes/change-zzzzzzzz/merge`, 'POST', t)).status, 400);
    assert.equal((await j(`${API}/${T}/assignments`, 'GET')).status, 401);
    assert.equal((await j(`${API}/tenants/other/assignments`, 'GET', t)).status, 403);
  });
  it('CSV connector: import lands on a branch, SoD is simulated, main untouched, merge applies it', async () => {
    const t = await login();
    const csv = 'identity_id,display_name,manager_id,department,role_id\ndemo-carol,"Carol, Demo",demo-alice,hr,accountant\n';
    const count = async () => ((await (await j(`${API}/${T}/assignments`, 'GET', t)).json()) as unknown[]).length;
    const base = await count();
    const r = await j(`${API}/${T}/connectors/csv`, 'POST', t, { csv });
    assert.equal(r.status, 201);
    assert.equal(await count(), base); // main untouched before merge
    const imp = (await r.json()) as { branch: string; mergeable: boolean; rows: number };
    assert.equal(imp.rows, 1); assert.equal(imp.mergeable, true);
    assert.equal((await j(`${API}/${T}/changes/${imp.branch}/merge`, 'POST', t)).status, 201);
    assert.equal(await count(), base + 1);
  });
  it('CSV connector: SoD conflict in the file is reported and cannot be merged; bad input is 400', async () => {
    const t = await login();
    const bad = 'identity_id,display_name,manager_id,department,role_id\ndemo-bob,Bob Demo,,finance,payment-approver\n';
    const imp = (await (await j(`${API}/${T}/connectors/csv`, 'POST', t, { csv: bad })).json()) as { branch: string; mergeable: boolean };
    assert.equal(imp.mergeable, false);
    assert.equal((await j(`${API}/${T}/changes/${imp.branch}/merge`, 'POST', t)).status, 409);
    for (const csv of ['wrong,header\n', 'identity_id,display_name,manager_id,department,role_id\nx;drop,N,,d,accountant\n', 'identity_id,display_name,manager_id,department,role_id\nok-id,N,,d,nope\n'])
      assert.equal((await j(`${API}/${T}/connectors/csv`, 'POST', t, { csv })).status, 400);
    assert.equal((await j(`${API}/${T}/connectors/csv`, 'POST', undefined, { csv: bad })).status, 401);
  });
  it('SCIM-like connector: import lands on a branch (inactive/role-less users skipped), SoD conflict is reported, bad input is 400', async () => {
    const t = await login();
    const EXT = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
    const count = async () => ((await (await j(`${API}/${T}/assignments`, 'GET', t)).json()) as unknown[]).length;
    const base = await count();
    const ok = { Resources: [
      { userName: 'demo-dave', displayName: 'Dave Demo', active: true, roles: [{ value: 'accountant' }], [EXT]: { department: 'finance', manager: { value: 'demo-alice' } } },
      { userName: 'demo-erin', displayName: 'Erin Demo', active: false, roles: [{ value: 'accountant' }] },
      { userName: 'demo-frank', displayName: 'Frank Demo', active: true } ] };
    const r = await j(`${API}/${T}/connectors/scim`, 'POST', t, ok);
    assert.equal(r.status, 201);
    const imp = (await r.json()) as { branch: string; mergeable: boolean; rows: number; skipped: number };
    assert.deepEqual([imp.rows, imp.skipped, imp.mergeable], [1, 2, true]);
    assert.equal(await count(), base); // main untouched before merge
    assert.equal((await j(`${API}/${T}/changes/${imp.branch}/merge`, 'POST', t)).status, 201);
    assert.equal(await count(), base + 1);
    const bad = { Resources: [{ userName: 'demo-bob', displayName: 'Bob Demo', roles: [{ value: 'payment-approver' }] }] };
    const sod = (await (await j(`${API}/${T}/connectors/scim`, 'POST', t, bad)).json()) as { branch: string; mergeable: boolean };
    assert.equal(sod.mergeable, false);
    assert.equal((await j(`${API}/${T}/changes/${sod.branch}/merge`, 'POST', t)).status, 409);
    for (const body of [{}, { Resources: [] }, { Resources: [{ userName: "x';drop", displayName: 'N', roles: [{ value: 'accountant' }] }] }, { Resources: [{ userName: 'ok-id', displayName: 'N', roles: [{ value: 'nope' }] }] }, { Resources: [{ userName: 'ok-id', displayName: 'N', active: false }] }])
      assert.equal((await j(`${API}/${T}/connectors/scim`, 'POST', t, body)).status, 400);
    assert.equal((await j(`${API}/${T}/connectors/scim`, 'POST', undefined, ok)).status, 401);
  });
});
