/**
 * ai-assistant plugin: model providers. Pure helpers, no storage. The core adapter (apps/api/src/ai) stores the
 * registered models and calls these.
 *
 * Messages use ONE internal shape (OpenAI-like) whatever the provider:
 *   { role: 'user' | 'assistant' | 'tool', content: string, toolCalls?: [{ id, name, args }], toolCallId?: string, name?: string }
 * and every provider call returns { text, toolCalls: [{ id, name, args, badArgs? }], stop, usage }.
 *
 * Security posture, enforced here server-side:
 *  - only an administrator registers a model endpoint; the assistant (and the model) can never choose a URL;
 *  - a remote endpoint requires https and a public host name (no IP literal in a private range, no metadata
 *    address); http is accepted only towards the local model host(s) (IAM_AI_LOCAL_HOSTS, default localhost, ollama);
 *    IAM_AI_ALLOWED_HOSTS optionally restricts the allowed remote hosts further;
 *  - the API key is stored encrypted (AES-256-GCM, key from IAM_AI_KEY_SECRET - POC grade: a real deployment
 *    injects a KMS key), never returned by any route and redacted from every error text.
 */
import { createRequire } from 'node:module';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const require = createRequire(new URL('./package.json', import.meta.url));
const { BadRequestException } = require('@nestjs/common');

export const MODEL_KINDS = ['openai-compatible', 'anthropic'];
export const MODEL_ID = /^md-[0-9a-f]{12}$/;
export const LOCAL_MODEL_ID = 'local';
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._:/@+-]{0,99}$/;

export const localHosts = () => (process.env.IAM_AI_LOCAL_HOSTS ?? 'localhost,127.0.0.1,::1,[::1],ollama').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

const privateIp = (host) => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (m) { const [a, b] = [Number(m[1]), Number(m[2])]; return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127); }
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
  const local = localHosts().includes(host);
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
    return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith('::ffff:');
  }
  return true;
}
/** Resolves the host of a remote endpoint and refuses it when ANY answer is a private address (blocks a public name pointing inside). */
export async function assertPublicResolution(hostname, resolve = (h) => lookup(h, { all: true, verbatim: true })) {
  let answers;
  try { answers = await resolve(hostname); } catch (e) { throw new ModelCallError(`the model host does not resolve: ${e.code ?? e.message}`, 502); }
  if (!answers?.length || answers.some((a) => privateAddress(a.address))) throw new ModelCallError('the model host resolves to a private or loopback address: refused', 400);
}
export const redact = (msg, key) => (key ? String(msg).split(key).join('[redacted]') : String(msg));

export class ModelCallError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const parseArgs = (raw) => {
  if (raw && typeof raw === 'object') return { args: raw };
  if (typeof raw !== 'string' || raw.trim() === '') return { args: {} };
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? { args: v } : { args: {}, badArgs: true }; } catch { return { args: {}, badArgs: true }; }
};

function openaiBody(model, system, messages, tools) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    else if (m.role === 'assistant' && m.toolCalls?.length) out.push({ role: 'assistant', content: m.content || null, tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } })) });
    else out.push({ role: m.role, content: m.content });
  }
  const body = { model: model.model, messages: out, max_tokens: model.maxTokens, stream: false };
  if (tools.length) { body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: (t.description ?? '').slice(0, 1000), parameters: t.inputSchema ?? { type: 'object', properties: {} } } })); body.tool_choice = 'auto'; }
  return body;
}
function parseOpenai(j) {
  const msg = j?.choices?.[0]?.message;
  if (!msg) throw new ModelCallError('the model endpoint returned no message', 502);
  const toolCalls = (msg.tool_calls ?? []).filter((t) => t?.function?.name).map((t, i) => ({ id: String(t.id ?? `call_${i}`).slice(0, 64), name: String(t.function.name), ...parseArgs(t.function.arguments) }));
  return { text: typeof msg.content === 'string' ? msg.content : '', toolCalls, stop: j.choices[0].finish_reason ?? '', usage: { input: j.usage?.prompt_tokens ?? null, output: j.usage?.completion_tokens ?? null } };
}

function anthropicBody(model, system, messages, tools) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) last.content.push(block); else out.push({ role: 'user', content: [block] });
    } else if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const t of m.toolCalls ?? []) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.args ?? {} });
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(no text)' }] });
    } else out.push({ role: 'user', content: m.content });
  }
  const body = { model: model.model, system, messages: out, max_tokens: model.maxTokens };
  if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: (t.description ?? '').slice(0, 1000), input_schema: t.inputSchema ?? { type: 'object', properties: {} } }));
  return body;
}
function parseAnthropic(j) {
  if (!Array.isArray(j?.content)) throw new ModelCallError('the model endpoint returned no content', 502);
  const text = j.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const toolCalls = j.content.filter((b) => b.type === 'tool_use' && b.name).map((b, i) => ({ id: String(b.id ?? `call_${i}`).slice(0, 64), name: String(b.name), ...parseArgs(b.input) }));
  return { text, toolCalls, stop: j.stop_reason ?? '', usage: { input: j.usage?.input_tokens ?? null, output: j.usage?.output_tokens ?? null } };
}

/**
 * One model turn. `model`: { kind, baseUrl, model, maxTokens }. `apiKey`: string | null (opened by the adapter).
 * `fetchImpl` is injectable for the tests. Errors never carry the key.
 */
export async function callModel({ model, apiKey, system, messages, tools, fetchImpl = fetch, timeoutMs = 90_000, resolveImpl }) {
  const anthropic = model.kind === 'anthropic';
  const url = anthropic ? `${model.baseUrl}/v1/messages` : `${model.baseUrl}/chat/completions`;
  const headers = { 'content-type': 'application/json' };
  if (anthropic) { headers['anthropic-version'] = '2023-06-01'; if (apiKey) headers['x-api-key'] = apiKey; } else if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const body = anthropic ? anthropicBody(model, system, messages, tools) : openaiBody(model, system, messages, tools);
  const host = new URL(url).hostname.toLowerCase();
  if (!localHosts().includes(host)) await assertPublicResolution(host, resolveImpl);
  let res;
  try { res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' }); } catch (e) { throw new ModelCallError(redact(`the model endpoint is unreachable: ${e.message}`, apiKey), 502); }
  const text = await res.text();
  if (!res.ok) throw new ModelCallError(redact(`the model endpoint answered ${res.status}: ${text.slice(0, 300)}`, apiKey), res.status === 401 || res.status === 403 ? 502 : 502);
  let j;
  try { j = JSON.parse(text); } catch { throw new ModelCallError('the model endpoint did not return JSON', 502); }
  return anthropic ? parseAnthropic(j) : parseOpenai(j);
}
