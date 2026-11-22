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

export interface ChainOption {
  id: string; name: string; enabled: boolean; effectiveLevel: number; simulated: boolean; /** the person has set up every method of the chain */ enrolled: boolean;
  /** What the sign-in page shows for the chain, carried so the re-sign-in page renders the same rows, filtered. */
  declaredLevel: number; mfa: boolean; recommended: boolean;
  steps: { name: string; type: string; simulated: boolean }[];
}

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

/** What a person has set up, per method instance (the shape of EnrollmentStore.status). */
export interface EnrollmentView { totp?: boolean; pin?: unknown; email?: string | null; external?: unknown; webauthn?: unknown }
/** Whether this person can really complete one method. Password needs no separate enrollment; e-mail needs a profile address, other factors need their own enrollment. */
export function methodEnrolled(type: string, rec: EnrollmentView | undefined): boolean {
  if (type === 'password') return true;
  if (type === 'email-otp') return typeof rec?.email === 'string' && !!rec.email.trim();
  if (type === 'totp') return !!rec?.totp;
  if (type === 'digit-code') return !!rec?.pin;
  if (type === 'passkey' || type === 'webauthn') return !!rec?.webauthn;
  if (type.startsWith('sso-')) return !!rec?.external;
  return false;
}
/** The chains of a configuration as options for a re-sign-in: effective level, simulated, and whether this person can complete every step. */
export function chainOptions(cfg: { methods: { id: string; type: string; enabled: boolean; name?: string }[]; chains: { id: string; name: string; level?: number; steps: string[]; enabled?: boolean }[]; defaultChain?: string | null }, analysis: Record<string, { effectiveLevel: number; simulatedSteps: string[]; mfa?: boolean }>, status: Record<string, EnrollmentView>): ChainOption[] {
  return cfg.chains.map((c) => {
    const methods = c.steps.map((s) => cfg.methods.find((m) => m.id === s));
    const a = analysis[c.id];
    return {
      id: c.id, name: c.name, enabled: c.enabled !== false && methods.length > 0 && methods.every((m) => !!m?.enabled), effectiveLevel: a?.effectiveLevel ?? 0, simulated: (a?.simulatedSteps.length ?? 0) > 0, enrolled: methods.every((m) => !!m && methodEnrolled(m.type, status[m.id])),
      declaredLevel: c.level ?? a?.effectiveLevel ?? 0, mfa: a?.mfa ?? c.steps.length > 1, recommended: cfg.defaultChain === c.id,
      steps: c.steps.map((s, i) => ({ name: methods[i]?.name ?? s, type: methods[i]?.type ?? '', simulated: a?.simulatedSteps.includes(s) ?? false })),
    };
  });
}

/** The level rule of one application, from the security settings. No entry or level 0: no rule. */
export function appRequirement(appLevels: Readonly<Record<string, { minLevel: number; maxAgeSeconds?: number }>>, appId: string): Requirement | undefined {
  const r = appLevels[appId];
  return r && r.minLevel > 0 ? { minLevel: r.minLevel, ...(r.maxAgeSeconds ? { maxAgeMs: r.maxAgeSeconds * 1000 } : {}) } : undefined;
}
