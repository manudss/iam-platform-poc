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
