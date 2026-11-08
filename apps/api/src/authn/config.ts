import { BadRequestException } from '@nestjs/common';
import { validateSettings } from '../plugins/v1/settings.js';
import { methodType } from './methods.js';

export interface MethodInstance { id: string; type: string; name: string; enabled: boolean; /** 1..10, 10 = strongest. Configured by an administrator; not measured. */ level: number; config: Record<string, unknown> }
export interface Chain { id: string; name: string; enabled: boolean; /** Ordered method instance ids: every step must succeed. */ steps: string[]; /** Declared level of the whole chain, 1..10. Never computed by adding the step levels. */ level: number; note?: string }
/** `methods` order is the administrator's display and priority order. */
export interface AuthnConfig { methods: MethodInstance[]; chains: Chain[]; defaultChain: string | null }
export const EMPTY_CONFIG: AuthnConfig = { methods: [], chains: [], defaultChain: null };
export const CORE_SETTINGS_ID = 'core-authn';

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const bad = (m: string): never => { throw new BadRequestException(m); };

export function parseStored(v: Record<string, unknown> | undefined): AuthnConfig {
  if (!v || !Array.isArray((v as any).methods)) return { methods: [], chains: [], defaultChain: null };
  return { methods: (v as any).methods, chains: Array.isArray((v as any).chains) ? (v as any).chains : [], defaultChain: typeof (v as any).defaultChain === 'string' ? (v as any).defaultChain : null };
}

/** Validates a whole configuration and returns the normalized version (defaults applied). Throws 400 with the first problems found. */
export function validateConfig(input: unknown): AuthnConfig {
  if (!input || typeof input !== 'object') return bad('configuration object required');
  const i = input as Record<string, unknown>;
  if (Object.keys(i).some((k) => !['methods', 'chains', 'defaultChain'].includes(k))) bad('unknown configuration field');
  if (!Array.isArray(i.methods) || i.methods.length > 30) bad('methods: list of at most 30');
  if (!Array.isArray(i.chains) || i.chains.length > 20) bad('chains: list of at most 20');
  const methods: MethodInstance[] = [], seen = new Set<string>();
  for (const raw of i.methods as Record<string, any>[]) {
    if (!raw || typeof raw !== 'object') bad('method must be an object');
    if (Object.keys(raw).some((k) => !['id', 'type', 'name', 'enabled', 'level', 'config'].includes(k))) bad(`method ${raw.id}: unknown field`);
    if (typeof raw.id !== 'string' || !ID.test(raw.id)) bad('method id: lowercase letters, digits and hyphens, max 40');
    if (seen.has(raw.id)) bad(`duplicate method id ${raw.id}`); seen.add(raw.id);
    const t = methodType(String(raw.type));
    if (!t) bad(`method ${raw.id}: unknown type ${raw.type}`);
    if (t!.maturity !== 'implemented') bad(`method ${raw.id}: type ${t!.id} is catalogue only (not implemented)`);
    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 60) bad(`method ${raw.id}: name required, max 60 characters`);
    if (!Number.isInteger(raw.level) || raw.level < 1 || raw.level > 10) bad(`method ${raw.id}: level must be a whole number from 1 to 10 (10 = strongest)`);
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') bad(`method ${raw.id}: enabled must be true or false`);
    const r = validateSettings(t!.settings, (raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config) ? raw.config : {}) as Record<string, unknown>);
    if (!r.ok) bad(`method ${raw.id}: ${r.errors.join('; ')}`);
    if (t!.instances === 'single' && methods.some((x) => x.type === t!.id)) bad(`method ${raw.id}: type ${t!.id} allows a single instance and one already exists`);
    methods.push({ id: raw.id, type: t!.id, name: raw.name.trim(), enabled: raw.enabled !== false, level: raw.level, config: r.values });
  }
  const byId = new Map(methods.map((m) => [m.id, m])), chains: Chain[] = [], cseen = new Set<string>();
  for (const raw of i.chains as Record<string, any>[]) {
    if (!raw || typeof raw !== 'object') bad('chain must be an object');
    if (Object.keys(raw).some((k) => !['id', 'name', 'enabled', 'steps', 'level', 'note'].includes(k))) bad(`chain ${raw.id}: unknown field`);
    if (typeof raw.id !== 'string' || !ID.test(raw.id)) bad('chain id: lowercase letters, digits and hyphens, max 40');
    if (cseen.has(raw.id)) bad(`duplicate chain id ${raw.id}`); cseen.add(raw.id);
    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 60) bad(`chain ${raw.id}: name required, max 60 characters`);
    if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > 6) bad(`chain ${raw.id}: 1 to 6 steps`);
    if (new Set(raw.steps).size !== raw.steps.length) bad(`chain ${raw.id}: the same method instance cannot appear twice (add a second instance instead)`);
    for (const s of raw.steps) if (typeof s !== 'string' || !byId.has(s)) bad(`chain ${raw.id}: unknown method ${s}`);
    const steps = raw.steps as string[], enabled = raw.enabled !== false;
    if (enabled) for (const s of steps) if (!byId.get(s)!.enabled) bad(`chain ${raw.id}: method ${s} is disabled`);
    if (!Number.isInteger(raw.level) || raw.level < 1 || raw.level > 10) bad(`chain ${raw.id}: level must be a whole number from 1 to 10 (10 = strongest)`);
    const max = Math.max(...steps.map((s) => byId.get(s)!.level));
    if (raw.level < max) bad(`chain ${raw.id}: level ${raw.level} is below its strongest step (${max}); a chain needs every step, so it cannot be weaker than one of them`);
    if (raw.note !== undefined && (typeof raw.note !== 'string' || raw.note.length > 200)) bad(`chain ${raw.id}: note max 200 characters`);
    chains.push({ id: raw.id, name: raw.name.trim(), enabled, steps, level: raw.level, ...(raw.note ? { note: raw.note } : {}) });
  }
  let defaultChain: string | null = null;
  if (i.defaultChain !== null && i.defaultChain !== undefined) {
    const c = chains.find((x) => x.id === i.defaultChain);
    if (!c) bad('defaultChain: unknown chain'); else if (!c.enabled) bad('defaultChain: chain is disabled');
    defaultChain = String(i.defaultChain);
  }
  return { methods, chains, defaultChain };
}

