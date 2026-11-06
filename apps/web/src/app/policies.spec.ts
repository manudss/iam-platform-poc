import { Rule, beneficiaryOptions, buildCandidate, filterRules, parseSimContext, pillars, schemaText, targetOf, usageText } from './policies';

const mk = (id: string, effect: 'permit' | 'forbid', pillar: string | null, text = ''): Rule => ({ id, set: 'default', name: id, kind: 'policy', effect, description: `${id} desc`, pillar, summary: 'Permits any principal.', conditions: 0, text });
const rules = [mk('sod-blocks-approve', 'forbid', 'sod', 'context.sod_conflict == true'), mk('approve-needs-role', 'permit', 'human'), mk('mcp-read', 'permit', 'mcp'), mk('loose', 'permit', null)];

describe('policy catalogue helpers', () => {
  it('lists the groups, with "other" for rules without one', () => { expect(pillars(rules)).toEqual(['human', 'mcp', 'other', 'sod']); });
  it('filters by group, effect and text, all combined', () => {
    const none = { pillar: '', effect: '', text: '' };
    expect(filterRules(rules, none).length).toBe(4);
    expect(filterRules(rules, { ...none, pillar: 'other' }).map((r) => r.id)).toEqual(['loose']);
    expect(filterRules(rules, { ...none, effect: 'forbid' }).map((r) => r.id)).toEqual(['sod-blocks-approve']);
    expect(filterRules(rules, { ...none, text: ' SOD_CONFLICT ' }).map((r) => r.id)).toEqual(['sod-blocks-approve']);
    expect(filterRules(rules, { pillar: 'mcp', effect: 'forbid', text: '' })).toEqual([]);
  });
  it('words the schema validation state', () => {
    expect(schemaText(true)).toContain('validated against the Cedar schema');
    expect(schemaText(undefined)).toContain('without validation');
    expect(schemaText(false)).toContain('without validation');
  });
  it('parses the simulator context: empty means none, an object passes, the rest is refused', () => {
    expect(parseSimContext('')).toEqual({});
    expect(parseSimContext('   ')).toEqual({});
    expect(parseSimContext('{"roles": ["payment-approver"], "sod_conflict": true}')).toEqual({ context: { roles: ['payment-approver'], sod_conflict: true } });
    expect(parseSimContext('[').error).toContain('not valid JSON');
    expect(parseSimContext('["viewer"]').error).toContain('JSON object');
    expect(parseSimContext('"roles"').error).toContain('JSON object');
  });
  it('words the recent use', () => {
    expect(usageText(undefined)).toBe('not used recently');
    expect(usageText({ allow: 3, deny: 1, last_at: null })).toBe('3 allowed, 1 denied');
  });
});

describe('rule editing helpers (step 4)', () => {
  const withLink: Rule[] = [...rules, { ...mk('night-freeze', 'forbid', 'sod'), kind: 'template' }, { id: 'night-freeze:demo-bob', set: 'default', name: 'night-freeze:demo-bob', kind: 'link', effect: 'forbid', description: null, pillar: 'sod', summary: 'x', conditions: 1, text: 'permit(...);', template: 'night-freeze', values: { principal: 'User::"demo-bob"' } }];
  it('rebuilds a candidate from the catalogue: texts grouped by set, links with their beneficiaries', () => {
    const c = buildCandidate(withLink);
    expect(c.sets).toEqual([{ set: 'default', text: withLink.filter((r) => r.kind !== 'link').map((r) => r.text).join('\n\n') }]);
    expect(c.links).toEqual([{ id: 'night-freeze:demo-bob', template: 'night-freeze', values: { principal: 'User::"demo-bob"' } }]);
  });
  it('applies an edit in place, adds a new rule (and set), and drops a removed rule', () => {
    const edited = buildCandidate(withLink, { set: 'default', id: 'loose', text: 'forbid(principal, action, resource);' });
    expect(edited.sets[0].text).toContain('forbid(principal, action, resource);');
    expect(edited.sets[0].text.split('\n\n').length).toBe(5);
    const added = buildCandidate(withLink, { set: 'delegation', id: 'new-rule', text: 'permit(principal, action, resource);' });
    expect(added.sets.map((x) => x.set)).toEqual(['default', 'delegation']);
    const dropped = buildCandidate(withLink, null, { set: 'default', id: 'loose' });
    expect(dropped.sets[0].text.split('\n\n').length).toBe(4);
  });
  it('suggests every known person, role and organisation as a beneficiary', () => {
    expect(beneficiaryOptions(['demo-alice'], ['auditor'], ['acme'])).toEqual(['User::"demo-alice"', 'Role::"auditor"', 'Organization::"acme"']);
  });
  it('words the beneficiary of a link', () => {
    expect(targetOf(withLink[5])).toBe('User::"demo-bob"');
    expect(targetOf(rules[0])).toBe('');
  });
});
