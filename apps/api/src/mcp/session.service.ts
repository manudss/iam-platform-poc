import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { createConnection, Connection } from 'mysql2/promise';
import { VersioningService } from '../versioning/versioning.service.js';

/** Public view of an MCP session. The secret itself is NEVER stored in clear and NEVER returned after creation. */
export interface McpSession {
  id: string; tenant: string; owner: string; label: string; branch: string; seq: number;
  createdAt: string; expiresAt: string; expiresMs: number; revoked: boolean; submitted: boolean; calls: number;
}
export interface ActivityEntry {
  id: number; at: string; tenant: string; sessionId: string; owner: string; branch: string;
  tool: string; kind: 'read' | 'write' | 'lifecycle' | 'proxy'; detail: string; targets: string[];
  allow: boolean; reasons: string[]; rowCount: number | null; error: string | null;
}
type Row = Record<string, unknown>;

const MIN_TTL = 60, MAX_TTL = 7 * 24 * 3600; // 1 minute .. 7 days
const ID = /^mcp-[0-9a-f]{12}$/;

export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');

/**
 * MCP sessions: one restricted identity per AI connection. The session record lives in the UNVERSIONED meta
 * database (same place as pull requests and personal branches), never in the versioned business data.
 * Only the SHA-256 hash of the bearer secret is stored. Each session owns exactly one Dolt branch, cut from
 * main at creation; rotation cuts a NEW branch from main again (never from an arbitrary branch).
 */
@Injectable()
export class McpSessionService {
  private ready?: Promise<void>;
  constructor(private readonly v: VersioningService) {}

