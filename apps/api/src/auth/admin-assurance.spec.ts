import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AdminGuard } from './admin.guard.js';
import { checkAssurance } from '../authn/step-up.js';

const TOKEN = 'x'.repeat(20);
const ctx = (user: Record<string, unknown>) => ({ switchToHttp: () => ({ getRequest: () => ({ headers: { 'x-api-admin-token': TOKEN }, originalUrl: '/tenants/acme-demo/users', method: 'GET', user }) }) }) as never;
const withMin = (min: number) => async (_t: string, c: Record<string, unknown> | undefined) => checkAssurance({ level: Number(c?.auth_level ?? 0), authTime: Number(c?.auth_time ?? 0) * 1000 }, { minLevel: min }, Date.now());

describe('administration pages need a minimum sign-in level', () => {
  const was = process.env.IAM_API_ADMIN_TOKEN; process.env.IAM_API_ADMIN_TOKEN = TOKEN;
  afterEach(() => { AdminGuard.assurance = undefined; });
  it('a session below the level gets a 403 step-up-required, with both levels', async () => {
    AdminGuard.assurance = withMin(5);
    await assert.rejects(new AdminGuard().canActivate(ctx({ sub: 'a', auth_level: 3 })), (e: any) => e.status === 403 && e.response.code === 'step-up-required' && e.response.requiredLevel === 5 && e.response.currentLevel === 3);
  });
  it('a session at or above the level passes', async () => {
    AdminGuard.assurance = withMin(5);
    assert.equal(await new AdminGuard().canActivate(ctx({ sub: 'a', auth_level: 5 })), true);
  });
  it('off (level 0) or no rule installed: nothing changes', async () => {
    AdminGuard.assurance = withMin(0); assert.equal(await new AdminGuard().canActivate(ctx({ sub: 'a', auth_level: 1 })), true);
    AdminGuard.assurance = undefined; assert.equal(await new AdminGuard().canActivate(ctx({ sub: 'a' })), true);
  });
  it('the level is not enough to open admin without the capability', async () => {
    AdminGuard.assurance = withMin(1);
    const c = { switchToHttp: () => ({ getRequest: () => ({ headers: {}, originalUrl: '/tenants/t/x', user: { sub: 'a', auth_level: 9 } }) }) } as never;
    await assert.rejects(new AdminGuard().canActivate(c), (e: any) => e.status === 403);
  });
  process.on('exit', () => { process.env.IAM_API_ADMIN_TOKEN = was; });
});
