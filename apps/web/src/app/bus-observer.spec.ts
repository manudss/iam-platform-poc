import { describe, it, expect } from 'vitest';
import { FIT, advance, factor, result, queuedOnes, answered, silentOnes, seenAt, stepTo, BusRec } from './bus-observer';

const rec = (seq: number, over: Partial<BusRec> = {}): BusRec => ({ seq, at_ms: seq * 1000, envelope_id: 'e' + seq, kind: 'k', mode: 'notify', payload: {}, elapsed_ms: 1, expected: [{ id: 'a', mandatory: false }], outcomes: [{ id: 'a', mandatory: false, status: 'replied', verdict: 'allow' }], ...over });
describe('bus observer', () => {
  it('reads the result from the real record', () => {
    expect(result(rec(1))).toBe('ok');
    expect(result(rec(1, { expected: [], outcomes: [] }))).toBe('no-consumer');
    expect(result(rec(1, { outcomes: [{ id: 'a', mandatory: false, status: 'silent' }] }))).toBe('silent-optional');
    expect(result(rec(1, { expected: [{ id: 'a', mandatory: true }], outcomes: [{ id: 'a', mandatory: true, status: 'silent' }] }))).toBe('refused');
    expect(result(rec(1, { verdict: 'deny' }))).toBe('refused');
    expect(result(rec(1, { outcomes: [{ id: 'a', mandatory: false, status: 'invalid' }] }))).toBe('error');
  });
  it('tells who answered and who stayed silent', () => {
    const r = rec(1, { outcomes: [{ id: 'a', mandatory: false, status: 'replied' }, { id: 'b', mandatory: false, status: 'silent' }] });
    expect(answered(r)).toEqual(['a']); expect(silentOnes(r)).toEqual(['b']);
  });
  it('durable queue receipts are not silent replies', () => {
    const r = rec(1, { outcomes: [{ id: 'a', mandatory: false, status: 'queued' }] });
    expect(result(r)).toBe('queued'); expect(queuedOnes(r)).toEqual(['a']); expect(silentOnes(r)).toEqual([]);
  });
  it('plays back in real time or fit mode and steps between records', () => {
    expect(advance(0, 1000, 1, 0, 120000)).toEqual({ cursor: 1000, done: false });
    expect(factor(FIT, 0, 3600000)).toBe(60);
    expect(advance(119500, 1000, 1, 0, 120000)).toEqual({ cursor: 120000, done: true });
    const rs = [rec(1), rec(2), rec(3)];
    expect(seenAt(rs, 2000).map((r) => r.seq)).toEqual([1, 2]);
    expect(stepTo(rs, 2000, 1)).toBe(3000); expect(stepTo(rs, 2000, -1)).toBe(1000); expect(stepTo(rs, 3000, 1)).toBeUndefined();
  });
});
