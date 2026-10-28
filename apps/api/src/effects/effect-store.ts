import pg from 'pg';

export type EffectState = 'done' | 'failed';
export interface EffectRow { effectKey: string; kind: string; tenant: string; seq: number; state: EffectState; attempts: number; lastError?: string }

/**
 * Ledger of side effects (notifications, provisioning), one row per effect key = tenant:seq:kind:subject:role:change.
 * PostgreSQL table `effects` when `pg` is given, memory otherwise. A 'done' key is never executed again; a 'failed' key is retried.
 */
export class EffectStore {
  private mem = new Map<string, EffectRow>();
  private ready?: Promise<unknown>;
  constructor(private readonly pool?: pg.Pool) {}
  private init() {
    return (this.ready ??= this.pool!.query('CREATE TABLE IF NOT EXISTS effects (effect_key text PRIMARY KEY, kind text NOT NULL, tenant text NOT NULL, seq integer NOT NULL, state text NOT NULL, attempts integer NOT NULL DEFAULT 0, last_error text, updated_at timestamptz NOT NULL DEFAULT now())'));
  }
  async get(key: string): Promise<EffectRow | undefined> {
    if (!this.pool) return this.mem.get(key);
    await this.init();
    const r = (await this.pool.query('SELECT effect_key, kind, tenant, seq, state, attempts, last_error FROM effects WHERE effect_key=$1', [key])).rows[0];
    return r && { effectKey: r.effect_key, kind: r.kind, tenant: r.tenant, seq: r.seq, state: r.state, attempts: r.attempts, lastError: r.last_error ?? undefined };
  }
  async mark(row: Omit<EffectRow, 'attempts'>): Promise<void> {
    if (!this.pool) { const p = this.mem.get(row.effectKey); this.mem.set(row.effectKey, { ...row, attempts: (p?.attempts ?? 0) + 1 }); return; }
    await this.init();
    await this.pool.query(`INSERT INTO effects (effect_key, kind, tenant, seq, state, attempts, last_error) VALUES ($1,$2,$3,$4,$5,1,$6)
      ON CONFLICT (effect_key) DO UPDATE SET state=$5, attempts=effects.attempts+1, last_error=$6, updated_at=now()`, [row.effectKey, row.kind, row.tenant, row.seq, row.state, row.lastError ?? null]);
  }
  async list(tenant: string): Promise<EffectRow[]> {
    if (!this.pool) return [...this.mem.values()].filter((r) => r.tenant === tenant);
    await this.init();
    return (await this.pool.query('SELECT effect_key, kind, tenant, seq, state, attempts, last_error FROM effects WHERE tenant=$1 ORDER BY effect_key', [tenant]))
      .rows.map((r) => ({ effectKey: r.effect_key, kind: r.kind, tenant: r.tenant, seq: r.seq, state: r.state, attempts: r.attempts, lastError: r.last_error ?? undefined }));
  }
}
