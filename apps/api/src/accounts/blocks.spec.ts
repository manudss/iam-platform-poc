import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type Block, afterVerification, canSignIn, inForce, lift, lockoutAfter, lockoutVerdict, LOCKOUT_OFF, LOCKOUT_DEFAULT, mayManage, shownBlock } from './blocks.js';

const b = (o: Partial<Block> & { id: string; kind: Block['kind'] }): Block => ({ subject: 'u', message: 'm', origin: 'admin', setBy: 'a', setAt: 1, ...o });
const now = 1_000;

describe('blocks in force', () => {
  it('no block: can sign in', () => assert.equal(canSignIn([], now), true));
  it('any block in force refuses sign-in, several blocks stack', () => {
    const l = [b({ id: '1', kind: 'pending_verification' }), b({ id: '2', kind: 'suspended' })];
    assert.equal(canSignIn(l, now), false);
    assert.equal(canSignIn(lift(l, '1'), now), false, 'lifting one keeps the other');
    assert.equal(canSignIn(lift(lift(l, '1'), '2'), now), true);
  });
  it('a timed block ends, a held block does not', () => {
    assert.equal(inForce([b({ id: '1', kind: 'locked', until: 500 })], now).length, 0);
    assert.equal(inForce([b({ id: '1', kind: 'locked', until: 500, hold: true })], now).length, 1);
    assert.equal(inForce([b({ id: '1', kind: 'locked', until: 2_000 })], now).length, 1);
  });
  it('shows the highest priority block, then the oldest', () => {
    const l = [b({ id: '1', kind: 'pending_verification' }), b({ id: '2', kind: 'locked', setAt: 5 }), b({ id: '3', kind: 'locked', setAt: 2 })];
    assert.equal(shownBlock(l, now)?.id, '3');
    assert.equal(shownBlock([b({ id: '9', kind: 'suspended' }), ...l], now)?.id, '9');
    assert.equal(shownBlock([], now), undefined);
  });
});

describe('e-mail verification', () => {
  const o = { subject: 'u', now, id: 'new', message: 'Waiting for approval' };
  it('lifts only the verification block', () => {
    const r = afterVerification([b({ id: '1', kind: 'pending_verification' }), b({ id: '2', kind: 'suspended' })], { ...o, holdAfterVerification: false });
    assert.deepEqual(r.map((x) => x.id), ['2']);
  });
  it('with hold, an approval block replaces it and only an admin or workflow lifts it', () => {
    const r = afterVerification([b({ id: '1', kind: 'pending_verification' })], { ...o, holdAfterVerification: true });
    assert.equal(r.length, 1); assert.equal(r[0].kind, 'pending_approval'); assert.equal(r[0].hold, true); assert.equal(canSignIn(r, now + 10 ** 12), false);
  });
  it('does not add a second approval block', () => {
    const r = afterVerification([b({ id: '1', kind: 'pending_verification' }), b({ id: '2', kind: 'pending_approval' })], { ...o, holdAfterVerification: true });
    assert.deepEqual(r.map((x) => x.id), ['2']);
  });
});

describe('who may block or unblock', () => {
  const admin = { subject: 'root', mayManageBlocks: true }, mgr = { subject: 'm', mayManageBlocks: true }, plain = { subject: 'p', mayManageBlocks: false };
  const t = (subject: string, adm = false) => ({ subject, admin: adm });
  it('nobody blocks themselves', () => {
    assert.deepEqual(mayManage({ actor: admin, target: t('root', true), kind: 'suspended', action: 'block', activeAdmins: ['root', 'x'] }), { ok: false, reason: 'self' });
  });
  it('the last active admin cannot be blocked', () => {
    assert.deepEqual(mayManage({ actor: { ...admin, subject: 'other' }, target: t('root', true), kind: 'suspended', action: 'block', activeAdmins: ['root'] }), { ok: false, reason: 'last-admin' });
  });
  it('whoever holds the right blocks and unblocks anyone else, of any kind', () => {
    for (const actor of [admin, mgr]) for (const kind of ['suspended', 'disabled', 'locked'] as const) for (const action of ['block', 'unblock'] as const)
      assert.equal(mayManage({ actor, target: t('e'), kind, action, activeAdmins: ['root', 'y'] }).ok, true);
  });
  it('without the right nothing is allowed', () => {
    assert.deepEqual(mayManage({ actor: plain, target: t('e'), kind: 'suspended', action: 'unblock', activeAdmins: ['root'] }), { ok: false, reason: 'not-allowed' });
  });
});

describe('a change set cannot lock us out', () => {
  it('refuses when the applier is blocked after the change', () => assert.deepEqual(lockoutAfter({ applier: 'me', adminsBefore: ['me', 'x'], blockedAfter: new Set(['me']) }), { ok: false, reason: 'applier-blocked' }));
  it('refuses when no admin is left', () => assert.deepEqual(lockoutAfter({ applier: 'me', adminsBefore: ['x', 'y'], blockedAfter: new Set(['x', 'y']) }), { ok: false, reason: 'no-admin-left' }));
  it('accepts a harmless change', () => assert.equal(lockoutAfter({ applier: 'me', adminsBefore: ['me', 'x'], blockedAfter: new Set(['z']) }).ok, true));
});

describe('automatic lock', () => {
  const on = { ...LOCKOUT_OFF, enabled: true, maxFailures: 3, windowMs: 1000, lockMs: 500 };
  it('starts on with 5 failures in 15 minutes, locked 15 minutes', () => { assert.equal(LOCKOUT_DEFAULT.enabled, true); assert.equal(lockoutVerdict([1, 2, 3, 4, 5], 6, LOCKOUT_DEFAULT, 'u').lock, true); assert.equal(LOCKOUT_DEFAULT.maxFailures, 5); });
  it('is off when disabled', () => assert.equal(lockoutVerdict([1, 2, 3, 4, 5, 6], 10, LOCKOUT_OFF, 'u').lock, false));
  it('counts failures inside the window only', () => {
    assert.equal(lockoutVerdict([0, 1500, 1600], 1700, on, 'u').lock, false);
    assert.equal(lockoutVerdict([1500, 1600, 1650], 1700, on, 'u').lock, true);
  });
  it('exempt accounts are never locked', () => assert.equal(lockoutVerdict([1500, 1600, 1650], 1700, { ...on, exempt: ['u'] }, 'u').lock, false));
});
