// Slice 2 + 3: async notification manager (local fictional sink) and outbound provisioning (local demo target), driven by real activation events.
// Real PostgreSQL ledger, real NATS JetStream consumer, local HTTP servers started by the test (nothing leaves the machine). Dolt snapshots are STUBBED here
// (real Dolt export is covered by activation/fullstack specs). Skipped if PG_BIN or NATS_SERVER_BIN is missing.
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { startBusHarness, busBinsPresent } from './testing/bus-harness.js';
import { ActivationEffects, diff, Snapshot } from './effects/activation-effects.js';
import { EffectStore } from './effects/effect-store.js';

const pgBin = process.env.PG_BIN;
const have = !!pgBin && existsSync(join(pgBin, 'postgres')) && busBinsPresent;
const PGP = 15451, NP = 14251, COREP = 18097, SINK = 18151, TARGET = 18152;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const snaps: Record<string, Snapshot> = {
  c1: { assignments: [{ identity_id: 'demo-bob', role_id: 'payment-creator' }] },
  c2: { assignments: [{ identity_id: 'demo-bob', role_id: 'payment-creator' }, { identity_id: 'demo-alice', role_id: 'payment-approver' }] },
  c3: { assignments: [{ identity_id: 'demo-alice', role_id: 'payment-approver' }] },
};
const prev: Record<string, string> = { '1:acme': '', '2:acme': 'c1', '3:acme': 'c2' };

function fake(port: number, state: { calls: { method: string; url: string; key: string; body: string }[]; failNext: number; seenKeys: Set<string> }): Promise<Server> {
  return new Promise((ok) => {
    const s = createServer((req, res) => {
      let body = ''; req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (state.failNext > 0) { state.failNext--; res.statusCode = 503; return res.end(); }
        const key = String(req.headers['idempotency-key'] ?? '');
        if (!state.seenKeys.has(key)) { state.seenKeys.add(key); state.calls.push({ method: req.method!, url: req.url!, key, body }); }
        res.statusCode = 204; res.end();
      });
    });
    s.listen(port, '127.0.0.1', () => ok(s));
  });
}

