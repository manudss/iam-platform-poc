/**
 * ai-assistant plugin: model providers. Pure helpers, no storage. The core adapter (apps/api/src/ai) stores the
 * registered models and calls these.
 *
 * Model calls go through the AI SDK (`ai`, @ai-sdk/openai-compatible, @ai-sdk/anthropic, @ai-sdk/google); the only network
 * path is `guardedFetch` below, which the SDK providers receive as their `fetch`.
 *
 * Security posture, enforced here server-side:
 *  - only an administrator registers a model endpoint; the assistant (and the model) can never choose a URL;
 *  - a remote endpoint requires https and a public host name (no IP literal in a private range, no metadata
 *    address); http is accepted only towards the local model host(s) (operator list IAM_AI_LOCAL_ENDPOINTS, exact host:port, default the Ollama ports);
 *    IAM_AI_ALLOWED_HOSTS optionally restricts the allowed remote hosts further;
 *  - the API key is stored encrypted (AES-256-GCM, key from IAM_AI_KEY_SECRET - POC grade: a real deployment
 *    injects a KMS key), never returned by any route and redacted from every error text.
 */
import { createRequire } from 'node:module';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import { Readable } from 'node:stream';

const require = createRequire(new URL('./package.json', import.meta.url));
const { BadRequestException } = require('@nestjs/common');

export const MODEL_KINDS = ['openai-compatible', 'anthropic', 'google'];
export const MODEL_ID = /^md-[0-9a-f]{12}$/;
export const LOCAL_MODEL_ID = 'local';
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._:/@+-]{0,99}$/;

