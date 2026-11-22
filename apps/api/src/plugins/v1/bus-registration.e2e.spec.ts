import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startTestBus, testBusBinsPresent, TestBus } from '../../testing/test-bus.js';

describe('bus registration replacement under concurrent HTTP callers (real core + NATS)', { skip: !testBusBinsPresent && 'real core and NATS required' }, () => {
  let bus: TestBus;
  before(async () => { const saved = process.env.TOKIO_WORKER_THREADS; process.env.TOKIO_WORKER_THREADS = '4'; try { bus = await startTestBus(import.meta.url); } finally { if (saved === undefined) delete process.env.TOKIO_WORKER_THREADS; else process.env.TOKIO_WORKER_THREADS = saved; } });
  after(async () => { const keepingCleanup = setInterval(() => {}, 100); try { await bus?.close(); } finally { clearInterval(keepingCleanup); } });
  const kinds = Array.from({ length: 128 }, (_, i) => `plg.registration-race.event${i}`);
  const body = { plugin: 'registration-race', declare_kinds: kinds.map(name => ({ name, mode: 'notify' })), subscriptions: kinds.map(kind => ({ kind })), emits: kinds };
  const post = async (path: string, value: unknown) => {
    const r = await fetch(`${bus.coreUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-core-admin-token': bus.token }, body: JSON.stringify(value) });
    return { status: r.status, body: await r.json() as any };
  };
  it('concurrent idempotent replacements all succeed and retain each declared delivery once', async () => {
    const initial = await post('/v1/bus/plugins/register', body);
    assert.equal(initial.status, 200, JSON.stringify(initial.body));
    for (let round = 0; round < 10; round++) {
      const responses = await Promise.all(Array.from({ length: 64 }, () => post('/v1/bus/plugins/register', body)));
      const failures = responses.filter(r => r.status !== 200);
      assert.deepEqual(failures, [], 'concurrent registration must not fail with duplicate subscriptions');
    }
    for (const kind of kinds) {
      const receipt = await post('/v1/bus/emit', { source: `plugin:${body.plugin}`, kind, payload: { fixture: true }, effect_key: kind });
      assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
      assert.equal(receipt.body.outcomes.filter((o: any) => o.id === body.plugin).length, 1, `${kind}: exactly one delivery`);
    }
  });
});
