import 'reflect-metadata';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import '../plugins/v1/plugins-v1.module.js'; // load order: the module graph initialises the users service before the controller needs it
import { TestAccountController } from './test-account.controller.js';
import { branchContext } from '../workspace/context.js';

// The test account route (docs/branch-test.md): created on the tested branch only, only with a valid ticket for that branch, never on main.
describe('test account from a branch test sign-in', () => {
  const env = { w: process.env.IAM_WORKSPACE_MODE, b: process.env.IAM_BRANCH_TEST };
  beforeEach(() => { process.env.IAM_WORKSPACE_MODE = '1'; delete process.env.IAM_BRANCH_TEST; });
  afterEach(() => { for (const [k, v] of [['IAM_WORKSPACE_MODE', env.w], ['IAM_BRANCH_TEST', env.b]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const saves: { branch?: string; id: string; body: Record<string, unknown>; create: boolean }[] = [];
  const users = { save: async (id: string, body: Record<string, unknown>, create: boolean) => { saves.push({ branch: branchContext.getStore()?.branch, id, body, create }); return { id }; } };
  const branchTest = { check: async (ticket: unknown, branch: unknown) => ticket === 'good-ticket-123' && branch === 'feat-x' };
  const ctl = () => new TestAccountController(branchTest as never, users as never);
  const ok = { branch: 'feat-x', ticket: 'good-ticket-123', id: 'test-nora', display_name: 'Nora Test', password: 'a-fictional-password-1' };
  beforeEach(() => { saves.length = 0; });

  it('creates the account on the tested branch only, with no role', async () => {
    const r = await ctl().create('acme-demo', ok) as { created: boolean; branch: string };
    assert.equal(r.created, true); assert.equal(r.branch, 'feat-x');
    assert.equal(saves.length, 1); assert.equal(saves[0].branch, 'feat-x'); assert.equal(saves[0].create, true);
    assert.equal(saves[0].body['roles'], undefined, 'no role is granted');
  });
  it('refuses without a valid ticket for exactly that branch', async () => {
    await assert.rejects(ctl().create('acme-demo', { ...ok, ticket: 'other-ticket-123' }), /ticket/);
    await assert.rejects(ctl().create('acme-demo', { ...ok, branch: 'other' }), /ticket/);
    await assert.rejects(ctl().create('acme-demo', { ...ok, ticket: undefined }), /ticket/);
    assert.equal(saves.length, 0, 'nothing written');
  });
  it('never writes on main, even with a ticket that claims main', async () => {
    const open = { check: async () => true };
    await assert.rejects(new TestAccountController(open as never, users as never).create('acme-demo', { ...ok, branch: 'main' }), /never on main/);
    assert.equal(saves.length, 0);
  });
  it('only test-* ids are accepted, so a real person id can never be created or shadowed', async () => {
    for (const id of ['demo-alice', 'alice', 'test-', 'test-A', 'test-x y', 'test-' + 'a'.repeat(40)]) await assert.rejects(ctl().create('acme-demo', { ...ok, id }), /test-/);
    assert.equal(saves.length, 0);
  });
  it('is off when branch testing is disabled, and capped per test link', async () => {
    process.env.IAM_BRANCH_TEST = '0';
    await assert.rejects(ctl().create('acme-demo', ok), /branch test/);
    delete process.env.IAM_BRANCH_TEST;
    const c = ctl();
    for (let i = 0; i < 20; i++) await c.create('acme-demo', { ...ok, id: `test-n${i}` });
    await assert.rejects(c.create('acme-demo', { ...ok, id: 'test-over' }), /maximum/);
  });
});
