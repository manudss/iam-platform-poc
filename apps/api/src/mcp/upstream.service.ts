import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { createConnection, Connection } from 'mysql2/promise';
import { VersioningService } from '../versioning/versioning.service.js';
import { loadPluginModule } from '../plugins/v1/loader.js';

/** Public view of a registered external MCP server. The upstream token is NEVER returned by any route. */
export interface McpUpstream {
  id: string; tenant: string; name: string; url: string; enabled: boolean;
  authType: UpstreamAuthType; authUser: string | null;
  createdAt: string; createdBy: string; lastStatus: string; lastTools: number | null; lastCheck: string | null;
}
export type UpstreamAuthType = 'bearer' | 'basic';
interface UpstreamTool { name: string; description?: string; inputSchema?: Record<string, unknown> }
interface Row { [k: string]: unknown }

const ID = /^up-[0-9a-f]{12}$/;
const LIST_CACHE_MS = 60_000;

/**
 * Registry of external MCP servers relayed by the platform ("MCP gateway", P1): storage and HTTP relay stay
 * in this core adapter; the security rules (URL/auth validation, token sealing, redaction) live in the
 * `mcp-gateway` plugin folder (`plugins/mcp-gateway/upstream.mjs`) and are re-exported here.
 */
interface UpstreamRulesModule {
  validateUpstreamUrl: (raw: unknown) => string;
  validUpstreamName: (name: unknown) => name is string;
  authHeader: (authType: UpstreamAuthType, authUser: string | null, token: string) => string;
  secretValues: (authType: UpstreamAuthType, authUser: string | null, token: string) => string[];
  validateAuth: (authType: unknown, authUser: unknown) => { type: UpstreamAuthType; user: string | null };
  sealToken: (token: string) => string;
  openToken: (sealed: string) => string;
  redact: (msg: string, token: string) => string;
  UpstreamHttpError: new (message: string, status: number) => Error & { status: number };
}
const plugin = loadPluginModule('mcp-gateway', 'upstream.mjs') as UpstreamRulesModule;
export const validateUpstreamUrl = plugin.validateUpstreamUrl;
export const validUpstreamName = plugin.validUpstreamName;
export const authHeader = plugin.authHeader;
const secretValues = plugin.secretValues;
const validateAuth = plugin.validateAuth;
export const sealToken = plugin.sealToken;
export const openToken = plugin.openToken;
export const redact = plugin.redact;
export const UpstreamHttpError = plugin.UpstreamHttpError as unknown as new (message: string, status: number) => Error & { status: number };

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
