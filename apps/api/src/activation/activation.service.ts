import { Injectable, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { NatsService } from '../integrations/nats.service.js';
import { DoltService } from '../dolt/dolt.service.js';
import { SecretsService } from '../integrations/secrets.service.js';

export interface Activation {
  tenant: string;
  seq: number; // increasing per tenant
  commit: string; // Dolt commit hash = data version
  state: ActivationState;
  error?: string;
  requestId?: string;
}

/** pending: journaled, not yet applied. applied: the Rust core confirmed this version. failed: core apply failed (retry or reconcile). recorded: journal only (core apply not configured). */
export type ActivationState = 'pending' | 'applied' | 'failed' | 'recorded';

/** Result of activate(): the event field says honestly whether the NATS event was acknowledged. */
export type ActivationResult = Activation & { event: 'published' | 'not-published' | 'disabled' };

/**
 * Activation journal. A merge changes nothing; only an explicit activation makes a Dolt commit live.
 * Re-activating an older commit (A -> B -> A) is a NEW activation with a new seq.
 *
 * Storage: PostgreSQL when IAM_PG_URL is set (durable, seq allocated under a per-tenant advisory lock),
 * otherwise an in-memory list (lost on restart - dev fallback only).
 * After the journal commit, a NATS JetStream event iam.activation.<tenant> is published when IAM_NATS_URL is set (not atomic with
 * the journal: no outbox yet). The PostgreSQL URL comes from IAM_PG_URL or, if absent, from OpenBao KV secret/iam/pg field "url".
 * TODO(POC): outbox is PostgreSQL-only and only when core-apply is enabled; otherwise the event is published directly after the journal write.
 */
@Injectable()
export class ActivationService implements OnModuleDestroy {
  private mem: Activation[] = [];
  private pool?: pg.Pool;
  private ready?: Promise<void>;

  private resolved?: Promise<string | undefined>;

  constructor(private readonly secrets: SecretsService = new SecretsService(), private readonly nats: NatsService = new NatsService(),
    private readonly dolt: DoltService = new DoltService()) {}

  /** Core apply is on only when IAM_CORE_URL and IAM_CORE_ADMIN_TOKEN are both set. */
  get applyEnabled() { return !!process.env.IAM_CORE_URL && !!process.env.IAM_CORE_ADMIN_TOKEN; }

  private resolveUrl(): Promise<string | undefined> {
    this.resolved ??= process.env.IAM_PG_URL ? Promise.resolve(process.env.IAM_PG_URL) : this.secrets.get('iam/pg').then((s) => s?.url);
    return this.resolved;
  }

  private async db(): Promise<pg.Pool> {
    if (!this.pool) this.pool = new pg.Pool({ connectionString: await this.resolveUrl(), max: 4 });
    this.ready ??= this.pool.query(
      `CREATE TABLE IF NOT EXISTS activations (
         tenant text NOT NULL, seq integer NOT NULL, commit_hash text NOT NULL,
         activated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant, seq));
       ALTER TABLE activations ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'recorded';
       ALTER TABLE activations ADD COLUMN IF NOT EXISTS error text;
       ALTER TABLE activations ADD COLUMN IF NOT EXISTS request_id text;
       CREATE TABLE IF NOT EXISTS outbox (id bigserial PRIMARY KEY, tenant text NOT NULL, seq integer NOT NULL, payload jsonb NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, UNIQUE (tenant, seq));
       CREATE UNIQUE INDEX IF NOT EXISTS activations_request ON activations (tenant, request_id) WHERE request_id IS NOT NULL`).then(() => undefined);
    return this.ready.then(() => this.pool!);
  }

  /**
   * Activation protocol: (1) journal a pending row, (2) export the Dolt data AS OF the commit and POST it to the core,
   * (3) mark applied or failed, (4) tag the commit act-<tenant>-<seq> in Dolt, (5) publish the NATS event only when applied.
   * Idempotence is per REQUEST id (client-supplied, stable across retries), never per commit hash: a request id seen before
   * returns/retries the same activation (same seq, no new effect); without it every call is a new activation (A -> B -> A = 3 seqs).
   */
  async activate(tenant: string, commit: string, requestId?: string): Promise<ActivationResult> {
    if (!/^[0-9a-v]{8,64}$/.test(commit)) throw new Error('invalid commit hash');
    if (requestId !== undefined && !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) throw new Error('invalid request id');
    let a: Activation;
    const prior = requestId ? (await this.list(tenant)).find((x) => x.requestId === requestId) : undefined;
    if (prior) {
      if (prior.commit !== commit) throw new Error('request id already used for another commit');
      if (prior.state === 'applied') return { ...prior, event: 'disabled' }; // same request, already done: no new effect
      a = prior; // same request, pending/failed/recorded: retry the SAME activation
    } else {
      // No request id (or a new one) = a new explicit activation with a new seq, even for a commit activated before (A -> B -> A).
      try { a = await this.record(tenant, commit, requestId); } catch (e) {
        // Two concurrent calls with the same request id: the unique index lets one win; the other returns the winner.
        const winner = requestId && (e as { code?: string }).code === '23505' ? (await this.list(tenant)).find((x) => x.requestId === requestId) : undefined;
        if (!winner) throw e;
        a = winner;
      }
    }
    if (this.applyEnabled) a = await this.apply(a);
    if (a.state === 'failed') return { ...a, event: 'disabled' };
    const outbox = this.applyEnabled && !!(await this.resolveUrl());
    if (outbox) { // events leave through the PostgreSQL outbox, written in the same transaction as the 'applied' state
      await this.relay();
      const sent = (await (await this.db()).query('SELECT sent_at FROM outbox WHERE tenant=$1 AND seq=$2', [a.tenant, a.seq])).rows[0]?.sent_at;
      return { ...a, event: sent ? 'published' : this.nats.enabled ? 'not-published' : 'disabled' };
    }
    const ev = this.nats.enabled ? ((await this.nats.publish(`iam.activation.${a.tenant}`, a)) ? 'published' : 'not-published') : 'disabled';
    return { ...a, event: ev };
  }

  /**
   * Outbox relay: publishes unsent events in order and marks them sent only after the NATS ack (at-least-once:
   * a crash between ack and mark re-publishes; consumers must dedupe on tenant+seq). Safe to call repeatedly.
   * Returns the number of events published. Does nothing when NATS is disabled or unreachable (rows stay unsent).
   */
  async relay(): Promise<number> {
    if (!this.nats.enabled || !(await this.resolveUrl())) return 0;
    const c = await (await this.db()).connect();
    let n = 0;
    try {
      await c.query('BEGIN');
      const rows = (await c.query('SELECT id, tenant, seq, payload FROM outbox WHERE sent_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100')).rows;
      for (const r of rows) {
        if (!(await this.nats.publish(`iam.activation.${r.tenant}`, r.payload))) break; // keep order: stop at the first failure
        await c.query('UPDATE outbox SET sent_at = now() WHERE id=$1', [r.id]); n++;
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    return n;
  }

  private async apply(a: Activation): Promise<Activation> {
    try {
      const snapshot = await this.dolt.snapshotAt(a.commit);
      const res = await fetch(`${process.env.IAM_CORE_URL}/v1/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-core-admin-token': process.env.IAM_CORE_ADMIN_TOKEN! },
        body: JSON.stringify({ tenant: a.tenant, seq: a.seq, commit: a.commit, snapshot }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`core refused activation: HTTP ${res.status} ${await res.text()}`);
      await this.markApplied(a);
      await this.dolt.tagActivation(a.tenant, a.seq, a.commit).catch(() => undefined); // reference only; core already applied
      return { ...a, state: 'applied', error: undefined };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      await this.setState(a, 'failed', msg);
      return { ...a, state: 'failed', error: msg };
    }
  }

  private async markApplied(a: Activation) {
    if (!(await this.resolveUrl())) return this.setState(a, 'applied');
    const c = await (await this.db()).connect();
    try {
      await c.query('BEGIN');
      await c.query("UPDATE activations SET state='applied', error=NULL WHERE tenant=$1 AND seq=$2", [a.tenant, a.seq]);
      await c.query('INSERT INTO outbox (tenant, seq, payload) VALUES ($1,$2,$3) ON CONFLICT (tenant, seq) DO NOTHING',
        [a.tenant, a.seq, JSON.stringify({ tenant: a.tenant, seq: a.seq, commit: a.commit, state: 'applied' })]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }

  private async setState(a: Activation, state: ActivationState, error?: string) {
    if (!(await this.resolveUrl())) {
      const m = this.mem.find((x) => x.tenant === a.tenant && x.seq === a.seq);
      if (m) { m.state = state; m.error = error; }
      return;
    }
    await (await this.db()).query('UPDATE activations SET state=$3, error=$4 WHERE tenant=$1 AND seq=$2', [a.tenant, a.seq, state, error ?? null]);
  }

  /**
   * Reconcile: asks the core which version it runs and re-applies the latest activation when the core differs
   * (core restarted, previous apply failed). Returns what was found and done.
   */
  async reconcile(tenant: string): Promise<{ action: 'none' | 'reapplied' | 'failed' | 'no-activation' | 'disabled'; core?: { seq: number; commit: string } | null; activation?: Activation }> {
    if (!this.applyEnabled) return { action: 'disabled' };
    const latest = await this.current(tenant);
    if (!latest) return { action: 'no-activation' };
    let core: { seq: number; commit: string } | null = null;
    try {
      const r = await fetch(`${process.env.IAM_CORE_URL}/v1/version?tenant=${encodeURIComponent(tenant)}`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) core = (await r.json()) as { seq: number; commit: string };
    } catch { /* core unreachable: treated as not running the version */ }
    if (core && core.seq === latest.seq && core.commit === latest.commit && latest.state === 'applied') return { action: 'none', core, activation: latest };
    const a = await this.apply(latest);
    await this.relay().catch(() => undefined);
    return { action: a.state === 'applied' ? 'reapplied' : 'failed', core, activation: a };
  }

  private async record(tenant: string, commit: string, requestId?: string): Promise<Activation> {
    const state: ActivationState = this.applyEnabled ? 'pending' : 'recorded';
    if (!(await this.resolveUrl())) {
      const seq = this.mem.filter((a) => a.tenant === tenant).length + 1;
      const a: Activation = { tenant, seq, commit, state, requestId };
      this.mem.push(a);
      return { ...a };
    }
    const c = await (await this.db()).connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tenant]);
      const r = await c.query('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM activations WHERE tenant=$1', [tenant]);
      const seq = Number(r.rows[0].seq);
      await c.query('INSERT INTO activations (tenant, seq, commit_hash, state, request_id) VALUES ($1,$2,$3,$4,$5)', [tenant, seq, commit, state, requestId ?? null]);
      await c.query('COMMIT');
      return { tenant, seq, commit, state, requestId };
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }

  async list(tenant: string): Promise<Activation[]> {
    if (!(await this.resolveUrl())) return this.mem.filter((a) => a.tenant === tenant).map((a) => ({ ...a }));
    const r = await (await this.db()).query('SELECT seq, commit_hash, state, error, request_id FROM activations WHERE tenant=$1 ORDER BY seq', [tenant]);
    return r.rows.map((x) => ({ tenant, seq: x.seq as number, commit: x.commit_hash as string, state: x.state as ActivationState, error: (x.error as string | null) ?? undefined, requestId: (x.request_id as string | null) ?? undefined }));
  }

  async current(tenant: string): Promise<Activation | undefined> {
    return (await this.list(tenant)).at(-1);
  }

  async onModuleDestroy() { await this.pool?.end(); }
}
