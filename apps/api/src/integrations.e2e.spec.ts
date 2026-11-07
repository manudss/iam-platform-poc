// Real OpenBao dev server, started as a local binary (no Docker). BAO_BIN points to the binary; the describe is
// skipped with a message if it is missing. (The NATS circuit this file also tested is gone in step 3: the single
// activation circuit - core emits activation.applied on the bus - is covered by activation-bus.e2e.spec.ts.)
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretsService } from './integrations/secrets.service.js';

const baoBin = process.env.BAO_BIN;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('OpenBao KV (real dev server)', { skip: !(baoBin && existsSync(baoBin)) && 'BAO_BIN not set' }, () => {
  let proc: ChildProcess;
  const ADDR = 'http://127.0.0.1:18200', TOKEN = 'local-dev-token-not-a-secret'; // dev mode, local only
  before(async () => {
    proc = spawn(baoBin!, ['server', '-dev', `-dev-root-token-id=${TOKEN}`, '-dev-listen-address=127.0.0.1:18200'], { stdio: 'ignore' });
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${ADDR}/v1/sys/health`)).ok) break; } catch { /* retry */ } await sleep(150); }
    Object.assign(process.env, { IAM_BAO_ADDR: ADDR, IAM_BAO_TOKEN: TOKEN });
  });
  after(() => { delete process.env.IAM_BAO_ADDR; delete process.env.IAM_BAO_TOKEN; proc?.kill(); });

  it('reads a KV v2 secret, returns undefined when absent, throws on a bad token', async () => {
    const w = await fetch(`${ADDR}/v1/secret/data/iam/pg`, { method: 'POST', headers: { 'X-Vault-Token': TOKEN }, body: JSON.stringify({ data: { url: 'postgres://example.invalid/x' } }) });
    assert.equal(w.status, 200);
    const s = new SecretsService();
    assert.deepEqual(await s.get('iam/pg'), { url: 'postgres://example.invalid/x' });
    assert.equal(await s.get('iam/missing'), undefined);
    process.env.IAM_BAO_TOKEN = 'wrong';
    await assert.rejects(() => s.get('iam/pg'), /secret store error 403/);
    process.env.IAM_BAO_TOKEN = TOKEN;
  });
});
