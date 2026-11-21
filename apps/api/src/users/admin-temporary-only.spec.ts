import 'reflect-metadata';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import '../plugins/v1/plugins-v1.module.js';   // loads the module graph in its working order (circular imports)
import { UsersService } from './users.service.js';
import { UsersController } from './users.controller.js';

// No Dolt: the controller gets a fake service, the service method is exercised with `save` stubbed (the refusals happen before any write).
describe('admin passwords are temporary only', () => {
  const req = { user: { sub: 'admin-1' } };
  const env = process.env.IAM_DIRECTORY_AUTH; beforeEach(() => { process.env.IAM_DIRECTORY_AUTH = '1'; }); afterEach(() => { process.env.IAM_DIRECTORY_AUTH = env; });
  const fake = () => { const calls: unknown[][] = []; const users = { save: async (...a: unknown[]) => { calls.push(['save', ...a]); return {}; }, createWithTemporaryPassword: async (...a: unknown[]) => { calls.push(['create', ...a]); return {}; } }; return { calls, ctl: new UsersController(users as never) }; };

  it('PUT refuses any password key, even empty, and writes nothing', async () => {
    for (const body of [{ password: 'x'.repeat(14) }, { password: '' }, { display_name: 'A', password: null }]) {
      const { ctl, calls } = fake();
      await assert.rejects(() => ctl.update('acme-demo', 'demo-bob', req, body as never), /cannot set a permanent password/); assert.equal(calls.length, 0);
    }
  });
  it('PUT without a password still saves the profile', async () => {
    const { ctl, calls } = fake(); await ctl.update('acme-demo', 'demo-bob', req, { display_name: 'Bob' }); assert.equal(calls.length, 1); assert.equal(calls[0][0], 'save');
  });
  it('POST create hands password and hours to the temporary path and never to a plain save', async () => {
    const { ctl, calls } = fake(); await ctl.create('acme-demo', req, { id: 'new-one', display_name: 'N', password: 'fictional-temp-pw', hours: 24 } as never);
    assert.equal(calls.length, 1); assert.equal(calls[0][0], 'create'); assert.equal((calls[0][3] as Record<string, unknown>).hours, undefined, 'hours is not part of the stored record'); assert.equal((calls[0][3] as Record<string, unknown>).password, 'fictional-temp-pw'); assert.equal(calls[0][4], 24);
  });
  const svc = () => { const saves: unknown[][] = []; const s = Object.create(UsersService.prototype) as UsersService & { save: unknown; now: () => number }; (s as any).save = async (...a: unknown[]) => { saves.push(a); return {}; }; (s as any).now = () => 1_000; return { s, saves }; };
  it('creation refuses a missing password, a missing or out-of-range duration, and directory auth off, before any write', async () => {
    const { s, saves } = svc();
    await assert.rejects(() => s.createWithTemporaryPassword('acme-demo', 'a', { id: 'a' }, 24), /temporary password is required/);
    for (const h of [undefined, 0, -1, 169, 'abc']) await assert.rejects(() => s.createWithTemporaryPassword('acme-demo', 'a', { id: 'a', password: 'fictional-temp-pw' }, h), /hours/);
    process.env.IAM_DIRECTORY_AUTH = '0'; await assert.rejects(() => s.createWithTemporaryPassword('acme-demo', 'a', { id: 'a', password: 'fictional-temp-pw' }, 24), /IAM_DIRECTORY_AUTH/);
    assert.equal(saves.length, 0);
  });
  it('a valid creation saves as a create with a server-side expiry from the duration', async () => {
    const { s, saves } = svc(); await s.createWithTemporaryPassword('acme-demo', 'a', { id: 'a', password: 'fictional-temp-pw' }, 2);
    assert.equal(saves.length, 1); assert.equal(saves[0][2], true); assert.deepEqual(saves[0][5], { expiresAt: 1_000 + 2 * 3_600_000 });
  });
});
