import type { AuthnConfig, Chain, MethodInstance } from './auth-methods';

/**
 * Pure model of the "Authentication methods" page. The stored configuration keeps its shape (method instances + chains).
 * The page shows ONE list of entries: a chain is a method too, and a method used alone is a chain with a single step.
 * "In use" = an enabled chain whose methods are all served by an active plugin. Everything else is "not in use"
 * (still usable as a step of another chain). There is no per-method disabled state: a method becomes unavailable when its plugin is disabled.
 */
export interface Availability { methods: Record<string, { available: boolean; plugin?: string }>; chains: Record<string, { available: boolean; missing: string[] }> }
export interface Entry {
  /** Stable key: `m:<methodId>` for a method entry, `c:<chainId>` for a chain entry. */
  key: string; kind: 'method' | 'chain'; methodId?: string; chainId?: string;
  name: string; level: number; stepIds: string[]; inUse: boolean; available: boolean; missing: string[];
}
export interface Dropped { name: string; reason: string }

export const slugId = (s: string, taken: string[]) => { const b = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34) || 'item'; let id = b, i = 2; while (taken.includes(id)) id = `${b}-${i++}`; return id; };
const solo = (cfg: AuthnConfig, methodId: string) => cfg.chains.find((c) => c.steps.length === 1 && c.steps[0] === methodId);
const methodOf = (cfg: AuthnConfig, id: string) => cfg.methods.find((m) => m.id === id);
const methodAvail = (a: Availability | null, id: string) => a ? (a.methods[id]?.available ?? false) : true;

/** All entries. In-use entries come first in sign-in order; the rest keep configuration order. */
export function entries(cfg: AuthnConfig, avail: Availability | null): Entry[] {
  const out: Entry[] = [], soloChains = new Set<string>();
  for (const c of cfg.chains) {
    const missing = c.steps.filter((id) => !methodAvail(avail, id));
    const isSolo = c.steps.length === 1 && solo(cfg, c.steps[0]) === c && !!methodOf(cfg, c.steps[0]);
    if (isSolo) soloChains.add(c.steps[0]);
    out.push({ key: isSolo ? `m:${c.steps[0]}` : `c:${c.id}`, kind: isSolo ? 'method' : 'chain', methodId: isSolo ? c.steps[0] : undefined, chainId: c.id,
      name: c.name, level: c.level, stepIds: c.steps, inUse: c.enabled && !missing.length, available: !missing.length, missing });
  }
  for (const m of cfg.methods) if (!soloChains.has(m.id)) {
    const ok = methodAvail(avail, m.id);
    out.push({ key: `m:${m.id}`, kind: 'method', methodId: m.id, name: m.name, level: m.level, stepIds: [m.id], inUse: false, available: ok, missing: ok ? [] : [m.id] });
  }
  return [...out.filter((e) => e.inUse), ...out.filter((e) => !e.inUse)];
}
export const inUse = (cfg: AuthnConfig, avail: Availability | null) => entries(cfg, avail).filter((e) => e.inUse);
export const notInUse = (cfg: AuthnConfig, avail: Availability | null) => entries(cfg, avail).filter((e) => !e.inUse);

/** Position among the enabled chains (sign-in order) -> index in cfg.chains where to insert/move. */
function place(cfg: AuthnConfig, chain: Chain, position: number) {
  cfg.chains = cfg.chains.filter((c) => c !== chain);
  const enabled = cfg.chains.filter((c) => c.enabled && c !== chain);
  const p = Math.max(0, Math.min(position, enabled.length));
  const before = enabled[p];
  const idx = before ? cfg.chains.indexOf(before) : (enabled.length ? cfg.chains.indexOf(enabled[enabled.length - 1]) + 1 : 0);
  cfg.chains.splice(idx, 0, chain);
}