  private get metaDb() { return `${this.v.dbName}_meta`; }
  private async meta(): Promise<Connection> {
    if (!this.ready) {
      this.ready = (async () => {
        const c = await this.v.connect();
        try { await c.query(`CREATE DATABASE IF NOT EXISTS \`${this.metaDb.replace(/[^A-Za-z0-9_]/g, '')}\``); } finally { await c.end(); }
        const m = await this.open();
        try {
          await m.query(`CREATE TABLE IF NOT EXISTS mcp_sessions (
            id VARCHAR(40) PRIMARY KEY, tenant VARCHAR(32) NOT NULL, owner_sub VARCHAR(64) NOT NULL, label VARCHAR(120) NOT NULL,
            branch VARCHAR(63) NOT NULL, seq INT NOT NULL DEFAULT 1, secret_hash CHAR(64) NOT NULL,
            created_at DATETIME(3) NOT NULL, expires_ms BIGINT NOT NULL,
            revoked BOOLEAN NOT NULL DEFAULT FALSE, submitted BOOLEAN NOT NULL DEFAULT FALSE, calls INT NOT NULL DEFAULT 0)`);
          await m.query(`CREATE TABLE IF NOT EXISTS mcp_activity (
            id BIGINT AUTO_INCREMENT PRIMARY KEY, at DATETIME(3) NOT NULL DEFAULT NOW(3),
            tenant VARCHAR(32) NOT NULL, session_id VARCHAR(40) NOT NULL, owner_sub VARCHAR(64) NOT NULL, branch VARCHAR(63) NOT NULL,
            tool VARCHAR(64) NOT NULL, kind VARCHAR(10) NOT NULL, detail TEXT, targets TEXT,
            allow BOOLEAN NOT NULL, reasons TEXT, row_count INT NULL, error VARCHAR(500) NULL)`);
        } finally { await m.end(); }
      })().catch((e) => { this.ready = undefined; throw new HttpException(`mcp session store unavailable: ${(e as Error).message}`, 503); });
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

  private shape(r: Row): McpSession {
    return {
      id: String(r.id), tenant: String(r.tenant), owner: String(r.owner_sub), label: String(r.label), branch: String(r.branch), seq: Number(r.seq),
      createdAt: String(r.created_at), expiresAt: new Date(Number(r.expires_ms)).toISOString(), expiresMs: Number(r.expires_ms), revoked: !!r.revoked, submitted: !!r.submitted, calls: Number(r.calls),
    };
  }

  /** Creates the session AND its Dolt branch (cut from main). Returns the secret exactly once. */
  async create(tenant: string, owner: string, label: unknown, ttlSeconds: unknown): Promise<{ secret: string; session: McpSession }> {
    const name = typeof label === 'string' ? label.replace(/[-]+/g, ' ').trim().slice(0, 120) : '';
    if (!name) throw new BadRequestException('label required (max 120 chars)');
    const ttl = Math.min(Math.max(Math.trunc(Number(ttlSeconds ?? 8 * 3600)) || 8 * 3600, MIN_TTL), MAX_TTL);
    const id = `mcp-${randomBytes(6).toString('hex')}`;
    await this.v.createBranch(id, this.v.defaultBranch); // the session branch always starts from main
    const secret = randomBytes(32).toString('base64url');
    const now = new Date(), exp = new Date(now.getTime() + ttl * 1000);
    const m = await this.meta();
    try {
      await m.query('INSERT INTO mcp_sessions (id, tenant, owner_sub, label, branch, seq, secret_hash, created_at, expires_ms) VALUES (?,?,?,?,?,1,?,?,?)',
        [id, tenant, owner.slice(0, 64), name, id, hashSecret(secret), now.toISOString().slice(0, 23), exp.getTime()]);
    } finally { await m.end(); }
    return { secret, session: { id, tenant, owner, label: name, branch: id, seq: 1, createdAt: now.toISOString(), expiresAt: exp.toISOString(), expiresMs: exp.getTime(), revoked: false, submitted: false, calls: 0 } };
  }

  /** Resolves a bearer secret to a live session, or null (unknown, wrong tenant, revoked, expired). */
  async authenticate(tenant: string, secret: string): Promise<McpSession | null> {
    if (typeof secret !== 'string' || secret.length < 20 || secret.length > 200) return null;
    const m = await this.meta();
    try {
      const [r] = await m.query('SELECT * FROM mcp_sessions WHERE secret_hash = ? AND tenant = ?', [hashSecret(secret), tenant]);
      const row = (r as Row[])[0];
      if (!row) return null;
      const s = this.shape(row);
      if (s.revoked || s.expiresMs <= Date.now()) return null;
      return s;
    } finally { await m.end(); }
  }

  async touch(id: string): Promise<void> {
    const m = await this.meta();
    try { await m.query('UPDATE mcp_sessions SET calls = calls + 1 WHERE id = ?', [id]); } finally { await m.end(); }
  }

  async list(tenant: string): Promise<McpSession[]> {
    const m = await this.meta();
    try {
      const [r] = await m.query('SELECT * FROM mcp_sessions WHERE tenant = ? ORDER BY created_at DESC LIMIT 200', [tenant]);
      return (r as Row[]).map((x) => this.shape(x));
    } finally { await m.end(); }
  }

  private async owned(tenant: string, id: string): Promise<McpSession> {
    if (!ID.test(id)) throw new BadRequestException('invalid session id');
    const all = await this.list(tenant);
    const s = all.find((x) => x.id === id);
    if (!s) throw new NotFoundException(`session ${id} not found`);
    return s;
  }

  async revoke(tenant: string, id: string): Promise<McpSession> {
    await this.owned(tenant, id);
    const m = await this.meta();
    try { await m.query('UPDATE mcp_sessions SET revoked = TRUE WHERE id = ?', [id]); } finally { await m.end(); }
    return this.owned(tenant, id);
  }

  /** Rotates the session to a FRESH branch cut from main (never from an arbitrary or caller-chosen branch). */
  async rotateBranch(tenant: string, id: string): Promise<McpSession> {
    const s = await this.owned(tenant, id);
    const branch = `${id}-${s.seq + 1}`;
    await this.v.createBranch(branch, this.v.defaultBranch);
    const m = await this.meta();
    try { await m.query('UPDATE mcp_sessions SET branch = ?, seq = seq + 1, submitted = FALSE WHERE id = ?', [branch, id]); } finally { await m.end(); }
    return this.owned(tenant, id);
  }

  async markSubmitted(tenant: string, id: string): Promise<void> {
    const m = await this.meta();
    try { await m.query('UPDATE mcp_sessions SET submitted = TRUE WHERE id = ?', [id]); } finally { await m.end(); }
  }

  async record(e: Omit<ActivityEntry, 'id' | 'at'>): Promise<void> {
    const m = await this.meta();
    try {
      await m.query('INSERT INTO mcp_activity (tenant, session_id, owner_sub, branch, tool, kind, detail, targets, allow, reasons, row_count, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [e.tenant, e.sessionId, e.owner, e.branch, e.tool.slice(0, 64), e.kind, e.detail.slice(0, 2000), JSON.stringify(e.targets.slice(0, 50)), e.allow, JSON.stringify(e.reasons.slice(0, 20)), e.rowCount, e.error?.slice(0, 500) ?? null]);
    } finally { await m.end(); }
  }

  async activity(tenant: string, sessionId?: string, limit = 200): Promise<ActivityEntry[]> {
    const n = Math.min(Math.max(Math.trunc(limit) || 200, 1), 1000);
    const m = await this.meta();
    try {
      const [r] = sessionId
        ? await m.query('SELECT * FROM mcp_activity WHERE tenant = ? AND session_id = ? ORDER BY id DESC LIMIT ?', [tenant, sessionId, n])
        : await m.query('SELECT * FROM mcp_activity WHERE tenant = ? ORDER BY id DESC LIMIT ?', [tenant, n]);
      return (r as Row[]).map((x) => ({
        id: Number(x.id), at: String(x.at), tenant: String(x.tenant), sessionId: String(x.session_id), owner: String(x.owner_sub), branch: String(x.branch),
        tool: String(x.tool), kind: x.kind as ActivityEntry['kind'], detail: String(x.detail ?? ''), targets: JSON.parse(String(x.targets ?? '[]')) as string[],
        allow: !!x.allow, reasons: JSON.parse(String(x.reasons ?? '[]')) as string[], rowCount: x.row_count === null ? null : Number(x.row_count), error: x.error === null ? null : String(x.error),
      }));
    } finally { await m.end(); }
  }
}
