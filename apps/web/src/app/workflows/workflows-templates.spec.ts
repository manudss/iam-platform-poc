import { WfTemplate, WF_TEMPLATES } from './wf-model';
import { filterTemplates, templateCategories } from './templates';

// Unit tests for the template gallery: category counts, filters, and the sample-derived gallery itself.
const tpl = (over: Partial<WfTemplate>): WfTemplate => ({
  id: 't1', name: 'HR onboarding', description: 'Grant starter roles', category: 'HR & sheets', source: 'official',
  nodes: [], edges: [], ...over,
});
const TEMPLATES: WfTemplate[] = [
  tpl({ id: 'a' }),
  tpl({ id: 'b', name: 'Loop over rows', category: 'HR & sheets', nodes: [{ id: 'l', type: 'loop', name: 'l', config: {} }] }),
  tpl({ id: 'c', name: 'SoD blocked', description: 'Governance demo', category: 'Governance' }),
];

describe('templateCategories / filterTemplates', () => {
  it('counts templates per category in first-seen order', () => {
    expect(templateCategories(TEMPLATES)).toEqual([{ name: 'HR & sheets', count: 2 }, { name: 'Governance', count: 1 }]);
  });
  it('filters by category and by text over name, description and node types', () => {
    expect(filterTemplates(TEMPLATES, 'Governance', '').map((t) => t.id)).toEqual(['c']);
    expect(filterTemplates(TEMPLATES, 'all', 'rows').map((t) => t.id)).toEqual(['b']);
    expect(filterTemplates(TEMPLATES, 'all', 'loop').map((t) => t.id)).toEqual(['b']);
    expect(filterTemplates(TEMPLATES, 'HR & sheets', 'rows').map((t) => t.id)).toEqual(['b']);
  });
});

describe('WF_TEMPLATES gallery', () => {
  it('derives one template per sample workflow, all official and categorized', () => {
    expect(WF_TEMPLATES.length).toBeGreaterThanOrEqual(8);
    expect(WF_TEMPLATES.every((t) => t.source === 'official')).toBe(true);
    expect(WF_TEMPLATES.every((t) => t.category.length > 0 && t.nodes.length > 0)).toBe(true);
    expect(new Set(WF_TEMPLATES.map((t) => t.id)).size).toBe(WF_TEMPLATES.length);
  });
  it('keeps trigger and graph from the samples so instantiation copies a working workflow', () => {
    const hr = WF_TEMPLATES.find((t) => t.name.toLowerCase().includes('joiner on user.created'))!;
    expect(hr.trigger?.event).toBe('user.created');
    expect(hr.edges.length).toBeGreaterThan(0);
  });
});
