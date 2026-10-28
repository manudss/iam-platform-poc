import { Injectable, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';

export interface Activation {
  tenant: string;
  seq: number; // increasing per tenant
  commit: string; // Dolt commit hash = data version
  state: 'activated';
}

/**
 * Activation journal. A merge changes nothing; only an explicit activation makes a Dolt commit live.
 * Re-activating an older commit (A -> B -> A) is a NEW activation with a new seq.
 *
 * Storage: PostgreSQL when IAM_PG_URL is set (durable, seq allocated under a per-tenant advisory lock),
 * otherwise an in-memory list (lost on restart - dev fallback only).
 * TODO(POC): Dolt tag as reference, NATS event, Rust reload, crash recovery of a half-done activation.
 */
@Injectable()
export class ActivationService implements OnModuleDestroy {
  private mem: Activation[] = [];
  private pool?: pg.Pool;
  private ready?: Promise<void>;

  private get url() { return process.env.IAM_PG_URL; }

  private db(): Promise<pg.Pool> {
    if (!this.pool) this.pool = new pg.Pool({ connectionString: this.url, max: 4 });
    this.ready ??= this.pool.query(
      `CREATE TABLE IF NOT EXISTS activations (
         tenant text NOT NULL, seq integer NOT NULL, commit_hash text NOT NULL,
         activated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant, seq))`).then(() => undefined);
    return this.ready.then(() => this.pool!);
  }

  async activate(tenant: string, commit: string): Promise<Activation> {
    if (!/^[0-9a-v]{8,64}$/.test(commit)) throw new Error('invalid commit hash');
    if (!this.url) {
      const seq = this.mem.filter((a) => a.tenant === tenant).length + 1;
      const a: Activation = { tenant, seq, commit, state: 'activated' };
      this.mem.push(a);
      return a;
    }
    const c = await (await this.db()).connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tenant]);
      const r = await c.query('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM activations WHERE tenant=$1', [tenant]);
      const seq = Number(r.rows[0].seq);
      await c.query('INSERT INTO activations (tenant, seq, commit_hash) VALUES ($1,$2,$3)', [tenant, seq, commit]);
      await c.query('COMMIT');
      return { tenant, seq, commit, state: 'activated' };
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }

  async list(tenant: string): Promise<Activation[]> {
    if (!this.url) return this.mem.filter((a) => a.tenant === tenant);
    const r = await (await this.db()).query('SELECT seq, commit_hash FROM activations WHERE tenant=$1 ORDER BY seq', [tenant]);
    return r.rows.map((x) => ({ tenant, seq: x.seq as number, commit: x.commit_hash as string, state: 'activated' as const }));
  }

  async current(tenant: string): Promise<Activation | undefined> {
    return (await this.list(tenant)).at(-1);
  }

  async onModuleDestroy() { await this.pool?.end(); }
}
