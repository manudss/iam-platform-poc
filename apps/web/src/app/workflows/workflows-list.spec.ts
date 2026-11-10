import { DefinitionSummary } from './wf-model';
import { filterWorkflows } from './list';

// Unit tests for the workflows list cards: search, chip filters and sorting (direction C list).
const def = (over: Partial<DefinitionSummary>): DefinitionSummary => ({
  id: 'd1', name: 'Onboard', description: 'Grant the starter roles', updatedAt: '2026-01-01',
  trigger: null, active: true, tags: [], steps: 3, graph: { nodes: [], edges: [] }, stats: null,
  simulatedSteps: 0, computedSteps: 0, dataSteps: 0, createdBy: 'tester', ...over,
});
const DEFS: DefinitionSummary[] = [
  def({ id: 'a', name: 'Alpha onboarding', stats: { runs: 2, okPct: 100, lastStatus: 'completed', lastAt: '2026-01-02', lastDurationMs: 100 } }),
  def({ id: 'b', name: 'Beta offboarding', active: false, trigger: { event: 'user.deleted' }, stats: { runs: 1, okPct: 0, lastStatus: 'failed', lastAt: '2026-01-03', lastDurationMs: 50 } }),
  def({ id: 'c', name: 'Gamma import', stats: null }),
];

describe('filterWorkflows (list cards)', () => {
  it('filters by the active / paused / failed chips', () => {
    expect(filterWorkflows(DEFS, '', 'active', 'name').map((d) => d.id)).toEqual(['a', 'c']);
    expect(filterWorkflows(DEFS, '', 'paused', 'name').map((d) => d.id)).toEqual(['b']);
    expect(filterWorkflows(DEFS, '', 'failed', 'name').map((d) => d.id)).toEqual(['b']);
    expect(filterWorkflows(DEFS, '', 'all', 'name').length).toBe(3);
  });
  it('searches name, description, trigger event and node types', () => {
    expect(filterWorkflows(DEFS, 'beta', 'all', 'name').map((d) => d.id)).toEqual(['b']);
    expect(filterWorkflows(DEFS, 'starter', 'all', 'name').map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(filterWorkflows(DEFS, 'user.deleted', 'all', 'name').map((d) => d.id)).toEqual(['b']);
    const withNodes = [def({ id: 'n', graph: { nodes: [{ id: 'x', type: 'assign-role' }], edges: [] } })];
    expect(filterWorkflows(withNodes, 'assign', 'all', 'name').map((d) => d.id)).toEqual(['n']);
  });
  it('filters by a tag chip and matches tags in search', () => {
    const tagged = [
      def({ id: 'a', tags: ['hr', 'joiner'] }),
      def({ id: 'b', tags: ['finance'] }),
      def({ id: 'c', tags: [] }),
    ];
    expect(filterWorkflows(tagged, '', 'all', 'name', 'hr').map((d) => d.id)).toEqual(['a']);
    expect(filterWorkflows(tagged, '', 'all', 'name', 'finance').map((d) => d.id)).toEqual(['b']);
    expect(filterWorkflows(tagged, '', 'all', 'name', '').map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(filterWorkflows(tagged, 'joiner', 'all', 'name').map((d) => d.id)).toEqual(['a']);
  });
  it('sorts by name, by update time, and recent-first by last run (never-run last)', () => {
    expect(filterWorkflows(DEFS, '', 'all', 'name').map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(filterWorkflows(DEFS, '', 'all', 'updated').map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(filterWorkflows(DEFS, '', 'all', 'lastRun').map((d) => d.id)).toEqual(['b', 'a', 'c']);
  });
});
