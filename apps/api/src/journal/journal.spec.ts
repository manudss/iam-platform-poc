import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { MemoryMigrationStore, MemorySettingsStore } from '../plugins/v1/memory-stores.js';
import { authPassword, authPasswordLockout, notifyLog, hooksJournal } from '../plugins/v1/builtin/index.js';
import { JournalStore, maskPayload, maskEmail, hookObserver, journalStore, HookObservation } from './journal.js';

const T = 'jt';
describe('hooks journal: masking', () => {
  it('drops credentials and shortens e-mail addresses', () => {
    const m = maskPayload({ subject: 'demo-alice', credential: { password: 'hunter2' }, password: 'x', token: 'abc', email: 'alice.martin@example.com', note: 'mail bob@corp.io now', n: 3, nested: { a: 1 } });
    assert.equal(m.subject, 'demo-alice');
    assert.equal(m.credential, '[masked]'); assert.equal(m.password, '[masked]'); assert.equal(m.token, '[masked]');
    assert.equal(m.email, 'a***@e***.com'); assert.match(m.note, /b\*\*\*@c\*\*\*\.io/);
    assert.equal(m.n, '3'); assert.equal(m.nested, '[object]');
    assert.ok(!JSON.stringify(m).includes('hunter2'));
    assert.equal(maskEmail('x@y.fr'), 'x***@y***.fr');
  });
});
describe('hooks journal: store', () => {
  it('is bounded, filters by period, never invents history', () => {
    const s = new JournalStore(3, undefined);
    assert.equal(s.recordingSince(T), undefined);
    for (let i = 0; i < 5; i++) s.record({ tenant: T, kind: 'plugin-hook', name: 'h', mode: 'blocking', candidates: ['a'], answered: ['a'], outcome: 'ok', at: `2026-11-0${i + 1}T10:00:00.000Z` });
    assert.equal(s.recordingSince(T), '2026-11-01T10:00:00.000Z');
    const all = s.query({ tenant: T });
    assert.equal(all.total, 3); assert.equal(all.entries[0].at, '2026-11-05T10:00:00.000Z');
    assert.equal(s.query({ tenant: T, from: '2026-11-04T00:00:00.000Z' }).total, 2);
    assert.equal(s.query({ tenant: 'other' }).total, 0);
    assert.equal(s.summary({ tenant: T }).hooks[0].count, 3);
  });
});
describe('hooks journal: registry observation', () => {
  let reg: PluginRegistry; let seen: HookObservation[]; const prev = hookObserver.current;
  beforeEach(() => {
    seen = []; hookObserver.current = (o) => { seen.push(o); };
    reg = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore(), () => undefined);
    reg.register(authPassword); reg.register(notifyLog); reg.register(hooksJournal);
  });
  it('reports nothing while the plugin is disabled', async () => {
    await reg.callSlot(T, 'auth.password', 'auth.authenticate', { subject: 'demo-user-1', credential: { password: 'demo-pass-1' } });
    assert.equal(seen.length, 0);
    hookObserver.current = prev;
  });
  it('after enabling: who could answer and who answered, credentials masked, no effect from reading', async () => {
    await reg.install(T, 'hooks-journal', {}); await reg.enable(T, 'hooks-journal', {});
    hookObserver.current = (o) => { seen.push(o); if (o.journalActive) journalStore.record(o); };
    await reg.callSlot(T, 'auth.password', 'auth.authenticate', { subject: 'demo-user-1', credential: { password: 'demo-pass-1' } });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].answered, ['auth-password']); assert.ok(seen[0].candidates.includes('auth-password'));
    const q = journalStore.query({ tenant: T });
    assert.equal(q.total, 1);
    assert.ok(!JSON.stringify(q).includes('demo-pass-1'));
    assert.equal((q.entries[0].payload as Record<string, string>).credential, '[masked]');
    hookObserver.current = prev;
  });
  it('records a refused sensitive call and an async fan-out with no consumer', async () => {
    reg.register(authPasswordLockout());
    await reg.install(T, 'hooks-journal', {}); await reg.enable(T, 'hooks-journal', {});
    await reg.install(T, 'auth-password-lockout', { install: true });
    await reg.enable(T, 'auth-password-lockout', { hooks: ['auth.authenticate'] });
    await reg.emit(T, 'identity.changed', { effectKey: 'e1' });
    const noConsumer = seen.find((o) => o.mode === 'async');
    assert.equal(noConsumer?.outcome, 'no-consumer'); assert.deepEqual(noConsumer?.answered, []);
    hookObserver.current = prev;
  });
});
