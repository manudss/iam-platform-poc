import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import pg from 'pg';
import { BusHostRef } from '../plugins/v1/bus-host.js';

export interface AuditEntry {
  id?: number; at?: string; tenant: string; subject: string; principal: string; action: string; resource: string;
  allow: boolean; reasons: string[]; activation_seq: number | null; commit: string | null; source: 'http' | 'grpc' | 'agent' | 'simulate' | 'core' | 'plugin'; note?: string;
}

/**
 * Persistent decision audit: one row per allow/deny answered through the API (reasons, tenant, activation seq/commit, caller).
 * PostgreSQL table `decision_audit` when IAM_PG_URL is set, in-memory fallback otherwise (lost on restart: NOT durable).
 * Context values are NOT stored (they may carry personal data); only the decision inputs that identify the request.
 * Scope: decisions that go through this API. Decisions sent straight to the core are not audited.
 */
@Injectable()
export class AuditService implements OnModuleDestroy, OnModuleInit {
  private mem: AuditEntry[] = [];
  private pool?: pg.Pool;
  private ready?: Promise<void>;
  private consuming?: Promise<void>;
  private consumerTimer?: NodeJS.Timeout;
  constructor(@Optional() private readonly busRef?: BusHostRef) {}
  private get url() { return process.env.IAM_PG_URL; }

  /** The consumer must exist BEFORE the first decision: the core routes access.decided only to subscriptions
   * registered at emit time, so a lazy registration would lose every early decision. The host connects
   * asynchronously in the plugins-v1 factory: poll for it (gives up when there is no bus). */
  onModuleInit() {
    let tries = 0;
    this.consumerTimer = setInterval(() => {
      if (++tries > 600 || !this.busRef?.host) { if (tries > 600) clearInterval(this.consumerTimer); return; }
      this.ensureConsumer()?.then(() => clearInterval(this.consumerTimer)).catch(() => undefined);
    }, 200);
    this.consumerTimer.unref?.();
  }

  /**
   * Step 3: with the bus up, the trail is fed by the bus instead of the call sites. The core emits access.decided
   * for every decision (durable, at-least-once); the caller context (source/note/subject) rides as audit meta in
   * the /v1/decide body. Registry audit events arrive as audit.event (source 'plugin'). Served lazily on first
   * use: the host connects after this service is constructed. */
  /** Public so tests (and bootstrap) can await the registration deterministically. */
  async ensureBusConsumer(): Promise<void> { await this.ensureConsumer(); }

  private ensureConsumer(): Promise<void> | undefined {
    const host = this.busRef?.host;
    if (!host || this.consuming) return this.consuming;
    return (this.consuming = host.serveService('decision-audit', ['access.decided', 'audit.event'], async (env) => {
      const p = (env.payload ?? {}) as Record<string, unknown>;
      if (env.kind === 'access.decided') {
        await this.record({
          tenant: String(env.tenant ?? p.tenant ?? '-'), subject: String(p.subject ?? 'core'),
          principal: String(p.principal ?? '-'), action: String(p.action ?? '-'), resource: String(p.resource ?? '-'),
          allow: p.allow === true, reasons: Array.isArray(p.reasons) ? p.reasons.map(String) : [],
          activation_seq: typeof p.seq === 'number' ? p.seq : null, commit: typeof p.commit === 'string' ? p.commit : null,
          source: ['http', 'grpc', 'agent', 'simulate'].includes(String(p.source)) ? (p.source as AuditEntry['source']) : 'core',
          note: typeof p.note === 'string' ? p.note : undefined,
        });
      } else if (env.kind === 'audit.event') {
        await this.record({
          tenant: String(env.tenant ?? p.tenant ?? '-'), subject: String(p.plugin ?? '-'),
          principal: 'plugin', action: String(p.action ?? '-'), resource: `Plugin::"${String(p.plugin ?? '-')}"`,
          allow: true, reasons: [], activation_seq: null, commit: null,
          source: 'plugin', note: typeof p.detail === 'string' ? p.detail : undefined,
        });
      }
    }).catch((e) => { this.consuming = undefined; throw e; }));
  }

  /**
   * Decision record with bus-first semantics: when the bus is up and the core actually answered, the core's
   * access.decided already covers the row - writing locally too would double it. Local record stays for
   * no-bus mode, and for the failure paths the core never saw (answered=false: unreachable, HTTP error).
   */
  async recordDecision(e: AuditEntry, answered = true): Promise<void> {
    if (!answered || !this.busRef?.host) return this.record(e);
    await this.ensureConsumer();
  }

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

  async onModuleDestroy() { clearInterval(this.consumerTimer); await this.pool?.end().catch(() => undefined); }
}
