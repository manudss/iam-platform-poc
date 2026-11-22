import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OFFICIAL_TEMPLATES } from './templates-catalog.js';
import { validateGraph } from './model.js';

// The recertification template must be a SAFE copyable example: manual start (no schedule),
// no hard-coded identity of the fictional dataset, a conditional that keeps the approved path
// free of any pull request, and remediation driven by loops over the REVIEW RESULTS (never fixed ids).
const tpl = () => OFFICIAL_TEMPLATES.find((t) => t.id === 'recertification-denial-remediation')!;
describe('recertification template (catalog)', () => {
  it('is valid and starts MANUALLY: no trigger, no cron', () => {
    const t = tpl();
    assert.equal((t as any).trigger, undefined, 'no implicit schedule: a copy stays inactive until deliberately activated');
    const { graph } = validateGraph({ nodes: t.nodes, edges: t.edges });
    assert.ok(graph.nodes.length > 0);
    assert.ok(!(t.nodes as any[]).some((n) => n.type === 'schedule' || (n.config as any)?.cron), 'no cron node in the graph');
  });
  it('contains no hard-coded demo identity', () => {
    const raw = JSON.stringify({ nodes: tpl().nodes, edges: tpl().edges });
    assert.ok(!raw.includes('demo-bob') && !raw.includes('demo-alice') && !raw.includes('payment-creator'), 'the scope stays a parameter (replace-with-user-id)');
  });
  it('branches on the review result and loops over the PREPARED actions', () => {
    const t = tpl(); const nodes = t.nodes as any[];
    const cond = nodes.find((n) => n.type === 'if')!;
    assert.equal(cond.config.left, '{{steps.await.denied}}', 'the condition reads the decisions count');
    const revloop = nodes.find((n) => n.id === 'revloop')!;
    assert.equal(revloop.config.items, '{{steps.prepare.actions}}', 'revocations come from the review results, not fixed ids');
    const revoke = nodes.find((n) => n.id === 'revoke')!;
    assert.equal(revoke.config.action, '{{steps.revloop.item}}', 'each loop item is a denied identity/role pair');
    const mark = nodes.find((n) => n.id === 'mark')!;
    assert.equal(mark.config.item, '{{steps.fixloop.item}}');
    const e = t.edges as any[];
    assert.ok(e.some((x) => x.from === 'any' && x.to === 'join' && x.label === 'false'), 'all approved -> straight to the close, no pull request');
    assert.ok(nodes.some((n) => n.type === 'merge'), 'the two paths join before the close (a plain step would wait for BOTH)');
    assert.ok(e.some((x) => x.from === 'any' && x.to === 'prepare' && x.label === 'true'));
    assert.ok(e.some((x) => x.from === 'revloop' && x.to === 'revoke' && x.label === 'each'));
    assert.ok(e.some((x) => x.from === 'revloop' && x.to === 'publish' && x.label === 'done'));
  });
});
