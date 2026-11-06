import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createConnection, Connection } from 'mysql2/promise';
import { VersioningService } from '../versioning/versioning.service.js';

/** Public view of a registered external MCP server. The upstream token is NEVER returned by any route. */
export interface McpUpstream {
  id: string; tenant: string; name: string; url: string; enabled: boolean;
  authType: UpstreamAuthType; authUser: string | null;
  createdAt: string; createdBy: string; lastStatus: string; lastTools: number | null; lastCheck: string | null;
}
export type UpstreamAuthType = 'bearer' | 'basic';
interface UpstreamTool { name: string; description?: string; inputSchema?: Record<string, unknown> }
interface Row { [k: string]: unknown }

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ID = /^up-[0-9a-f]{12}$/;
const LIST_CACHE_MS = 60_000;

/**
 * Registry of external MCP servers relayed by the platform ("MCP gateway", P1).
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
export function validateUpstreamUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 500) throw new BadRequestException('url required (max 500 chars)');
  let u: URL;
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

export const validUpstreamName = (name: unknown): name is string => typeof name === 'string' && NAME.test(name);

/**
 * Authorization header the relay sends to the upstream (P3).
 *  - bearer (default): `Bearer <token>` - the common remote-MCP scheme;
 *  - basic: `Basic base64(<user>:<token>)` - the Atlassian API-token scheme (account email + scoped token),
 *    which the Atlassian Rovo MCP accepts for machine-to-machine access next to OAuth 2.1.
 * The header is built server-side only; neither the token nor the derived credential ever leaves the platform.
 */
export function authHeader(authType: UpstreamAuthType, authUser: string | null, token: string): string {
  if (authType === 'basic') {
    if (!authUser) throw new Error('basic auth requires the upstream auth user (e.g. the Atlassian account email)');
    return `Basic ${Buffer.from(`${authUser}:${token}`, 'utf8').toString('base64')}`;
  }
  return `Bearer ${token}`;
}

/** Values that must never appear in a log, trace or error: the raw token AND the derived credential. */
const secretValues = (authType: UpstreamAuthType, authUser: string | null, token: string): string[] =>
  authType === 'basic' && authUser ? [token, authHeader(authType, authUser, token), Buffer.from(`${authUser}:${token}`, 'utf8').toString('base64')] : [token];

/** Validation of the auth fields at registration: basic requires its user (the Atlassian account email). */
function validateAuth(authType: unknown, authUser: unknown): { type: UpstreamAuthType; user: string | null } {
  if (authType === undefined || authType === null || authType === 'bearer') return { type: 'bearer', user: null };
  if (authType !== 'basic') throw new BadRequestException('authType must be "bearer" (default) or "basic" (Atlassian-style email:token)');
  if (typeof authUser !== 'string' || !/^[^\s:]{3,200}$/.test(authUser.trim()))
    throw new BadRequestException('authUser is required for basic auth: the upstream account email or id (3..200 chars, no space or colon)');
  return { type: 'basic', user: authUser.trim() };
}

