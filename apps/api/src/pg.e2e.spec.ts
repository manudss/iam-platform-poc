// Durable activation journal on a REAL PostgreSQL (no Docker). Needs PG_BIN = dir with initdb/postgres
// (e.g. node_modules/@embedded-postgres/linux-x64/native/bin from `npm i embedded-postgres`). Skipped otherwise.
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { ActivationService } from './activation/activation.service.js';
import { SecretsService } from './integrations/secrets.service.js';
import { NatsService } from './integrations/nats.service.js';

const bin = process.env.PG_BIN;
const have = !!bin && existsSync(join(bin, 'postgres')) && existsSync(join(bin, 'initdb'));
const PORT = 15432;

describe('activation journal on real PostgreSQL', { skip: !have && 'PG_BIN not set or postgres binaries missing' }, () => {
  let proc: ChildProcess, dir: string;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-pg-'));
    const i = spawnSync(join(bin!, 'initdb'), ['-D', join(dir, 'd'), '-U', 'poc', '--auth=trust', '-E', 'UTF8']);
    assert.equal(i.status, 0, String(i.stderr));
    proc = spawn(join(bin!, 'postgres'), ['-D', join(dir, 'd'), '-p', String(PORT), '-k', dir, '-c', 'listen_addresses=127.0.0.1'], { stdio: 'ignore' });
    for (let k = 0; k < 100; k++) {
      try { const c = new pg.Client({ connectionString: `postgres://poc@127.0.0.1:${PORT}/postgres` }); await c.connect(); await c.end(); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    process.env.IAM_PG_URL = `postgres://poc@127.0.0.1:${PORT}/postgres`;
  });
  after(() => { delete process.env.IAM_PG_URL; proc?.kill(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('is durable across service instances (restart) and re-activation is a new seq', async () => {
    const a = new ActivationService();
    assert.equal((await a.activate('t1', 'aaaaaaaa')).seq, 1);
    assert.equal((await a.activate('t1', 'bbbbbbbb')).seq, 2);
    assert.equal((await a.activate('t1', 'aaaaaaaa')).seq, 3);
    await a.onModuleDestroy();
    const b = new ActivationService(); // "restart"
    assert.deepEqual((await b.list('t1')).map((x) => x.commit), ['aaaaaaaa', 'bbbbbbbb', 'aaaaaaaa']);
    assert.equal((await b.current('t1'))?.seq, 3);
    assert.equal((await b.list('t2')).length, 0);
    await b.onModuleDestroy();
  });
  it('A/B/A with request ids: new request = new seq; retry of the same request has no new row; concurrent same request = one row', async () => {
    const a = new ActivationService();
    const A = 'aaaaaaaa', B = 'bbbbbbbb';
    assert.equal((await a.activate('t4', A, 'req-a-000001')).seq, 1);
    assert.equal((await a.activate('t4', B, 'req-b-000001')).seq, 2);
    assert.equal((await a.activate('t4', A, 'req-a-000002')).seq, 3); // A again after B, new request
    assert.equal((await a.activate('t4', A, 'req-a-000002')).seq, 3); // retry of that request
    assert.equal((await a.activate('t4', A, 'req-a-000001')).seq, 1); // retry of the first request
    assert.equal((await a.list('t4')).length, 3);
    await assert.rejects(a.activate('t4', B, 'req-a-000001'), /another commit/);
    const par = await Promise.all(Array.from({ length: 6 }, () => a.activate('t5', A, 'req-par-00001')));
    assert.deepEqual([...new Set(par.map((x) => x.seq))], [1]);
    assert.equal((await a.list('t5')).length, 1);
    await a.onModuleDestroy();
  });
  it('concurrent activations get distinct consecutive seqs', async () => {
    const a = new ActivationService();
    const r = await Promise.all(Array.from({ length: 8 }, (_, n) => a.activate('t3', `cc${n}`.padEnd(8, '0'))));
    assert.deepEqual(r.map((x) => x.seq).sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8]);
    await a.onModuleDestroy();
  });
  it('PostgreSQL URL taken from the secret store when IAM_PG_URL is unset (secret store STUBBED here; real OpenBao is tested separately)', async () => {
    const url = process.env.IAM_PG_URL!;
    delete process.env.IAM_PG_URL;
    const stub = { get: async (p: string) => (p === 'iam/pg' ? { url } : undefined) } as unknown as SecretsService;
    const a = new ActivationService(stub, new NatsService());
    assert.equal((await a.current('t1'))?.seq, 3); // sees the durable rows written by the first test
    await a.onModuleDestroy();
    process.env.IAM_PG_URL = url;
  });
});
