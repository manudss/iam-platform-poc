import { describe, it, expect } from 'vitest';
import { advance, bucketize, seenAt, silent, stepTo, JEntry } from './journal';

const e = (at: string, outcome = 'ok', candidates = ['a', 'b'], answered = ['a']): JEntry => ({ id: at, at, kind: 'plugin-hook', name: 'h', mode: 'blocking', candidates, answered, outcome, payload: {} });
describe('journal helpers', () => {
  it('buckets calls into the period and flags refused ones', () => {
    const from = Date.parse('2026-11-01T00:00:00Z'), to = from + 24 * 3600e3;
    const b = bucketize([e('2026-11-01T00:30:00Z'), e('2026-11-01T00:40:00Z', 'refused'), e('2026-10-31T23:00:00Z')], from, to, 24);
    expect(b.length).toBe(24); expect(b[0].count).toBe(2); expect(b[0].bad).toBe(1); expect(b.reduce((n, x) => n + x.count, 0)).toBe(2);
  });
  it('lists plugins that could answer but did not', () => { expect(silent(e('2026-11-01T00:00:00Z'))).toEqual(['b']); });
});
describe('playback (read only)', () => {
  const from = 0, to = 60000;
  it('x1 plays the period in 60 s, speed multiplies, stops at the end', () => {
    expect(advance(0, 1000, 1, from, to)).toEqual({ cursor: 1000, done: false });
    expect(advance(0, 1000, 10, from, to).cursor).toBe(10000);
    expect(advance(59500, 1000, 1, from, to)).toEqual({ cursor: 60000, done: true });
  });
  it('shows only calls up to the cursor and steps between recorded calls', () => {
    const es = [e('1970-01-01T00:00:10Z'), e('1970-01-01T00:00:30Z')];
    expect(seenAt(es, 9000).length).toBe(0); expect(seenAt(es, 10000).length).toBe(1); expect(seenAt(es, 31000).length).toBe(2);
    expect(stepTo(es, 0, 1)).toBe(10000); expect(stepTo(es, 10000, 1)).toBe(30000); expect(stepTo(es, 30000, 1)).toBeUndefined(); expect(stepTo(es, 30000, -1)).toBe(10000);
  });
});
