/**
 * Step 3, commit 9 (decision 7): working branches travel on the SAME bus, the branch rides in the envelope,
 * and every delivery is resolved against the registry of ITS branch - never silently main's.
 * - a control call from a branch registry is answered by the plugin chosen on THAT branch;
 * - an async event emitted with a branch runs only the handlers active on that branch (simulated effects);
 * - main and the branch never leak into each other.
 * Real nats-server + real iam-core (the shared bus harness, two registries).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry, PluginImpl } from './plugins/v1/registry.js';
import { authPassword, authPasswordLockout, notifyLog } from './plugins/v1/builtin/index.js';
import { MemoryMigrationStore, MemorySettingsStore } from './plugins/v1/memory-stores.js';
import { startBusHarness, busBinsPresent, BusHarness } from './testing/bus-harness.js';

const T = 'acme-demo', BRANCH = 'feature-x';
const NP = 14228, CORE_PORT = 18098, TOKEN = 'branch-bus-token';
const good = { tenant: T, subject: 'demo-alice', credential: { password: 'demo-only-not-a-secret' } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spy sink for async effects: counts the deliveries its handler ran (a SIMULATED effect). */
const spySink = (ran: string[]): PluginImpl => ({
  manifest: { apiVersion: 'plugin/v1', id: 'spy-sink', version: '0.1.0', name: 'Spy sink', publisher: 'example', kinds: ['notifier'], hooks: [{ name: 'identity.changed', mode: 'async' }], settings: [] },
  handlers: { 'identity.changed': (p: { subject: string }) => { ran.push(p.subject); return { ok: true }; } },
});

describe('working branches on the same bus (decision 7)', () => {
  let bus: BusHarness; let main: PluginRegistry; let branch: PluginRegistry;
  const ran: string[] = [];
  before(async () => {
    if (!busBinsPresent) return;
    main = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore());
    main.register(authPassword); main.register(notifyLog); main.register(spySink(ran));
    branch = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore());
    branch.register(authPassword); branch.register(notifyLog); branch.register(spySink(ran));
    branch.register(authPasswordLockout(new Map()));
    bus = await startBusHarness({
      natsPort: NP, corePort: CORE_PORT, token: TOKEN, registry: main,
      registryFor: async (b) => (b === BRANCH ? branch : main),
      allRegistries: async () => [['main', main], [BRANCH, branch]],
    });
    main.setBus(bus.host.bridge());
    branch.setBus(bus.host.bridge(), BRANCH);
    // The lockout replacement is enabled on the branch only.
    await branch.install(T, 'auth-password-lockout', { install: true });
    await branch.enable(T, 'auth-password-lockout', { hooks: ['auth.authenticate'] });
    // The spy sink is enabled on the branch only.
    await branch.install(T, 'spy-sink', { install: true });
    await branch.enable(T, 'spy-sink', {});
    await bus.host.sync();
  });
  after(async () => { await bus?.close(); });

  it('main answers with the base, the branch with ITS replacement (control resolved per branch)', async (t) => {
    if (!bus) return t.skip('no nats-server or core binary');
    assert.equal((await main.callSlot<any>(T, 'auth.password', 'auth.authenticate', good)).result.outcome, 'allow');
    const r = await branch.callSlot<any>(T, 'auth.password', 'auth.authenticate', good);
    assert.equal(r.servedBy, 'auth-password-lockout'); assert.equal(r.result.outcome, 'allow');
    const recs: any = await (await fetch(`http://127.0.0.1:${CORE_PORT}/v1/bus/records?limit=100`, { headers: { 'x-core-admin-token': TOKEN } })).json();
    const last = recs.records.at(-1);
    assert.equal(last.branch, BRANCH, 'the branch rode in the envelope');
    const byId = Object.fromEntries(last.outcomes.map((o: any) => [o.id, o.status]));
    assert.equal(byId['auth-password-lockout'], 'replied', `the branch's replacement answered: ${JSON.stringify(last.outcomes)}`);
    assert.equal(byId['auth-password'], 'not-concerned');
  });

  it('an async event runs only the handlers active on ITS branch (simulated effects)', async (t) => {
    if (!bus) return t.skip('no nats-server or core binary');
    const ev = (subject: string) => ({ tenant: T, subject, change: 'joiner' as const, effectKey: `branch-${subject}` });
    await branch.emit(T, 'identity.changed', ev('zoe'));
    for (let i = 0; i < 60 && !ran.includes('zoe'); i++) await sleep(100);
    assert.deepEqual(ran, ['zoe'], 'the branch-enabled spy ran for the branch event');
    await main.emit(T, 'identity.changed', ev('yann'));
    await sleep(1200); // give a wrong delivery time to happen
    assert.deepEqual(ran, ['zoe'], "main's event found the spy disabled on main: consumed without effect");
  });
});
