/**
 * Plugin manifest v1 (see docs/plugins.md).
 * A manifest is pure data: what a plugin is, which hooks it listens to, what it installs,
 * which parameters it exposes. The admin console builds its forms from `settings` only.
 */
export const PLUGIN_KINDS = [
  'auth-method', // how a user proves who they are (password, TOTP, passkey, federation)
  'profile', // enriches the user profile (attributes, derived claims)
  'notifier', // sends notifications (mail, chat, webhook)
  'workflow', // approval / certification steps in IGA flows
  'ui', // adds admin or self-service screens
  'connector', // reads from or provisions to a directory or application
  'policy', // contributes access decisions (blocking, runs in the core)
  'audit-sink', // forwards audit events elsewhere
  'risk-signal', // adds a score or a signal to a sign-in or access decision
] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

export type HookMode = 'blocking' | 'async';
export interface HookDecl {
  /** Hook name from the catalogue (hooks.ts), for example `auth.authenticate`. */
  name: string;
  mode: HookMode;
}

export type FieldType = 'string' | 'text' | 'number' | 'boolean' | 'select' | 'multiselect' | 'secret' | 'url' | 'list';
export interface SettingField {
  key: string;
  type: FieldType;
  label: string;
  help?: string;
  required?: boolean;
  default?: unknown;
  /** For select / multiselect. */
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  pattern?: string;
  /** Show this field only when another field has the given value. Purely cosmetic: validation still applies if the value is present. */
  visibleIf?: { key: string; equals: unknown };
  /** Form grouping. */
  group?: string;
}

export interface Migration {
  /** Stable id, unique inside the plugin. Never edit an applied migration: add a new one. */
  id: string;
  /** Statements run in order inside one transaction by the installer. Tables must be prefixed `plg_<pluginId>_`. */
  sql: string[];
}
export interface SeedRow {
  table: string;
  row: Record<string, unknown>;
}
export interface InstallSpec {
  migrations: Migration[];
  seed?: SeedRow[];
}

export interface UiScreen {
  id: string;
  title: string;
  /** Where the screen appears in the admin console navigation. */
  area: 'admin' | 'self-service';
  /** `schema`: the console renders a generic list/form from `schemaRef`. `component`: a packaged web component. */
  render: 'schema' | 'component';
  schemaRef?: string;
  component?: string;
}

export interface PluginManifest {
  apiVersion: 'plugin/v1';
  id: string; // lowercase-kebab
  version: string; // semver
  name: string;
  description?: string;
  publisher: string;
  kinds: PluginKind[]; // a plugin may mix several kinds
  /** Hooks the plugin can listen to and answer. A plugin cannot receive a hook it did not declare. */
  hooks: HookDecl[];
  /** Slot this plugin provides, for base or replacement plugins, for example `auth.password`. */
  provides?: string[];
  /** Id of the base plugin this one extends and may replace. Its settings and hooks must be a superset. */
  extends?: string;
  /** Plugins that must be enabled for this one to work. */
  requires?: string[];
  /** True for base plugins: shipped, mandatory for their slot, cannot be uninstalled. */
  base?: boolean;
  install?: InstallSpec;
  settings: SettingField[];
  screens?: UiScreen[];
}

const ID = /^[a-z][a-z0-9-]{1,48}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const FIELD_TYPES: FieldType[] = ['string', 'text', 'number', 'boolean', 'select', 'multiselect', 'secret', 'url', 'list'];

/** Returns the list of problems; an empty list means the manifest is well formed. */
export function validateManifest(m: PluginManifest, knownHooks: ReadonlyMap<string, HookMode[]>): string[] {
  const errs: string[] = [];
  if (m.apiVersion !== 'plugin/v1') errs.push('apiVersion must be plugin/v1');
  if (!ID.test(m.id ?? '')) errs.push('id must be lowercase kebab-case');
  if (!SEMVER.test(m.version ?? '')) errs.push('version must be x.y.z');
  if (!m.name) errs.push('name is required');
  if (!m.publisher) errs.push('publisher is required');
  if (!Array.isArray(m.kinds) || m.kinds.length === 0) errs.push('at least one kind is required');
  for (const k of m.kinds ?? []) if (!(PLUGIN_KINDS as readonly string[]).includes(k)) errs.push(`unknown kind ${k}`);
  const seenHooks = new Set<string>();
  for (const h of m.hooks ?? []) {
    const modes = knownHooks.get(h.name);
    if (!modes) errs.push(`unknown hook ${h.name}`);
    else if (!modes.includes(h.mode)) errs.push(`hook ${h.name} does not allow mode ${h.mode}`);
    if (seenHooks.has(h.name)) errs.push(`hook ${h.name} declared twice`);
    seenHooks.add(h.name);
  }
  const seen = new Set<string>();
  for (const f of m.settings ?? []) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(f.key ?? '')) errs.push(`setting key ${f.key} is invalid`);
    if (seen.has(f.key)) errs.push(`setting ${f.key} declared twice`);
    seen.add(f.key);
    if (!FIELD_TYPES.includes(f.type)) errs.push(`setting ${f.key}: unknown type ${f.type}`);
    if ((f.type === 'select' || f.type === 'multiselect') && !(f.options?.length)) errs.push(`setting ${f.key}: options required`);
    if (f.type === 'secret' && f.default !== undefined) errs.push(`setting ${f.key}: a secret cannot have a default`);
    if (f.pattern) {
      try { new RegExp(f.pattern); } catch { errs.push(`setting ${f.key}: invalid pattern`); }
    }
  }
  const prefix = `plg_${(m.id ?? '').replace(/-/g, '_')}_`;
  const ids = new Set<string>();
  for (const mig of m.install?.migrations ?? []) {
    if (ids.has(mig.id)) errs.push(`migration ${mig.id} declared twice`);
    ids.add(mig.id);
    for (const s of mig.sql) {
      const t = /(?:create|alter|drop)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?([a-z0-9_]+)/gi;
      let x: RegExpExecArray | null;
      while ((x = t.exec(s))) if (!x[1].toLowerCase().startsWith(prefix)) errs.push(`migration ${mig.id}: table ${x[1]} must start with ${prefix}`);
      if (/\bdrop\s+table\b/i.test(s)) errs.push(`migration ${mig.id}: drop table is not allowed (uninstall keeps data)`);
    }
  }
  for (const s of m.install?.seed ?? []) if (!s.table.toLowerCase().startsWith(prefix)) errs.push(`seed table ${s.table} must start with ${prefix}`);
  if (m.base && m.extends) errs.push('a base plugin cannot extend another plugin');
  if (m.base && !(m.provides?.length)) errs.push('a base plugin must provide a slot');
  if (m.extends && !(m.provides?.length)) errs.push('a replacement plugin must provide the slot of its base');
  return errs;
}
