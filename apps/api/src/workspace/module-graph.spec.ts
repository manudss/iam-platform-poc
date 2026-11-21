import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Test } from '@nestjs/testing';
import { WorkspaceModule } from './workspace.module.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';

/** The module graph must resolve (exports, imports, injection). Without NATS/Dolt the compile stops later, at the event bus requirement: that
 * one is tolerated here, any wiring error (bad export, unresolved dependency) is not. It caught a bad export that only the demo image build showed. */
describe('module graph: publication wiring', () => {
  for (const [name, mod] of [['WorkspaceModule', WorkspaceModule], ['WorkflowsModule', WorkflowsModule]] as const) {
    it(`${name} has no export or dependency wiring error`, async () => {
      try { await Test.createTestingModule({ imports: [mod] }).compile(); }
      catch (e) {
        const m = String((e as Error).message);
        assert.ok(/event bus required/.test(m), `wiring error: ${m.slice(0, 300)}`);
      }
    });
  }
});
