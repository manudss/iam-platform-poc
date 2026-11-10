import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hasDataSteps, nextCronFire, placeholderKeys, substituteEventPayload, validateCronExpression, validateGraph, validateStepPlaceholders, validateTrigger } from './model.js';
import { COMMUNITY_TEMPLATES, OFFICIAL_TEMPLATES } from './templates-catalog.js';

const node = (id: string, type: string, config: object = {}, name = id) => ({ id, type, name, config });
const seq = (...ids: string[]) => ids.slice(1).map((to, i) => ({ from: ids[i], to }));

describe('workflow graph validation', () => {
  it('accepts a simple linear graph and returns its order', () => {
    const { order, graph } = validateGraph({ nodes: [node('a', 'wait', { seconds: 1 }), node('b', 'notify', { recipient: 'manager', message: 'hi' })], edges: seq('a', 'b') });
    assert.deepEqual(order, ['a', 'b']);
    assert.equal(graph.nodes[1].config.recipient, 'manager');
  });
  it('accepts a diamond (acyclic with joins) in topological order', () => {
    const { order } = validateGraph({ nodes: [node('a', 'wait'), node('b', 'wait'), node('c', 'wait'), node('d', 'wait')], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }] });
    assert.equal(order[0], 'a');
    assert.equal(order[3], 'd');
  });
  it('refuses cycles, dangling edges, duplicates, unknown types and bad ids', () => {
    assert.throws(() => validateGraph({ nodes: [node('a', 'wait'), node('b', 'wait')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }), /cycle/);
    assert.throws(() => validateGraph({ nodes: [node('a', 'wait')], edges: [{ from: 'a', to: 'ghost' }] }), /unknown step/);
    assert.throws(() => validateGraph({ nodes: [node('a', 'wait'), node('a', 'wait')], edges: [] }), /duplicate/);
    assert.throws(() => validateGraph({ nodes: [node('a', 'teleport')], edges: [] }), /unknown step type/);
    assert.throws(() => validateGraph({ nodes: [node("a'; drop", 'wait')], edges: [] }), /invalid step id/);
    assert.throws(() => validateGraph({ nodes: [node('a', 'wait'), node('b', 'wait')], edges: [{ from: 'a', to: 'a' }] }), /itself/);
  });
  it('bounds the graph size', () => {
    const many = Array.from({ length: 21 }, (_, i) => node(`n${i}`, 'wait'));
    assert.throws(() => validateGraph({ nodes: many, edges: [] }), /1 to 20/);
    assert.throws(() => validateGraph({ nodes: [], edges: [] }), /1 to 20/);
  });
  it('validates per-type config and rejects unknown keys', () => {
    assert.throws(() => validateGraph({ nodes: [node('a', 'wait', { seconds: 600 })], edges: [] }), /0 to 60/);
    assert.throws(() => validateGraph({ nodes: [node('a', 'notify', { message: 'x' })], edges: [] }), /recipient is required/);
    assert.throws(() => validateGraph({ nodes: [node('a', 'assign-role', { identity: 'UPPER', role: 'ok' })], edges: [] }), /identity uses lowercase/);
    assert.throws(() => validateGraph({ nodes: [node('a', 'assign-role', { identity: 'ok', role: 'ok', extra: 1 })], edges: [] }), /unknown config key/);
    assert.throws(() => validateGraph({ nodes: [node('a', 'set-department', { identity: 'ok' })], edges: [] }), /department is required/);
    assert.throws(() => validateGraph({ nodes: [node('a', 'set-profile-field', { identity: 'ok', field: 'noDot', value: 'x' })], edges: [] }), /profile field key/);
    assert.throws(() => validateGraph({ nodes: [node('a', 'set-profile-field', { identity: 'ok', field: 'hr-attributes.employee_grade' })], edges: [] }), /value is required/);
    assert.throws(() => validateGraph({ nodes: [node('a', 'set-profile-field', { identity: 'ok', field: 'hr-attributes.employee_grade', value: 'G1', extra: 1 })], edges: [] }), /unknown config key/);
    const { graph } = validateGraph({ nodes: [node('a', 'wait')], edges: [] });
    assert.equal(graph.nodes[0].config.seconds, 2); // default
    const spf = validateGraph({ nodes: [node('a', 'set-profile-field', { identity: '{{event.subject}}', field: 'hr-attributes.employee_grade', value: 'G1' })], edges: [] }).graph;
    assert.equal(spf.nodes[0].config.value, 'G1');
  });
  it('marks simulated-only graphs vs graphs with real data steps', () => {
    const sim = validateGraph({ nodes: [node('a', 'wait'), node('b', 'notify', { recipient: 'x', message: 'y' })], edges: seq('a', 'b') }).graph;
    assert.equal(hasDataSteps(sim), false);
    const real = validateGraph({ nodes: [node('a', 'assign-role', { identity: 'demo-bob', role: 'accountant' })], edges: [] }).graph;
    assert.equal(hasDataSteps(real), true);
  });
  it('keeps a duplicated link only once', () => {
    const { graph } = validateGraph({ nodes: [node('a', 'wait'), node('b', 'wait')], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }] });
    assert.equal(graph.edges.length, 1);
  });
});

