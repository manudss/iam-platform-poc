import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventory, saveInventory } from './activation-inventory.mjs';
const origin = 'https://example.invalid', tenant = 't1', auth = { id_token: 'test.jwt.signature' };
const row = { tenant, seq: 1, commit: 'test-commit', state: 'applied' };
const answer = (body, status = 200, type = 'application/json') => new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const run = (response, extra = {}) => inventory({ origin, tenant, auth, fetchImpl: async () => response(), ...extra });
for (const status of [401, 403, 404, 429, 500, 503]) test(`HTTP ${status} is UNKNOWN, never zero (even array body)`, async () => {
  await assert.rejects(run(() => answer([], status)), new RegExp(`HTTP ${status}`));
});
for (const body of [{ statusCode: 401 }, {}, { activations: [] }, { rows: [] }, null, '[]', 0]) test(`unexpected envelope ${JSON.stringify(body)} rejected`, async () => {
  await assert.rejects(run(() => answer(body)), /expected a JSON array/);
});
test('only successful exact empty array verifies zero', async () => {
  const r = await run(() => answer([])); assert.equal(r.count, 0); assert.equal(r.verified, true);
});
test('valid rows are retained without dropping fields', async () => {
  const r = await run(() => answer([{ ...row, requestId: 'req', error: '' }]));
  assert.deepEqual(r.rows, [{ ...row, requestId: 'req', error: '' }]); assert.equal(r.count, 1);
});
for (const rows of [[{}], [{ ...row, tenant: 'other' }], [{ ...row, seq: '1' }], [{ ...row, seq: 0 }], [row, row], [{ ...row, state: 'unknown' }], [{ ...row, commit: '' }], [{ ...row, error: {} }]]) test(`invalid row or ordering rejected ${JSON.stringify(rows)}`, async () => {
  await assert.rejects(run(() => answer(rows)), /invalid row/);
});
test('HTML login page at 200 and malformed JSON rejected', async () => {
  await assert.rejects(run(() => answer([], 200, 'text/html')), /not JSON/);
  await assert.rejects(run(() => new Response('{', { headers: { 'content-type': 'application/json' } })), /invalid or oversized JSON/);
});
test('network or redirect errors are unknown without echoing secret', async () => {
  await assert.rejects(run(() => { throw new Error('PRIVATE_SECRET'); }), (e) => e.message.includes('UNKNOWN') && !e.message.includes('PRIVATE_SECRET'));
});
test('request uses edge API, bearer and redirect refusal', async () => {
  await inventory({ origin, tenant, auth, fetchImpl: async (url, opts) => {
    assert.equal(url, origin + '/api/tenants/t1/activations'); assert.equal(opts.method, 'GET');
    assert.equal(opts.redirect, 'error'); assert.equal(opts.headers.authorization, 'Bearer test.jwt.signature');
    return answer([]);
  } });
});
test('static capability is not a session JWT', async () => {
  await assert.rejects(run(() => answer([]), { auth: { id_token: 'static-capability' } }), /session JWT/);
});
test('normal login exchanges a fresh PKCE code, then reads journal', async () => {
  const calls = [];
  const r = await inventory({ origin, tenant, auth: { username: 'fictional-user', password: 'fictional-test-value' }, fetchImpl: async (url, opts) => {
    calls.push({ url, opts }); return answer(calls.length === 1 ? { code: 'one-use' } : calls.length === 2 ? { id_token: auth.id_token } : [row]);
  } });
  assert.equal(r.count, 1); assert.equal(calls[0].url, origin + '/core/authorize');
  assert.equal(calls[1].url, origin + '/core/token');
  const a = JSON.parse(calls[0].opts.body), b = JSON.parse(calls[1].opts.body);
  const { createHash } = await import('node:crypto');
  assert.equal(a.code_challenge, createHash('sha256').update(b.code_verifier).digest('base64url'));
  assert.equal(b.code, 'one-use'); assert.ok(!JSON.stringify(r).includes('fictional-test-value'));
});
test('failed login or missing token blocks inventory request', async () => {
  await assert.rejects(run(() => answer({}, 401), { auth: { username: 'u', password: 'p' } }), /sign-in: HTTP 401/);
  await assert.rejects(run(() => answer({}), { auth: { username: 'u', password: 'p' } }), /missing code/);
});
test('refuse insecure remote origin or embedded URL credentials', async () => {
  for (const bad of ['http://example.invalid', 'https://user:secret@example.invalid', origin + '/api', origin + '?x=y']) {
    await assert.rejects(run(() => answer([]), { origin: bad }), /HTTPS origin required/);
  }
});
test('archive is private and cannot overwrite earlier evidence', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'activation-inventory-test-')), dir = join(parent, 'result');
  try {
    const result = await run(() => answer([row])); await saveInventory(result, dir);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, 'activations.json'))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'activations.json'), 'utf8')), result);
    await assert.rejects(saveInventory(result, dir));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('CLI preserves UNKNOWN on 401 and creates no misleading empty archive', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const parent = await mkdtemp(join(tmpdir(), 'activation-cli-test-'));
  let response = { status: 401, body: { statusCode: 401, message: 'PRIVATE_MARKER' } };
  const server = createServer((req, res) => { res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(response.body)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const invoke = (out) => new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./activation-inventory.mjs', import.meta.url)), `http://127.0.0.1:${server.address().port}`, tenant, out]);
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => stdout += d); child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => resolve({ code, stdout, stderr })); child.stdin.end(JSON.stringify(auth));
  });
  try {
    const out = join(parent, 'export');
    const failed = await invoke(out);
    assert.equal(failed.code, 1); assert.equal(failed.stdout, ''); assert.match(failed.stderr, /HTTP 401/);
    assert.ok(!failed.stderr.includes('PRIVATE_MARKER')); assert.ok(!failed.stderr.includes(auth.id_token));
    await assert.rejects(stat(out), { code: 'ENOENT' });
    response = { status: 200, body: [] };
    const success = await invoke(out); assert.equal(success.code, 0); assert.match(success.stdout, /VERIFIED.*0 rows/);
    assert.equal(JSON.parse(await readFile(join(out, 'activations.json'), 'utf8')).count, 0);
  } finally { await new Promise((r) => server.close(r)); await rm(parent, { recursive: true, force: true }); }
});
