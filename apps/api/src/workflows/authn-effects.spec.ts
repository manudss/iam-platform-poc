import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthnEffects } from './engine.js';

/** A fake AuthnService whose enrollment status is a shared, mutable object (the live store). */
const fakeAuthn = (state: Record<string, Record<string, boolean>>) => ({
  enroll: {
    status: async () => { await new Promise((r) => setImmediate(r)); return JSON.parse(JSON.stringify(state)); },
    remove: async (_t: string, _u: string, instance: string) => { delete state[instance]; },
  },
  saveConfig: async () => undefined,
  outbox: { send: async () => undefined },
});

const fakeTasks = (admins: string[] = []) => ({ isAdmin: (s: string) => admins.includes(s), poolMembers: (n: string) => (n === 'admin' ? admins : []) });

describe('buildAuthnEffects: immediate unenroll guards', () => {
  it('refuses to remove the LAST enrolled factor (defense in depth, engine side)', async () => {
    const fx = buildAuthnEffects(fakeAuthn({ 'm1:i1': { totp: true } }) as never, fakeTasks() as never)!;
    await assert.rejects(fx.unenroll('acme', { runId: 'r1', user: 'u1', instance: 'm1:i1', reason: 'x' }), /last enrolled factor/);
  });

  it('an already-absent factor is reported, not an error', async () => {
    const fx = buildAuthnEffects(fakeAuthn({ 'm2:i1': { pin: true } }) as never, fakeTasks() as never)!;
    assert.deepEqual(await fx.unenroll('acme', { runId: 'r1', user: 'u1', instance: 'm1:i1', reason: 'x' }), { removed: false });
  });

  it('two CONCURRENT re-enrollments of the two last factors: exactly one is removed, the other refused', async () => {
    const state: Record<string, Record<string, boolean>> = { 'm1:i1': { totp: true }, 'm2:i1': { pin: true } };
    const fx = buildAuthnEffects(fakeAuthn(state) as never, fakeTasks() as never)!;
    const a = fx.unenroll('acme', { runId: 'r1', user: 'u1', instance: 'm1:i1', reason: 'x' });
    const b = fx.unenroll('acme', { runId: 'r2', user: 'u1', instance: 'm2:i1', reason: 'y' });
    const [ra, rb] = await Promise.allSettled([a, b]);
    const removed = [ra, rb].filter((r) => r.status === 'fulfilled' && (r as PromiseFulfilledResult<{ removed: boolean }>).value.removed).length;
    const refused = [ra, rb].filter((r) => r.status === 'rejected' && /last enrolled factor/.test(String((r as PromiseRejectedResult).reason))).length;
    assert.equal(removed, 1, 'exactly one concurrent removal passes');
    assert.equal(refused, 1, 'the other sees the state the first left and refuses the last factor');
    assert.equal(Object.keys(state).length, 1, 'one factor remains enrolled');
  });

  it('targetIsAdmin wires the task service admin list (fail-open only when the service is absent)', async () => {
    const fx = buildAuthnEffects(fakeAuthn({}) as never, fakeTasks(['root']) as never)!;
    assert.equal(fx.targetIsAdmin('root'), true);
    assert.equal(fx.targetIsAdmin('u1'), false);
    assert.equal(fx.adminsConfigured(), true, 'a non-empty list');
    const fx2 = buildAuthnEffects(fakeAuthn({}) as never, undefined)!;
    assert.equal(fx2.targetIsAdmin('root'), false);
    assert.equal(fx2.adminsConfigured(), false, 'no task service: not configured');
    assert.equal(buildAuthnEffects(fakeAuthn({}) as never, fakeTasks([]) as never)!.adminsConfigured(), false, 'an empty list is reported, so the guard fails closed');
    assert.equal(buildAuthnEffects(undefined, fakeTasks() as never), undefined);
  });
});
