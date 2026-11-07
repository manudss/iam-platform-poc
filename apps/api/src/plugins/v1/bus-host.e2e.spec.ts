/**
 * Step 3 host e2e: a REAL nats-server and the REAL iam-core binary; the API serves its plugins over the bus.
 * Notify deliveries are durable (JetStream, at-least-once): an emission returns queue receipts, the effects
 * happen asynchronously in the consumers. Needs: nats-server (NATS_SERVER_BIN or PATH) and the core binary
 * (IAM_CORE_BIN or core/target/debug/iam-core). Skipped (loudly) when absent unless IAM_REQUIRE_NATS=1.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { PluginRegistry } from './registry.js';
import { BusHost } from './bus-host.js';
import { MemoryMigrationStore, MemorySettingsStore } from './memory-stores.js';
import { notifyLog, orgManager } from './builtin/index.js';
import type { PluginImpl } from './registry.js';
import { AppEvent, ApplicationBus } from '../../events/application-bus.service.js';

/** Test plugin: records every payload it receives, so the tests can see the asynchronous effects. */
const received: { kind: string; payload: any }[] = [];
const spy: PluginImpl = {
  manifest: {
    apiVersion: 'plugin/v1', id: 'spy-log', version: '1.0.0', name: 'Spy (test)', publisher: 'iam-platform-tests',
    kinds: ['notifier'],
    hooks: [{ name: 'notify.send', mode: 'async' }, { name: 'identity.changed', mode: 'async' }],
    settings: [],
  },
  handlers: {
    'notify.send': (payload: any) => { received.push({ kind: 'notify.send', payload }); return { seen: true }; },
    'identity.changed': (payload: any) => { received.push({ kind: 'identity.changed', payload }); return { seen: true }; },
  },
};
async function untilKind(kind: string, pred: (p: any) => boolean, ms = 6000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = received.find((r) => r.kind === kind && pred(r.payload));
    if (hit) return hit.payload;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`no ${kind} delivery within ${ms} ms`);
}

const NATS_PORT = 14551;
const CORE_PORT = 18551;
const TOKEN = 'bus-host-e2e-token';
const T = 't1';

