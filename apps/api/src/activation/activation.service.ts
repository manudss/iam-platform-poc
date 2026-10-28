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
 * TODO(POC): transactional outbox for the NATS event (still not atomic with the journal).
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
       ALTER TABLE activations ADD COLUMN IF NOT EXISTS error text`).then(() => undefined);
    return this.ready.then(() => this.pool!);
  }

  /**
   * Activation protocol: (1) journal a pending row, (2) export the Dolt data AS OF the commit and POST it to the core,
   * (3) mark applied or failed, (4) tag the commit act-<tenant>-<seq> in Dolt, (5) publish the NATS event only when applied.
   * Idempotent: activating the commit that is already the latest, applied activation returns it unchanged; if the latest
   * one for the same commit is pending/failed it is RETRIED (same seq) instead of creating a new one.
   */
  async activate(tenant: string, commit: string): Promise<ActivationResult> {
    if (!/^[0-9a-v]{8,64}$/.test(commit)) throw new Error('invalid commit hash');
    const last = await this.current(tenant);
    let a: Activation;
    if (last && last.commit === commit && last.state !== 'recorded') {
      if (last.state === 'applied') return { ...last, event: 'disabled' };
      a = last; // retry the same activation
    } else {
      a = await this.record(tenant, commit);
    }
    if (this.applyEnabled) a = await this.apply(a);
    const ev = a.state !== 'failed' && this.nats.enabled ? ((await this.nats.publish(`iam.activation.${tenant}`, a)) ? 'published' : 'not-published') : 'disabled';
    return { ...a, event: ev };
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
      await this.setState(a, 'applied');
      await this.dolt.tagActivation(a.tenant, a.seq, a.commit).catch(() => undefined); // reference only; core already applied
      return { ...a, state: 'applied', error: undefined };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      await this.setState(a, 'failed', msg);
      return { ...a, state: 'failed', error: msg };
    }
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
    return { action: a.state === 'applied' ? 'reapplied' : 'failed', core, activation: a };
  }

  private async record(tenant: string, commit: string): Promise<Activation> {
    const state: ActivationState = this.applyEnabled ? 'pending' : 'recorded';
    if (!(await this.resolveUrl())) {
      const seq = this.mem.filter((a) => a.tenant === tenant).length + 1;
      const a: Activation = { tenant, seq, commit, state };
      this.mem.push(a);
      return { ...a };
    }
    const c = await (await this.db()).connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tenant]);
      const r = await c.query('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM activations WHERE tenant=$1', [tenant]);
      const seq = Number(r.rows[0].seq);
      await c.query('INSERT INTO activations (tenant, seq, commit_hash, state) VALUES ($1,$2,$3,$4)', [tenant, seq, commit, state]);
      await c.query('COMMIT');
      return { tenant, seq, commit, state };
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }

  async list(tenant: string): Promise<Activation[]> {
    if (!(await this.resolveUrl())) return this.mem.filter((a) => a.tenant === tenant).map((a) => ({ ...a }));
    const r = await (await this.db()).query('SELECT seq, commit_hash, state, error FROM activations WHERE tenant=$1 ORDER BY seq', [tenant]);
    return r.rows.map((x) => ({ tenant, seq: x.seq as number, commit: x.commit_hash as string, state: x.state as ActivationState, error: (x.error as string | null) ?? undefined }));
  }

  async current(tenant: string): Promise<Activation | undefined> {
    return (await this.list(tenant)).at(-1);
  }

  async onModuleDestroy() { await this.pool?.end(); }
}
