// Read-only activation inventory through the normal authenticated demo edge. No auth bypass.
// Credentials/session token arrive only on stdin, never argv, logs or the resulting archive.
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (reason) => { throw new Error(reason); };
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export function validateRows(rows, tenant) {
  if (!Array.isArray(rows)) fail('journal: expected a JSON array, inventory UNKNOWN');
  let last = 0;
  for (const r of rows) {
    if (!object(r) || r.tenant !== tenant || !Number.isSafeInteger(r.seq) || r.seq <= last ||
        typeof r.commit !== 'string' || !r.commit.trim() ||
        !['pending', 'recorded', 'applied', 'failed'].includes(r.state) ||
        (r.error !== undefined && typeof r.error !== 'string') ||
        (r.requestId !== undefined && typeof r.requestId !== 'string')) {
      fail('journal: invalid row, tenant or sequence, inventory UNKNOWN');
    }
    last = r.seq;
  }
  return rows;
}

export async function inventory({ origin, tenant, auth, fetchImpl = fetch, timeoutMs = 15000 }) {
  let base;
  try { base = new URL(origin); } catch { fail('invalid origin'); }
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)))) fail('HTTPS origin required (HTTP allowed only on loopback)');
  if (typeof tenant !== 'string' || !tenant || /[\x00-\x20/\\]/.test(tenant)) fail('invalid tenant');
  base = base.origin;
  const json = async (path, options, label) => {
    let r;
    try { r = await fetchImpl(base + path, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json', ...options.headers } }); }
    catch { fail(`${label}: network, redirect or timeout error, inventory UNKNOWN`); }
    if (r.status !== 200) fail(`${label}: HTTP ${r.status}, inventory UNKNOWN`);
    if (!/^application\/json(?:\s*;|$)/i.test(r.headers.get('content-type') ?? '')) fail(`${label}: not JSON, inventory UNKNOWN`);
    // Bound the response while streaming, including chunked responses.
    let data = '', bytes = 0;
    try {
      const decoder = new TextDecoder();
      for await (const chunk of r.body) {
        bytes += chunk.byteLength;
        if (bytes > 16 * 1024 * 1024) { await r.body.cancel().catch(() => {}); fail('too large'); }
        data += decoder.decode(chunk, { stream: true });
      }
      data += decoder.decode();
      return JSON.parse(data);
    } catch { fail(`${label}: invalid or oversized JSON, inventory UNKNOWN`); }
  };
  if (!object(auth)) fail('stdin must contain a session token or login credentials');
  let token;
  if (Object.keys(auth).length === 1 && typeof auth.id_token === 'string') token = auth.id_token;
  else if (Object.keys(auth).sort().join(',') === 'password,username' && typeof auth.username === 'string' && auth.username && typeof auth.password === 'string' && auth.password) {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const post = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const code = await json('/core/authorize', post({ client_id: 'demo-web', redirect_uri: base + '/callback', code_challenge: challenge, username: auth.username, password: auth.password }), 'sign-in');
    if (!object(code) || typeof code.code !== 'string' || !code.code) fail('sign-in: missing code, inventory UNKNOWN');
    const issued = await json('/core/token', post({ client_id: 'demo-web', redirect_uri: base + '/callback', code_verifier: verifier, code: code.code }), 'token exchange');
    if (!object(issued) || typeof issued.id_token !== 'string') fail('token exchange: missing token, inventory UNKNOWN');
    token = issued.id_token;
  } else fail('stdin must contain only id_token, or username and password');
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) fail('a session JWT is required, not the static admin capability');
  const rows = await json(`/api/tenants/${encodeURIComponent(tenant)}/activations`, { method: 'GET', headers: { authorization: `Bearer ${token}` } }, 'journal');
  validateRows(rows, tenant);
  return { version: 1, verified: true, origin: base, tenant, capturedAt: new Date().toISOString(), count: rows.length, rows };
}

export async function saveInventory(result, outputDir) {
  // A new private directory is the completion boundary. Never overwrite a prior inventory.
  await mkdir(outputDir, { mode: 0o700 });
  try { await writeFile(resolve(outputDir, 'activations.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
  catch { await rm(outputDir, { recursive: true, force: true }); fail('could not save inventory'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 5) fail('usage: node activation-inventory.mjs <https-origin> <tenant> <new-private-output-directory> < private-auth.json');
    let auth;
    try { let input = ''; for await (const chunk of process.stdin) { input += chunk.toString('utf8'); if (input.length > 65536) fail('too large'); } auth = JSON.parse(input); } catch { fail('invalid private authentication input'); }
    const result = await inventory({ origin: process.argv[2], tenant: process.argv[3], auth });
    await saveInventory(result, resolve(process.argv[4]));
    console.log(`VERIFIED journal inventory: ${result.count} rows. Private archive saved. This is not permission to stop or migrate the service.`);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
