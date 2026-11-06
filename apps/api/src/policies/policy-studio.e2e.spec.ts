// REAL Rust core (built binary) + the API's catalogue source: the rules the core loaded come back with readable names, and a decision's reasons
// carry the same names the audit stores. Skipped when core/target/debug/iam-core is missing (the CI api job builds it).
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CorePolicySource } from './policy-studio.js';
import { AuditService } from '../access/audit.service.js';

const root = resolve(process.cwd(), '../..'), coreBin = resolve(root, 'core/target/debug/iam-core'), have = existsSync(coreBin);
const CORE = 'http://127.0.0.1:18097', ADMIN = 'local-demo-admin-token'; // local fictional value
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('policy-studio with the real core', { skip: !have && 'the core binary is missing' }, () => {
  let core: ChildProcess; const env = { u: process.env.IAM_CORE_URL, t: process.env.IAM_CORE_ADMIN_TOKEN };
  before(async () => {
    core = spawn(coreBin, [], { cwd: resolve(root, 'core'), stdio: 'ignore', env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18097', IAM_ISSUER: CORE, IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar'), IAM_CORE_ADMIN_TOKEN: ADMIN } });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${CORE}/health`)).ok) break; } catch { /* starting */ } await sleep(100); }
    process.env.IAM_CORE_URL = CORE; process.env.IAM_CORE_ADMIN_TOKEN = ADMIN;
  });
  after(() => { core?.kill(); if (env.u) process.env.IAM_CORE_URL = env.u; else delete process.env.IAM_CORE_URL; if (env.t) process.env.IAM_CORE_ADMIN_TOKEN = env.t; else delete process.env.IAM_CORE_ADMIN_TOKEN; });

  it('lists the six demo rules by name and refuses a caller without the admin token', async () => {
    const c = await new CorePolicySource().catalog();
    assert.deepEqual(c.rules.map((r) => r.id).sort(), ['approve-needs-payment-approver', 'demo-alice-approves', 'demo-bob-reads', 'mcp-operator-read-write-lifecycle', 'mcp-proxy-needs-delegation-grant', 'sod-blocks-approve']);
    assert.equal(c.rules.find((r) => r.id === 'sod-blocks-approve')!.effect, 'forbid');
    assert.equal((await fetch(`${CORE}/v1/policies`)).status, 401);
  });
  it('a denied decision names the forbid rule, and the audit stores that name', async () => {
    const res = await fetch(`${CORE}/v1/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ principal: 'User::"alice"', action: 'Action::"approve"', resource: 'Request::"r1"', context: { sod_conflict: true } }) });
    const out = await res.json() as { allow: boolean; reasons: string[] };
    assert.equal(out.allow, false); assert.deepEqual(out.reasons, ['sod-blocks-approve']);
    const audit = new AuditService(); delete process.env.IAM_PG_URL;
    await audit.record({ tenant: 'acme-demo', subject: 's', principal: 'User::"alice"', action: 'Action::"approve"', resource: 'Request::"r1"', allow: out.allow, reasons: out.reasons, activation_seq: null, commit: null, source: 'http' });
    assert.deepEqual((await audit.list('acme-demo'))[0].reasons, ['sod-blocks-approve']);
  });
});
