import { BadRequestException } from '@nestjs/common';

/**
 * Session length settings (docs/session.md). One object per tenant, stored with the other core settings on the Dolt data branch:
 * edited on a working branch, live after Apply, used by the next sign-in. All durations are whole seconds.
 */
export const SESSION_SETTINGS_ID = 'core-session';
export interface SessionConfig {
  /** How long one session token lives. Each renewal gives a fresh token of this length. */
  ttlSeconds: number;
  /** How long before the end the console warns the person and offers to stay signed in. */
  warnSeconds: number;
  /** Absolute limit counted from the sign-in. Renewals never go past it. */
  maxSeconds: number;
  /** When false, a session cannot be renewed: it ends after ttlSeconds. */
  allowExtend: boolean;
}
/** Defaults: a 30 minute token, a warning 2 minutes before the end, and at most 8 hours in a row. */
export const DEFAULT_SESSION: SessionConfig = { ttlSeconds: 1800, warnSeconds: 120, maxSeconds: 28800, allowExtend: true };
export const SESSION_LIMITS = { ttlSeconds: [60, 86_400], warnSeconds: [10, 3_600], maxSeconds: [60, 604_800] } as const;

const bad = (m: string): never => { throw new BadRequestException(m); };
const int = (v: unknown, name: keyof typeof SESSION_LIMITS) => {
  const [lo, hi] = SESSION_LIMITS[name];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) bad(`${name}: a whole number of seconds from ${lo} to ${hi}`);
  return v as number;
};

/** Validates a whole configuration (400 on the first problem). Missing fields take the defaults. */
export function validateSession(input: unknown): SessionConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('session configuration object required');
  const i = input as Record<string, unknown>;
  if (Object.keys(i).some((k) => !['ttlSeconds', 'warnSeconds', 'maxSeconds', 'allowExtend'].includes(k))) bad('unknown session configuration field');
  const ttlSeconds = int(i.ttlSeconds ?? DEFAULT_SESSION.ttlSeconds, 'ttlSeconds');
  const warnSeconds = int(i.warnSeconds ?? DEFAULT_SESSION.warnSeconds, 'warnSeconds');
  const maxSeconds = int(i.maxSeconds ?? Math.max(DEFAULT_SESSION.maxSeconds, ttlSeconds), 'maxSeconds');
  if (i.allowExtend !== undefined && typeof i.allowExtend !== 'boolean') bad('allowExtend must be true or false');
  if (warnSeconds >= ttlSeconds) bad('warnSeconds must be shorter than ttlSeconds');
  if (maxSeconds < ttlSeconds) bad('maxSeconds cannot be shorter than ttlSeconds');
  return { ttlSeconds, warnSeconds, maxSeconds, allowExtend: i.allowExtend !== false };
}

/** Reads what is stored. Never throws: anything unusable falls back to the defaults, so sign-in always works. */
export function parseSession(v: Record<string, unknown> | undefined): SessionConfig {
  if (!v || Object.keys(v).length === 0) return { ...DEFAULT_SESSION };
  try { return validateSession(v); } catch { return { ...DEFAULT_SESSION }; }
}

/** Claims the sign-in answer hands to the core (which bounds them again; IAM_TOKEN_TTL_SECS stays a hard ceiling). Without renewal the absolute limit equals the token length. */
export function sessionClaims(c: SessionConfig): Record<string, number> {
  return { session_ttl: c.ttlSeconds, session_warn: c.warnSeconds, session_max: c.allowExtend ? c.maxSeconds : c.ttlSeconds };
}
