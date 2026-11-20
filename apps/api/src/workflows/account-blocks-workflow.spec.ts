import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { externalBlock, validateGraph, type WfBlockCtx } from './model.js';
import { patchSecurity } from '../accounts/security-config.js';

const mk = (over: Partial<WfBlockCtx>) => { const lines: string[] = []; return { c: { tenant: 'acme', config: {}, settings: {}, dryRun: false, log: (l: string) => lines.push(l), outputs: {}, branchWrite: async () => undefined, runId: 'run-1', ...over } as WfBlockCtx, lines }; };
const calls: unknown[] = [];
const accounts = {
  block: async (_t: string, a: unknown) => { calls.push(['block', a]); return { applied: true, blockId: 'b1' }; },
  unblock: async (_t: string, a: unknown) => { calls.push(['unblock', a]); return { lifted: 2 }; },
  patchSecurity,
};

describe('workflow blocks: account blocks and security settings', () => {
  it('block validates its type, message and duration', () => {
    const b = externalBlock('lyam-block-account')!;
    assert.throws(() => b.validate({ subject: 'emp', kind: 'banned', message: 'x' }), /kind/);
    assert.throws(() => b.validate({ subject: 'emp', kind: 'suspended', message: '' }), /required/);
    assert.throws(() => b.validate({ subject: 'emp', kind: 'suspended', message: 'x'.repeat(301) }), /300/);
    assert.throws(() => b.validate({ subject: 'emp', kind: 'suspended', message: 'x', durationMinutes: 0.5 }), /minutes/);
    assert.deepEqual(b.validate({ subject: '{{event.subject}}', kind: 'suspended', message: 'Paused', durationMinutes: 30 }), { subject: '{{event.subject}}', kind: 'suspended', message: 'Paused', durationMinutes: 30 });
  });
  it('a test run applies nothing', async () => {
    const { c, lines } = mk({ test: true, accounts, config: { subject: 'emp', kind: 'suspended', message: 'm' } });
    calls.length = 0;
    assert.equal((await externalBlock('lyam-block-account')!.run(c))!.applied, false);
    assert.equal((await externalBlock('lyam-unblock-account')!.run({ ...c, config: { subject: 'emp' } }))!.lifted, 0);
    assert.equal(calls.length, 0); assert.match(lines[0], /would block/);
  });
  it('a real run asks the account service, with the run as actor context', async () => {
    calls.length = 0;
    const { c } = mk({ accounts, config: { subject: 'emp', kind: 'suspended', message: 'm', durationMinutes: 10 } });
    assert.equal((await externalBlock('lyam-block-account')!.run(c))!.applied, true);
    assert.deepEqual(calls[0], ['block', { runId: 'run-1', subject: 'emp', kind: 'suspended', message: 'm', untilSeconds: 600 }]);
    assert.equal((await externalBlock('lyam-unblock-account')!.run({ ...c, config: { subject: 'emp', kind: 'locked' } }))!.lifted, 2);
    assert.deepEqual(calls[1], ['unblock', { runId: 'run-1', subject: 'emp', kind: 'locked' }]);
  });
  it('without the account service the block refuses instead of pretending', async () => {
    await assert.rejects(externalBlock('lyam-block-account')!.run(mk({ config: { subject: 'emp', kind: 'suspended', message: 'm' } }).c), /not available/);
  });
  it('the settings block patches one setting on the run branch and refuses a bad value', async () => {
    const writes: unknown[][] = [];
    const db = { query: async (sql: string, p?: unknown[]) => { if (sql.includes('information_schema')) return [[{ n: 1 }], undefined] as [unknown, unknown]; if (sql.startsWith('select settings')) return [[], undefined] as [unknown, unknown]; writes.push(p ?? []); return [[], undefined] as [unknown, unknown]; } };
    const b = externalBlock('lyam-security-setting')!;
    const { c } = mk({ accounts, config: b.validate({ setting: 'lockout.maxFailures', value: '3' }), branchWrite: async (fn) => { await fn(db); } });
    await b.run(c);
    const saved = JSON.parse(String(writes[0][1])); assert.equal(saved.lockout.maxFailures, 3); assert.equal(saved.lockout.enabled, true);
    const bad = mk({ accounts, config: { setting: 'lockout.maxFailures', value: '0' }, branchWrite: async (fn) => { await fn(db); } }).c;
    await assert.rejects(b.run(bad), /maxFailures/);
  });
  it('patchSecurity: application level on and off, unknown settings refused', () => {
    const on = patchSecurity(undefined, 'appLevel.finance', '8') as any; assert.equal(on.appLevels.finance.minLevel, 8);
    const off = patchSecurity(on, 'appLevel.finance', '0') as any; assert.deepEqual(off.appLevels, {});
    assert.throws(() => patchSecurity(undefined, 'nope', '1'), /unknown/);
    assert.throws(() => patchSecurity(undefined, 'adminMinLevel', '11'), /adminMinLevel/);
  });
  it('a graph with the three blocks validates', () => {
    const n = (id: string, type: string, config: Record<string, unknown>) => ({ id, type, name: id, config });
    validateGraph({ nodes: [n('a', 'lyam-block-account', { subject: '{{event.subject}}', kind: 'suspended', message: 'm' }), n('b', 'lyam-security-setting', { setting: 'adminMinLevel', value: '5' }), n('c', 'lyam-unblock-account', { subject: 'x' })], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] });
  });
});
