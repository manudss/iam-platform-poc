import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BranchTestService } from './branch-test.js';
import { assertNotBranchTest, AuthGuard } from '../auth/auth.guard.js';

const branches = (...names: string[]) => ({ branches: async () => ({ default: 'main', branches: names.map((name) => ({ name, commit: 'c-' + name })) }) });

function svc(...names: string[]) {
  process.env.IAM_WORKSPACE_MODE = '1'; delete process.env.IAM_BRANCH_TEST;
  return new BranchTestService(branches(...names) as never);
}

test('ticket: created only for an existing non-main branch, bound to it, expiring', async () => {
  const s = svc('main', 'feature-x');
  await assert.rejects(() => s.create('admin', 'main'), /nothing to test/);
  await assert.rejects(() => s.create('admin', 'nope'), /unknown branch/);
  await assert.rejects(() => s.create('admin', 'Bad Name'), /branch/i);
  const t = await s.create('admin', 'feature-x');
  assert.match(t.ticket, /^[A-Za-z0-9_-]{10,64}$/);
  assert.equal(s.check(t.ticket, 'feature-x'), true);
  assert.equal(s.check(t.ticket, 'main'), false, 'a ticket never authorizes another branch');
  assert.equal(s.check('forged-ticket', 'feature-x'), false);
  assert.equal(s.check(t.ticket, ''), false);
  s.now = () => Date.now() + 11 * 60_000;
  assert.equal(s.check(t.ticket, 'feature-x'), false, 'expired');
});

test('ticket: IAM_BRANCH_TEST=0 disables creation and checks', async () => {
  const s = svc('main', 'feature-x');
  process.env.IAM_BRANCH_TEST = '0';
  await assert.rejects(() => s.create('admin', 'feature-x'), /disabled/);
  assert.equal(s.check('anything-here', 'feature-x'), false);
});

test('ticket: outside workspace mode there is no branch test at all', async () => {
  process.env.IAM_WORKSPACE_MODE = '0'; delete process.env.IAM_BRANCH_TEST;
  const s = new BranchTestService(branches('main', 'feature-x') as never);
  await assert.rejects(() => s.create('admin', 'feature-x'), /disabled/);
  process.env.IAM_WORKSPACE_MODE = '1';
});

test('assertNotBranchTest: a branch-bound token is refused on shared-state routes', () => {
  assert.doesNotThrow(() => assertNotBranchTest({ user: {} }));
  assert.throws(() => assertNotBranchTest({ user: { branch: 'feature-x' } }), /testing a data branch/);
});test('AuthGuard: a branch-bound token cannot be presented with another branch header', async () => {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ json: async () => ({ keys: [{ kid: 'k1', x: jwk.x }] }) })) as never;
  const claims = { iss: process.env.IAM_ISSUER ?? 'http://127.0.0.1:8081', aud: process.env.IAM_AUDIENCE ?? 'demo-web', sub: 'u1', exp: Math.floor(Date.now() / 1000) + 60, tenant: 'acme', branch: 'feature-x' };
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ alg: 'EdDSA', kid: 'k1' }), body = b64(claims);
  const sig = sign(null, Buffer.from(header + '.' + body), privateKey).toString('base64url');
  const token = header + '.' + body + '.' + sig;
  const ctx = (headers: Record<string, string>) => ({ switchToHttp: () => ({ getRequest: () => ({ headers, params: { tenant: 'acme' } }) }) });
  const g = new AuthGuard();
  try {
    assert.equal(await g.canActivate(ctx({ authorization: 'Bearer ' + token, 'x-iam-branch': 'feature-x' }) as never), true, 'matching branch passes');
    assert.equal(await g.canActivate(ctx({ authorization: 'Bearer ' + token }) as never), true, 'no header stays usable for shared routes');
    await assert.rejects(() => g.canActivate(ctx({ authorization: 'Bearer ' + token, 'x-iam-branch': 'main' }) as never), /bound to another data branch/);
    await assert.rejects(() => g.canActivate(ctx({ authorization: 'Bearer ' + token, 'x-iam-branch': 'feature-y' }) as never), /bound to another data branch/);
  } finally { globalThis.fetch = origFetch; }
});
