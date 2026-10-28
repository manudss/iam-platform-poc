// Real NATS JetStream server and real OpenBao dev server, started as local binaries (no Docker).
// NATS_SERVER_BIN / BAO_BIN point to the binaries; each describe is skipped with a message if its binary is missing.
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, JSONCodec } from 'nats';
import { ActivationService } from './activation/activation.service.js';
import { NatsService } from './integrations/nats.service.js';
import { SecretsService } from './integrations/secrets.service.js';

const natsBin = process.env.NATS_SERVER_BIN, baoBin = process.env.BAO_BIN;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('NATS JetStream (real server)', { skip: !(natsBin && existsSync(natsBin)) && 'NATS_SERVER_BIN not set' }, () => {
  let proc: ChildProcess, dir: string;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-nats-'));
    proc = spawn(natsBin!, ['-js', '-a', '127.0.0.1', '-p', '14222', '-sd', dir], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) { try { (await connect({ servers: '127.0.0.1:14222' })).close(); break; } catch { await sleep(100); } }
  });
  after(() => { delete process.env.IAM_NATS_URL; proc?.kill(); rmSync(dir, { recursive: true, force: true }); });

  it('an activation publishes iam.activation.<tenant> and a consumer receives it', async () => {
    process.env.IAM_NATS_URL = '127.0.0.1:14222';
    const nats = new NatsService();
    const svc = new ActivationService(new SecretsService(), nats);
    const a = await svc.activate('acme-demo', 'aaaaaaaa');
    assert.equal(a.event, 'published');
    const nc = await connect({ servers: '127.0.0.1:14222' });
    const m = await (await nc.jetstream().consumers.get('IAM_EVENTS')).next({ expires: 3000 });
    assert.equal(m?.subject, 'iam.activation.acme-demo');
    assert.deepEqual(JSONCodec<{ seq: number; commit: string }>().decode(m!.data).commit, 'aaaaaaaa');
    await nc.close(); await nats.onModuleDestroy();
  });
  it('NATS unreachable: the activation still succeeds in the journal and says not-published', async () => {
    process.env.IAM_NATS_URL = '127.0.0.1:14999';
    const nats = new NatsService();
    const a = await new ActivationService(new SecretsService(), nats).activate('acme-demo', 'bbbbbbbb');
    assert.equal(a.seq, 1);
    assert.equal(a.event, 'not-published');
    await nats.onModuleDestroy();
  });
  it('disabled when IAM_NATS_URL is unset', async () => {
    delete process.env.IAM_NATS_URL;
    assert.equal((await new ActivationService().activate('t', 'cccccccc')).event, 'disabled');
  });
});

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