// Local (non-public, plain http, no DNS check) endpoints are an OPERATOR decision, never an admin one: exact host:port entries in
// IAM_AI_LOCAL_ENDPOINTS (default: the Ollama ports) plus the origin of IAM_AI_LOCAL_URL. "host:*" allows any port (tests only).
const hostPort = (u) => `${u.hostname.toLowerCase()}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
export const localEndpoints = () => {
  const list = (process.env.IAM_AI_LOCAL_ENDPOINTS ?? 'localhost:11434,127.0.0.1:11434,ollama:11434').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  try { if (process.env.IAM_AI_LOCAL_URL) list.push(hostPort(new URL(process.env.IAM_AI_LOCAL_URL))); } catch { /* ignored: validated where used */ }
  return list;
};
export const isLocalEndpoint = (u) => { const hp = hostPort(u); const list = localEndpoints(); return list.includes(hp) || list.includes(`${u.hostname.toLowerCase()}:*`); };

const privateIp = (host) => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (m) { const [a, b] = [Number(m[1]), Number(m[2])]; return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && Number(m[3]) === 0) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127); }
  return host.includes(':') || host.startsWith('[') || /\.(internal|local|localdomain)$/.test(host) || !host.includes('.');
};

/** Validates a model endpoint base URL. `local` is true when it targets a local model host. */
export function validateModelUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 300) throw new BadRequestException('baseUrl required (max 300 chars)');
  let u;
  try { u = new URL(raw); } catch { throw new BadRequestException('baseUrl must be an absolute URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BadRequestException('only http(s) URLs are supported');
  if (u.username || u.password) throw new BadRequestException('credentials in the URL are refused: use the key field');
  if (u.search || u.hash) throw new BadRequestException('baseUrl must not carry a query string or a fragment');
  const host = u.hostname.toLowerCase();
  const local = isLocalEndpoint(u);
  if (!local) {
    if (u.protocol !== 'https:') throw new BadRequestException('a remote model endpoint requires https (http is only allowed towards the local model host)');
    if (privateIp(host)) throw new BadRequestException('a remote model endpoint must be a public host name (private, loopback and metadata addresses are refused)');
    const allow = (process.env.IAM_AI_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (allow.length && !allow.includes(host)) throw new BadRequestException(`host "${host}" is not in IAM_AI_ALLOWED_HOSTS`);
  }
  return { url: u.toString().replace(/\/+$/, ''), local };
}

/** Validation of a model registration. Returns the clean values. */
export function validateModelInput(b) {
  if (typeof b?.name !== 'string' || !NAME.test(b.name.trim())) throw new BadRequestException('name required (1..40 chars: letters, digits, space . _ -)');
  if (!MODEL_KINDS.includes(b.kind)) throw new BadRequestException(`kind must be one of ${MODEL_KINDS.join(', ')}`);
  if (typeof b.model !== 'string' || !MODEL_NAME.test(b.model.trim())) throw new BadRequestException('model required: the provider model identifier (e.g. gpt-4.1, claude-sonnet-4-5, llama3.1)');
  const { url, local } = validateModelUrl(b.baseUrl);
  if (b.apiKey !== undefined && b.apiKey !== null && b.apiKey !== '' && (typeof b.apiKey !== 'string' || b.apiKey.length < 4 || b.apiKey.length > 500)) throw new BadRequestException('apiKey must be 4..500 chars');
  const apiKey = typeof b.apiKey === 'string' && b.apiKey ? b.apiKey : null;
  if (!local && !apiKey) throw new BadRequestException('a remote model needs an API key');
  // Data protection: every tool result (users, roles, configuration) is sent to the model provider. Remote = explicit acknowledgement.
  if (!local && b.acknowledgeDataSharing !== true) throw new BadRequestException('acknowledgeDataSharing must be true: data returned by the tools the assistant uses is sent to this external provider');
  const maxTokens = Math.min(Math.max(Math.trunc(Number(b.maxTokens ?? 2048)) || 2048, 256), 16000);
  return { name: b.name.trim(), kind: b.kind, model: b.model.trim(), baseUrl: url, local, apiKey, maxTokens, enabled: b.enabled !== false };
}

// No built-in fallback secret: without IAM_AI_KEY_SECRET (16+ chars) a key is refused instead of being sealed with a public value.
const encKey = () => {
  const secret = process.env.IAM_AI_KEY_SECRET ?? '';
  if (secret.length < 16) throw new BadRequestException('IAM_AI_KEY_SECRET (16+ characters) must be set on the API before an external model key can be stored');
  return createHash('sha256').update(secret).digest();
};
export function sealKey(key) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([c.update(key, 'utf8'), c.final()]);
  return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}
export function openKey(sealed) {
  const [iv, tag, data] = String(sealed).split('.').map((p) => Buffer.from(p, 'base64'));
  if (!iv?.length || !tag?.length || !data?.length) throw new Error('corrupt stored key');
  const d = createDecipheriv('aes-256-gcm', encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}
/** True for an address a remote model endpoint must never resolve to (loopback, private, link-local, metadata, mapped, ULA). */
export function privateAddress(addr) {
  const v = isIP(addr);
  if (v === 4) return privateIp(addr);
  if (v === 6) {
    const a = addr.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return privateIp(mapped[1]);
    return a === '::' || a === '::1' || a.startsWith('64:ff9b:') || a.startsWith('2002:') || a.startsWith('ff') || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith('::ffff:');
  }
  return true;
}
/** Resolves the host of a remote endpoint and refuses it when ANY answer is a private address (blocks a public name pointing inside). */
export async function assertPublicResolution(hostname, resolve = (h) => lookup(h, { all: true, verbatim: true })) {
  let answers;
  try { answers = await resolve(hostname); } catch (e) { throw new ModelCallError(`the model host does not resolve: ${e.code ?? e.message}`, 502); }
  if (!answers?.length || answers.some((a) => privateAddress(a.address))) throw new ModelCallError('the model host resolves to a private or loopback address: refused', 400);
  return answers;
}

/**
 * Request over https to the ALREADY CHECKED addresses: the socket connects to the address that passed the check (not to a second
 * DNS answer), TLS still validates the certificate for the host name. No redirect is followed. The body streams (model replies are
 * streamed to the console); a response larger than MAX_RESPONSE_BYTES is cut with an error.
 */
const MAX_RESPONSE_BYTES = 8_000_000;
export function pinnedFetch(answers) {
  return (url, init = {}) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const pick = answers[0];
    const req = https.request({
      protocol: 'https:', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: init.method ?? 'GET', headers: init.headers, servername: u.hostname,
      lookup: (_h, opts, cb) => (opts?.all ? cb(null, [{ address: pick.address, family: pick.family ?? isIP(pick.address) }]) : cb(null, pick.address, pick.family ?? isIP(pick.address))),
      signal: init.signal,
    }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400) { r.resume(); reject(new Error('redirects are refused')); return; }
      let size = 0;
      r.on('data', (c) => { size += c.length; if (size > MAX_RESPONSE_BYTES) r.destroy(new Error('response too large')); });
      const headers = Object.fromEntries(Object.entries(r.headers).filter(([, v]) => typeof v === 'string'));
      resolve(new Response([204, 205, 304].includes(r.statusCode) ? null : Readable.toWeb(r), { status: r.statusCode, headers }));
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

export const redact = (msg, key) => (key ? String(msg).split(key).join('[redacted]') : String(msg));

export const redactMessage = (e, key) => redact(String(e?.message ?? e), key);

export class ModelCallError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/**
 * The fetch every model call goes through (handed to the AI SDK provider): operator-listed local endpoints use plain fetch
 * (redirects refused); anything else must resolve ONLY to public addresses and connects to the checked address.
 */
export function guardedFetch({ resolveImpl, localFetch = fetch } = {}) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (isLocalEndpoint(url)) return localFetch(url, { ...init, redirect: 'error' });
    if (url.protocol !== 'https:') throw new ModelCallError('a remote model endpoint requires https', 400);
    const answers = await assertPublicResolution(url.hostname.toLowerCase(), resolveImpl);
    const headers = Object.fromEntries(new Headers(init.headers ?? {}));
    return pinnedFetch(answers)(url, { ...init, headers });
  };
}

/** The AI SDK language model for a stored model. `fetch` is the guarded one (or a test double). */
export function createLanguageModel({ model, apiKey, fetch: f = guardedFetch() }) {
  if (model.kind === 'anthropic') {
    const { createAnthropic } = require('@ai-sdk/anthropic');
    return createAnthropic({ apiKey: apiKey ?? undefined, baseURL: /\/v1$/.test(model.baseUrl) ? model.baseUrl : `${model.baseUrl}/v1`, fetch: f })(model.model);
  }
  if (model.kind === 'google') {
    const { createGoogleGenerativeAI } = require('@ai-sdk/google');
    return createGoogleGenerativeAI({ apiKey: apiKey ?? undefined, baseURL: model.baseUrl, fetch: f })(model.model);
  }
  const { createOpenAICompatible } = require('@ai-sdk/openai-compatible');
  return createOpenAICompatible({ name: 'lyam-model', apiKey: apiKey ?? undefined, baseURL: model.baseUrl, fetch: f }).chatModel(model.model);
}