describe('workflow start triggers', () => {
  it('validates the trigger: known event, payload-bound match keys, no smuggled fields', () => {
    assert.deepEqual(validateTrigger(undefined), null);
    assert.deepEqual(validateTrigger({ event: 'user.created' }), { event: 'user.created' });
    assert.deepEqual(validateTrigger({ event: 'user.department-changed', match: { to: 'finance' } }), { event: 'user.department-changed', match: { to: 'finance' } });
    assert.throws(() => validateTrigger({ event: 'user.deleted' }), /unknown event/);
    assert.throws(() => validateTrigger({ event: 'user.created', match: { role: 'x' } }), /not a payload key/);
    assert.throws(() => validateTrigger({ event: 'user.created', admin: true }), /only event, match, config/);
    // config is reserved for contributed events that declare configFields; built-in events take none
    assert.throws(() => validateTrigger({ event: 'user.created', config: { token: 'x' } }), /unknown key/);
  });
  it('accepts {{event.<key>}} placeholders in step configs, still refuses garbage', () => {
    const { graph } = validateGraph({ nodes: [node('a', 'assign-role', { identity: '{{event.subject}}', role: 'employee' })], edges: [] });
    assert.equal(graph.nodes[0].config.identity, '{{event.subject}}');
    assert.throws(() => validateGraph({ nodes: [node('a', 'assign-role', { identity: '{{event.subject}', role: 'employee' })], edges: [] }), /identity uses lowercase/);
    assert.throws(() => validateGraph({ nodes: [node('a', 'assign-role', { identity: 'UPPER', role: 'employee' })], edges: [] }), /identity uses lowercase/);
    assert.deepEqual(placeholderKeys('x {{event.subject}} y {{event.to}}'), ['subject', 'to']);
    assert.deepEqual(placeholderKeys('plain'), []);
  });
  it('resolves placeholders from the event payload and refuses a missing key', () => {
    const { graph } = validateGraph({ nodes: [node('a', 'assign-role', { identity: '{{event.subject}}', role: 'employee' }), node('b', 'notify', { recipient: 'manager', message: '{{event.displayName}} arrived' })], edges: seq('a', 'b') });
    const resolved = substituteEventPayload(graph, { subject: 'jane-doe', displayName: 'Jane Doe' });
    assert.equal(resolved.nodes[0].config.identity, 'jane-doe');
    assert.equal(resolved.nodes[1].config.message, 'Jane Doe arrived');
    assert.throws(() => substituteEventPayload(graph, { displayName: 'Jane Doe' }), /no value for \{\{event.subject\}\}/);
    // The resolved graph is validated again at start: a bad payload value is caught there.
    const bad = substituteEventPayload(graph, { subject: 'UPPER CASE', displayName: 'x' });
    assert.throws(() => validateGraph(bad), /identity uses lowercase/);
  });
});

