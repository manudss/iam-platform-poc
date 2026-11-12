import 'reflect-metadata';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { realGoogleDemoSeed } from './demo-seed.js';
import { validateGraph, validateTrigger, validateStepPlaceholders } from './model.js';
  it('prepares a disabled real-sheet seed without credentials or simulated notifications', () => {
    const seed = realGoogleDemoSeed('fictional-contract-sheet', '7', 'conn-demo');
    const { graph, order } = validateGraph({ nodes: seed.nodes, edges: seed.edges });
    validateTrigger(seed.trigger); validateStepPlaceholders(graph, order);
    assert.equal(seed.active, false);
    assert.equal(seed.nodes.find(n => n.id === 'mark')!.config.executionMode, 'real');
    assert.equal(seed.nodes.find(n => n.id === 'role')!.config.role, 'employee');
    assert.equal(seed.nodes.some(n => n.type === 'notify'), false);
    assert.throws(() => realGoogleDemoSeed('bad', '7', 'conn-demo'));
  });
