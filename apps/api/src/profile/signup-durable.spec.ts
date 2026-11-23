import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadPluginModule } from '../plugins/v1/loader.js';
import { MemorySignupRequestStore } from './signup-request-store.js';
const { createSignupManager } = loadPluginModule('directory', 'signup.mjs') as any;
const body = { id: 'applicant', display_name: 'Applicant', email: 'fiction@example.invalid', password: 'fictional-password-123', values: {} };
function manager(store: MemorySignupRequestStore) {
  const messages: any[] = [];
  const m = createSignupManager({
    pendingLoad: (t: string) => store.load(t), pendingSave: (t: string, rev: number, rows: any[]) => store.save(t, rev, rows),
    signupOpen: async () => true, schema: async () => [], signupValues: async () => ({}), usersList: async () => [],
    currentBranch: () => undefined, emit: () => {}, outboxSend: async (m: any) => messages.push(m),
  });
  return { m, messages };
}
describe('signup durable request adapter', () => {
  it('new manager confirms and rejects the persisted request, public list never exposes hashes or tokens', async () => {
    const store = new MemorySignupRequestStore();
    const first = manager(store);
    await first.m.submit('acme', body, 'ip1');
    const token = first.messages[0].text.split(': ')[1];
    const fresh = manager(store).m;
    assert.equal((await fresh.list('acme')).requests[0].confirmed, false);
    await fresh.confirm('other', token);
    assert.equal((await fresh.list('acme')).requests[0].confirmed, false);
    await fresh.confirm('acme', token);
    const list = await manager(store).m.list('acme');
    assert.equal(list.requests[0].confirmed, true);
    assert.doesNotMatch(JSON.stringify(list), /salt|hash|token|password/i);
    assert.ok(!JSON.stringify(await store.load('acme')).includes(body.password));
    await manager(store).m.reject(body.id, 'acme');
    assert.equal((await manager(store).m.list('acme')).requests.length, 0);
  });
  it('same id in different tenants is isolated, duplicate submission sends no second confirmation', async () => {
    const store = new MemorySignupRequestStore();
    const { m, messages } = manager(store);
    await m.submit('a', body, 'ip1'); await m.submit('b', body, 'ip2'); await m.submit('a', body, 'ip3');
    assert.equal(messages.length, 2);
    assert.equal((await m.list('a')).requests.length, 1);
    await m.reject(body.id, 'a');
    assert.equal((await m.list('b')).requests.length, 1);
  });
  it('stale writes are rejected instead of resurrecting a removed request', async () => {
    const s = new MemorySignupRequestStore();
    await s.save('a', 0, [{ id: 'one' }]);
    await s.save('a', 1, []);
    await assert.rejects(s.save('a', 1, [{ id: 'one' }]), /changed/);
    assert.deepEqual((await s.load('a')).requests, []);
  });
});

