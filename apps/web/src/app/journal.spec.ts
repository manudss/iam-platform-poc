import { describe, it, expect } from 'vitest';
import { FIT, advance, factor, factorLabel, bucketize, seenAt, silent, stepTo, JEntry } from './journal';

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
  const from = 0, to = 120000;
  it('x1 is real time, other speeds multiply it, the fit mode is explicit and depends on the period', () => {
    expect(advance(0, 1000, 1, from, to)).toEqual({ cursor: 1000, done: false });
    expect(advance(0, 1000, 60, from, to).cursor).toBe(60000);
    expect(factor(1, 0, 86400000)).toBe(1); expect(factor(FIT, 0, 86400000)).toBe(1440); expect(factor(FIT, 0, 3600000)).toBe(60);
    expect(factorLabel(3600)).toContain('1 h'); expect(factorLabel(1)).toContain('x1 ');
    expect(advance(119500, 1000, 1, from, to)).toEqual({ cursor: 120000, done: true });
  });
  it('shows only calls up to the cursor and steps between recorded calls', () => {
    const es = [e('1970-01-01T00:00:10Z'), e('1970-01-01T00:00:30Z')];
    expect(seenAt(es, 9000).length).toBe(0); expect(seenAt(es, 10000).length).toBe(1); expect(seenAt(es, 31000).length).toBe(2);
    expect(stepTo(es, 0, 1)).toBe(10000); expect(stepTo(es, 10000, 1)).toBe(30000); expect(stepTo(es, 30000, 1)).toBeUndefined(); expect(stepTo(es, 30000, -1)).toBe(10000);
  });
});
