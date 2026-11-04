import { formatMapping, parseList, parseMapping } from './applications';

describe('applications form helpers', () => {
  it('round-trips the attribute mapping', () => {
    const m = { sub: 'id', email: 'email', NameID: 'email' };
    expect(parseMapping(formatMapping(m))).toEqual(m);
  });
  it('parses mapping lines, ignoring blanks and trimming', () => {
    expect(parseMapping(' sub = id \n\nname=display_name\n')).toEqual({ sub: 'id', name: 'display_name' });
  });
  it('parses lists by line or comma, without blanks or duplicates', () => {
    expect(parseList('a, b\nb\n\n c ')).toEqual(['a', 'b', 'c']);
    expect(parseList('')).toEqual([]);
  });
});
