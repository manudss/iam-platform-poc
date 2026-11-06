/**
 * Step 3, commit 7: auth.authenticate and auth.challenge travel on the bus as MANDATORY controls.
 * - the plugin chosen for the slot is the single responder; the others answer not-concerned (never a verdict);
 * - a deny verdict, a silent mandatory subscriber (bus down) or no answer at all refuse the sign-in (fail closed);
 * - the base is never asked in place of a failing replacement.
 * Real nats-server + real iam-core (the shared bus harness).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry, PluginError } from './plugins/v1/registry.js';
import { authPassword, authPasswordLockout } from './plugins/v1/builtin/index.js';
import { MemoryMigrationStore, MemorySettingsStore } from './plugins/v1/memory-stores.js';
import { startBusHarness, busBinsPresent, BusHarness } from './testing/bus-harness.js';

const T = 'acme-demo';
const NP = 14224, CORE_PORT = 18094, TOKEN = 'auth-bus-token';
const good = { tenant: T, subject: 'demo-alice', credential: { password: 'demo-only-not-a-secret' } };
const bad = { tenant: T, subject: 'demo-alice', credential: { password: 'wrong' } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('authentication over the bus (mandatory controls)', () => {
  let bus: BusHarness; let reg: PluginRegistry;
  before(async () => {
    if (!busBinsPresent) return;
    reg = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore());
    reg.register(authPassword);
    reg.register(authPasswordLockout(new Map()));
    bus = await startBusHarness({ natsPort: NP, corePort: CORE_PORT, token: TOKEN, registry: reg });
    reg.setBus(bus.host.bridge());
  });
  after(async () => { await bus?.close(); });

  it('a good password is allowed through the bus; a bad one is refused', async (t) => {
    if (!bus) return t.skip('no nats-server or core binary');
    const r = await reg.callSlot<any>(T, 'auth.password', 'auth.authenticate', good);
    assert.equal(r.servedBy, 'bus');
    assert.equal(r.result.outcome, 'allow');
    assert.equal(r.result.subject, 'demo-alice');
    await assert.rejects(reg.callSlot(T, 'auth.password', 'auth.authenticate', bad), (e: PluginError) => e.code === 'plugin-failed');
    // The core saw the exchange as a control with a single real responder (the base plugin).
    const recs: any = await (await fetch(`http://127.0.0.1:${CORE_PORT}/v1/bus/records?limit=100`, { headers: { 'x-core-admin-token': TOKEN } })).json();
    const last = recs.records.at(-1);
    assert.equal(last.kind, 'auth.authenticate');
    const answered = last.outcomes.filter((o: any) => o.status === 'replied');
    assert.equal(answered.length, 1, `exactly one responder: ${JSON.stringify(last.outcomes)}`);
    assert.equal(answered[0].id, 'auth-password');
    assert.equal(answered[0].verdict, 'deny');
  });

  it('the enabled replacement answers, the base says not-concerned (single responder)', async (t) => {
    if (!bus) return t.skip('no nats-server or core binary');
    await reg.install(T, 'auth-password-lockout', { install: true });
    await reg.enable(T, 'auth-password-lockout', { hooks: ['auth.authenticate'] }); // sensitive hook: explicit grant
    await reg.configure(T, 'auth-password-lockout', { maxFailures: 2 });
    await bus.host.sync();
    const r = await reg.callSlot<any>(T, 'auth.password', 'auth.authenticate', good);
    assert.equal(r.servedBy, 'bus', `routed=${(reg as any).bus?.routed('auth.authenticate')}`);
    assert.equal(r.result.outcome, 'allow');
    const recs: any = await (await fetch(`http://127.0.0.1:${CORE_PORT}/v1/bus/records?limit=100`, { headers: { 'x-core-admin-token': TOKEN } })).json();
    const last = recs.records.at(-1);
    const byId = Object.fromEntries(last.outcomes.map((o: any) => [o.id, o.status]));
    assert.equal(byId['auth-password-lockout'], 'replied', `record: ${JSON.stringify(last)}`);
    assert.equal(byId['auth-password'], 'not-concerned', `the base must not answer: ${JSON.stringify(last.outcomes)}`);
  });

  it('the replacement lockout applies over the bus (fail closed, never the base)', async (t) => {
    if (!bus) return t.skip('no nats-server or core binary');
    await assert.rejects(reg.callSlot(T, 'auth.password', 'auth.authenticate', bad)); // failure 1
    await assert.rejects(reg.callSlot(T, 'auth.password', 'auth.authenticate', bad)); // failure 2 -> locked
    await assert.rejects(reg.callSlot(T, 'auth.password', 'auth.authenticate', good),
      (e: PluginError) => e.code === 'plugin-failed' && /auth-password-lockout/.test(e.message),
      'locked: even the good password is refused, by the replacement');
  });

  it('bus down = sign-in refused; bus back = sign-in works again', async (t) => {
    if (!bus) return t.skip('no nats-server or core binary');
    // A fresh subject: the previous test locked demo-alice out.
    const bob = { tenant: T, subject: 'demo-bob', credential: { password: 'demo-only-not-a-secret' } };
    await bus.stopNats();
    await assert.rejects(reg.callSlot(T, 'auth.password', 'auth.authenticate', bob, 1500),
      (e: PluginError) => e.code === 'plugin-failed', 'NATS down: the mandatory control cannot be answered, the call is refused');
    await bus.startNats();
    // The core and the host reconnect by themselves; give them a moment.
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      await sleep(500);
      try { ok = (await reg.callSlot<any>(T, 'auth.password', 'auth.authenticate', bob)).result.outcome === 'allow'; } catch { /* still reconnecting */ }
    }
    assert.ok(ok, 'authentication works again once the bus is back');
  });
});
