import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import {
  checkStart, buildAuthorizeUrl, exchangeOidc, exchangeUserinfo, mint, mintPkceVerifier, pkceChallenge,
  ProviderRefusal, externalRefusalMessage, githubTokenReason,
  type ExternalStart,
} from './federation.js';

/**
 * The REAL exchange paths of the federation client, against a loopback fake provider: a signed id_token validated
 * through JWKS (OIDC mode) and a token + userinfo (+ e-mails, token-inspection) flow (oauth2-userinfo mode).
 * No provider account, no network beyond 127.0.0.1 - the provider's wire behaviour is what is under test.
 */

async function listen(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ srv: Server; base: string }> {
  const srv = createServer(handler);
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const { port } = srv.address() as { port: number };
  return { srv, base: `http://127.0.0.1:${port}` };
}
const readBody = (req: import('node:http').IncomingMessage) => new Promise<string>((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });
const json = (res: import('node:http').ServerResponse, body: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

describe('federation client (real exchange paths)', () => {
  it('mints RFC 7636 verifiers separately from state/nonce and matches the RFC S256 vector', () => {
    const samples = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const verifier = mintPkceVerifier();
      assert.equal(verifier.length, 43);
      assert.match(verifier, /^[A-Za-z0-9._~-]{43,128}$/);
      assert.equal(pkceChallenge(verifier).length, 43);
      samples.add(verifier);
    }
    assert.equal(samples.size, 100);
    assert.equal(mint().length, 32, 'state and nonce format is unchanged');
    assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('checkStart refuses malformed answers and non-https endpoints (fail closed)', () => {
    assert.throws(() => checkStart(null), /bad auth\.external\.start/);
    assert.throws(() => checkStart({ ok: true, mode: 'simulated', identities: [] }), /simulated/);
    assert.throws(() => checkStart({ ok: true, mode: 'oidc', authorizeEndpoint: 'http://evil.example.com/a', tokenEndpoint: 'https://p.example.com/t', jwksUri: 'https://p.example.com/j', issuer: 'https://p.example.com', clientId: 'x' }), /endpoints/);
    const ok = checkStart({ ok: true, mode: 'oidc', authorizeEndpoint: 'https://p.example.com/a', tokenEndpoint: 'https://p.example.com/t', jwksUri: 'https://p.example.com/j', issuer: 'https://p.example.com', clientId: 'c', scopes: ['openid', 'x'.repeat(60), 'email'], extraAuthorizeParams: { 'bad key!': 'v', hd: 'example.com' } });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.scopes, ['openid', 'email']); // over-long entries dropped
    assert.deepEqual(ok.extraAuthorizeParams, { hd: 'example.com' }); // illegal key dropped
  });

  it('buildAuthorizeUrl carries state, nonce, S256 challenge and extra params', () => {
    const s = checkStart({ ok: true, mode: 'oidc', authorizeEndpoint: 'https://p.example.com/authorize', tokenEndpoint: 'https://p.example.com/token', jwksUri: 'https://p.example.com/jwks', issuer: 'https://p.example.com', clientId: 'client-1', scopes: ['openid', 'email'], extraAuthorizeParams: { hd: 'example.com' } });
    const u = new URL(buildAuthorizeUrl(s, 'https://iam.example.com/authorize/external/callback', { state: 'st', nonce: 'no', challenge: 'ch' }));
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('client_id'), 'client-1');
    assert.equal(u.searchParams.get('redirect_uri'), 'https://iam.example.com/authorize/external/callback');
    assert.equal(u.searchParams.get('state'), 'st');
    assert.equal(u.searchParams.get('nonce'), 'no');
    assert.equal(u.searchParams.get('code_challenge'), 'ch');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('scope'), 'openid email');
    assert.equal(u.searchParams.get('hd'), 'example.com');
  });

  describe('OIDC mode against a loopback fake provider', () => {
    let srv: Server, base: string, start: ExternalStart, verifier: string, state: string, nonce: string;
    let priv: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'], pub: Awaited<ReturnType<typeof generateKeyPair>>['publicKey'], otherPriv: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'], kid: string;
    const seen: { codeVerifier?: string; clientSecret?: string; code?: string } = {};
    before(async () => {
      ({ privateKey: priv, publicKey: pub } = await generateKeyPair('RS256'));
      ({ privateKey: otherPriv } = await generateKeyPair('RS256'));
      kid = 'fake-key-1';
      const jwk = await exportJWK(pub); jwk.kid = kid; jwk.alg = 'RS256'; jwk.use = 'sig';
      verifier = mintPkceVerifier(); state = mint(); nonce = mint();
      const challenge = pkceChallenge(verifier);
      const signIdToken = (key: typeof priv, claims: Record<string, unknown> = {}) => new SignJWT({ email: 'user@example.com', email_verified: true, name: 'Real User', ...claims })
        .setProtectedHeader({ alg: 'RS256', kid }).setSubject('provider-sub-42').setIssuer(base).setAudience('client-1')
        .setIssuedAt().setExpirationTime('10m').setJti(mint()).sign(key);
      ({ srv, base } = await listen(async (req, res) => {
        const u = new URL(req.url ?? '/', 'http://x');
        if (u.pathname === '/jwks') return json(res, { keys: [jwk] });
        if (u.pathname === '/token') {
          const f = new URLSearchParams(await readBody(req));
          seen.codeVerifier = f.get('code_verifier') ?? undefined; seen.clientSecret = f.get('client_secret') ?? undefined; seen.code = f.get('code') ?? undefined;
          if (f.get('grant_type') !== 'authorization_code' || f.get('code') !== 'the-code' || f.get('redirect_uri') !== 'https://iam.example.com/cb' || f.get('client_id') !== 'client-1') return json(res, { error: 'invalid_grant' }, 400);
          if (f.get('client_secret') !== 's3cret') return json(res, { error: 'invalid_client' }, 401);
          if (!/^[A-Za-z0-9._~-]{43,128}$/.test(f.get('code_verifier') ?? '') || createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') !== challenge) return json(res, { error: 'invalid_grant', error_description: 'pkce' }, 400);
          return json(res, { access_token: 'at-1', token_type: 'Bearer', expires_in: 3600, id_token: await signIdToken(priv, { nonce }) });
        }
        return json(res, { error: 'not-found' }, 404);
      }));
      start = checkStart({ ok: true, mode: 'oidc', authorizeEndpoint: `${base}/authorize`, tokenEndpoint: `${base}/token`, jwksUri: `${base}/jwks`, issuer: base, clientId: 'client-1', scopes: ['openid', 'email'] });
    });
    after(() => srv.close());

    it('a well-formed code exchange returns the validated profile (PKCE + secret reach the provider)', async () => {
      const p = await exchangeOidc(start, 's3cret', 'https://iam.example.com/cb', { code: 'the-code', state }, { state, nonce, verifier });
      assert.equal(p.sub, 'provider-sub-42');
      assert.equal(p.email, 'user@example.com');
      assert.equal(p.emailVerified, true);
      assert.equal(p.name, 'Real User');
      assert.equal(p.claims?.iss, base);
      assert.equal(seen.codeVerifier, verifier);
      assert.equal(seen.clientSecret, 's3cret');
    });

    it('a wrong state is refused before any token call', async () => {
      await assert.rejects(exchangeOidc(start, 's3cret', 'https://iam.example.com/cb', { code: 'the-code', state: 'forged' }, { state, nonce, verifier }));
    });

    it('a wrong nonce in the id_token is refused', async () => {
      // Pending nonce differs from what the provider will sign: validation must fail.
      await assert.rejects(exchangeOidc(start, 's3cret', 'https://iam.example.com/cb', { code: 'the-code', state }, { state, nonce: mint(), verifier }));
    });

    it('a wrong PKCE verifier is refused by the provider', async () => {
      await assert.rejects(exchangeOidc(start, 's3cret', 'https://iam.example.com/cb', { code: 'the-code', state }, { state, nonce, verifier: mintPkceVerifier() }));
    });

    it('an id_token signed by a key absent from the JWKS is refused', async () => {
      // The fake provider signs with a DIFFERENT key than the one its JWKS publishes: signature validation must fail.
      const bad = await new SignJWT({ nonce }).setProtectedHeader({ alg: 'RS256', kid }).setSubject('x')
        .setIssuer(base).setAudience('client-1').setIssuedAt().setExpirationTime('10m').sign(otherPriv);
      const { srv: srv2, base: base2 } = await listen(async (req, res) => {
        const u = new URL(req.url ?? '/', 'http://x');
        if (u.pathname === '/jwks') { const j = await exportJWK(pub); j.kid = kid; j.alg = 'RS256'; return json(res, { keys: [j] }); }
        if (u.pathname === '/token') return json(res, { access_token: 'a', token_type: 'Bearer', id_token: bad });
        return json(res, {}, 404);
      });
      try {
        const s2 = checkStart({ ok: true, mode: 'oidc', authorizeEndpoint: `${base2}/authorize`, tokenEndpoint: `${base2}/token`, jwksUri: `${base2}/jwks`, issuer: base, clientId: 'client-1' });
        await assert.rejects(exchangeOidc(s2, '', 'https://iam.example.com/cb', { code: 'c', state }, { state, nonce }));
      } finally { srv2.close(); }
    });
  });

  describe('oauth2-userinfo mode against a loopback fake provider', () => {
    let srv: Server, base: string, start: ExternalStart;
    const seen: { authHeader?: string; emailsCalled: boolean; tokenInfoCalled: boolean; verifier?: string } = { emailsCalled: false, tokenInfoCalled: false };
    before(async () => {
      const verifierExpected = pkceChallenge('v'.repeat(43));
      ({ srv, base } = await listen(async (req, res) => {
        const u = new URL(req.url ?? '/', 'http://x');
        if (u.pathname === '/token') {
          const f = new URLSearchParams(await readBody(req));
          seen.verifier = f.get('code_verifier') ?? undefined;
          if (f.get('code') !== 'gh-code' || f.get('client_id') !== 'gh-client' || f.get('client_secret') !== 'gh-secret') return json(res, { error: 'bad_verification_code' }, 400);
          if (!/^[A-Za-z0-9._~-]{43,128}$/.test(f.get('code_verifier') ?? '') || createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') !== verifierExpected) return json(res, { error: 'bad_verification_code' }, 400);
          return json(res, { access_token: 'gh-token', token_type: 'bearer', scope: 'read:user user:email' });
        }
        if (u.pathname === '/user') {
          seen.authHeader = String(req.headers.authorization ?? '');
          if (req.headers.authorization !== 'Bearer gh-token') return json(res, { message: 'bad credentials' }, 401);
          return json(res, { id: 12345, login: 'octocat', name: 'The Octocat', email: null });
        }
        if (u.pathname === '/user/emails') {
          seen.emailsCalled = true;
          return json(res, [{ email: 'secondary@example.com', primary: false, verified: true }, { email: 'octocat@example.com', primary: true, verified: true }]);
        }
        if (u.pathname === '/debug_token') {
          seen.tokenInfoCalled = true;
          if (u.searchParams.get('access_token') !== 'gh-client|gh-secret') return json(res, { error: { message: 'bad app token' } }, 400);
          return json(res, { data: { app_id: 'gh-client', is_valid: true } });
        }
        return json(res, {}, 404);
      }));
      start = checkStart({
        ok: true, mode: 'oauth2-userinfo', authorizeEndpoint: `${base}/authorize`, tokenEndpoint: `${base}/token`, userinfoEndpoint: `${base}/user`,
        clientId: 'gh-client', scopes: ['read:user', 'user:email'], pkce: true,
        profileMap: { sub: 'id', email: 'email', name: 'name' }, emailsEndpoint: `${base}/user/emails`,
        tokenInfoEndpoint: `${base}/debug_token?input_token={token}&access_token={appToken}`,
      });
    });
    after(() => srv.close());

    it('code -> token -> userinfo with e-mail fallback and token inspection', async () => {
      const p = await exchangeUserinfo(start, 'gh-secret', 'https://iam.example.com/cb', { code: 'gh-code', state: 'st' }, { state: 'st', verifier: 'v'.repeat(43) });
      assert.equal(p.sub, '12345'); // numeric provider id stringified
      assert.equal(p.email, 'octocat@example.com'); // primary verified picked from the e-mails list
      assert.equal(p.emailVerified, true);
      assert.equal(p.name, 'The Octocat');
      assert.deepEqual(p.tokenInfo, { data: { app_id: 'gh-client', is_valid: true } });
      assert.equal(seen.emailsCalled, true);
      assert.equal(seen.tokenInfoCalled, true);
      assert.equal(seen.verifier, 'v'.repeat(43));
    });

    it('a strict provider rejects the old 32-character verifier even with its matching challenge', async () => {
      const short = mint();
      let lengthRejected = false;
      const { srv: strict, base: strictBase } = await listen(async (req, res) => {
        const form = new URLSearchParams(await readBody(req));
        lengthRejected = !/^[A-Za-z0-9._~-]{43,128}$/.test(form.get('code_verifier') ?? '');
        assert.equal(pkceChallenge(form.get('code_verifier')!), pkceChallenge(short));
        return json(res, { error: 'invalid_request' }, lengthRejected ? 400 : 200);
      });
      try {
        await assert.rejects(exchangeUserinfo({ ...start, tokenEndpoint: `${strictBase}/token` }, 'gh-secret', 'https://iam.example.com/cb', { code: 'gh-code' }, { state: 'st', verifier: short }), ProviderRefusal);
        assert.equal(lengthRejected, true);
      } finally { strict.close(); }
    });

    it('refuses when the token endpoint rejects the code', async () => {
      await assert.rejects(exchangeUserinfo(start, 'gh-secret', 'https://iam.example.com/cb', { code: 'wrong', state: 'st' }, { state: 'st', verifier: 'v'.repeat(43) }), /token endpoint answered 400/);
    });

    it('refuses a profile without a subject', async () => {
      const { srv: s2, base: b2 } = await listen(async (req, res) => {
        const u = new URL(req.url ?? '/', 'http://x');
        if (u.pathname === '/token') return json(res, { access_token: 't', token_type: 'bearer' });
        if (u.pathname === '/user') return json(res, { login: 'nosub' });
        return json(res, {}, 404);
      });
      try {
        const bad = checkStart({ ok: true, mode: 'oauth2-userinfo', authorizeEndpoint: `${b2}/a`, tokenEndpoint: `${b2}/token`, userinfoEndpoint: `${b2}/user`, clientId: 'c', profileMap: { sub: 'id' } });
        await assert.rejects(exchangeUserinfo(bad, '', 'https://iam.example.com/cb', { code: 'c', state: 'st' }, { state: 'st' }), /no subject/);
      } finally { s2.close(); }
    });
  });

  describe('provider refusals: a definitive NO from the provider is typed, never a generic fault', () => {
    const cbUrl = 'https://iam.example.com/cb';
    const startAt = (base: string) => checkStart({ ok: true, mode: 'oauth2-userinfo', authorizeEndpoint: `${base}/a`, tokenEndpoint: `${base}/token`, userinfoEndpoint: `${base}/user`, clientId: 'c', profileMap: { sub: 'id' } });
    const run = (s: ExternalStart) => exchangeUserinfo(s, 'a-secret', cbUrl, { code: 'c', state: 'st' }, { state: 'st' });

    it('a token-endpoint 4xx (rejected client credentials, bad code) is a typed refusal', async () => {
      const { srv, base } = await listen((_req, res) => json(res, { error: 'incorrect_client_credentials' }, 404));
      try {
        await assert.rejects(run(startAt(base)), (e: unknown) => e instanceof ProviderRefusal && e.where === 'token' && e.status === 404 && /token endpoint answered 404/.test((e as Error).message));
      } finally { srv.close(); }
    });

    it("a 200 error payload (GitHub's refusal shape) is a typed refusal, not a crash", async () => {
      const { srv, base } = await listen((_req, res) => json(res, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }));
      try {
        await assert.rejects(run(startAt(base)), (e: unknown) => e instanceof ProviderRefusal && e.where === 'token' && e.status === 'error-payload' && /no access token/.test((e as Error).message));
      } finally { srv.close(); }
    });

    it('a userinfo rejection is a typed refusal at the userinfo step', async () => {
      const { srv, base } = await listen((req, res) => {
        const u = new URL(req.url ?? '/', 'http://x');
        if (u.pathname === '/token') return json(res, { access_token: 't', token_type: 'bearer' });
        return json(res, { message: 'bad credentials' }, 401);
      });
      try {
        await assert.rejects(run(startAt(base)), (e: unknown) => e instanceof ProviderRefusal && e.where === 'userinfo' && e.status === 401);
      } finally { srv.close(); }
    });

    it('a provider 5xx stays a generic technical failure (the gate keeps answering 503)', async () => {
      const { srv, base } = await listen((_req, res) => json(res, { error: 'boom' }, 503));
      try {
        await assert.rejects(run(startAt(base)), (e: unknown) => !(e instanceof ProviderRefusal) && /token endpoint answered 503/.test((e as Error).message));
      } finally { srv.close(); }
    });

    it('externalRefusalMessage maps only a typed refusal to an actionable denial', () => {
      const m = externalRefusalMessage(new ProviderRefusal('token', 404, 'oauth2: token endpoint answered 404'));
      assert.ok(m && /client secret/.test(m) && /callback URL/.test(m) && m.length <= 200);
      assert.equal(externalRefusalMessage(new Error('oauth2: token endpoint answered 503')), undefined);
      assert.equal(externalRefusalMessage('nope'), undefined);
    });
  });
});



