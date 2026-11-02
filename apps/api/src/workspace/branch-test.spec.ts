import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BranchTestService } from './branch-test.js';
import { AuthnService } from '../authn/flow.service.js';
import { assertNotBranchTest, AuthGuard, OptionalAuthGuard } from '../auth/auth.guard.js';

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

test('OptionalAuthGuard: signup stays public, but a presented branch-test token is refused', async () => {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ json: async () => ({ keys: [{ kid: 'k1', x: jwk.x }] }) })) as never;
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = (claims: object) => { const h = b64({ alg: 'EdDSA', kid: 'k1' }), b = b64(claims); return h + '.' + b + '.' + sign(null, Buffer.from(h + '.' + b), privateKey).toString('base64url'); };
  const base = { iss: process.env.IAM_ISSUER ?? 'http://127.0.0.1:8081', aud: process.env.IAM_AUDIENCE ?? 'demo-web', sub: 'u1', exp: Math.floor(Date.now() / 1000) + 60, tenant: 'acme' };
  const ctx = (headers: Record<string, string>) => { const req = { headers, params: {} }; return { req, c: { switchToHttp: () => ({ getRequest: () => req }) } }; };
  const g = new OptionalAuthGuard();
  try {
    const anon = ctx({});
    assert.equal(await g.canActivate(anon.c as never), true, 'no token: public as before');
    assert.equal((anon.req as { user?: unknown }).user, undefined);
    const live = ctx({ authorization: 'Bearer ' + tok(base) });
    assert.equal(await g.canActivate(live.c as never), true, 'an ordinary live token still signs up');
    assert.doesNotThrow(() => assertNotBranchTest(live.req as never));
    const test = ctx({ authorization: 'Bearer ' + tok({ ...base, branch: 'feature-x' }) });
    assert.equal(await g.canActivate(test.c as never), true);
    assert.throws(() => assertNotBranchTest(test.req as never), /testing a data branch/, 'the test token is refused');
    await assert.rejects(() => g.canActivate(ctx({ authorization: 'Bearer forged.jwt.here' }).c as never), /malformed|bad signature/, 'a forged token never passes');
  } finally { globalThis.fetch = origFetch; }
});

test('a running sign-in session stays bound to its branch', async () => {
  const svc = new AuthnService({ callSlot: async () => { throw new Error('not needed'); } } as never);
  (svc as unknown as { sessions: Map<string, object> }).sessions.set('sess1', { id: 'sess1', tenant: 'acme', subject: 'u1', branch: 'feature-x', known: true, exp: Date.now() + 60_000, index: 0, chain: { id: 'c', name: 'c', level: 3 }, steps: [], declared: 3, done: [], tries: 0 });
  const cont = (branch?: string) => svc.authenticate({ tenant: 'acme', session: 'sess1', ...(branch ? { branch } : {}), answers: {} } as never);
  assert.equal((await cont('feature-y'))?.outcome, 'deny', 'another branch is refused with the generic message');
  await assert.rejects(() => cont('feature-x'), 'the bound branch passes the check and reaches the step verifier (stubbed here)');
});
