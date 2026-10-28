// gRPC NestJS client -> REAL Rust core (tonic server on IAM_CORE_GRPC_ADDR). The same decision is compared with HTTP /v1/decide.
// Not covered: TLS/auth on the gRPC port (plaintext loopback POC), streaming, gRPC for /v1/activate (still HTTP).
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CoreGrpc } from './access/core-grpc.js';

const root = resolve(process.cwd(), '../..');
const coreBin = resolve(root, 'core/target/debug/iam-core');
const HTTP = 'http://127.0.0.1:18096', GRPC = '127.0.0.1:18097', ADMIN = 'local-demo-admin-token';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('gRPC decision (real core over tonic)', { skip: !existsSync(coreBin) && 'core binary missing' }, () => {
  let core: ChildProcess, g: CoreGrpc;
  before(async () => {
    core = spawn(coreBin, [], { cwd: resolve(root, 'core'), env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18096', IAM_CORE_GRPC_ADDR: GRPC, IAM_ISSUER: HTTP, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar'), IAM_CORE_ADMIN_TOKEN: ADMIN }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${HTTP}/health`)).ok) break; } catch { await sleep(100); } }
    g = new CoreGrpc(GRPC);
  });
  after(() => { g?.close(); core?.kill(); });

  const http = async (b: object) => (await (await fetch(`${HTTP}/v1/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json()) as { allow: boolean };
  const base = { principal: 'User::"demo-alice"', action: 'Action::"approve"', resource: 'Request::"r1"' };

  it('allow and deny over gRPC equal the HTTP answer', async () => {
    for (const context of [{ roles: ['payment-approver'], sod_conflict: false }, { roles: [], sod_conflict: false }, { roles: ['payment-approver'], sod_conflict: true }]) {
      const r = await g.decide({ ...base, context });
      assert.equal(r.allow, (await http({ ...base, context })).allow, JSON.stringify(context));
    }
    assert.equal((await g.decide({ ...base, context: { roles: ['payment-approver'], sod_conflict: false } })).allow, true);
  });
  it('tenant mode over gRPC is fail closed without an active version, then uses the activated data (caller roles ignored)', async () => {
    const t = { ...base, tenant: 'acme-demo', context: { roles: ['payment-approver'] } };
    const before = await g.decide(t);
    assert.equal(before.allow, false); assert.deepEqual(before.reasons, ['no-active-version']);
    const act = await fetch(`${HTTP}/v1/activate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-core-admin-token': ADMIN },
      body: JSON.stringify({ tenant: 'acme-demo', seq: 1, commit: 'abcdef12', snapshot: { assignments: [{ identity_id: 'demo-alice', role_id: 'payment-approver' }], sod_rules: [] } }) });
    assert.equal(act.status, 200);
    const after = await g.decide({ ...t, context: {} });
    assert.equal(after.allow, true); assert.deepEqual(after.version, { seq: 1, commit: 'abcdef12' });
    assert.equal((await g.decide({ ...t, principal: 'User::"demo-bob"', context: { roles: ['payment-approver'] } })).allow, false);
  });
  it('unreachable core: the client call fails (the controller turns that into a deny)', async () => {
    const dead = new CoreGrpc('127.0.0.1:1');
    await assert.rejects(dead.decide(base, 800)); dead.close();
  });
});
