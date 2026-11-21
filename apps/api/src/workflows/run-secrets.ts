import { randomBytes, randomInt } from 'node:crypto';

/** What a stored secret may be used for. Anything else is refused. */
export type SecretUse = 'set-temporary' | 'mail';

const SETS = ['abcdefghjkmnpqrstuvwxyz', 'ABCDEFGHJKMNPQRSTUVWXYZ', '23456789', '!#%+-=?@_'];

/** A random temporary password: 20 characters, at least one of each class, from the system random source. Never logged. */
export function randomPassword(len = 20): string {
  const all = SETS.join('');
  const out = SETS.map((s) => s[randomInt(s.length)]);
  while (out.length < len) out.push(all[randomInt(all.length)]);
  for (let i = out.length - 1; i > 0; i--) { const j = randomInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join('');
}

/**
 * Run-scoped secrets held in memory only (never written to the data store, a step, a log or an audit). A secret is created from a block and only travels as an opaque reference,
 * which only the allowed consumers of THE SAME run can resolve. A restart of the server loses them: the next use then fails closed and the run is started again from the generation step.
 */
export class RunSecrets {
  private readonly m = new Map<string, { runId: string; value: string; expires: number; uses: ReadonlySet<SecretUse> }>();
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = 2 * 3_600_000) {}
  create(runId: string, uses: readonly SecretUse[], value = randomPassword()): string {
    this.sweep();
    const ref = `secret:${randomBytes(12).toString('hex')}`;
    this.m.set(ref, { runId, value, expires: this.now() + this.ttlMs, uses: new Set(uses) });
    return ref;
  }
  /** The value, only for a consumer the secret allows and only inside the run that created it. Unknown, expired, other run, wrong consumer: refusal with no detail. */
  reveal(runId: string, ref: string, use: SecretUse): string {
    const s = this.m.get(String(ref));
    if (!s || s.runId !== runId || s.expires <= this.now() || !s.uses.has(use)) throw new Error('secret reference unavailable');
    return s.value;
  }
  drop(runId: string, ref: string) { const s = this.m.get(ref); if (s && s.runId === runId) this.m.delete(ref); }
  /** Every live value of the run: only for redaction of logs and outputs. */
  valuesOf(runId: string): string[] { return [...this.m.values()].filter((s) => s.runId === runId && s.expires > this.now()).map((s) => s.value); }
  private sweep() { const t = this.now(); for (const [k, s] of this.m) if (s.expires <= t) this.m.delete(k); }
}