describe('effects: notification manager + outbound provisioning (local fictional targets)', { skip: !have && 'PG_BIN, NATS_SERVER_BIN or core binary missing' }, () => {
  let pgp: ChildProcess, dir: string, pool: pg.Pool, sink: Server, target: Server, fx: ActivationEffects, store: EffectStore;
  const sinkState = { calls: [] as { method: string; url: string; key: string; body: string }[], failNext: 0, seenKeys: new Set<string>() };
  const targetState = { calls: [] as { method: string; url: string; key: string; body: string }[], failNext: 0, seenKeys: new Set<string>() };
  const deps = (over: object = {}) => ({ store, snapshotAt: async (c: string) => snaps[c], previousCommit: async (t: string, s: number) => prev[`${s}:${t}`] || undefined,
    notifySinkUrl: `http://127.0.0.1:${SINK}`, provisionTargetUrl: `http://127.0.0.1:${TARGET}`, timeoutMs: 1500, ...over });

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'iam-fx-'));
    assert.equal(spawnSync(join(pgBin!, 'initdb'), ['-D', join(dir, 'd'), '-U', 'poc', '--auth=trust', '-E', 'UTF8']).status, 0);
    pgp = spawn(join(pgBin!, 'postgres'), ['-D', join(dir, 'd'), '-p', String(PGP), '-k', dir, '-c', 'listen_addresses=127.0.0.1'], { stdio: 'ignore' });
    process.env.IAM_PG_URL = `postgres://poc@127.0.0.1:${PGP}/postgres`;
    pool = new pg.Pool({ connectionString: process.env.IAM_PG_URL });
    for (let k = 0; k < 100; k++) { try { await pool.query('select 1'); break; } catch { await sleep(200); } }
    sink = await fake(SINK, sinkState); target = await fake(TARGET, targetState);
    store = new EffectStore(pool); fx = new ActivationEffects(deps());
  });
  after(async () => { sink?.close(); target?.close(); await pool?.end(); pgp?.kill(); delete process.env.IAM_PG_URL; await sleep(500); if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

  it('diff: grants and revokes between two data versions', () => {
    assert.deepEqual(diff(snaps.c1, snaps.c2), [{ subject: 'demo-alice', role: 'payment-approver', change: 'granted' }]);
    assert.deepEqual(diff(snaps.c2, snaps.c3), [{ subject: 'demo-bob', role: 'payment-creator', change: 'revoked' }]);
    assert.deepEqual(diff(undefined, snaps.c1).length, 1);
  });
  it('a grant notifies the fictional manager and provisions the demo target; same event again changes nothing (idempotent)', async () => {
    const r = await fx.handle({ tenant: 'acme', seq: 2, commit: 'c2' });
    assert.equal(r.changes, 1);
    assert.deepEqual(sinkState.calls.map((c) => [c.method, c.url]), [['POST', '/notify']]);
    assert.deepEqual(JSON.parse(sinkState.calls[0].body), { type: 'role.changed', tenant: 'acme', activation: 2, commit: 'c2', subject: 'demo-alice', role: 'payment-approver', change: 'granted', to: 'manager-of:demo-alice' });
    assert.deepEqual(targetState.calls.map((c) => [c.method, c.url]), [['PUT', '/Users/demo-alice/Roles/payment-approver']]);
    await fx.handle({ tenant: 'acme', seq: 2, commit: 'c2' }); // replay
    assert.equal(sinkState.calls.length, 1); assert.equal(targetState.calls.length, 1);
    assert.deepEqual((await store.list('acme')).map((x) => [x.effectKey, x.state]).sort(), [['acme:2:notify:demo-alice:payment-approver:granted', 'done'], ['acme:2:provision:demo-alice:payment-approver:granted', 'done']]);
  });
  it('a revoke becomes DELETE on the target', async () => {
    await fx.handle({ tenant: 'acme', seq: 3, commit: 'c3' });
    assert.ok(targetState.calls.some((c) => c.method === 'DELETE' && c.url === '/Users/demo-bob/Roles/payment-creator'));
  });
  it('negative: target down -> effect recorded failed and the handler throws; retry succeeds and does not repeat the notification', async () => {
    const before = { n: sinkState.calls.length, t: targetState.calls.length };
    targetState.failNext = 1;
    await assert.rejects(new ActivationEffects(deps()).handle({ tenant: 'acme', seq: 5, commit: 'c2' }), /effects failed/); // prev of seq 5 is undefined -> two grants
    const rows = await store.list('acme');
    assert.ok(rows.some((r) => r.state === 'failed' && r.kind === 'provision' && /503/.test(r.lastError ?? '')));
    await new ActivationEffects(deps()).handle({ tenant: 'acme', seq: 5, commit: 'c2' }); // retry (what a NATS redelivery does)
    assert.equal(sinkState.calls.length - before.n, 2); // 2 grants notified once each, even though the first attempt already notified
    assert.equal(targetState.calls.length - before.t, 2);
    assert.ok((await store.list('acme')).filter((r) => r.effectKey.startsWith('acme:5:')).every((r) => r.state === 'done'));
  });
  it('negative: a non-loopback target is refused (nothing is sent) and recorded failed', async () => {
    prev['2:gamma'] = 'c1';
    const n0 = sinkState.calls.length;
    const e = new ActivationEffects(deps({ notifySinkUrl: 'http://example.com:9', provisionTargetUrl: undefined }));
    await assert.rejects(e.handle({ tenant: 'gamma', seq: 2, commit: 'c2' }), /not a loopback host/);
    assert.equal(sinkState.calls.length, n0);
    assert.ok((await store.list('gamma')).some((r) => r.state === 'failed' && /not a loopback host/.test(r.lastError ?? '')));
  });
  it('through the bus: a failing delivery is redelivered and the effects still run once (idempotent per effect key)', async () => {
    const bus = await startBusHarness({ natsPort: NP, corePort: COREP, token: 'fx-e2e-token' });
    try {
      const f2 = new ActivationEffects(deps());
      const handled: string[] = [];
      const nSink = sinkState.calls.length;
      targetState.failNext = 1; // the target answers 503 once: the handler throws, the delivery is nakked and redelivered
      await bus.host.serveService('fx-test', ['activation.applied'], async (env) => {
        const p = env.payload as { tenant: string; seq: number; commit: string };
        if (p.tenant !== 'beta') return;
        await f2.handle(p); // throws while the target 503s -> nak -> redelivery
        handled.push(`${p.tenant}:${p.seq}`);
      });
      prev['3:beta'] = 'c2';
      // The core owns and emits activation.applied when it applies (the single activation circuit, step 3).
      const r = await fetch(`${bus.coreUrl}/v1/activate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-core-admin-token': bus.token },
        body: JSON.stringify({ tenant: 'beta', seq: 3, commit: 'c3', snapshot: { assignments: [], sod_rules: [] } }) });
      assert.ok(r.ok, `core activate: ${r.status}`);
      for (let i = 0; i < 100 && !handled.includes('beta:3'); i++) await sleep(150);
      await sleep(800);
      assert.deepEqual(handled.filter((h) => h === 'beta:3'), ['beta:3']);
      assert.equal(sinkState.calls.length - nSink, 1); // revoke of demo-bob notified exactly once, despite the redelivery
      assert.ok(targetState.calls.some((c) => c.url === '/Users/demo-bob/Roles/payment-creator' && c.key.startsWith('beta:3:')));
    } finally { await bus.close(); }
  });
});
