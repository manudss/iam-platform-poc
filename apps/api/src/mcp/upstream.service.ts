import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createConnection, Connection } from 'mysql2/promise';
import { VersioningService } from '../versioning/versioning.service.js';

/** Public view of a registered external MCP server. The upstream token is NEVER returned by any route. */
export interface McpUpstream {
  id: string; tenant: string; name: string; url: string; enabled: boolean;
  createdAt: string; createdBy: string; lastStatus: string; lastTools: number | null; lastCheck: string | null;
}
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
            created_at DATETIME(3) NOT NULL, created_by VARCHAR(64) NOT NULL,
            last_status VARCHAR(32) NOT NULL DEFAULT 'never-checked', last_tools INT NULL, last_check DATETIME(3) NULL,
            UNIQUE KEY uq_upstream_name (tenant, name))`);
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
      createdAt: String(r.created_at), createdBy: String(r.created_by),
      lastStatus: String(r.last_status), lastTools: r.last_tools === null ? null : Number(r.last_tools), lastCheck: r.last_check === null ? null : String(r.last_check),
    };
  }

  async create(tenant: string, by: string, input: { name?: unknown; url?: unknown; token?: unknown; enabled?: unknown }): Promise<McpUpstream> {
    if (!validUpstreamName(input.name)) throw new BadRequestException('name required: [a-z0-9][a-z0-9-]{0,31} (used as the relayed tool prefix)');
    const url = validateUpstreamUrl(input.url);
    if (typeof input.token !== 'string' || input.token.length < 4 || input.token.length > 500) throw new BadRequestException('token required (4..500 chars): it authenticates the platform towards the upstream, it is never shown again');
    const id = `up-${randomBytes(6).toString('hex')}`;
    const m = await this.meta();
    try {
      const dup = await m.query('SELECT 1 FROM mcp_upstreams WHERE tenant = ? AND name = ?', [tenant, input.name]);
      if ((dup[0] as Row[]).length) throw new BadRequestException(`an upstream named "${input.name}" already exists`);
      await m.query('INSERT INTO mcp_upstreams (id, tenant, name, url, token_enc, enabled, created_at, created_by) VALUES (?,?,?,?,?,?,?,?)',
        [id, tenant, input.name, url, sealToken(input.token), input.enabled === false ? 0 : 1, new Date().toISOString().slice(0, 23), by.slice(0, 64)]);
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
    return up;
  }

  /** JSON-RPC over the stateless streamable HTTP transport (same style as the platform's own endpoint). */
  private async rpc(url: string, token: string, method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`upstream answered HTTP ${res.status}`);
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
      const raw = e instanceof Error && e.name === 'AbortError' ? `upstream timeout after ${timeoutMs}ms` : (e as Error).message;
      throw new Error(redact(String(raw).slice(0, 500), token));
    } finally { clearTimeout(timer); }
  }

  /** tools/list of an upstream, cached 60 s per upstream (the console "Test" button forces a refresh). */
  async listTools(tenant: string, id: string, force = false): Promise<UpstreamTool[]> {
    const { up, token } = await this.rowWithToken(tenant, id);
    const hit = this.listCache.get(id);
    if (!force && hit && Date.now() - hit.at < LIST_CACHE_MS) return hit.tools;
    const r = (await this.rpc(up.url, token, 'tools/list', {})) as { tools?: UpstreamTool[] };
    const tools = Array.isArray(r?.tools) ? r.tools : [];
    this.listCache.set(id, { at: Date.now(), tools });
    return tools;
  }

  /** tools/call relay: arguments go through untouched, the upstream token is attached server-side. */
  async callTool(tenant: string, id: string, tool: string, args: unknown): Promise<unknown> {
    const { up, token } = await this.rowWithToken(tenant, id);
    return this.rpc(up.url, token, 'tools/call', { name: tool, arguments: args ?? {} }, 30_000);
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
