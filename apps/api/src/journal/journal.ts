import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Hooks journal: a READ-ONLY memory of what the plugin registry and (later) the application event bus actually did.
 * It records only while the `hooks-journal` plugin is enabled for the tenant, and only from that moment: nothing before is
 * reconstructed. Reading it never calls a hook, emits an event or changes a role. The payload is masked before it is stored.
 */
export type JournalKind = 'plugin-hook' | 'app-event';
export interface JournalEntry {
  id: string;
  at: string;
  tenant: string;
  kind: JournalKind;
  /** Hook name (plugin-hook) or event type (app-event). */
  name: string;
  /** Slot of a blocking call, when there is one. */
  slot?: string;
  mode: 'blocking' | 'async' | 'event';
  branch?: string;
  /** Plugins that could have answered at call time (active, declaring the hook or providing the slot). */
  candidates: string[];
  /** Plugins that actually answered. Empty for an event nobody consumed, or a refused call. */
  answered: string[];
  outcome: 'ok' | 'fell-back' | 'refused' | 'error' | 'no-consumer';
  fellBack?: boolean;
  durationMs?: number;
  /** Error text, masked. */
  detail?: string;
  /** Masked, allow-listed payload keys only. */
  payload: Record<string, string>;
}
export type RawEntry = Omit<JournalEntry, 'id' | 'at' | 'payload' | 'detail'> & { at?: string; payload?: unknown; detail?: string };

const DENY = /token|password|passwd|secret|credential|code|pin|authorization|cookie|key|hash|salt|otp|signature/i;
/** Keys safe to show as they are: identifiers and counters, never credentials. */
const KEEP = new Set(['subject', 'effectKey', 'actor', 'from', 'to', 'organization', 'decision', 'field', 'keys', 'role', 'department', 'plugin', 'hook', 'type']);

export function maskEmail(v: string): string {
  return v.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9])[A-Za-z0-9.-]*(\.[A-Za-z]{2,})/g, '$1***@$2***$3');
}
/** Masks a payload: credential-like keys are dropped, e-mail addresses are masked, long values are cut, only scalars survive. */
export function maskPayload(p: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!p || typeof p !== 'object') return out;
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    if (DENY.test(k) && !KEEP.has(k)) { out[k] = '[masked]'; continue; }
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') { out[k] = Array.isArray(v) && v.every((x) => typeof x === 'string') ? maskEmail(v.join(',')).slice(0, 120) : '[object]'; continue; }
    out[k] = maskEmail(String(v)).slice(0, 120);
  }
  return out;
}
export function maskText(s: string | undefined): string | undefined {
  return s === undefined ? undefined : maskEmail(s).replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[masked]').slice(0, 200);
}

/** Bounded in-memory list with an optional append-only JSON-lines file (IAM_JOURNAL_FILE) that is read back at start. */
export class JournalStore {
  private entries: JournalEntry[] = [];
  private since = new Map<string, string>();
  constructor(private readonly max = 5000, private readonly file = process.env.IAM_JOURNAL_FILE) {
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try { const e = JSON.parse(line) as JournalEntry; this.entries.push(e); if (!this.since.has(e.tenant)) this.since.set(e.tenant, e.at); } catch { /* skip a damaged line */ }
      }
      this.entries = this.entries.slice(-max);
    }
  }
  /** First moment this tenant was recorded: the left edge of what the journal can honestly show. */
  recordingSince(tenant: string) { return this.since.get(tenant); }
  markStart(tenant: string, at = new Date().toISOString()) { if (!this.since.has(tenant)) this.since.set(tenant, at); }
  record(raw: RawEntry): JournalEntry {
    const at = raw.at ?? new Date().toISOString();
    this.markStart(raw.tenant, at);
    const e: JournalEntry = { ...raw, id: randomUUID(), at, payload: maskPayload(raw.payload), detail: maskText(raw.detail) };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    if (this.file) { try { mkdirSync(dirname(this.file), { recursive: true }); appendFileSync(this.file, JSON.stringify(e) + '\n'); } catch { /* the journal never breaks a hook */ } }
    return e;
  }
  query(q: { tenant: string; from?: string; to?: string; kind?: string; name?: string; outcome?: string; limit?: number }) {
    const lim = Math.min(Math.max(q.limit ?? 200, 1), 1000);
    const rows = this.entries.filter((e) => e.tenant === q.tenant
      && (!q.from || e.at >= q.from) && (!q.to || e.at <= q.to)
      && (!q.kind || e.kind === q.kind) && (!q.name || e.name === q.name) && (!q.outcome || e.outcome === q.outcome));
    return { total: rows.length, entries: rows.slice(-lim).reverse() };
  }
  summary(q: { tenant: string; from?: string; to?: string }) {
    const { entries } = this.query({ ...q, limit: 1000 });
    const by = new Map<string, { name: string; kind: string; count: number; refused: number; errors: number; fellBack: number; answeredBy: Record<string, number>; candidates: string[] }>();
    for (const e of entries) {
      const k = `${e.kind}:${e.name}`;
      const s = by.get(k) ?? { name: e.name, kind: e.kind, count: 0, refused: 0, errors: 0, fellBack: 0, answeredBy: {}, candidates: [] };
      s.count++; if (e.outcome === 'refused') s.refused++; if (e.outcome === 'error') s.errors++; if (e.fellBack) s.fellBack++;
      for (const a of e.answered) s.answeredBy[a] = (s.answeredBy[a] ?? 0) + 1;
      s.candidates = [...new Set([...s.candidates, ...e.candidates])];
      by.set(k, s);
    }
    return { tenant: q.tenant, recordingSince: this.recordingSince(q.tenant) ?? null, hooks: [...by.values()].sort((a, b) => b.count - a.count) };
  }
}

/** Process-wide sink. The registry reports to it; nothing reads from it except the journal API. */
export interface HookObservation extends RawEntry { journalActive: boolean; }
export const journalStore = new JournalStore();
export const hookObserver: { current?: (o: HookObservation) => void } = {
  current: (o) => { if (o.journalActive) journalStore.record(o); },
};
/** Never lets the journal break the call it observes. */
export function observe(o: HookObservation) { try { hookObserver.current?.(o); } catch { /* ignore */ } }
