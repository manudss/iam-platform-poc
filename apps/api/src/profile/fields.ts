import { BadRequestException } from '@nestjs/common';

/**
 * Profile fields (see docs/profile-fields.md). Three separate things:
 *  1. the DEFINITION of a field (what a plugin or the base declares: type, constraints, security class),
 *  2. the admin CONFIGURATION of each field (versioned like other settings, live only after Apply),
 *  3. the VALUES people enter (runtime data, written by the server under the LIVE configuration).
 * Permissions (roles, organizations, assignments) are not profile fields: no configuration here can write them.
 */
export const FIELD_TYPES = ['string', 'text', 'number', 'boolean', 'date', 'select', 'email', 'phone', 'url'] as const;
export type ProfileFieldType = (typeof FIELD_TYPES)[number];
/** `authority`: read by a policy or a claim, or decides who someone is allowed to be. Never editable by the user, never asked at sign-up. */
export type FieldClass = 'profile' | 'authority';
export type Pii = 'none' | 'personal' | 'sensitive';

export interface ProfileFieldDecl {
  /** Local key, lowercase. The full key is `<plugin>.<key>`. */
  key: string;
  type: ProfileFieldType;
  label: string;
  help?: string;
  options?: { value: string; label: string }[];
  min?: number; max?: number; pattern?: string;
  klass?: FieldClass; // default 'profile'
  pii?: Pii; // default 'personal'
  /** Initial admin settings; absent keys use SAFE_DEFAULTS. */
  defaults?: Partial<FieldSetting>;
}
export interface CatalogField extends ProfileFieldDecl { fullKey: string; plugin: string; klass: FieldClass; pii: Pii; storage: 'identities' | 'values' }

export type SignupMode = 'off' | 'optional' | 'required';
export interface FieldSetting {
  enabled: boolean;
  signup: SignupMode;
  /** Shown to the user in their own profile, read only unless selfEdit. */
  selfView: boolean;
  selfEdit: boolean;
  /** Editable by an administrator in the user list and user sheet. */
  adminEdit: boolean;
  label?: string; group?: string; order?: number;
}
export const SAFE_DEFAULTS: FieldSetting = { enabled: true, signup: 'off', selfView: true, selfEdit: false, adminEdit: true };
/** `signup.open` is the switch for the public form. Absent means closed. */
/** `selfEditPolicy`: absent or 'immediate' = a person's own edits go live at once (Dolt main). 'review' = each person's edits go to an automatic personal Dolt branch that a validator accepts (merge) or refuses (delete). */
export type SelfEditPolicy = 'immediate' | 'review';
export interface ProfileConfig { fields: Record<string, Partial<FieldSetting>>; signup?: { open: boolean }; selfEditPolicy?: SelfEditPolicy }
export const EMPTY_PROFILE_CONFIG: ProfileConfig = { fields: {} };
export const CORE_PROFILE_SETTINGS_ID = 'core-profile-fields';
export type Context = 'signup' | 'self' | 'admin';

const KEY = /^[a-z][a-z0-9_]{0,31}$/;
const bad = (m: string): never => { throw new BadRequestException(m); };

/** The base fields. They live in the identities table (UsersService); a plugin can never add a column to it. */
export const BASE_FIELDS: CatalogField[] = [
  { plugin: 'base', key: 'display_name', fullKey: 'base.display_name', type: 'string', label: 'Display name', max: 80, klass: 'profile', pii: 'personal', storage: 'identities', defaults: { signup: 'required', selfEdit: true } },
  { plugin: 'base', key: 'email', fullKey: 'base.email', type: 'email', label: 'E-mail', max: 254, klass: 'profile', pii: 'personal', storage: 'identities', defaults: { signup: 'required' }, help: 'Also receives sign-in codes: changing it later needs a new confirmation.' },
  { plugin: 'base', key: 'department', fullKey: 'base.department', type: 'string', label: 'Department', max: 40, klass: 'authority', pii: 'none', storage: 'identities', help: 'Treated as authority until the access engine is confirmed not to read it.' },
  { plugin: 'base', key: 'manager_id', fullKey: 'base.manager_id', type: 'string', label: 'Manager', max: 32, klass: 'authority', pii: 'none', storage: 'identities' },
];

