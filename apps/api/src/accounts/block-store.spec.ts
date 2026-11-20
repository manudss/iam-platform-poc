import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlockStore } from './block-store.js';
import { refusalMessage, blockReference } from './blocks.js';

const tmp = async () => join(await mkdtemp(join(tmpdir(), 'blocks-')), 'b.json');
const base = { kind: 'suspended' as const, message: 'Paused for review.', origin: 'admin' as const, setBy: 'root', setAt: 1 };

describe('block store', () => {
  it('keeps several blocks, lifts one at a time, survives a restart, file is private', async () => {
    const p = await tmp(); const s = new BlockStore(p);
    const a = await s.add('t', { ...base, subject: 'u' });
    await s.add('t', { ...base, subject: 'u', kind: 'pending_verification' });
    assert.equal((await s.list('t', 'u')).length, 2);
    assert.deepEqual(await s.blocked('t'), ['u']);
    assert.equal(await new BlockStore(p).list('t', 'u').then((l) => l.length), 2);
    assert.equal(await s.lift('t', 'u', a.id), true);
    assert.deepEqual((await s.list('t', 'u')).map((x) => x.kind), ['pending_verification']);
    assert.equal(await s.lift('t', 'u', 'nope'), false);
    assert.equal(((await stat(p)).mode & 0o777), 0o600);
  });
  it('a second block of the same kind replaces the first, tenants stay apart', async () => {
    const s = new BlockStore(await tmp());
    await s.add('t', { ...base, subject: 'u', message: 'one' }); await s.add('t', { ...base, subject: 'u', message: 'two' }); await s.add('other', { ...base, subject: 'u' });
    assert.deepEqual((await s.list('t', 'u')).map((x) => x.message), ['two']);
    assert.equal((await s.list('other', 'u')).length, 1);
  });
  it('lockout is OFF and approval hold is off until an administrator sets them', async () => {
    const s = new BlockStore(await tmp());
    assert.equal((await s.lockout('t')).enabled, false); assert.equal(await s.holdAfterVerification('t'), false);
    await s.setLockout('t', { ...(await s.lockout('t')), enabled: true, maxFailures: 3 });
    assert.equal((await s.lockout('t')).maxFailures, 3); assert.equal((await s.lockout('other')).enabled, false);
  });
  it('the refusal shows the type, the admin message and a reference', () => {
    const m = refusalMessage({ ...base, id: 'ab12cd34', subject: 'u' });
    assert.match(m, /^Account suspended\. Paused for review\. Reference BLK-CD34\.$/); assert.equal(blockReference({ id: 'ab12cd34' }), 'BLK-CD34');
  });
});