export interface ChainAnalysis {
  id: string; declaredLevel: number; effectiveLevel: number; maxStepLevel: number;
  /** Distinct factor categories among steps whose verification is real. */
  verifiedFactors: string[]; simulatedSteps: string[]; mfa: boolean; warnings: string[];
  /** What the numbers mean, shown next to them. */
  basis: string;
}
/**
 * Honest summary of a chain. Levels are configured by an administrator and are NOT added up: the chain level is declared on its own.
 * - `mfa` is true only when at least two different factor categories are verified for real (simulated steps do not count).
 * - `effectiveLevel` equals the declared level when every step is really verified. With a simulated step it is capped by the strongest really-verified step.
 * - The suggestion (highest step level) is only a starting point for the administrator.
 */
export function analyzeChain(cfg: AuthnConfig, chain: Chain): ChainAnalysis {
  const steps = chain.steps.map((s) => cfg.methods.find((m) => m.id === s)!);
  const info = steps.map((m) => { const t = methodType(m.type)!; return { m, t, v: t.verification(m.config) }; });
  const real = info.filter((x) => x.v.real), sim = info.filter((x) => !x.v.real);
  const factors = [...new Set(real.map((x) => x.t.factor))];
  const maxStep = Math.max(...steps.map((m) => m.level)), maxReal = real.length ? Math.max(...real.map((x) => x.m.level)) : 1;
  const warnings: string[] = [];
  if (sim.length) warnings.push(`Simulated step(s): ${sim.map((x) => x.m.name).join(', ')}. They do not count as a factor and the effective level is capped at ${maxReal}.`);
  const typeCount = new Map<string, number>(); for (const x of info) typeCount.set(x.t.id, (typeCount.get(x.t.id) ?? 0) + 1);
  for (const [t, n] of typeCount) if (n > 1) warnings.push(`${n} steps use the ${t} type: repeating a type adds attempts, not an independent factor.`);
  if (steps.length > 1 && factors.length < 2 && !sim.length) warnings.push('All verified steps are the same factor category: this is a longer sign-in, not multi-factor.');
  if (chain.level > maxStep && factors.length < 2) warnings.push(`Declared level ${chain.level} is above the strongest step (${maxStep}) without a second verified factor category.`);
  const effective = sim.length ? Math.min(chain.level, maxReal) : chain.level;
  return { id: chain.id, declaredLevel: chain.level, effectiveLevel: effective, maxStepLevel: maxStep, verifiedFactors: factors, simulatedSteps: sim.map((x) => x.m.id), mfa: factors.length >= 2, warnings,
    basis: 'Levels are set by an administrator (10 = strongest). They are declared, not measured, and are never added up across steps.' };
}

/**
 * Ready-to-try examples shown when nothing is stored yet on a branch. Fictional, executable types only; catalogue-only types are never seeded.
 * Nothing is written until an administrator saves, and no chain is selected for sign-in (defaultChain null), so live sign-in does not change.
 * The e-mail step is simulated unless SMTP is configured. Levels are declared, never measured.
 */
export const SEED_CONFIG: AuthnConfig = {
  methods: [
    { id: 'password', type: 'password', name: 'Password', enabled: true, level: 3, config: {} },
    { id: 'authenticator-app', type: 'totp', name: 'Authenticator app', enabled: true, level: 7, config: {} },
    { id: 'e-mail-code', type: 'email-otp', name: 'E-mail code', enabled: true, level: 4, config: { delivery: 'smtp' } },
    { id: 'pin-keypad', type: 'digit-code', name: 'PIN keypad', enabled: true, level: 3, config: { length: 6 } },
    { id: 'pin-keypad-8', type: 'digit-code', name: 'PIN keypad (8 digits)', enabled: true, level: 4, config: { length: 8 } },
  ],
  chains: [
    { id: 'password-only', name: 'Password only', enabled: true, steps: ['password'], level: 3 },
    { id: 'password-then-authenticator', name: 'Password then authenticator', enabled: true, steps: ['password', 'authenticator-app'], level: 8 },
    { id: 'password-then-e-mail-code', name: 'Password then e-mail code', enabled: true, steps: ['password', 'e-mail-code'], level: 5, note: 'The e-mail step is simulated unless SMTP is configured.' },
    { id: 'e-mail-then-pin-keypad', name: 'E-mail then PIN keypad', enabled: true, steps: ['e-mail-code', 'pin-keypad'], level: 7, note: 'The e-mail step is simulated unless SMTP is configured.' },
    { id: 'password-e-mail-pin', name: 'Password, e-mail code, PIN', enabled: true, steps: ['password', 'e-mail-code', 'pin-keypad-8'], level: 8, note: 'Three steps, two factor categories at most.' },
  ],
  defaultChain: null,
};
export const isEmptyConfig = (c: AuthnConfig) => !c.methods.length && !c.chains.length && !c.defaultChain;
