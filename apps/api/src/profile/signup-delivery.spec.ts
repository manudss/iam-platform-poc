import 'reflect-metadata';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
void PluginsV1Module;
import { SignupService } from './signup.service.js';
import { SignupController } from './signup.controller.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { screensFor } from '../auth/screens.js';
import { AdminGuard } from '../auth/admin.guard.js';

describe('signup delivery capability (read-only live status)', () => {
  const service = (notifier?: unknown) => new SignupService({} as never, undefined, undefined, undefined, notifier as never);
  it('reports real/simulated capability without sending any mail or reading a draft registry', async () => {
    for (const real of [true, false]) {
      const calls: unknown[] = [];
      const s = service({ callSlot: async (...args: unknown[]) => { calls.push(args); return { result: { real } }; }, emit: () => { throw new Error('Status must not send'); } });
      assert.deepEqual(await s.deliveryStatus('acme-demo'), { mode: real ? 'real' : 'simulated', source: 'live' });
      assert.deepEqual(calls, [['acme-demo', 'notify.default', 'notify.capability', {}]]);
    }
  });
  it('does not describe missing or failed capability as proven real or simulated', async () => {
    for (const callSlot of [async () => { throw new Error('Unavailable'); }, async () => ({ result: {} }), async () => ({ result: { real: 'true' } })]) {
      assert.deepEqual(await service({ callSlot }).deliveryStatus('acme-demo'), { mode: 'unknown', source: 'live' });
    }
    assert.equal((await service().deliveryStatus('acme-demo')).mode, 'simulated');
  });
  it('protects the status route with both authentication and administrator guards', () => {
    assert.deepEqual(Reflect.getMetadata('__guards__', SignupController.prototype.deliveryStatus), [AuthGuard, AdminGuard]);
    assert.equal(Reflect.getMetadata('path', SignupController.prototype.deliveryStatus), 'delivery-status');
    assert.deepEqual(screensFor('GET', 'signup/delivery-status'), ['profile-fields']);
    assert.deepEqual(screensFor('GET', 'signup/requests'), ['users']);
  });
});
