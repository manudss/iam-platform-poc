// Contract of the authprobe mode of deploy/oci/qualification-container.mjs, executed the
// way the controller executes it (node --input-type=module -e SOURCE authprobe, JSON on
// stdin) against a fixture OIDC app on a random loopback port. Pins the reviewer-required
// behavior: ONE real password login per probe (first origin only, later origins get a
// form-only check), stop at the FIRST failure, no retry loop, per-fetch AbortSignal
// bound, closed stage tokens only - and the anti-redirection boundary: the loopback
// base is an ENVIRONMENT-only fixture seam, a payload/policy key is ignored.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'qualification-container.mjs'), 'utf8');

function fixture(loginStatus) {
  const log = [];
  let lastState = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    log.push(`${req.method} ${url.pathname}`);
    if (url.pathname === '/healthz') { res.writeHead(200); res.end('ok'); return; }
    if (url.pathname === '/core/authorize') {
      lastState = url.searchParams.get('state');
      const redirect = url.searchParams.get('redirect_uri');
      if (!redirect.startsWith('https://')) { res.writeHead(400); res.end('unknown client'); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<form><input name="username"><input name="password"><input name="csrf" value="tok"></form>');
      return;
    }
    if (url.pathname === '/core/authorize/login') {
      const target = `https://a.example/callback?state=${lastState}&code=fixture-code`;
      if (loginStatus === 302) res.writeHead(302, { location: target }); else res.writeHead(loginStatus);
      res.end();
      return;
    }
    res.writeHead(404); res.end();
  });
  return { server, log };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// Async spawn: the fixture server shares this process's event loop, which a sync
// spawn would freeze (the child would wait on a server that can never answer).
function run(payload, localBase) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (localBase !== null) env.LYAM_AUTHPROBE_LOCAL_BASE = localBase; else delete env.LYAM_AUTHPROBE_LOCAL_BASE;
    const child = spawn('node', ['--input-type=module', '-e', source, 'authprobe'], { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const payload = { auth: { username: 'qualification', password: 'fixture' }, origins: ['https://a.example', 'https://b.example'] };

test('authprobe: one login on the first origin, form-only check on the others', async () => {
  const { server, log } = fixture(302);
  const port = await listen(server);
  try {
    const r = await run(payload, `http://127.0.0.1:${port}`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { authprobe: 'login-ok' });
    assert.equal(log.filter((l) => l === 'POST /core/authorize/login').length, 1, log.join(', '));
    assert.equal(log.filter((l) => l === 'GET /core/authorize').length, 2, log.join(', '));
  } finally { server.close(); }
});

test('authprobe: a failed login stops at the first failure with a closed stage token', async () => {
  const { server, log } = fixture(200);
  const port = await listen(server);
  try {
    const r = await run(payload, `http://127.0.0.1:${port}`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /stage=SMOKE_LOGIN/);
    assert.doesNotMatch(r.stderr + r.stdout, /fixture/);  // never leaks input content
    assert.equal(log.filter((l) => l === 'POST /core/authorize/login').length, 1, log.join(', '));
    assert.equal(log.filter((l) => l === 'GET /core/authorize').length, 1, log.join(', '));  // no second origin
  } finally { server.close(); }
});

test('authprobe anti-redirection: a payload localBase is ignored, only the environment seam applies', async () => {
  const { server, log } = fixture(302);
  const port = await listen(server);
  try {
    // Malicious payload key pointing at a dead port, environment pointing at the fixture:
    // the probe must succeed through the environment, proving the payload key is inert.
    const evil = { ...payload, localBase: 'http://127.0.0.1:1' };
    const r = await run(evil, `http://127.0.0.1:${port}`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { authprobe: 'login-ok' });
    assert.ok(log.length > 0);
    // And without the environment seam the same payload key is NOT honored either:
    // the probe aims at the production default 8080, never at the payload's target.
    const r2 = await run({ ...payload, localBase: 'http://127.0.0.1:1' }, null);
    assert.notEqual(r2.status, 0);
    assert.match(r2.stderr, /stage=SMOKE_HEALTH/);
  } finally { server.close(); }
});