/** Validates the declarations of ONE plugin (manifest time). Returns problems. */
export function validateFieldDecls(plugin: string, fields: ProfileFieldDecl[] | undefined): string[] {
  const errs: string[] = []; const seen = new Set<string>();
  for (const f of fields ?? []) {
    if (!KEY.test(f?.key ?? '')) { errs.push(`profile field key ${f?.key} is invalid`); continue; }
    if (seen.has(f.key)) errs.push(`profile field ${f.key} declared twice`); seen.add(f.key);
    if (!FIELD_TYPES.includes(f.type)) errs.push(`profile field ${f.key}: unknown type ${f.type}`);
    if (!f.label) errs.push(`profile field ${f.key}: label required`);
    if (f.type === 'select' && !f.options?.length) errs.push(`profile field ${f.key}: options required`);
    if (f.klass !== undefined && f.klass !== 'profile' && f.klass !== 'authority') errs.push(`profile field ${f.key}: unknown class`);
    if (f.pii !== undefined && !['none', 'personal', 'sensitive'].includes(f.pii)) errs.push(`profile field ${f.key}: unknown pii level`);
    if (f.pattern) { try { new RegExp(f.pattern); } catch { errs.push(`profile field ${f.key}: invalid pattern`); } }
    if (plugin === 'base') errs.push('the base plugin id is reserved for profile fields');
    const d = f.defaults;
    if (d && (f.klass === 'authority') && (d.selfEdit || (d.signup && d.signup !== 'off'))) errs.push(`profile field ${f.key}: an authority field cannot default to user-editable or sign-up`);
  }
  return errs;
}
export function toCatalog(plugin: string, fields: ProfileFieldDecl[]): CatalogField[] {
  return fields.map((f) => ({ ...f, plugin, fullKey: `${plugin}.${f.key}`, klass: f.klass ?? 'profile', pii: f.pii ?? 'personal', storage: 'values' as const }));
}

export function settingFor(f: CatalogField, cfg: ProfileConfig): FieldSetting {
  const s = { ...SAFE_DEFAULTS, ...(f.defaults ?? {}), ...(cfg.fields[f.fullKey] ?? {}) } as FieldSetting;
  return f.klass === 'authority' ? { ...s, selfEdit: false, signup: 'off' } : s; // defense in depth: validation already refuses a stored config that says otherwise
}

export function parseProfileConfig(v: Record<string, unknown> | undefined): ProfileConfig {
  const f = (v as { fields?: unknown } | undefined)?.fields;
  const su = (v as { signup?: { open?: unknown } } | undefined)?.signup;
  const pol = (v as { selfEditPolicy?: unknown } | undefined)?.selfEditPolicy;
  return { fields: f && typeof f === 'object' && !Array.isArray(f) ? (f as Record<string, FieldSetting>) : {}, ...(su && su.open === true ? { signup: { open: true } } : {}), ...(pol === 'review' ? { selfEditPolicy: 'review' as const } : {}) };
}

/** Validates a whole configuration against the catalogue. The security rules are enforced here, not in the screen. */
export function validateProfileConfig(input: unknown, catalogue: CatalogField[]): ProfileConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('configuration object required');
  const i = input as Record<string, unknown>;
  if (Object.keys(i).some((k) => k !== 'fields' && k !== 'signup' && k !== 'selfEditPolicy')) bad('unknown configuration field');
  if (i.selfEditPolicy !== undefined && i.selfEditPolicy !== 'immediate' && i.selfEditPolicy !== 'review') bad('selfEditPolicy: immediate or review');
  const su = i.signup as Record<string, unknown> | undefined;
  if (su !== undefined && (!su || typeof su !== 'object' || Array.isArray(su) || Object.keys(su).some((k) => k !== 'open') || typeof su.open !== 'boolean')) bad('signup: { open: boolean }');
  const fields = i.fields; if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return bad('fields: object required');
  const out: Record<string, FieldSetting> = {};
  for (const [k, raw] of Object.entries(fields as Record<string, unknown>)) {
    const f = catalogue.find((c) => c.fullKey === k); if (!f) { bad(`unknown profile field ${k}`); continue; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad(`${k}: settings object required`);
    const r = raw as Record<string, unknown>;
    const allowed = ['enabled', 'signup', 'selfView', 'selfEdit', 'adminEdit', 'label', 'group', 'order'];
    if (Object.keys(r).some((x) => !allowed.includes(x))) bad(`${k}: unknown setting`);
    for (const b of ['enabled', 'selfView', 'selfEdit', 'adminEdit']) if (r[b] !== undefined && typeof r[b] !== 'boolean') bad(`${k}.${b}: boolean required`);
    if (r.signup !== undefined && !['off', 'optional', 'required'].includes(String(r.signup))) bad(`${k}.signup: off, optional or required`);
    for (const t of ['label', 'group']) if (r[t] !== undefined && (typeof r[t] !== 'string' || (r[t] as string).length > 80)) bad(`${k}.${t}: text of at most 80 characters`);
    if (r.order !== undefined && (!Number.isInteger(r.order) || (r.order as number) < 0 || (r.order as number) > 999)) bad(`${k}.order: integer 0..999`);
    const s = { ...SAFE_DEFAULTS, ...(f.defaults ?? {}), ...r } as FieldSetting;
    if (f.klass === 'authority' && (s.selfEdit || s.signup !== 'off')) bad(`${k}: an authority field can never be edited by the user or asked at sign-up`);
    if (!s.enabled && (s.signup !== 'off' || s.selfEdit)) bad(`${k}: a disabled field cannot be asked at sign-up or edited by the user`);
    if (s.selfEdit && !s.selfView) bad(`${k}: selfEdit needs selfView`);
    out[k] = { ...r } as unknown as FieldSetting;
  }
  return { fields: out, ...(su?.open ? { signup: { open: true } } : {}), ...(i.selfEditPolicy === 'review' ? { selfEditPolicy: 'review' as const } : {}) };
}

