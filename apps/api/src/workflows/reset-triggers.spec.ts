import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { WorkflowTriggersService } from './triggers.js';
import { WorkflowCronService } from './cron.js';
import { RESET_FROZEN } from './reset-freeze.js';
import { releaseDataReady } from '../migrations/readiness.js';

const definitions = ['frozen', 'healthy'].map(id => ({ id, tenant: 'acme', name: id, active: true, trigger: { event: 'user.created', cron: '* * * * *' } }));
const registry = { isActive: () => true };
describe('permanent reset refusal does not degrade automatic trigger loops', () => {
  it('event delivery resolves and continues to later definitions; subsequent events still dispatch', async () => {
    const calls: string[] = [];
    const wf = { start: async (_t: string, id: string) => { calls.push(id); if (id === 'frozen') throw new ForbiddenException(RESET_FROZEN); return { run: { id: 'healthy-run' } }; } };
    const svc = new WorkflowTriggersService({} as any, { listDefinitions: async () => definitions, liveRef: 'main' } as any, wf as any, registry as any);
    for (let i = 0; i < 2; i++) await (svc as any).dispatch({ id: `fictional-${i}`, tenant: 'acme', branch: 'main', type: 'user.created', payload: {} });
    assert.deepEqual(calls, ['frozen', 'healthy', 'frozen', 'healthy']);
  });
  it('other forbidden/transient errors remain rejected for ordinary redelivery', async () => {
    const svc = new WorkflowTriggersService({} as any, { listDefinitions: async () => definitions, liveRef: 'main' } as any, { start: async () => { throw new ForbiddenException('unrelated refusal'); } } as any, registry as any);
    await assert.rejects((svc as any).dispatch({ tenant: 'acme', branch: 'main', type: 'user.created', payload: {} }), /unrelated refusal/);
  });
  it('cron catches the refusal per definition, continues and releases its tick lock', async () => {
    releaseDataReady();
    const calls: string[] = [], markers = new Map<string, string>();
    const wf = { start: async (_t: string, id: string) => { calls.push(id); if (id === 'frozen') throw new ForbiddenException(RESET_FROZEN); return { run: { id: 'healthy-run' } }; } };
    const store = { listAllDefinitions: async () => definitions, liveRef: 'main', getMeta: async (k: string) => markers.get(k), setMeta: async (k: string, v: string) => markers.set(k, v) };
    const svc = new WorkflowCronService(store as any, wf as any, registry as any);
    await svc.tick(); markers.clear(); await svc.tick();
    assert.deepEqual(calls, ['frozen', 'healthy', 'frozen', 'healthy']);
  });
});
