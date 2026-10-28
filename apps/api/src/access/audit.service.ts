import { Injectable, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';

export interface AuditEntry {
  id?: number; at?: string; tenant: string; subject: string; principal: string; action: string; resource: string;
  allow: boolean; reasons: string[]; activation_seq: number | null; commit: string | null; source: 'http' | 'grpc' | 'agent'; note?: string;
}

/**
 * Persistent decision audit: one row per allow/deny answered through the API (reasons, tenant, activation seq/commit, caller).
 * PostgreSQL table `decision_audit` when IAM_PG_URL is set, in-memory fallback otherwise (lost on restart: NOT durable).
 * Context values are NOT stored (they may carry personal data); only the decision inputs that identify the request.
 * Scope: decisions that go through this API. Decisions sent straight to the core are not audited.
 */
@Injectable()
export class AuditService implements OnModuleDestroy {
  private mem: AuditEntry[] = [];
  private pool?: pg.Pool;
  private ready?: Promise<void>;
  private get url() { return process.env.IAM_PG_URL; }

  private init(): Promise<void> {
    this.pool ??= new pg.Pool({ connectionString: this.url, max: 2 });
    return (this.ready ??= this.pool.query(`CREATE TABLE IF NOT EXISTS decision_audit (
      id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), tenant text NOT NULL, subject text NOT NULL, principal text NOT NULL,
      action text NOT NULL, resource text NOT NULL, allow boolean NOT NULL, reasons jsonb NOT NULL, activation_seq integer, commit text,
      source text NOT NULL, note text);
      CREATE INDEX IF NOT EXISTS decision_audit_tenant ON decision_audit (tenant, id)`).then(() => undefined));
  }

  async record(e: AuditEntry): Promise<void> {
    if (!this.url) { this.mem.push({ ...e, id: this.mem.length + 1, at: new Date().toISOString() }); return; }
    await this.init();
    await this.pool!.query('INSERT INTO decision_audit (tenant, subject, principal, action, resource, allow, reasons, activation_seq, commit, source, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [e.tenant, e.subject, e.principal, e.action, e.resource, e.allow, JSON.stringify(e.reasons), e.activation_seq, e.commit, e.source, e.note ?? null]);
  }

  /** Newest first, only the given tenant, limit clamped to 1..500. */
  async list(tenant: string, limit = 100): Promise<AuditEntry[]> {
    const n = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
    if (!this.url) return this.mem.filter((x) => x.tenant === tenant).slice(-n).reverse();
    await this.init();
    const r = await this.pool!.query('SELECT id, at, tenant, subject, principal, action, resource, allow, reasons, activation_seq, commit, source, note FROM decision_audit WHERE tenant=$1 ORDER BY id DESC LIMIT $2', [tenant, n]);
    return r.rows.map((x) => ({ ...x, id: Number(x.id), at: new Date(x.at).toISOString() }));
  }

  async onModuleDestroy() { await this.pool?.end().catch(() => undefined); }
}
