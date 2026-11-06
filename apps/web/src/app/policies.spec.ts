import { Rule, filterRules, pillars, schemaText, usageText } from './policies';

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
  it('words the recent use', () => {
    expect(usageText(undefined)).toBe('not used recently');
    expect(usageText({ allow: 3, deny: 1, last_at: null })).toBe('3 allowed, 1 denied');
  });
});
