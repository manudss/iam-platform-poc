// Step 3: the audit trail rides the bus. Real nats-server + real core (bus on) + real NestJS API.
// - a /access/check decision lands in the trail ONCE, with the caller meta (source http) that rode in the
//   /v1/decide body - the local write is skipped because the core's access.decided covers it;
// - a decision sent straight to the core (no meta) lands with source 'core';
// - a registry audit event (plugin administration) lands as an audit.event with source 'plugin';
// - the bus journal survives a core restart: /v1/bus/records still serves the pre-restart records.
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'nats';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { BusHostRef } from './plugins/v1/bus-host.js';
import { AuditService } from './access/audit.service.js';
import { PluginRegistry } from './plugins/v1/registry.js';

const root = resolve(process.cwd(), '../..');
const coreBin = resolve(root, 'core/target/debug/iam-core');
const natsBin = process.env.NATS_SERVER_BIN;
const present = !!natsBin && existsSync(natsBin!) && existsSync(coreBin);
const NATS = 14230, CORE = 'http://127.0.0.1:18103', API = 'http://127.0.0.1:13103', REDIRECT = 'http://localhost:4200/callback', ADMIN = 'audit-bus-admin-token';
const PW = 'demo-only-not-a-secret'; // fictional local demo password
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (url: string, body: object, token?: string, h: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...h, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
async function login(user = 'demo-alice'): Promise<string> {
  const v = randomBytes(40).toString('base64url'), ch = createHash('sha256').update(v).digest('base64url');
  const { code } = (await (await post(`${CORE}/authorize`, { client_id: 'demo-web', redirect_uri: REDIRECT, code_challenge: ch, username: user, password: PW })).json()) as { code: string };
  return ((await (await post(`${CORE}/token`, { code, code_verifier: v, redirect_uri: REDIRECT, client_id: 'demo-web' })).json()) as { id_token: string }).id_token;
}
type Entry = { id: number; tenant: string; subject: string; principal: string; action: string; resource: string; allow: boolean; source: string; note?: string };

describe('audit via the bus (step 3)', { skip: !present && 'nats-server or core binary missing' }, () => {
  let nats: ChildProcess, core: ChildProcess, app: Awaited<ReturnType<typeof NestFactory.create>>;
  const dir = join(tmpdir(), 'iam-audit-bus-14230');
  const spawnCore = () => {
    core = spawn(coreBin, [], { cwd: resolve(root, 'core'), stdio: 'ignore', env: { ...process.env,
      IAM_CORE_NATS_URL: `127.0.0.1:${NATS}`, IAM_CORE_NATS_PASSWORD: 'core-dev',
      IAM_CORE_ADDR: '127.0.0.1:18103', IAM_ISSUER: CORE, IAM_CORE_ADMIN_TOKEN: ADMIN,
      IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar') } });
    core.unref();
  };
  const waitCore = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${CORE}/health`, { signal: AbortSignal.timeout(500) })).ok) return; } catch { await sleep(100); } } throw new Error('core did not start'); };
  before(async () => {
    delete process.env.IAM_PG_URL; delete process.env.IAM_CORE_GRPC_ADDR;
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    const conf = readFileSync(resolve(root, 'conf/nats-local.conf'), 'utf8').replace('127.0.0.1:4222', `127.0.0.1:${NATS}`).replace('/tmp/iam-nats-js', join(dir, 'js'));
    writeFileSync(join(dir, 'nats.conf'), conf);
    nats = spawn(natsBin!, ['-c', join(dir, 'nats.conf')], { stdio: 'ignore' }); nats.unref();
    for (let i = 0; i < 50; i++) { try { (await connect({ servers: `127.0.0.1:${NATS}`, timeout: 500 })).close(); break; } catch { await sleep(100); } }
    spawnCore(); await waitCore();
    Object.assign(process.env, { IAM_CORE_URL: CORE, IAM_ISSUER: CORE, IAM_CORE_ADMIN_TOKEN: ADMIN,
      IAM_BUS_NATS_URL: `127.0.0.1:${NATS}`, IAM_BUS_NATS_USER: 'api-host', IAM_BUS_NATS_PASSWORD: 'api-host-dev' });
    app = await NestFactory.create(AppModule, { logger: false }); await app.listen(13103);
    // The bus host connects asynchronously in the plugins-v1 factory; wait for it before deciding.
    const ref = app.get(BusHostRef);
    for (let i = 0; i < 100 && !ref.host; i++) await sleep(100);
    assert.ok(ref.host, 'bus host did not connect');
    // The decision-audit subscription must exist BEFORE the first decision: the core routes an event only to
    // subscriptions registered at emit time. The onModuleInit poll would cover it, but await it deterministically.
    await app.get(AuditService).ensureBusConsumer();
  });
  after(async () => {
    await app?.close(); core?.kill('SIGKILL'); nats?.kill('SIGKILL');
    delete process.env.IAM_BUS_NATS_URL; delete process.env.IAM_BUS_NATS_USER; delete process.env.IAM_BUS_NATS_PASSWORD;
    rmSync(dir, { recursive: true, force: true });
  });
  const check = (token: string, body: object = {}) => post(`${API}/access/check`, { action: 'Action::"approve"', resource: 'Request::"r1"', ...body }, token);
  const trail = async (token: string): Promise<Entry[]> =>
    ((await (await fetch(`${API}/tenants/acme-demo/audit`, { headers: { authorization: `Bearer ${token}` } })).json()) as { entries: Entry[] }).entries;
  const untilRow = async (token: string, match: (e: Entry) => boolean, what: string): Promise<Entry> => {
    for (let i = 0; i < 100; i++) { const hit = (await trail(token)).find(match); if (hit) return hit; await sleep(150); }
    throw new Error(`no trail row for ${what}`);
  };

  it('a decision through the API is trailed ONCE with the caller meta (source http), a direct core decision with source core', async () => {
    const t = await login();
    assert.equal((await post(`${CORE}/v1/activate`, { tenant: 'acme-demo', seq: 1, commit: 'abcdef12', snapshot: { assignments: [{ identity_id: 'demo-alice', role_id: 'payment-approver' }], sod_rules: [] } }, undefined, { 'x-core-admin-token': ADMIN })).status, 200);
    assert.equal(((await (await check(t)).json()) as { allow: boolean }).allow, true);
    const row = await untilRow(t, (e) => e.action === 'Action::"approve"' && e.resource === 'Request::"r1"', 'api decision');
    assert.equal(row.source, 'http');
    assert.equal(row.subject, 'demo-alice');
    assert.equal(row.allow, true);
    await sleep(400); // no double write: the local record is skipped when the bus covers the decision
    assert.equal((await trail(t)).filter((e) => e.action === 'Action::"approve"' && e.resource === 'Request::"r1"').length, 1);
    // A decision sent straight to the core carries no caller meta: the trail row falls back to source 'core'.
    await post(`${CORE}/v1/decide`, { tenant: 'acme-demo', principal: 'User::"demo-bob"', action: 'Action::"approve"', resource: 'Request::"r2"', context: {} });
    const direct = await untilRow(t, (e) => e.resource === 'Request::"r2"', 'direct core decision');
    assert.equal(direct.source, 'core');
    assert.equal(direct.subject, 'core');
  });

  it('plugin administration lands in the trail as audit.event (source plugin)', async () => {
    const t = await login();
    const registry = app.get(PluginRegistry);
    await registry.putCoreSettings('acme-demo', 'audit.test', { v: 1 });
    const row = await untilRow(t, (e) => e.source === 'plugin' && e.action === 'core.settings.changed', 'audit.event');
    assert.equal(row.resource, 'Plugin::"audit.test"');
    assert.equal(row.tenant, 'acme-demo');
  });

  it('direct Cedar administration is audited without exposing candidate content', async () => {
    const headers = { 'x-core-admin-token': ADMIN };
    await post(`${CORE}/v1/policies/validate`, { sets: [] }, undefined, headers);
    await post(`${CORE}/v1/policies/simulate`, { principal: 'User::"demo-alice"', action: 'Action::"approve"', resource: 'Request::"admin-test"', context: { secret: 'must-not-be-journaled' } }, undefined, headers);
    for (let i = 0; i < 50; i++) {
      const r = await (await fetch(`${CORE}/v1/bus/records?limit=500`, { headers })).json() as { records: { kind: string; payload: unknown }[] };
      const audits = r.records.filter(x => x.kind === 'policy.admin');
      if (audits.length >= 2) { assert.ok(!JSON.stringify(audits).includes('must-not-be-journaled')); return; }
      await sleep(100);
    }
    assert.fail('missing policy administration audit');
  });

  it('the bus journal survives a core restart: pre-restart records are still served', async () => {
    const records = async () => ((await (await fetch(`${CORE}/v1/bus/records?after=0&limit=500`, { headers: { 'x-core-admin-token': ADMIN } })).json()) as { records: { id: string; kind: string }[] }).records;
    let before_: { id: string; kind: string }[] = [];
    for (let i = 0; i < 50; i++) { before_ = await records(); if (before_.some((r) => r.kind === 'access.decided')) break; await sleep(150); }
    assert.ok(before_.length > 0, 'no bus records before restart');
    const decided = before_.filter((r) => r.kind === 'access.decided').map((r) => r.id);
    assert.ok(decided.length > 0, 'no access.decided record before restart');
    core.kill('SIGKILL'); await new Promise((r) => core.once('exit', r));
    spawnCore(); await waitCore();
    const after_ = await records();
    assert.ok(after_.length >= decided.length, 'journal replay refilled the ring');
    for (const id of decided) assert.ok(after_.some((r) => r.id === id && r.kind === 'access.decided'), `record ${id} lost across restart`);
  });
});
