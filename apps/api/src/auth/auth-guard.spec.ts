import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, KeyObject } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { AuthGuard } from './auth.guard.js';

// The PRODUCTION guard, exercised end to end with real EdDSA tokens: the only seam is the JWKS URL
// (a local stub serves the test key), exactly like the core IdP prototype would.
describe('AuthGuard (production): real signed tokens, tenant claim bound to the route', () => {
  let server: Server, coreUrl: string, priv: KeyObject;
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = (claims: Record<string, unknown>, kid = 'k1', signable?: string) => {
    const h = b64({ alg: 'EdDSA', kid });
    const p = b64(claims);
    const input = signable ?? `${h}.${p}`;
    return `${input}.${sign(null, Buffer.from(input), priv).toString('base64url')}`;
  };
  const valid = (over: Record<string, unknown> = {}) => ({ iss: coreUrl, aud: 'demo-web', sub: 'demo-alice', exp: Math.floor(Date.now() / 1000) + 600, tenant: 'acme-demo', ...over });
  const ctx = (tenantParam: string | undefined, tok?: string, extraHeaders: Record<string, string> = {}) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...extraHeaders }, params: tenantParam === undefined ? {} : { tenant: tenantParam } }) }) }) as never;

  before(async () => {
    const pair = generateKeyPairSync('ed25519');
    priv = pair.privateKey;
    const jwk = pair.publicKey.export({ format: 'jwk' }) as { x: string };
    server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [{ kty: 'OKP', crv: 'Ed25519', kid: 'k1', x: jwk.x }] })); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    coreUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.IAM_CORE_URL = coreUrl;
    process.env.IAM_ISSUER = coreUrl;
    process.env.IAM_AUDIENCE = 'demo-web';
  });
  after(async () => { await new Promise((r) => server.close(r)); delete process.env.IAM_CORE_URL; delete process.env.IAM_ISSUER; delete process.env.IAM_AUDIENCE; });

  it('accepts a valid token whose tenant claim matches the route', async () => {
    const g = new AuthGuard();
    const c = ctx('acme-demo', token(valid()));
    assert.equal(await g.canActivate(c), true);
  });
  it('refuses a valid token of ANOTHER tenant on a tenant route (403, never a silent widen)', async () => {
    const g = new AuthGuard();
    await assert.rejects(g.canActivate(ctx('acme-demo', token(valid({ tenant: 'other-tenant' })))), (e: Error & { getStatus?: () => number }) => e.getStatus?.() === 403 && /wrong tenant/.test(e.message));
  });
  it('refuses expired, wrong issuer, wrong audience, bad signature, wrong alg, missing and malformed tokens', async () => {
    const g = new AuthGuard();
    const unauth = (e: Error & { getStatus?: () => number }) => e.getStatus?.() === 401;
    await assert.rejects(g.canActivate(ctx('acme-demo', token(valid({ exp: Math.floor(Date.now() / 1000) - 10 })))), unauth);
    await assert.rejects(g.canActivate(ctx('acme-demo', token(valid({ iss: 'https://elsewhere' })))), unauth);
    await assert.rejects(g.canActivate(ctx('acme-demo', token(valid({ aud: 'other-audience' })))), unauth);
    await assert.rejects(g.canActivate(ctx('acme-demo', token(valid(), 'k1', 'x.y'))), unauth); // signature over different content
    await assert.rejects(g.canActivate(ctx('acme-demo', `${b64({ alg: 'RS256', kid: 'k1' })}.${b64(valid())}.x`)), unauth);
    await assert.rejects(g.canActivate(ctx('acme-demo', undefined)), unauth);
    await assert.rejects(g.canActivate(ctx('acme-demo', 'not-a-jwt')), unauth);
    await assert.rejects(g.canActivate(ctx('acme-demo', token(valid(), 'unknown-kid'))), unauth); // fail closed when the key is unknown
  });
  it('a branch-bound token cannot be presented with another branch context', async () => {
    const g = new AuthGuard();
    await assert.rejects(g.canActivate(ctx('acme-demo', token(valid({ branch: 'b1' })), { 'x-iam-branch': 'b2' })), (e: Error & { getStatus?: () => number }) => e.getStatus?.() === 403);
    assert.equal(await g.canActivate(ctx('acme-demo', token(valid({ branch: 'b1' })), { 'x-iam-branch': 'b1' })), true);
  });
});