describe('cron triggers (phase 3)', () => {
  it('validates expressions: five fields, ranges, steps, lists', () => {
    assert.equal(validateCronExpression('0 6 * * *'), '0 6 * * *');
    assert.equal(validateCronExpression('  */15   9-17  *  *  1-5 '), '*/15 9-17 * * 1-5');
    assert.throws(() => validateCronExpression('0 6 * *'), /five fields/);
    assert.throws(() => validateCronExpression('99 * * * *'), /out of range/);
    assert.throws(() => validateCronExpression('a b c d e'), /not a valid/);
    assert.throws(() => validateCronExpression('*/0 * * * *'), /invalid step/);
    assert.throws(() => validateCronExpression('5-2 * * * *'), /out of range/);
  });
  it('a trigger is either a cron or an event, never both, without match/config', () => {
    assert.deepEqual(validateTrigger({ cron: '0 6 * * *' }), { cron: '0 6 * * *' });
    assert.throws(() => validateTrigger({ cron: '0 6 * * *', event: 'user.created' }), /exclusive/);
    assert.throws(() => validateTrigger({ cron: '0 6 * * *', match: { to: 'x' } }), /match/);
    assert.throws(() => validateTrigger({ cron: '0 6 * * *', config: { token: 'x' } }), /config/);
    assert.throws(() => validateTrigger({ cron: 'nope' }), /five fields/);
  });
  it('nextCronFire finds the next matching Paris minute', () => {
    const from = Date.parse('2026-11-10T22:00:00+01:00'); // 23:00 Europe/Paris
    assert.equal(new Date(nextCronFire('* * * * *', from)).toISOString(), '2026-11-10T21:01:00.000Z'); // 22:01 Paris = 21:01Z
    // Daily at 06:00 Paris: next is tomorrow 06:00 Paris (05:00Z in winter)
    assert.equal(new Date(nextCronFire('0 6 * * *', from)).toISOString(), '2026-11-11T05:00:00.000Z');
    // Weekdays only (1-5): 2026-11-13 is a Friday 23:00 Paris -> next Monday 00:00 Paris
    const fri = Date.parse('2026-11-13T22:00:00+01:00');
    assert.equal(new Date(nextCronFire('0 0 * * 1-5', fri)).toISOString(), '2026-11-15T23:00:00.000Z');
    // Steps: */15 from :00 -> :15
    assert.equal(new Date(nextCronFire('*/15 * * * *', from)).toISOString(), '2026-11-10T21:15:00.000Z'); // 22:15 Paris = 21:15Z
  });
});

describe('templates catalog (phase 3)', () => {
  it('every official or community template is categorized, unique and instantiable: valid graph, placeholders and trigger', () => {
    const all = [...OFFICIAL_TEMPLATES, ...COMMUNITY_TEMPLATES];
    assert.ok(OFFICIAL_TEMPLATES.length >= 8);
    assert.ok(COMMUNITY_TEMPLATES.length >= 3);
    assert.ok(COMMUNITY_TEMPLATES.every((t) => t.author), 'community picks are attributed');
    assert.ok(COMMUNITY_TEMPLATES.some((t) => t.trigger?.cron), 'a community pick shows a cron trigger');
    assert.equal(new Set(all.map((t) => t.id)).size, all.length, 'unique ids');
    for (const t of all) {
      assert.ok(t.category.length > 0 && t.nodes.length > 0, `${t.id}: categorized with blocks`);
      const { graph, order } = validateGraph({ nodes: t.nodes, edges: t.edges });
      validateStepPlaceholders(graph, order);
      validateTrigger(t.trigger ?? null);
    }
  });
});
