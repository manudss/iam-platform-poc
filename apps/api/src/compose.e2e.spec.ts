// Runs against the REAL docker-compose stack (infra/docker-compose.yml), already started by the caller (CI job "compose").
// Skipped unless COMPOSE_STACK=1. Ports/credentials are the local-only values from .env.example.
import 'reflect-metadata';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, JSONCodec } from 'nats';
import { Connection } from '@temporalio/client';
import { DoltService } from './dolt/dolt.service.js';
import { ActivationService } from './activation/activation.service.js';
import { NatsService } from './integrations/nats.service.js';
import { SecretsService } from './integrations/secrets.service.js';

const on = process.env.COMPOSE_STACK === '1';
const PW = process.env.COMPOSE_PW ?? 'dev-only-change-me'; // .env.example value, local only

describe('docker-compose stack (real containers)', { skip: !on && 'COMPOSE_STACK=1 not set' }, () => {
  const cleanup: (() => Promise<unknown>)[] = [];
  after(async () => { for (const c of cleanup) await c().catch(() => undefined); });

  it('Dolt container: demo seed from docker-entrypoint-initdb.d is present', async () => {
    Object.assign(process.env, { DOLT_PORT: '3307', DOLT_PASSWORD: PW, DOLT_DATABASE: 'iam' });
    const d = new DoltService();
    assert.ok((await d.head()).length >= 8);
    assert.deepEqual(await d.assignments(), [{ identity_id: 'demo-alice', role_id: 'mcp-operator' }, { identity_id: 'demo-bob', role_id: 'payment-creator' }]); // seed: bob + alice as MCP operator
  });
  it('runtime PostgreSQL container: activation journal is durable', async () => {
    process.env.IAM_PG_URL = `postgres://postgres:${PW}@127.0.0.1:5433/runtime`;
    const a = new ActivationService(); cleanup.push(() => a.onModuleDestroy());
    const r = await a.activate('compose-test', 'aaaaaaaa');
    assert.ok(r.seq >= 1);
    assert.ok((await a.list('compose-test')).some((x) => x.commit === 'aaaaaaaa'));
  });
  it('NATS container: JetStream publish is acknowledged', async () => {
    process.env.IAM_NATS_URL = '127.0.0.1:4222';
    const n = new NatsService(); cleanup.push(() => n.onModuleDestroy());
    assert.equal(await n.publish('iam.activation.compose-test', { ok: true }), true);
    const nc = await connect({ servers: '127.0.0.1:4222' }); cleanup.push(() => nc.close());
    const m = await (await nc.jetstream().consumers.get('IAM_EVENTS')).next({ expires: 3000 });
    assert.ok(m && JSONCodec().decode(m.data));
  });
  it('OpenBao container (dev mode): KV v2 write then read', async () => {
    const token = process.env.COMPOSE_BAO_TOKEN ?? PW;
    Object.assign(process.env, { IAM_BAO_ADDR: 'http://127.0.0.1:8200', IAM_BAO_TOKEN: token });
    const w = await fetch('http://127.0.0.1:8200/v1/secret/data/iam/compose', { method: 'POST', headers: { 'X-Vault-Token': token }, body: JSON.stringify({ data: { k: 'v' } }) });
    assert.equal(w.status, 200);
    assert.deepEqual(await new SecretsService().get('iam/compose'), { k: 'v' });
  });
  it('Temporal container: frontend answers on 7233', async () => {
    const c = await Connection.connect({ address: '127.0.0.1:7233' }); cleanup.push(async () => c.close());
    const info = await c.workflowService.getSystemInfo({});
    assert.ok(info.serverVersion);
  });
});