function bin(name: string, env: string): string | undefined {
  if (process.env[env] && existsSync(process.env[env]!)) return process.env[env];
  return undefined;
}
function startNats(): ChildProcess | undefined {
  const b = process.env.NATS_SERVER_BIN ?? 'nats-server';
  const conf = readFileSync(new URL('../../../../../conf/nats-local.conf', import.meta.url)).toString()
    .replace('127.0.0.1:4222', `127.0.0.1:${NATS_PORT}`).replace('/tmp/iam-nats-js', `/tmp/iam-nats-js-${NATS_PORT}`);
  const tmp = `/tmp/iam-bus-host-e2e.conf`;
  writeFileSync(tmp, conf);
  try {
    const c = spawn(b, ['-c', tmp], { stdio: 'ignore' });
    return c;
  } catch { return undefined; }
}
function startCore(): ChildProcess | undefined {
  const b = process.env.IAM_CORE_BIN ?? new URL('../../../../../core/target/debug/iam-core', import.meta.url).pathname;
  if (!existsSync(b)) return undefined;
  return spawn(b, [], { stdio: 'ignore', env: { ...process.env,
    IAM_CORE_NATS_URL: `127.0.0.1:${NATS_PORT}`, IAM_CORE_NATS_PASSWORD: 'core-dev',
    IAM_CORE_ADMIN_TOKEN: TOKEN, IAM_CORE_ADDR: `127.0.0.1:${CORE_PORT}`,
    IAM_POLICY_FILE: new URL('../../../../../policies/demo.cedar', import.meta.url).pathname } });
}
async function waitHealth(url: string, ms = 8000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

describe('bus host e2e (step 2): plugins served by the core bus', { skip: false }, async () => {
  let nats: ChildProcess | undefined; let core: ChildProcess | undefined; let host: BusHost | undefined;
  let reg: PluginRegistry; let available = false;

  before(async () => {
    rmSync(`/tmp/iam-nats-js-${NATS_PORT}`, { recursive: true, force: true });
    let natsErr = false;
    nats = startNats();
    nats?.on('error', () => { natsErr = true; });
    await new Promise((r) => setTimeout(r, 600));
    if (!nats || natsErr || nats.exitCode !== null) {
      if (process.env.IAM_REQUIRE_NATS) assert.fail('nats-server required');
      console.error('SKIPPED: no nats-server'); return;
    }
    core = startCore();
    if (!core || !(await waitHealth(`http://127.0.0.1:${CORE_PORT}/health`))) {
      if (process.env.IAM_REQUIRE_NATS) assert.fail('core binary required');
      console.error('SKIPPED: no core binary'); return;
    }
    process.env.IAM_BUS_NATS_URL = `127.0.0.1:${NATS_PORT}`;
    process.env.IAM_BUS_NATS_USER = 'api-host';
    process.env.IAM_BUS_NATS_PASSWORD = 'api-host-dev';
    process.env.IAM_CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
    process.env.IAM_CORE_ADMIN_TOKEN = TOKEN;
    reg = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore());
    reg.register(notifyLog); reg.register(orgManager); reg.register(spy);
    await reg.install(T, 'spy-log', { install: true });
    await reg.enable(T, 'spy-log', {});
    host = await BusHost.startIfConfigured(async () => reg, (e) => console.error('[bus-host]', JSON.stringify(e)));
    assert.ok(host, 'host starts');
    reg.setBus(host!.bridge());
    available = true;
  });
  after(async () => {
    await host?.close();
    core?.kill(); nats?.kill();
    delete process.env.IAM_BUS_NATS_URL; delete process.env.IAM_BUS_NATS_USER; delete process.env.IAM_BUS_NATS_PASSWORD;
  });

  it('notify.send is queued THROUGH the bus, then delivered to the active plugins', async (t) => {
    if (!available) return t.skip('no nats-server or core binary');
    const out = await reg.emit(T, 'notify.send', { tenant: T, to: 'a@b.c', template: 'hello', data: {}, effectKey: 'e2e-1' } as any);
    // receipts, not results: every active plugin with the hook got a durable copy (at-least-once)
    assert.deepEqual(out, [
      { plugin: 'notify-log', result: { queued: true } },
      { plugin: 'spy-log', result: { queued: true } },
    ]);
    // the effect itself is asynchronous: the spy sees the exact payload shortly after
    const got = await untilKind('notify.send', (p) => p.effectKey === 'e2e-1');
    assert.equal(got.template, 'hello'); assert.equal(got.to, 'a@b.c');
    // the observer saw the emission, with the source stamped by the core
    const r = await fetch(`http://127.0.0.1:${CORE_PORT}/v1/bus/records?limit=5`, { headers: { 'x-core-admin-token': TOKEN } });
    const recs: any = await r.json();
    const last = recs.records.at(-1);
    assert.equal(last.kind, 'notify.send'); assert.equal(last.source, 'api');
    assert.ok(last.outcomes.every((o: any) => o.status === 'queued'), `queued outcomes: ${JSON.stringify(last.outcomes)}`);
  });

  it('dedupes on the effect key (no double effect)', async (t) => {
    if (!available) return t.skip('no nats-server or core binary');
    const first = await reg.emit(T, 'notify.send', { tenant: T, to: 'a@b.c', template: 'once', data: {}, effectKey: 'e2e-2' } as any);
    assert.equal(first.length, 2);
    assert.deepEqual(await reg.emit(T, 'notify.send', { tenant: T, to: 'a@b.c', template: 'once', data: {}, effectKey: 'e2e-2' } as any), [], 'same effect key: nothing re-emitted');
    await untilKind('notify.send', (p) => p.effectKey === 'e2e-2');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(received.filter((r) => r.kind === 'notify.send' && r.payload.effectKey === 'e2e-2').length, 1, 'one effect only');
  });

  it('enable pushes the registration, disable cuts the delivery', async (t) => {
    if (!available) return t.skip('no nats-server or core binary');
    await reg.install(T, 'org-manager', { install: true });
    await reg.enable(T, 'org-manager', {});
    await host!.sync();
    const out = await reg.emit(T, 'identity.changed', { tenant: T, subject: 'demo-alice', change: 'joiner', effectKey: 'e2e-3' } as any);
    assert.deepEqual(out, [{ plugin: 'org-manager', result: { queued: true } }, { plugin: 'spy-log', result: { queued: true } }]);
    await untilKind('identity.changed', (p) => p.effectKey === 'e2e-3');
    await reg.disable(T, 'org-manager');
    await host!.sync();
    const out2 = await reg.emit(T, 'identity.changed', { tenant: T, subject: 'demo-alice', change: 'leaver', effectKey: 'e2e-4' } as any);
    assert.deepEqual(out2, [{ plugin: 'spy-log', result: { queued: true } }], 'a disabled plugin no longer receives the event');
    await untilKind('identity.changed', (p) => p.effectKey === 'e2e-4');
  });

  it('a service of the API consumes its own durable address (no plugin manifest)', async (t) => {
    if (!available) return t.skip('no nats-server or core binary');
    const got: string[] = [];
    await host!.serveService('workflow-triggers', ['identity.changed'], async (env) => { got.push(`${env.id}:${(env.payload as any).effectKey}`); });
    const out = await reg.emit(T, 'identity.changed', { tenant: T, subject: 'demo-bob', change: 'mover', effectKey: 'e2e-5' } as any);
    assert.deepEqual(out, [{ plugin: 'spy-log', result: { queued: true } }, { plugin: 'workflow-triggers', result: { queued: true } }]);
    const t0 = Date.now();
    while (!got.some((x) => x.endsWith(':e2e-5')) && Date.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 100));
    assert.equal(got.filter((x) => x.endsWith(':e2e-5')).length, 1, 'the service received the event once');
  });

  it('application events travel on the bus once the host attaches (commit 5)', async (t) => {
    if (!available) return t.skip('no nats-server or core binary');
    const events = new ApplicationBus();
    const got: AppEvent[] = [];
    events.consumeOnBus('app-events-test', ['user.created', 'sso.login.succeeded'], (e) => { got.push(e); });
    host!.attachEvents(events); // registered consumers are served on attach
    assert.ok(events.routedToBus);
    events.emit({ type: 'user.created', tenant: T, branch: 'main', at: new Date().toISOString(), payload: { subject: 'demo-zoe', displayName: 'Zoe', department: 'it', email: 'zoe@acme.test' } });
    const t0 = Date.now();
    while (!got.length && Date.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 100));
    assert.equal(got.length, 1, 'the consumer received the event over the bus');
    assert.equal(got[0].type, 'user.created');
    assert.equal(got[0].branch, 'main');
    assert.equal(got[0].payload.subject, 'demo-zoe');
    assert.equal(got[0].payload.displayName, 'Zoe');
    assert.ok(got[0].at, 'the at timestamp rides along');
    // An event kind the consumer did not subscribe to never reaches it.
    events.emit({ type: 'user.disabled', tenant: T, branch: 'main', at: new Date().toISOString(), payload: { subject: 'demo-zoe' } });
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(got.length, 1, 'unsubscribed kinds are not delivered');
  });
});
