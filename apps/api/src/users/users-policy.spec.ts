import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { BranchRegistries } from '../plugins/v1/branch-registries.js';
import { UsersService } from './users.service.js';
import { branchContext } from '../workspace/context.js';

/** The auth.password policy is a READ: it must never demand a working branch. The registry that owns it is the
 * caller's working branch when an administrator edits on one, main on context-free live paths (public sign-up,
 * live self-service password change) - the same configuration sign-in enforces. */
const MODE = process.env.IAM_WORKSPACE_MODE;
afterEach(() => { if (MODE === undefined) delete process.env.IAM_WORKSPACE_MODE; else process.env.IAM_WORKSPACE_MODE = MODE; });

/** Registry stub with no auth.password provider: the check falls back to the historical 12..128 rule. */
const emptyRegistry = { resolve: () => { throw new Error('no provider'); }, isActive: () => false } as never;
function svc(refs: string[]) {
  const branches = { get: async (ref: string) => { refs.push(ref); return emptyRegistry; } };
  const modules = { get: (token: unknown) => (token === BranchRegistries ? branches : emptyRegistry) };
  return new UsersService(undefined as never, modules as never);
}

describe('password policy check without a working-branch context (public sign-up, live self-service)', () => {
  it('reads the LIVE policy on main instead of refusing with "choose a working branch"', async () => {
    process.env.IAM_WORKSPACE_MODE = '1';
    const refs: string[] = [];
    const s = svc(refs);
    assert.equal((await s.checkPasswordPolicy('acme-demo', 'new-user', 'a-fictional-password-1')).ok, true);
    assert.deepEqual((await s.checkPasswordPolicy('acme-demo', 'new-user', 'short')).errors, ['password: 12 to 128 characters']);
    assert.deepEqual(refs, ['main', 'main']);
  });
  it('keeps reading the working branch policy when the caller edits on a branch', async () => {
    process.env.IAM_WORKSPACE_MODE = '1';
    const refs: string[] = [];
    const s = svc(refs);
    await branchContext.run({ branch: 'personal/demo' }, () => s.checkPasswordPolicy('acme-demo', 'new-user', 'a-fictional-password-1'));
    assert.deepEqual(refs, ['personal/demo']);
  });
});
