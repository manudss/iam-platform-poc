import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import '../authn/flow.service.js';   // load order: enter the cyclic module graph from the sign-in flow, as the app does
import { UsersService } from './users.service.js';

// Unit checks that need no Dolt and no bus: the admin action refuses before touching any state.
describe('temporary password admin action: guards that run before any write', () => {
  const svc = Object.create(UsersService.prototype) as UsersService;
  (svc as unknown as { save: () => never }).save = () => { throw new Error('must not be reached'); };
  const prev = process.env.IAM_DIRECTORY_AUTH;
  const restore = () => { if (prev === undefined) delete process.env.IAM_DIRECTORY_AUTH; else process.env.IAM_DIRECTORY_AUTH = prev; };
  it('refuses clearly when the directory is not the sign-in authority (nothing written)', async () => {
    delete process.env.IAM_DIRECTORY_AUTH;
    try { await assert.rejects(svc.setTemporaryPassword('t', 'admin', 'bob', 'Str0ng-temp-pass!', 24), /directory authentication is off/); } finally { restore(); }
  });
  it('refuses a self-target, a zero or oversized validity', async () => {
    process.env.IAM_DIRECTORY_AUTH = '1';
    try {
      await assert.rejects(svc.setTemporaryPassword('t', 'bob', 'bob', 'x', 24), /own account/);
      await assert.rejects(svc.setTemporaryPassword('t', 'admin', 'bob', 'x', 0), /hours/);
      await assert.rejects(svc.setTemporaryPassword('t', 'admin', 'bob', 'x', 169), /hours/);
      await assert.rejects(svc.setTemporaryPassword('t', 'admin', 'bob', '', 24), /password required/);
    } finally { restore(); }
  });
});