describe('safe GitHub token diagnostics', () => {
  const endpoint = 'https://github.com/login/oauth/access_token';
  for (const code of ['incorrect_client_credentials', 'redirect_uri_mismatch', 'bad_verification_code'] as const) {
    it(`keeps only the allowlisted ${code} from a 400`, async () => {
      const original = globalThis.fetch;
      globalThis.fetch = async () => new Response(JSON.stringify({ error: code, error_description: 'PRIVATE_SENTINEL', access_token: 'PRIVATE_SENTINEL', error_uri: 'https://secret.invalid' }), { status: 400, headers: { 'content-type': 'application/json' } });
      try {
        const s = checkStart({ ok: true, mode: 'oauth2-userinfo', authorizeEndpoint: 'https://github.com/login/oauth/authorize', tokenEndpoint: endpoint, userinfoEndpoint: 'https://api.github.com/user', clientId: 'fictional', profileMap: { sub: 'id' } });
        await assert.rejects(exchangeUserinfo(s, 'PRIVATE_SENTINEL', 'https://iam.example/cb', { code: 'PRIVATE_SENTINEL' }, { state: 'st' }), (e: unknown) => {
          assert.ok(e instanceof ProviderRefusal); assert.equal(e.providerReason, code); assert.equal(e.status, 400);
          assert.ok(!JSON.stringify(e).includes('PRIVATE_SENTINEL')); assert.ok(!e.message.includes('PRIVATE_SENTINEL'));
          assert.ok(!externalRefusalMessage(e)?.includes(code)); return true;
        });
      } finally { globalThis.fetch = original; }
    });
  }
  it('unknown or malicious error text never escapes', () => {
    for (const payload of [null, {}, { error: 'PRIVATE_SENTINEL' }, { error: { secret: 'PRIVATE_SENTINEL' } }, { error: 'bad_verification_code\nPRIVATE_SENTINEL' }]) assert.equal(githubTokenReason(endpoint, payload), 'other');
  });
  it('does not attribute another provider or look-alike endpoint to GitHub', () => {
    for (const url of ['https://github.com.evil.invalid/login/oauth/access_token', endpoint + '?secret=x', 'http://github.com/login/oauth/access_token', 'https://other.invalid/token']) assert.equal(githubTokenReason(url, { error: 'bad_verification_code' }), undefined);
  });
  for (const variant of ['form', 'malformed', 'oversized', 'server-error', 'success-error']) it(`handles ${variant} without a payload leak or auth change`, async () => {
    const original = globalThis.fetch;
    const body = variant === 'form' ? 'error=redirect_uri_mismatch&error_description=PRIVATE_SENTINEL' : variant === 'malformed' ? '{PRIVATE_SENTINEL' : variant === 'oversized' ? 'PRIVATE_SENTINEL'.repeat(1000) : JSON.stringify({ error: 'bad_verification_code', error_description: 'PRIVATE_SENTINEL' });
    globalThis.fetch = async () => new Response(body, { status: variant === 'server-error' ? 503 : variant === 'success-error' ? 200 : 400, headers: { 'content-type': variant === 'form' ? 'application/x-www-form-urlencoded' : 'application/json' } });
    try {
      const s = checkStart({ ok: true, mode: 'oauth2-userinfo', authorizeEndpoint: 'https://github.com/login/oauth/authorize', tokenEndpoint: endpoint, userinfoEndpoint: 'https://api.github.com/user', clientId: 'fictional', profileMap: { sub: 'id' } });
      await assert.rejects(exchangeUserinfo(s, 'secret', 'https://iam.example/cb', { code: 'code' }, { state: 'st' }), (e: unknown) => {
        assert.ok(e instanceof Error); assert.ok(!e.message.includes('PRIVATE_SENTINEL')); assert.ok(!JSON.stringify(e).includes('PRIVATE_SENTINEL'));
        if (variant === 'server-error') { assert.ok(!(e instanceof ProviderRefusal)); assert.equal(externalRefusalMessage(e), undefined); }
        else { assert.ok(e instanceof ProviderRefusal); assert.equal(e.providerReason, variant === 'form' ? 'redirect_uri_mismatch' : variant === 'success-error' ? 'bad_verification_code' : 'other'); }
        return true;
      });
    } finally { globalThis.fetch = original; }
  });
});
