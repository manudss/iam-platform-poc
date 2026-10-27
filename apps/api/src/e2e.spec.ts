// End-to-end: real Rust core binary (Cedar) + real NestJS API over HTTP.
// Skipped with a clear message if the core binary has not been built (cd core && cargo build -p iam-core).
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const root = resolve(process.cwd(), '../..');
const bin = resolve(root, 'core/target/debug/iam-core');
const CORE = 'http://127.0.0.1:18081';
const API = 'http://127.0.0.1:13000';

describe('e2e core + api', { skip: !existsSync(bin) && 'core binary not built' }, () => {
  let core: ChildProcess;
  let app: Awaited<ReturnType<typeof NestFactory.create>>;

  before(async () => {
    core = spawn(bin, [], {
      env: { ...process.env, IAM_CORE_ADDR: '127.0.0.1:18081', IAM_POLICY_FILE: resolve(root, 'policies/demo.cedar') },
      stdio: 'ignore',
    });
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${CORE}/health`)).ok) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    process.env.IAM_CORE_URL = CORE;
    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(13000);
  });
  after(async () => { await app?.close(); core?.kill(); });

  const check = (context: object, principal = 'User::"alice"') =>
    fetch(`${API}/access/check`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ principal, action: 'Action::"approve"', resource: 'Request::"r1"', context }),
    }).then((r) => r.json() as Promise<{ allow: boolean }>);

  it('manager approves without SoD conflict', async () => assert.equal((await check({ sod_conflict: false })).allow, true));
  it('SoD conflict is forbidden', async () => assert.equal((await check({ sod_conflict: true })).allow, false));
  it('unknown principal is denied', async () => assert.equal((await check({ sod_conflict: false }, 'User::"mallory"')).allow, false));
  it('denies (fail closed) when the core goes away', async () => {
    core.kill(); await new Promise((r) => setTimeout(r, 300));
    const r = await fetch(`${API}/access/check`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ principal: 'User::"alice"', action: 'Action::"approve"', resource: 'Request::"r1"', context: { sod_conflict: false } }) });
    assert.equal(r.status, 502);
    assert.equal(((await r.json()) as { allow: boolean }).allow, false);
  });
});