export interface EffectiveField { key: string; plugin: string; label: string; type: ProfileFieldType; help?: string; options?: { value: string; label: string }[]; klass: FieldClass; pii: Pii; group?: string; order: number; visible: boolean; editable: boolean; required: boolean }
/** The one schema the screens and the server rules both use, per context. */
export function effectiveSchema(catalogue: CatalogField[], cfg: ProfileConfig, ctx: Context): EffectiveField[] {
  const out: EffectiveField[] = [];
  for (const f of catalogue) {
    const s = settingFor(f, cfg); if (!s.enabled) continue;
    const e: EffectiveField = { key: f.fullKey, plugin: f.plugin, label: s.label ?? f.label, type: f.type, help: f.help, options: f.options, klass: f.klass, pii: f.pii, group: s.group, order: s.order ?? 500, visible: false, editable: false, required: false };
    if (ctx === 'signup') { if (s.signup === 'off' || f.klass === 'authority') continue; e.visible = e.editable = true; e.required = s.signup === 'required'; }
    else if (ctx === 'self') { if (!s.selfView) continue; e.visible = true; e.editable = s.selfEdit && f.klass === 'profile' && f.storage === 'values'; }
    else { e.visible = true; e.editable = s.adminEdit && f.storage === 'values'; }
    out.push(e);
  }
  return out.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

/** Checks one value against its declaration and returns the normalized value. Throws 400. */
export function checkValue(f: { fullKey: string; type: ProfileFieldType; options?: { value: string }[]; min?: number; max?: number; pattern?: string }, v: unknown): string | number | boolean | null {
  if (v === null || v === '') return null;
  const k = f.fullKey;
  switch (f.type) {
    case 'boolean': if (typeof v !== 'boolean') bad(`${k}: boolean required`); return v as boolean;
    case 'number': if (typeof v !== 'number' || !Number.isFinite(v)) bad(`${k}: number required`); if (f.min !== undefined && (v as number) < f.min || f.max !== undefined && (v as number) > f.max) bad(`${k}: out of range`); return v as number;
    default: {
      if (typeof v !== 'string') return bad(`${k}: text required`);
      const s = v.trim(); const max = f.max ?? (f.type === 'text' ? 2000 : 200); if (s.length > max || (f.min !== undefined && s.length < f.min)) bad(`${k}: length out of range`);
      if (f.type === 'select' && !f.options?.some((o) => o.value === s)) bad(`${k}: not one of the options`);
      if (f.type === 'email' && !/^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,190}$/.test(s)) bad(`${k}: invalid e-mail address`);
      if (f.type === 'phone' && !/^\+?[0-9 ().-]{6,20}$/.test(s)) bad(`${k}: invalid phone number`);
      if (f.type === 'url' && !/^https:\/\/[^\s]{1,200}$/.test(s)) bad(`${k}: https URL required`);
      if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(s)) bad(`${k}: date as YYYY-MM-DD`);
      if (f.pattern && !new RegExp(f.pattern).test(s)) bad(`${k}: does not match the expected format`);
      return s;
    }
  }
}