/** Puts an entry in the sign-in list at `position` (default: the end). A method that is not a chain yet gets its single-step chain. Returns the chain id, or null when the entry cannot be used. */
export function useEntry(cfg: AuthnConfig, e: Entry, avail: Availability | null, position = Number.MAX_SAFE_INTEGER): string | null {
  if (!e.available) return null;
  let chain = e.chainId ? cfg.chains.find((c) => c.id === e.chainId) : undefined;
  if (!chain && e.methodId) {
    const m = methodOf(cfg, e.methodId); if (!m) return null;
    chain = { id: slugId(m.id, cfg.chains.map((c) => c.id)), name: m.name, enabled: true, steps: [m.id], level: m.level };
    cfg.chains.push(chain);
  }
  if (!chain) return null;
  for (const id of chain.steps) { const m = methodOf(cfg, id); if (m) m.enabled = true; }
  chain.enabled = true; place(cfg, chain, position); return chain.id;
}
/** Takes an entry out of the sign-in list (kept as "not in use", still usable inside chains). */
export function removeFromList(cfg: AuthnConfig, e: Entry) {
  const c = e.chainId ? cfg.chains.find((x) => x.id === e.chainId) : undefined;
  if (c) { c.enabled = false; if (cfg.defaultChain === c.id) cfg.defaultChain = null; }
}
/** Moves an in-use entry to `position` in the list. */
export function moveInUse(cfg: AuthnConfig, e: Entry, position: number) {
  const c = e.chainId ? cfg.chains.find((x) => x.id === e.chainId) : undefined;
  if (c && c.enabled) place(cfg, c, position);
}
/** A plugin was disabled: every enabled chain that needs it leaves the list. Returns what was removed, for the error message. */
export function reconcile(cfg: AuthnConfig, avail: Availability | null): Dropped[] {
  const dropped: Dropped[] = [];
  if (!avail) return dropped;
  for (const c of cfg.chains) {
    if (!c.enabled) continue;
    const missing = c.steps.filter((id) => !methodAvail(avail, id));
    if (!missing.length) continue;
    c.enabled = false; if (cfg.defaultChain === c.id) cfg.defaultChain = null;
    dropped.push({ name: c.name, reason: `needs ${missing.map((id) => methodOf(cfg, id)?.name ?? id).join(', ')}, whose plugin is not active` });
  }
  return dropped;
}
/** Keeps the single-step chain of a method in line with the method (name, and a level never below the method's). */
export function syncSolo(cfg: AuthnConfig, methodId: string) {
  const m = methodOf(cfg, methodId), c = solo(cfg, methodId); if (!m || !c) return;
  c.name = m.name; c.level = m.level;
}
/** A chain cannot be declared weaker than its strongest step. */
export function minChainLevel(cfg: AuthnConfig, steps: string[]) { return Math.max(1, ...steps.map((s) => methodOf(cfg, s)?.level ?? 1)); }

/** Creates a method instance of a catalogue type with its defaults. Single-instance types can only be created once. */
export function addInstance(cfg: AuthnConfig, type: { id: string; name: string; suggestedLevel: number; instances?: 'single' | 'multiple'; settings: { key: string; default?: unknown }[] }, name: string, level: number, config: Record<string, unknown>): MethodInstance | null {
  if (type.instances === 'single' && cfg.methods.some((m) => m.type === type.id)) return null;
  const nm = name.trim() || type.name;
  const defaults = Object.fromEntries(type.settings.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]));
  const m: MethodInstance = { id: slugId(nm, cfg.methods.map((x) => x.id)), type: type.id, name: nm, enabled: true, level, config: { ...defaults, ...config } };
  cfg.methods.push(m); return m;
}
/** Deletes a method instance and its single-step chain; refused (false) when a longer chain still uses it. */
export function deleteMethod(cfg: AuthnConfig, id: string): boolean {
  if (cfg.chains.some((c) => c.steps.length > 1 && c.steps.includes(id))) return false;
  cfg.chains = cfg.chains.filter((c) => !(c.steps.length === 1 && c.steps[0] === id)); cfg.methods = cfg.methods.filter((m) => m.id !== id);
  if (cfg.defaultChain && !cfg.chains.some((c) => c.id === cfg.defaultChain)) cfg.defaultChain = null; return true;
}
export function deleteChain(cfg: AuthnConfig, id: string) { cfg.chains = cfg.chains.filter((c) => c.id !== id); if (cfg.defaultChain === id) cfg.defaultChain = null; }
/** Single-instance types that already have an instance, and instance counts per type, for the "New instance" chooser. */
export function instanceCount(cfg: AuthnConfig, type: string) { return cfg.methods.filter((m) => m.type === type).length; }
