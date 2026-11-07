import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defaultPluginsDir } from '../plugins/v1/loader.js';

/**
 * Profile fields (see docs/profile-fields.md). Three separate things:
 *  1. the DEFINITION of a field (what a plugin or the base declares: type, constraints, security class),
 *  2. the admin CONFIGURATION of each field (versioned like other settings, live only after Apply),
 *  3. the VALUES people enter (runtime data, written by the server under the LIVE configuration).
 * Permissions (roles, organizations, assignments) are not profile fields: no configuration here can write them.
 *
 * Decision 2: the types below are shared with the core (identity storage), but every management rule
 * (catalogue, configuration validation, effective schema, value checking) lives in the base directory
 * plugin (`plugins/directory/fields.mjs`), replaceable by slot. This file re-exports them.
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
/** `signup.open` is the switch for the public form. Absent means closed. */
/** `selfEditPolicy`: absent or 'immediate' = a person's own edits go live at once (Dolt main). 'review' = each person's edits go to an automatic personal Dolt branch that a validator accepts (merge) or refuses (delete). */
export type SelfEditPolicy = 'immediate' | 'review';
export interface ProfileConfig { fields: Record<string, Partial<FieldSetting>>; signup?: { open: boolean }; selfEditPolicy?: SelfEditPolicy }
export const EMPTY_PROFILE_CONFIG: ProfileConfig = { fields: {} };
export const CORE_PROFILE_SETTINGS_ID = 'core-profile-fields';
export type Context = 'signup' | 'self' | 'admin';
export interface EffectiveField { key: string; plugin: string; label: string; type: ProfileFieldType; help?: string; options?: { value: string; label: string }[]; klass: FieldClass; pii: Pii; group?: string; order: number; visible: boolean; editable: boolean; required: boolean }

interface DirectoryFieldsModule {
  SAFE_DEFAULTS: FieldSetting;
  BASE_FIELDS: CatalogField[];
  validateFieldDecls: (plugin: string, fields: ProfileFieldDecl[] | undefined) => string[];
  toCatalog: (plugin: string, fields: ProfileFieldDecl[]) => CatalogField[];
  settingFor: (f: CatalogField, cfg: ProfileConfig) => FieldSetting;
  parseProfileConfig: (v: Record<string, unknown> | undefined) => ProfileConfig;
  validateProfileConfig: (input: unknown, catalogue: CatalogField[]) => ProfileConfig;
  effectiveSchema: (catalogue: CatalogField[], cfg: ProfileConfig, ctx: Context) => EffectiveField[];
  checkValue: (f: { fullKey: string; type: ProfileFieldType; options?: { value: string }[]; min?: number; max?: number; pattern?: string }, v: unknown) => string | number | boolean | null;
}
const plugin = createRequire(import.meta.url)(resolve(defaultPluginsDir(), 'directory', 'fields.mjs')) as DirectoryFieldsModule;

export const SAFE_DEFAULTS = plugin.SAFE_DEFAULTS;
/** The base fields. They live in the identities table (UsersService); a plugin can never add a column to it. */
export const BASE_FIELDS = plugin.BASE_FIELDS;
export const validateFieldDecls = plugin.validateFieldDecls;
export const toCatalog = plugin.toCatalog;
export const settingFor = plugin.settingFor;
export const parseProfileConfig = plugin.parseProfileConfig;
export const validateProfileConfig = plugin.validateProfileConfig;
export const effectiveSchema = plugin.effectiveSchema;
export const checkValue = plugin.checkValue;
