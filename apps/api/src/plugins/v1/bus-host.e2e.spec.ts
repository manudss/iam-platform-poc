/**
 * Step 2 host e2e: a REAL nats-server and the REAL iam-core binary; the API serves its plugins over the bus.
 * Needs: nats-server (NATS_SERVER_BIN or PATH) and the core binary (IAM_CORE_BIN or core/target/debug/iam-core).
 * Skipped (loudly) when absent unless IAM_REQUIRE_NATS=1, which CI-like runs must set.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PluginRegistry } from './registry.js';
import { BusHost } from './bus-host.js';
import { MemoryMigrationStore, MemorySettingsStore } from './memory-stores.js';
import { notifyLog, orgManager } from './builtin/index.js';

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
    nats = startNats();
    if (!nats || !(await waitHealth(`http://127.0.0.1:${CORE_PORT}/health`, 1))) { /* core not started yet */ }
    if (!nats) { if (process.env.IAM_REQUIRE_NATS) assert.fail('nats-server required'); console.error('SKIPPED: no nats-server'); return; }
    await new Promise((r) => setTimeout(r, 500));
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
    reg.register(notifyLog); reg.register(orgManager);
    host = await BusHost.startIfConfigured(async () => reg, () => {});
    assert.ok(host, 'host starts');
    reg.setBus(host!.bridge());
    available = true;
  });
  after(async () => {
    await host?.close();
    core?.kill(); nats?.kill();
    delete process.env.IAM_BUS_NATS_URL; delete process.env.IAM_BUS_NATS_USER; delete process.env.IAM_BUS_NATS_PASSWORD;
  });

  it('notify.send is answered by notify-log THROUGH the bus, with the same result shape as in process', async (t) => {
    if (!available) return t.skip('no nats-server or core binary');
    const out = await reg.emit(T, 'notify.send', { tenant: T, to: 'a@b.c', template: 'hello', data: {}, effectKey: 'e2e-1' } as any);
    assert.deepEqual(out, [{ plugin: 'notify-log', result: { delivered: false, line: 'notify: hello -> a@b.c' } }]);
    // the observer saw it, with the source stamped by the core
    const r = await fetch(`http://127.0.0.1:${CORE_PORT}/v1/bus/records?limit=5`, { headers: { 'x-core-admin-token': TOKEN } });
    const recs: any = await r.json();
    const last = recs.records.at(-1);
    assert.equal(last.kind, 'notify.send'); assert.equal(last.source, 'api');
  });

  it('dedupes on the effect key (no double effect)', async (t) => {
    if (!available) return t.skip('no nats-server or core binary');
    const first = await reg.emit(T, 'notify.send', { tenant: T, to: 'a@b.c', template: 'once', data: {}, effectKey: 'e2e-2' } as any);
    assert.equal(first.length, 1);
    assert.deepEqual(await reg.emit(T, 'notify.send', { tenant: T, to: 'a@b.c', template: 'once', data: {}, effectKey: 'e2e-2' } as any), []);
  });

  it('enable pushes the registration, disable cuts the delivery', async (t) => {
    if (!available) return t.skip('no nats-server or core binary');
    await reg.install(T, 'org-manager', { install: true });
    await reg.enable(T, 'org-manager', {});
    await host!.sync();
    const out = await reg.emit(T, 'identity.changed', { tenant: T, subject: 'demo-alice', change: 'joiner', effectKey: 'e2e-3' } as any);
    assert.deepEqual(out, [{ plugin: 'org-manager', result: { queued: 'e2e-3' } }]);
    await reg.disable(T, 'org-manager');
    await host!.sync();
    const out2 = await reg.emit(T, 'identity.changed', { tenant: T, subject: 'demo-alice', change: 'leaver', effectKey: 'e2e-4' } as any);
    assert.deepEqual(out2, [], 'a disabled plugin no longer receives the event');
  });
});
