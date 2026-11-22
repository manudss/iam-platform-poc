import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BusHost } from './bus-host.js';

// Controlled transport barrier: subscribe queues the wire command; flush acknowledges it.
// No sleep, retries, credentials, provider calls or relaxed business assertions.
function fixture() {
  const host: any = Object.create(BusHost.prototype);
  const calls: string[] = [];
  let ready = false;
  let release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  Object.assign(host, {
    serving: new Map(), events: new Map(), eventMsgs: new Map(), services: new Map(), routedKinds: new Set(),
    chain: Promise.resolve(), closing: false,
    nc: {
      subscribe: () => { calls.push('subscribe'); return { async *[Symbol.asyncIterator]() {}, unsubscribe() {} }; },
      flush: async () => { calls.push('flush'); await barrier; ready = true; },
    },
    declarePlatformKinds: async () => {}, attachActivity: () => {}, serveEvents: () => {},
    allRegistries: async () => [['main', {
      tenants: () => [], list: () => [{ id: 'fixture-auth', enabled: true }],
      impl: () => ({ manifest: { id: 'fixture-auth', hooks: [{ name: 'auth.prepare', mode: 'blocking' }] } }),
    }]],
    post: async (path: string) => { if (path.endsWith('/register')) { calls.push('register'); assert.equal(ready, true, 'core must not publish routing before NATS acknowledges the subscriber'); } },
  });
  return { host, calls, release };
}
test('plugin readiness is acknowledged before routing is published and sync resolves', async () => {
  const { host, calls, release } = fixture();
  let finished = false;
  const pending = host.sync().then(() => { finished = true; });
  pending.catch(() => {});
  // Advance the finite promise chain, not wall-clock time.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.deepEqual(calls, ['subscribe', 'flush']);
  assert.equal(finished, false);
  release(); await pending;
  assert.deepEqual(calls, ['subscribe', 'flush', 'register']);
});
test('failed subscriber acknowledgement refuses sync without publishing registration', async () => {
  const { host, calls } = fixture();
  host.nc.flush = async () => { calls.push('flush'); throw new Error('fictional acknowledgement failure'); };
  await assert.rejects(host.sync(), /acknowledgement failure/);
  assert.deepEqual(calls, ['subscribe', 'flush']);
});