describe('signup publication-aware staging', () => {
  it('keeps request until exact publication, isolates another run, and finalizes only once after restart', async () => {
    const store = new MemorySignupRequestStore(); let token = '', published = false, creates = 0;
    const events: string[] = [];
    const mk = () => createSignupManager({
      pendingLoad: (t: string) => store.load(t), pendingSave: (t: string, rev: number, rows: any[]) => store.save(t, rev, rows),
      signupOpen: async () => true, signupValues: async () => ({ field: 'reviewed' }), usersList: async () => [], currentBranch: () => 'workflow/test',
      emit: (type: string) => events.push(type), outboxSend: async (m: any) => { token = m.text.split(': ')[1]; },
      usersStage: async () => { creates++; return { credential_revision: 'rev-1' }; }, putWorking: async () => {}, verifyPublished: async () => published,
    });
    await mk().submit('acme', body, 'ip'); await mk().confirm('acme', token);
    const request = (await mk().list('acme')).requests[0];
    const { createHash } = await import('node:crypto');
    const snapshot = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    assert.equal((await mk().stageApprove('acme', body.id, 'admin', snapshot, 'run-1', 'workflow/test')).publicationRequired, true);
    assert.equal(creates, 1);
    assert.equal((await mk().list('acme')).requests.length, 1, 'discarding a branch does not remove its request');
    assert.ok(!events.includes('signup.approved') && !events.includes('user.created'), 'no early live event');
    await assert.rejects(mk().stageApprove('acme', body.id, 'admin', snapshot, 'run-other', 'workflow/other'), /reserved/);
    await assert.rejects(mk().finalize('acme', body.id, 'admin', 'run-1'), /not effectively published/);
    await assert.rejects(mk().reject(body.id, 'acme'), /reserved/);
    published = true;
    assert.equal((await mk().finalize('acme', body.id, 'admin', 'run-1')).finalized, true);
    assert.equal((await mk().list('acme')).requests.length, 0);
    assert.equal((await mk().finalize('acme', body.id, 'admin', 'run-1')).resumed, true);
    assert.equal(events.filter(e => e === 'signup.approved').length, 1);
    const saved = JSON.stringify(await store.load('acme'));
    assert.ok(!saved.includes('rev-secret') && saved.includes('finalized'));
    assert.ok(!saved.includes(body.email) && !saved.includes(body.display_name) && !saved.includes('reviewed') && !saved.includes('rev-1'), 'receipt strips personal and credential material');
  });
  it('a failure after the reservation never blindly recreates a potentially created account', async () => {
    const store = new MemorySignupRequestStore(); let token = '', calls = 0;
    const mk = () => createSignupManager({ pendingLoad: (t: string) => store.load(t), pendingSave: (t: string, rev: number, rows: any[]) => store.save(t, rev, rows), signupOpen: async () => true, signupValues: async () => ({}), usersList: async () => [], currentBranch: () => undefined, emit: () => {}, outboxSend: async (m: any) => { token = m.text.split(': ')[1]; }, usersStage: async () => { calls++; throw Error('response lost'); } });
    await mk().submit('acme', body, 'ip'); await mk().confirm('acme', token);
    const { createHash } = await import('node:crypto');
    const snapshot = createHash('sha256').update(JSON.stringify((await mk().list('acme')).requests[0])).digest('hex');
    await assert.rejects(mk().stageApprove('acme', body.id, 'admin', snapshot, 'run-1', 'workflow/test'), /response lost/);
    await assert.rejects(mk().stageApprove('acme', body.id, 'admin', snapshot, 'run-1', 'workflow/test'), /uncertain/);
    assert.equal(calls, 1);
  });
});

describe('finalization receipts do not block a later signup generation', () => {
  it('an old run receipt is separate from a new request with the same id/email', async () => {
    const store = new MemorySignupRequestStore();
    await store.save('acme', 0, [{ tenant: 'acme', id: body.id, email: body.email, display_name: 'old', values: {}, confirmed: true, at: Date.now(), staged: { state: 'finalized', run: 'run-old' }, hash: '', salt: '', tokenHash: '' }]);
    const { m, messages } = manager(store);
    await m.submit('acme', body, 'ip');
    assert.equal(messages.length, 1);
    assert.equal((await m.list('acme')).requests.length, 1);
    assert.equal((await m.finalize('acme', body.id, 'admin', 'run-old')).resumed, true);
    assert.equal((await m.list('acme')).requests[0].confirmed, false, 'old replay does not consume or confirm the new generation');
    assert.equal((await store.load('acme')).requests.length, 2, 'receipt retained safely, not purged by guessed TTL');
  });
});

describe('signup receipt capacity and multiple subjects', () => {
  it('retains separate subjects finalized by the same workflow run', async () => {
    const store = new MemorySignupRequestStore();
    await store.save('acme', 0, ['one', 'two'].map(id => ({ tenant: 'acme', id, at: Date.now(), staged: { state: 'finalized', run: 'same-run' } })));
    const { m } = manager(store);
    assert.equal((await m.finalize('acme', 'one', 'admin', 'same-run')).resumed, true);
    assert.equal((await m.finalize('acme', 'two', 'admin', 'same-run')).resumed, true);
    await assert.rejects(m.finalize('acme', 'missing', 'admin', 'same-run'), /unknown/);
  });
  it('fails explicitly at capacity without deleting receipts or sending confirmation', async () => {
    const store = new MemorySignupRequestStore();
    await store.save('acme', 0, Array.from({ length: 1000 }, (_, i) => ({ tenant: 'acme', id: `old-${i}`, at: Date.now(), staged: { state: 'finalized', run: `run-${i}` } })));
    const { m, messages } = manager(store);
    await assert.rejects(m.submit('acme', body, 'ip'), (e: any) => e.getStatus() === 503);
    assert.equal(messages.length, 0);
    assert.equal((await store.load('acme')).requests.length, 1000);
    await m.submit('other', body, 'other-ip');
    assert.equal(messages.length, 1, 'capacity is tenant scoped');
  });
});
