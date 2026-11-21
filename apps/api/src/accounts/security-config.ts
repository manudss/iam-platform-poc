import { BadRequestException } from '@nestjs/common';
import { LOCKOUT_DEFAULT, type LockoutSettings } from './blocks.js';

/**
 * Account security settings (versioned, per tenant, on the Dolt data branch like the session settings): what the owner CONFIGURES.
 * The state those settings act on (who is blocked, failed-attempt counters) is operational and lives in the block store, so an
 * old branch or a rebase can never undo an unblock, a verification or an automatic lock.
 * Starting values chosen by the owner: lockout after 5 failures in 15 minutes for 15 minutes (on). The demo level for the administration pages is 5, but
 * it is not on in the code: the level is raised through the settings by someone who holds it (see saveSecurity), so a deploy can never lock the administrators out.
 */
export const SECURITY_SETTINGS_ID = 'core-security';
export interface SecurityConfig {
  lockout: LockoutSettings;
  /** Minimum authentication level to open the administration pages. 0 turns the rule off. */
  adminMinLevel: number;
  /** Maximum age (seconds) of the sign-in behind an administration session. 0: no freshness rule. */
  adminMaxAgeSeconds: number;
  /** When true, a person whose e-mail was just verified stays blocked until someone approves them. */
  holdAfterVerification: boolean;
  /** Minimum sign-in level per application (by application id). An application not listed has no level rule. Declared, never measured. */
  appLevels: Record<string, { minLevel: number; maxAgeSeconds?: number }>;
}
export const DEFAULT_SECURITY: SecurityConfig = { lockout: { ...LOCKOUT_DEFAULT }, adminMinLevel: 0, adminMaxAgeSeconds: 0, holdAfterVerification: false, appLevels: {} };

const bad = (m: string): never => { throw new BadRequestException(m); };
const whole = (v: unknown, name: string, lo: number, hi: number) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) bad(`${name}: a whole number from ${lo} to ${hi}`);
  return v as number;
};
const obj = (v: unknown, name: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return bad(`${name}: object required`);
  return v as Record<string, unknown>;
};
const only = (o: Record<string, unknown>, keys: string[], name: string) => { if (Object.keys(o).some((k) => !keys.includes(k))) bad(`${name}: unknown field`); };

export function validateSecurity(input: unknown): SecurityConfig {
  const i = obj(input, 'security configuration');
  only(i, ['lockout', 'adminMinLevel', 'adminMaxAgeSeconds', 'holdAfterVerification', 'appLevels'], 'security configuration');
  const al = i.appLevels === undefined ? {} : obj(i.appLevels, 'appLevels');
  const appLevels: SecurityConfig['appLevels'] = {};
  for (const [id, v] of Object.entries(al)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) bad(`appLevels: bad application id ${id}`);
    const o = obj(v, `appLevels.${id}`); only(o, ['minLevel', 'maxAgeSeconds'], `appLevels.${id}`);
    appLevels[id] = { minLevel: whole(o.minLevel, `appLevels.${id}.minLevel`, 0, 10), ...(o.maxAgeSeconds ? { maxAgeSeconds: whole(o.maxAgeSeconds, `appLevels.${id}.maxAgeSeconds`, 1, 604_800) } : {}) };
  }
  const l = i.lockout === undefined ? {} : obj(i.lockout, 'lockout');
  only(l, ['enabled', 'maxFailures', 'windowSeconds', 'lockSeconds', 'hold', 'exempt'], 'lockout');
  for (const k of ['enabled', 'hold']) if (l[k] !== undefined && typeof l[k] !== 'boolean') bad(`lockout.${k}: true or false`);
  if (i.holdAfterVerification !== undefined && typeof i.holdAfterVerification !== 'boolean') bad('holdAfterVerification: true or false');
  const exempt = l.exempt === undefined ? [] : l.exempt;
  if (!Array.isArray(exempt) || exempt.some((x) => typeof x !== 'string' || !x)) bad('lockout.exempt: a list of account ids');
  const d = DEFAULT_SECURITY.lockout;
  return {
    lockout: {
      enabled: (l.enabled as boolean | undefined) ?? d.enabled,
      maxFailures: whole(l.maxFailures ?? d.maxFailures, 'lockout.maxFailures', 1, 100),
      windowMs: whole(l.windowSeconds ?? d.windowMs / 1000, 'lockout.windowSeconds', 10, 86_400) * 1000,
      lockMs: whole(l.lockSeconds ?? d.lockMs / 1000, 'lockout.lockSeconds', 10, 30 * 86_400) * 1000,
      hold: (l.hold as boolean | undefined) ?? d.hold,
      exempt: exempt as string[],
    },
    adminMinLevel: whole(i.adminMinLevel ?? DEFAULT_SECURITY.adminMinLevel, 'adminMinLevel', 0, 10),
    adminMaxAgeSeconds: whole(i.adminMaxAgeSeconds ?? 0, 'adminMaxAgeSeconds', 0, 604_800),
    holdAfterVerification: (i.holdAfterVerification as boolean | undefined) ?? false,
    appLevels,
  };
}