/** Token encryption at rest. POC-grade: the key comes from the environment, a deployment would use a KMS. */
const encKey = () => createHash('sha256').update(process.env.IAM_MCP_UPSTREAM_KEY ?? 'demo-only-not-a-secret').digest();
export function sealToken(token: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}
export function openToken(sealed: string): string {
  const [iv, tag, data] = sealed.split('.').map((p) => Buffer.from(p, 'base64'));
  if (!iv?.length || !tag?.length || !data?.length) throw new Error('corrupt stored token');
  const d = createDecipheriv('aes-256-gcm', encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

/** Error text from an upstream may quote a request: the stored token is redacted before anything is logged or returned. */
export const redact = (msg: string, token: string) => (token ? msg.split(token).join('[redacted]') : msg);

/** HTTP-level failure from an upstream call: carries the status so the session lifecycle can spot a lost session. */
export class UpstreamHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

interface RpcOptions {
  /** mcp-session-id to attach (sessionful upstreams, e.g. the Atlassian Rovo MCP). */
  sessionId?: string;
  /** Out-param: set from the mcp-session-id response header when the upstream starts a session. */
  captureSessionId?: { value?: string };
  /** Notifications get HTTP 202 with an empty body: accept it as success. */
  allowEmptyAccepted?: boolean;
  /** JSON-RPC notification: no id member. */
  notification?: boolean;
}

@Injectable()
export class McpUpstreamService {
  private ready?: Promise<void>;
  private listCache = new Map<string, { at: number; tools: UpstreamTool[] }>();
  constructor(private readonly v: VersioningService) {}

  private get metaDb() { return `${this.v.dbName}_meta`; }
  private async meta(): Promise<Connection> {
    if (!this.ready) {
      this.ready = (async () => {
        const c = await this.v.connect();
        try { await c.query(`CREATE DATABASE IF NOT EXISTS \`${this.metaDb.replace(/[^A-Za-z0-9_]/g, '')}\``); } finally { await c.end(); }
        const m = await this.open();
        try {
          await m.query(`CREATE TABLE IF NOT EXISTS mcp_upstreams (
            id VARCHAR(40) PRIMARY KEY, tenant VARCHAR(32) NOT NULL, name VARCHAR(40) NOT NULL, url VARCHAR(500) NOT NULL,
            token_enc TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
            auth_type VARCHAR(10) NOT NULL DEFAULT 'bearer', auth_user VARCHAR(200) NULL,
            created_at DATETIME(3) NOT NULL, created_by VARCHAR(64) NOT NULL,
            last_status VARCHAR(32) NOT NULL DEFAULT 'never-checked', last_tools INT NULL, last_check DATETIME(3) NULL,
            UNIQUE KEY uq_upstream_name (tenant, name))`);
          // P3 migration for registries created before the auth columns existed (a fresh CREATE already has them).
          for (const alter of [
            `ALTER TABLE mcp_upstreams ADD COLUMN auth_type VARCHAR(10) NOT NULL DEFAULT 'bearer'`,
            `ALTER TABLE mcp_upstreams ADD COLUMN auth_user VARCHAR(200) NULL`,
          ]) { try { await m.query(alter); } catch (e) { if (!/duplicate column|already exists/i.test((e as Error).message)) throw e; } }
        } finally { await m.end(); }
      })().catch((e) => { this.ready = undefined; throw new HttpException(`mcp upstream store unavailable: ${(e as Error).message}`, 503); });
    }
    await this.ready;
    return this.open();
  }
  private open(): Promise<Connection> {
    return createConnection({
      host: process.env.DOLT_HOST ?? '127.0.0.1', port: Number(process.env.DOLT_PORT ?? 3307), user: process.env.DOLT_USER ?? 'root',
      password: process.env.DOLT_PASSWORD ?? '', database: this.metaDb.replace(/[^A-Za-z0-9_]/g, ''), connectTimeout: 5000, dateStrings: true,
    });
  }

  private shape(r: Row): McpUpstream {
    return {
      id: String(r.id), tenant: String(r.tenant), name: String(r.name), url: String(r.url), enabled: !!r.enabled,
      authType: r.auth_type === 'basic' ? 'basic' : 'bearer', authUser: r.auth_user == null ? null : String(r.auth_user),
      createdAt: String(r.created_at), createdBy: String(r.created_by),
      lastStatus: String(r.last_status), lastTools: r.last_tools === null ? null : Number(r.last_tools), lastCheck: r.last_check === null ? null : String(r.last_check),
    };
  }

  async create(tenant: string, by: string, input: { name?: unknown; url?: unknown; token?: unknown; enabled?: unknown; authType?: unknown; authUser?: unknown }): Promise<McpUpstream> {
    if (!validUpstreamName(input.name)) throw new BadRequestException('name required: [a-z0-9][a-z0-9-]{0,31} (used as the relayed tool prefix)');
    const url = validateUpstreamUrl(input.url);
    if (typeof input.token !== 'string' || input.token.length < 4 || input.token.length > 500) throw new BadRequestException('token required (4..500 chars): it authenticates the platform towards the upstream, it is never shown again');
    const auth = validateAuth(input.authType, input.authUser);
    const id = `up-${randomBytes(6).toString('hex')}`;
    const m = await this.meta();
    try {
      const dup = await m.query('SELECT 1 FROM mcp_upstreams WHERE tenant = ? AND name = ?', [tenant, input.name]);
      if ((dup[0] as Row[]).length) throw new BadRequestException(`an upstream named "${input.name}" already exists`);
      await m.query('INSERT INTO mcp_upstreams (id, tenant, name, url, token_enc, enabled, auth_type, auth_user, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [id, tenant, input.name, url, sealToken(input.token), input.enabled === false ? 0 : 1, auth.type, auth.user, new Date().toISOString().slice(0, 23), by.slice(0, 64)]);
    } finally { await m.end(); }
    return (await this.list(tenant)).find((u) => u.id === id)!;
  }

  async list(tenant: string): Promise<McpUpstream[]> {
    const m = await this.meta();
    try {
      const [r] = await m.query('SELECT * FROM mcp_upstreams WHERE tenant = ? ORDER BY created_at DESC LIMIT 100', [tenant]);
      return (r as Row[]).map((x) => this.shape(x));
    } finally { await m.end(); }
  }

  async enabled(tenant: string): Promise<McpUpstream[]> { return (await this.list(tenant)).filter((u) => u.enabled); }

  private async rowWithToken(tenant: string, id: string): Promise<{ up: McpUpstream; token: string }> {
    if (!ID.test(id)) throw new BadRequestException('invalid upstream id');
    const m = await this.meta();
    try {
      const [r] = await m.query('SELECT * FROM mcp_upstreams WHERE tenant = ? AND id = ?', [tenant, id]);
      const row = (r as Row[])[0];
      if (!row) throw new NotFoundException(`upstream ${id} not found`);
      return { up: this.shape(row), token: openToken(String(row.token_enc)) };
    } finally { await m.end(); }
  }

  async remove(tenant: string, id: string): Promise<McpUpstream> {
    const { up } = await this.rowWithToken(tenant, id);
    const m = await this.meta();
    try { await m.query('DELETE FROM mcp_upstreams WHERE id = ?', [id]); } finally { await m.end(); }
    this.listCache.delete(id);
    this.sessions.delete(id);
    return up;
  }

  /**
   * One JSON-RPC call over the streamable HTTP transport (same style as the platform's own endpoint).
   * Sessionful upstreams (the Atlassian Rovo MCP among them) answer any non-initialize request that
   * lacks a valid mcp-session-id with HTTP 400, so the header rides along when we hold a session.
   */
  private async rpc(url: string, authz: string, secrets: string[], method: string, params: unknown, timeoutMs = 10_000, opts: RpcOptions = {}): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: authz,
          ...(opts.sessionId ? { 'mcp-session-id': opts.sessionId } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', ...(opts.notification ? {} : { id: 1 }), method, ...(params === undefined ? {} : { params }) }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        // A short body snippet helps the console admin (e.g. Atlassian's "-32600: initialize required"):
        // the stored credential is redacted from it below like anywhere else.
        let detail = '';
        try { detail = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 200); } catch { /* no body */ }
        throw new UpstreamHttpError(`upstream answered HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
      }
      if (opts.captureSessionId) {
        const sid = res.headers.get('mcp-session-id');
        if (sid) opts.captureSessionId.value = sid;
      }
      if (res.status === 202 && opts.allowEmptyAccepted) return undefined;
      const type = res.headers.get('content-type') ?? '';
      let msg: { result?: unknown; error?: { code?: number; message?: string } } | undefined;
      if (type.includes('text/event-stream')) {
        const events = (await res.text()).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
        msg = events.map((d) => { try { return JSON.parse(d); } catch { return undefined; } }).filter(Boolean).pop();
      } else {
        msg = (await res.json()) as typeof msg;
      }
      if (!msg) throw new Error('empty upstream response');
      if (msg.error) throw new Error(`upstream error ${msg.error.code ?? ''}: ${String(msg.error.message ?? 'unknown').slice(0, 300)}`);
      return msg.result;
    } catch (e) {
      const status = e instanceof UpstreamHttpError ? e.status : undefined;
      let raw = e instanceof Error && e.name === 'AbortError' ? `upstream timeout after ${timeoutMs}ms` : (e as Error).message;
      for (const secret of secrets) raw = redact(raw, secret);
      throw new UpstreamHttpError(String(raw).slice(0, 500), status ?? 0);
    } finally { clearTimeout(timer); }
  }

  /** Session cache: one MCP session per upstream (null = the upstream is stateless and wants no session). */
  private sessions = new Map<string, Promise<string | null>>();

  private ensureSession(up: McpUpstream, authz: string, secrets: string[]): Promise<string | null> {
    let p = this.sessions.get(up.id);
    if (!p) {
      p = this.initSession(up, authz, secrets).catch((e) => { this.sessions.delete(up.id); throw e; });
      this.sessions.set(up.id, p);
    }
    return p;
  }

  /**
   * MCP streamable-HTTP handshake: initialize, then the initialized notification when the server issued
   * a session id. Stateless servers (the original fake, simple relays) answer initialize without a
   * mcp-session-id header: they keep being used one POST per call, exactly as before.
   */
  private async initSession(up: McpUpstream, authz: string, secrets: string[]): Promise<string | null> {
    const capture: { value?: string } = {};
    await this.rpc(up.url, authz, secrets, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'iam-mcp-gateway', version: '0.3.0' },
    }, 10_000, { captureSessionId: capture });
    if (!capture.value) return null;
    await this.rpc(up.url, authz, secrets, 'notifications/initialized', undefined, 10_000, { sessionId: capture.value, allowEmptyAccepted: true, notification: true });
    return capture.value;
  }

  /**
   * Run upstream work inside the session lifecycle: handshake once per upstream, then transparently
   * re-initialize and retry once when the server dropped the session (the MCP spec lets a server expire
   * a session at any time; the Atlassian Rovo MCP answers HTTP 400/404 to a stale mcp-session-id).
   */
  private async withUpstream<T>(up: McpUpstream, token: string, fn: (authz: string, secrets: string[], sessionId: string | null) => Promise<T>): Promise<T> {
    const authz = authHeader(up.authType, up.authUser, token);
    const secrets = secretValues(up.authType, up.authUser, token);
    const sid = await this.ensureSession(up, authz, secrets);
    try {
      return await fn(authz, secrets, sid);
    } catch (e) {
      if (sid && e instanceof UpstreamHttpError && (e.status === 400 || e.status === 404)) {
        this.sessions.delete(up.id);
        const sid2 = await this.ensureSession(up, authz, secrets);
        return fn(authz, secrets, sid2);
      }
      throw e;
    }
  }

  /**
   * tools/list of an upstream, cached 60 s per upstream (the console "Test" button forces a refresh).
   * Pagination (P3): a gateway needs the COMPLETE catalog so each tool is individually grantable - the
   * Atlassian Rovo MCP serves its flat list (?tools=all) over several pages, so nextCursor is followed
   * (bounded at 10 pages: a buggy or hostile upstream cannot loop the registry forever).
   */
  async listTools(tenant: string, id: string, force = false): Promise<UpstreamTool[]> {
    const { up, token } = await this.rowWithToken(tenant, id);
    const hit = this.listCache.get(id);
    if (!force && hit && Date.now() - hit.at < LIST_CACHE_MS) return hit.tools;
    const tools = await this.withUpstream(up, token, async (authz, secrets, sid) => {
      const acc: UpstreamTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const r = (await this.rpc(up.url, authz, secrets, 'tools/list', cursor ? { cursor } : {}, 10_000, { sessionId: sid ?? undefined })) as { tools?: UpstreamTool[]; nextCursor?: unknown };
        if (Array.isArray(r?.tools)) acc.push(...r.tools);
        cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined;
        if (!cursor) break;
      }
      return acc;
    });
    this.listCache.set(id, { at: Date.now(), tools });
    return tools;
  }

  /** tools/call relay: arguments go through untouched, the upstream credential is attached server-side. */
  async callTool(tenant: string, id: string, tool: string, args: unknown): Promise<unknown> {
    const { up, token } = await this.rowWithToken(tenant, id);
    return this.withUpstream(up, token, (authz, secrets, sid) =>
      this.rpc(up.url, authz, secrets, 'tools/call', { name: tool, arguments: args ?? {} }, 30_000, { sessionId: sid ?? undefined }));
  }

  /** Console "Test" button: refreshes the tool list and records the outcome on the registry row. */
  async test(tenant: string, id: string): Promise<{ ok: boolean; tools: string[]; error: string | null }> {
    let ok = false, tools: UpstreamTool[] = [], error: string | null = null;
    try { tools = await this.listTools(tenant, id, true); ok = true; } catch (e) { error = (e as Error).message; }
    const m = await this.meta();
    try {
      await m.query('UPDATE mcp_upstreams SET last_status = ?, last_tools = ?, last_check = ? WHERE id = ?',
        [ok ? 'ok' : 'error', ok ? tools.length : null, new Date().toISOString().slice(0, 23), id]);
    } finally { await m.end(); }
    return { ok, tools: tools.map((t) => t.name), error };
  }
}
