import { WfBlock, WfEvent, WfNode } from './wf-model';
import { autoLayout, defaultLabel, edgeLabelChoices, loopBody, outgoingLabels, placeholdersIn, validateGraph } from './graph-utils';

// Unit tests for the editor graph helpers: branch labels, client-side validation (mirrors the server
// rules) and the layered auto-layout.

const BLOCKS: WfBlock[] = [
  { type: 'notify', family: 'Core', label: 'Notify', simulated: true, description: '', provider: null, providerActive: true, fields: [{ key: 'recipient', label: 'Recipient', type: 'string', required: true }], outputs: [] },
  { type: 'if', family: 'Logic', label: 'If', simulated: true, category: 'computed', description: '', provider: null, providerActive: true, fields: [{ key: 'left', label: 'Left', type: 'string', required: true }], outputs: [{ key: 'branch', description: '' }] },
  { type: 'loop', family: 'Logic', label: 'Loop', simulated: true, category: 'computed', description: '', provider: null, providerActive: true, fields: [{ key: 'items', label: 'Items', type: 'string' }], outputs: [{ key: 'item', description: '' }] },
];
const EVENTS: WfEvent[] = [{ type: 'user.created', label: 'User created', payload: ['subject', 'email'] }];
const node = (id: string, type: string, config: Record<string, unknown> = {}, name = id): WfNode => ({ id, type, name, config });

describe('logic branch labels', () => {
  it('lists the branch labels of each logic type, plain steps have none', () => {
    expect(outgoingLabels('if', {})).toEqual(['true', 'false']);
    expect(outgoingLabels('switch', { cases: 'a=1\nb=2' })).toEqual(['a', 'b', 'default']);
    expect(outgoingLabels('loop', {})).toEqual(['each', 'done']);
    expect(outgoingLabels('merge', {})).toEqual([]);
    expect(outgoingLabels('notify', {})).toEqual([]);
  });
  it('offers the error path on every step and (main flow) on plain steps', () => {
    expect(edgeLabelChoices('notify', {}).map((c) => c.value)).toEqual(['', 'error']);
    expect(edgeLabelChoices('if', {}).map((c) => c.value)).toEqual(['true', 'false', 'error']);
  });
  it('picks the first unused branch label when drawing a link', () => {
    expect(defaultLabel('if', {}, [])).toBe('true');
    expect(defaultLabel('if', {}, ['true'])).toBe('false');
    expect(defaultLabel('if', {}, ['true', 'false'])).toBeUndefined();
    expect(defaultLabel('notify', {}, [])).toBeUndefined();
  });
});

describe('editor validation', () => {
  it('accepts a valid branching graph', () => {
    const nodes = [node('c', 'if', { left: '{{event.subject}}' }), node('t', 'notify', { recipient: 'a' }), node('f', 'notify', { recipient: 'b' })];
    const edges = [{ from: 'c', to: 't', label: 'true' }, { from: 'c', to: 'f', label: 'false' }];
    expect(validateGraph(nodes, edges, BLOCKS, EVENTS, 'user.created')).toEqual([]);
  });
  it('flags missing required fields, unlabeled logic links and missing branches as errors', () => {
    const nodes = [node('c', 'if', {}), node('t', 'notify', {})];
    const edges = [{ from: 'c', to: 't' }];
    const msgs = validateGraph(nodes, edges, BLOCKS, EVENTS, 'user.created').filter((i) => i.level === 'error').map((i) => i.message).join('\n');
    expect(msgs).toContain('required field');
    expect(msgs).toContain('needs a branch label');
    expect(msgs).toContain('missing the "true" branch');
    expect(msgs).toContain('missing the "false" branch');
  });
  it('flags labels on plain steps other than the error path', () => {
    const nodes = [node('a', 'notify', { recipient: 'x' }), node('b', 'notify', { recipient: 'y' })];
    const issues = validateGraph(nodes, [{ from: 'a', to: 'b', label: 'true' }], BLOCKS, EVENTS, '');
    expect(issues.some((i) => i.level === 'error' && i.message.includes('only logic steps'))).toBe(true);
  });
  it('flags cycles, unknown step references and non-upstream references', () => {
    const cyclic = validateGraph([node('a', 'notify', { recipient: 'x' }), node('b', 'notify', { recipient: 'y' })], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }], BLOCKS, EVENTS, '');
    expect(cyclic.some((i) => i.message.includes('cycle'))).toBe(true);
    const unknown = validateGraph([node('a', 'notify', { recipient: '{{steps.ghost.out}}' })], [], BLOCKS, EVENTS, '');
    expect(unknown.some((i) => i.message.includes('unknown step'))).toBe(true);
    const sideways = validateGraph([node('a', 'notify', { recipient: '{{steps.b.out}}' }), node('b', 'notify', { recipient: 'y' })], [], BLOCKS, EVENTS, '');
    expect(sideways.some((i) => i.message.includes('not upstream'))).toBe(true);
  });
  it('flags event placeholders without a trigger and unknown event keys as warnings', () => {
    const noTrigger = validateGraph([node('a', 'notify', { recipient: '{{event.subject}}' })], [], BLOCKS, EVENTS, '');
    expect(noTrigger.some((i) => i.level === 'error' && i.message.includes('no start trigger'))).toBe(true);
    const wrongKey = validateGraph([node('a', 'notify', { recipient: '{{event.nope}}' })], [], BLOCKS, EVENTS, 'user.created');
    expect(wrongKey.some((i) => i.level === 'warning' && i.message.includes('not a documented key'))).toBe(true);
  });
  it('flags nested loops', () => {
    const nodes = [node('l1', 'loop'), node('l2', 'loop'), node('b', 'notify', { recipient: 'x' })];
    const edges = [{ from: 'l1', to: 'l2', label: 'each' }, { from: 'l2', to: 'b', label: 'each' }, { from: 'l1', to: 'b', label: 'done' }];
    expect(validateGraph(nodes, edges, BLOCKS, EVENTS, '').some((i) => i.message.includes('Nested loops'))).toBe(true);
  });
});

describe('loopBody / placeholders / auto-layout', () => {
  it('computes the loop body as each-descendants minus done-descendants', () => {
    const nodes = [node('l', 'loop'), node('a', 'notify'), node('b', 'notify'), node('after', 'notify')];
    const edges = [{ from: 'l', to: 'a', label: 'each' }, { from: 'a', to: 'b' }, { from: 'l', to: 'after', label: 'done' }, { from: 'b', to: 'after' }];
    const body = loopBody(nodes, edges, 'l');
    expect([...body].sort()).toEqual(['a', 'b']);
  });
  it('extracts event and step placeholders from text fields', () => {
    expect(placeholdersIn('hi {{event.subject}} and {{ steps.a.value }}')).toEqual([{ source: 'event', path: 'subject' }, { source: 'steps', path: 'a.value' }]);
    expect(placeholdersIn(42)).toEqual([]);
  });
  it('lays out layers left to right by topological depth', () => {
    const nodes = [node('a', 'notify'), node('b', 'notify'), node('c', 'notify'), node('d', 'notify')];
    const edges = [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }];
    const pos = autoLayout(nodes, edges);
    expect(pos.get('a')!.x).toBe(pos.get('b')!.x);
    expect(pos.get('c')!.x).toBeGreaterThan(pos.get('a')!.x);
    expect(pos.get('d')!.x).toBeGreaterThan(pos.get('c')!.x);
    expect(pos.get('a')!.y).not.toBe(pos.get('b')!.y);
  });
});
