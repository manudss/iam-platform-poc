/**
 * Step-up rules (pure). A session has the level of the chain it signed in with. An application or an admin area may require a minimum
 * level and, optionally, a maximum age of that sign-in. Levels are declared by an administrator, never added up across steps.
 */
export interface SessionAssurance { level: number; /** epoch ms of the sign-in that produced the level */ authTime: number }
export interface Requirement { minLevel: number; /** ms; absent: no freshness rule */ maxAgeMs?: number }
export type StepUpVerdict = { ok: true } | { ok: false; code: 'step-up-required'; reason: 'level' | 'age'; requiredLevel: number; currentLevel: number };

export function checkAssurance(s: SessionAssurance | undefined, r: Requirement, now: number): StepUpVerdict {
  const cur = s && Number.isFinite(s.level) ? s.level : 0;
  if (r.minLevel <= 0) return { ok: true };
  if (cur < r.minLevel) return { ok: false, code: 'step-up-required', reason: 'level', requiredLevel: r.minLevel, currentLevel: cur };
  if (r.maxAgeMs !== undefined && (!s || now - s.authTime > r.maxAgeMs)) return { ok: false, code: 'step-up-required', reason: 'age', requiredLevel: r.minLevel, currentLevel: cur };
  return { ok: true };
}

export interface ChainOption { id: string; name: string; enabled: boolean; effectiveLevel: number; simulated: boolean; /** the person has set up every method of the chain */ enrolled: boolean }

/** Only chains that reach the level, are enabled, have no simulated step and that this person can really complete. Never a weaker one. */
export function eligibleChains(chains: readonly ChainOption[], minLevel: number): ChainOption[] {
  return chains.filter((c) => c.enabled && !c.simulated && c.enrolled && c.effectiveLevel >= minLevel).sort((a, b) => a.effectiveLevel - b.effectiveLevel);
}

/** A re-authentication must end on the same account, otherwise it is refused (no switching identity by stepping up). */
export function sameAccount(sessionSubject: string, signedInSubject: string): boolean { return !!sessionSubject && sessionSubject === signedInSubject; }

/**
 * Before saving a minimum level for the admin area: how many administrators could still reach it? Zero refuses the change.
 * `admins` maps each active administrator to the chains they can really complete.
 */
export function adminReachability(admins: Readonly<Record<string, readonly ChainOption[]>>, minLevel: number): { ok: boolean; reachable: string[]; unreachable: string[] } {
  const reachable: string[] = [], unreachable: string[] = [];
  for (const [sub, chains] of Object.entries(admins)) (eligibleChains(chains, minLevel).length ? reachable : unreachable).push(sub);
  return { ok: reachable.length > 0, reachable, unreachable };
}