/** Reads what is stored; anything unusable falls back to the defaults (never throws, so sign-in keeps working). */
export function parseSecurity(v: Record<string, unknown> | undefined): SecurityConfig {
  if (!v || Object.keys(v).length === 0) return structuredClone(DEFAULT_SECURITY);
  try { return validateSecurity(v); } catch { return structuredClone(DEFAULT_SECURITY); }
}

/** The shape saved to the data branch (seconds, no internal milliseconds). */
export function storedSecurity(c: SecurityConfig): Record<string, unknown> {
  return { lockout: { enabled: c.lockout.enabled, maxFailures: c.lockout.maxFailures, windowSeconds: c.lockout.windowMs / 1000, lockSeconds: c.lockout.lockMs / 1000, hold: c.lockout.hold, exempt: [...c.lockout.exempt] },
    adminMinLevel: c.adminMinLevel, adminMaxAgeSeconds: c.adminMaxAgeSeconds, holdAfterVerification: c.holdAfterVerification, appLevels: structuredClone(c.appLevels) };
}

/** The settings a workflow block may change one at a time. The value is text from the workflow editor. */
export const SECURITY_SETTING_KEYS = ['lockout.enabled', 'lockout.maxFailures', 'lockout.windowSeconds', 'lockout.lockSeconds', 'lockout.hold', 'adminMinLevel', 'adminMaxAgeSeconds', 'holdAfterVerification', 'appLevel.<application id>'] as const;
export function patchSecurity(current: Record<string, unknown> | undefined, setting: string, raw: string): Record<string, unknown> {
  const stored = storedSecurity(parseSecurity(current));
  const text = String(raw).trim();
  const asBool = () => { if (text !== 'true' && text !== 'false') bad(`${setting}: true or false`); return text === 'true'; };
  const asInt = () => { if (!/^\d{1,9}$/.test(text)) bad(`${setting}: a whole number`); return Number(text); };
  const lock = stored.lockout as Record<string, unknown>;
  if (setting === 'lockout.enabled' || setting === 'lockout.hold') lock[setting.slice(8)] = asBool();
  else if (['lockout.maxFailures', 'lockout.windowSeconds', 'lockout.lockSeconds'].includes(setting)) lock[setting.slice(8)] = asInt();
  else if (setting === 'adminMinLevel' || setting === 'adminMaxAgeSeconds') stored[setting] = asInt();
  else if (setting === 'holdAfterVerification') stored[setting] = asBool();
  else if (setting.startsWith('appLevel.')) {
    const id = setting.slice(9), level = asInt();
    const levels = stored.appLevels as Record<string, { minLevel: number; maxAgeSeconds?: number }>;
    if (level === 0) delete levels[id]; else levels[id] = { ...(levels[id] ?? {}), minLevel: level };
  } else bad(`unknown setting ${setting}`);
  return storedSecurity(validateSecurity(stored));
}
