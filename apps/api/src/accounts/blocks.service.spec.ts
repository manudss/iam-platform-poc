import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlockStore } from './block-store.js';
import { BlocksService } from './blocks.service.js';
import { canSignIn } from './blocks.js';

const mk = () => { const events: any[] = []; const store = new BlockStore(join(mkdtempSync(join(tmpdir(), 'blk-')), 'b.json')); let t = 1_000_000; return { events, store, svc: new BlocksService(store, (e) => events.push(e), () => t), tick: (ms: number) => { t += ms; } }; };
const base = { tenant: 't', actor: 'mgr', message: 'Contact HR.', admins: ['root'] };

describe('blocks service', () => {
  it('blocks someone else, with type and message, and tells the workflows', async () => {
    const { svc, store, events } = mk();
    const b = await svc.block({ ...base, subject: 'emp', kind: 'suspended' });
    assert.equal(b.kind, 'suspended'); assert.equal(b.origin, 'admin'); assert.equal(b.setBy, 'mgr');
    assert.equal(canSignIn(await store.list('t', 'emp'), 1_000_001), false);
    assert.deepEqual(events.map((e) => [e.type, e.payload.subject, e.payload.kind, e.payload.actor]), [['user.blocked', 'emp', 'suspended', 'mgr']]);
  });
  it('nobody blocks themselves', async () => {
    const { svc, store } = mk();
    await assert.rejects(svc.block({ ...base, subject: 'mgr', kind: 'suspended' }), (e: any) => e.response?.code === 'block-self');
    assert.deepEqual(await store.list('t', 'mgr'), []);
  });
  it('the last active administrator cannot be blocked, but one of two can', async () => {
    const { svc } = mk();
    await assert.rejects(svc.block({ ...base, subject: 'root', kind: 'suspended' }), (e: any) => e.response?.code === 'block-last-admin');
    await svc.block({ ...base, admins: ['root', 'root2'], subject: 'root', kind: 'suspended' });
    await assert.rejects(svc.block({ ...base, actor: 'x', admins: ['root', 'root2'], subject: 'root2', kind: 'suspended' }), (e: any) => e.response?.code === 'block-last-admin');
  });
  it('anyone with the right lifts any block on someone else, whoever set it', async () => {
    const { svc, store, events } = mk();
    const b = await svc.block({ ...base, actor: 'root', subject: 'emp', kind: 'disabled' });
    await svc.unblock({ tenant: 't', actor: 'mgr', subject: 'emp', blockId: b.id });
    assert.deepEqual(await store.list('t', 'emp'), []); assert.equal(events.at(-1).type, 'user.unblocked');
    await assert.rejects(svc.unblock({ tenant: 't', actor: 'mgr', subject: 'emp', blockId: 'nope' }), { status: 404 });
  });
  it('validates kind, message and end time', async () => {
    const { svc } = mk();
    await assert.rejects(svc.block({ ...base, subject: 'e', kind: 'pending_verification' }), { status: 400 });
    await assert.rejects(svc.block({ ...base, subject: 'e', kind: 'suspended', message: ' ' }), { status: 400 });
    await assert.rejects(svc.block({ ...base, subject: 'e', kind: 'suspended', message: 'x'.repeat(301) }), { status: 400 });
    await assert.rejects(svc.block({ ...base, subject: 'e', kind: 'suspended', until: 5 }), { status: 400 });
  });
  it('a timed block ends by itself; a held one does not', async () => {
    const { svc, store, tick } = mk();
    await svc.block({ ...base, subject: 'a', kind: 'suspended', until: 1_000_500 }); await svc.block({ ...base, subject: 'b', kind: 'suspended', until: 1_000_500, hold: true });
    tick(1000);
    assert.equal(canSignIn(await store.list('t', 'a'), 1_001_000), true); assert.equal(canSignIn(await store.list('t', 'b'), 1_001_000), false);
  });
});
