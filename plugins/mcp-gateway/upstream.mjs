/**
 * mcp-gateway plugin: the security rules of the upstream registry (external MCP servers relayed by the
 * platform). Pure helpers; the core adapter (apps/api/src/mcp/upstream.service.ts) keeps the storage and
 * the HTTP relay and re-exports these.
 *
 * Security posture, enforced here server-side:
 *  - only an administrator registers an upstream; an AI agent can never choose the URL it reaches (SSRF);
 *  - the upstream token is stored encrypted (AES-256-GCM, key from IAM_MCP_UPSTREAM_KEY - POC grade: a real
 *    deployment injects a KMS/vault-managed key), is never returned by any route and never written to any log
 *    or trace entry (outbound errors are redacted against it before being recorded);
 *  - NO TOKEN PASSTHROUGH (MCP spec, security best practices): the agent's session secret terminates here;
 *    the relay authenticates to the upstream with the upstream's OWN stored token. The agent never sees it.
 *  - http is accepted only towards loopback hosts (local demo / tests); anything remote requires https.
 *    IAM_MCP_UPSTREAM_HOSTS (comma-separated hostnames) optionally restricts the allowed hosts further.
 */
import { createRequire } from 'node:module';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// No top-level await: the loader and the core adapter sync-load this module with createRequire.
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { BadRequestException } = require('@nestjs/common');

export const UPSTREAM_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const UPSTREAM_ID = /^up-[0-9a-f]{12}$/;

export function validateUpstreamUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 500) throw new BadRequestException('url required (max 500 chars)');
  let u;
  try { u = new URL(raw); } catch { throw new BadRequestException('url must be an absolute URL'); }
  const host = u.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (u.protocol === 'http:' && !loopback) throw new BadRequestException('http is only allowed towards a loopback host (local demo); use https for a remote server');
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BadRequestException('only http(s) URLs are supported');
  if (u.username || u.password) throw new BadRequestException('credentials in the URL are refused: use the token field');
  const allow = (process.env.IAM_MCP_UPSTREAM_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.includes(host)) throw new BadRequestException(`host "${host}" is not in IAM_MCP_UPSTREAM_HOSTS`);
  return u.toString();
}

export const validUpstreamName = (name) => typeof name === 'string' && UPSTREAM_NAME.test(name);

/**
 * Authorization header the relay sends to the upstream.
 *  - bearer (default): `Bearer <token>` - the common remote-MCP scheme;
 *  - basic: `Basic base64(<user>:<token>)` - the Atlassian API-token scheme (account email + scoped token),
 *    which the Atlassian Rovo MCP accepts for machine-to-machine access next to OAuth 2.1.
 * The header is built server-side only; neither the token nor the derived credential ever leaves the platform.
 */
export function authHeader(authType, authUser, token) {
  if (authType === 'basic') {
    if (!authUser) throw new Error('basic auth requires the upstream auth user (e.g. the Atlassian account email)');
    return `Basic ${Buffer.from(`${authUser}:${token}`, 'utf8').toString('base64')}`;
  }
  return `Bearer ${token}`;
}

/** Values that must never appear in a log, trace or error: the raw token AND the derived credential. */
export const secretValues = (authType, authUser, token) =>
  authType === 'basic' && authUser ? [token, authHeader(authType, authUser, token), Buffer.from(`${authUser}:${token}`, 'utf8').toString('base64')] : [token];

/** Validation of the auth fields at registration: basic requires its user (the Atlassian account email). */
export function validateAuth(authType, authUser) {
  if (authType === undefined || authType === null || authType === 'bearer') return { type: 'bearer', user: null };
  if (authType !== 'basic') throw new BadRequestException('authType must be "bearer" (default) or "basic" (Atlassian-style email:token)');
  if (typeof authUser !== 'string' || !/^[^\s:]{3,200}$/.test(authUser.trim()))
    throw new BadRequestException('authUser is required for basic auth: the upstream account email or id (3..200 chars, no space or colon)');
  return { type: 'basic', user: authUser.trim() };
}

/** Token encryption at rest. POC-grade: the key comes from the environment, a deployment would use a KMS. */
const encKey = () => createHash('sha256').update(process.env.IAM_MCP_UPSTREAM_KEY ?? 'demo-only-not-a-secret').digest();
export function sealToken(token) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}
export function openToken(sealed) {
  const [iv, tag, data] = sealed.split('.').map((p) => Buffer.from(p, 'base64'));
  if (!iv?.length || !tag?.length || !data?.length) throw new Error('corrupt stored token');
  const d = createDecipheriv('aes-256-gcm', encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

/** Error text from an upstream may quote a request: the stored token is redacted before anything is logged or returned. */
export const redact = (msg, token) => (token ? msg.split(token).join('[redacted]') : msg);

/** HTTP-level failure from an upstream call: carries the status so the session lifecycle can spot a lost session. */
export class UpstreamHttpError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
