import type { ProfileFieldDecl } from '../../profile/fields.js';
import { validateFieldDecls } from '../../profile/fields.js';
/**
 * Plugin manifest v1 (see docs/plugins.md).
 * A manifest is pure data: what a plugin is, which hooks it listens to, what it installs,
 * which parameters it exposes. The admin console builds its forms from `settings` only.
 */
export const PLUGIN_KINDS = [
  'auth-method', // how a user proves who they are (password, TOTP, passkey, federation)
  'directory', // manages identities, profiles, roles and sign-up (decision 2: base plugin, replaceable by slot; storage stays core)
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
  /** Inverse statements run in reverse order when the LAST tenant uninstalls the plugin (plan D: destructive inverses).
   * A down may drop the plugin's own tables (only uninstall may drop). Uninstall refuses an applied migration without one. */
  down?: string[];
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

/** v2: a bus-only subscription to a custom event kind of the plugin's own namespace `plg.<id>.*`.
 * Platform hooks are already declared in `hooks`; this is for events the plugin defines itself. */
export interface SubscribeDecl {
  /** Custom kind, must start with `plg.<pluginId>.`. */
  name: string;
  /** `async` = notify delivery (fire and forget, `group` allowed); `blocking` = the core waits for an answer (`mandatory` allowed). */
  mode: HookMode;
  /** Blocking only: a missing answer refuses the call (fail closed). */
  mandatory?: boolean;
  /** Async only: one-of delivery group (one member receives each event). */
  group?: string;
}

export interface HttpRouteDecl {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Route path under `/plugins/:id/`, for example `/apps` or `/apps/:appId`. */
  path: string;
  /** Key of the handler in the plugin's handlers module; defaults to `http:<METHOD> <path>`. */
  handler?: string;
  /** `user` (signed-in, default), `admin` (admin capability) or `public` (sign-in pages and protocol endpoints). */
  auth?: 'user' | 'admin' | 'public';
}
export interface MenuEntry {
  id: string;
  title: string;
  /** Console area: the administration menu or the self-service space. */
  area: 'admin' | 'self-service';
  /** Sidebar group the entry joins (created on demand). */
  group: string;
  icon?: string;
  order?: number;
  /** Console route the entry opens, for example `/applications`. */
  path: string;
}
/** v3: a plugin of kind `auth-method` that provides a sign-in method TYPE (slot `auth.<id>`).
 * The chains and their levels stay in the core (decision 1); the method behaviour lives in the plugin's
 * handlers (`auth.prepare`, `auth.verify`, `auth.interact`, `auth.verification`). */
export interface AuthMethodDecl {
  name: string;
  description: string;
  /** Category of factor the method DECLARES. A classification, not a measurement. */
  factor: 'knowledge' | 'possession' | 'inherence' | 'other';
  amr: string;
  maturity: 'implemented' | 'catalogue';
  suggestedLevel: number;
  provisioning: 'directory' | 'admin-demo' | 'none';
  /** The step runs on the same page as the username (first factor inline). */
  inlineWithUsername?: boolean;
}

export interface PluginManifest {
  apiVersion: 'plugin/v1' | 'plugin/v3';
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
  /** Profile fields this plugin adds (kind `profile`). Values live in the core profile value store; a plugin cannot add columns to the identities table. */
  profileFields?: ProfileFieldDecl[];
  /** v2: custom event kinds (namespace `plg.<id>.*`) this plugin answers without a platform hook. Each needs a handler of the same name. */
  subscribes?: SubscribeDecl[];
  /** v2: custom event kinds (namespace `plg.<id>.*`) this plugin may emit on the bus. The core checks this grant before accepting an emission. */
  emits?: string[];
  /** v3 (folder plugins): where the plugin's code lives inside its folder. */
  entrypoints?: { handlers?: string };
  /** v3: HTTP routes mounted under `/plugins/:id/`. Each needs a handler; public routes are for sign-in and protocol endpoints only. */
  httpRoutes?: HttpRouteDecl[];
  /** v3: console menu entries. An entry disappears with its plugin (disabled = out of the menu, routes refuse). */
  menu?: MenuEntry[];
  /** v3: the sign-in method type this plugin provides (kind `auth-method` with a slot `auth.<id>`). */
  authMethod?: AuthMethodDecl;
  /** v3: package security. `signed` requires a valid signature.json verified at load against the trust store. */
  security?: { signed?: boolean };
}

const ID = /^[a-z][a-z0-9-]{1,48}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const FIELD_TYPES: FieldType[] = ['string', 'text', 'number', 'boolean', 'select', 'multiselect', 'secret', 'url', 'list'];

/** Returns the list of problems; an empty list means the manifest is well formed. */
export function validateManifest(m: PluginManifest, knownHooks: ReadonlyMap<string, HookMode[]>): string[] {
  const errs: string[] = [];
  if (m.apiVersion !== 'plugin/v1' && m.apiVersion !== 'plugin/v3') errs.push('apiVersion must be plugin/v1 or plugin/v3');
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
  if (m.authMethod) {
    const a = m.authMethod;
    if (!a.name) errs.push('authMethod.name is required');
    if (!a.description) errs.push('authMethod.description is required');
    if (!['knowledge', 'possession', 'inherence', 'other'].includes(a.factor)) errs.push(`authMethod.factor: unknown factor ${a.factor}`);
    if (!a.amr) errs.push('authMethod.amr is required');
    if (!['implemented', 'catalogue'].includes(a.maturity)) errs.push(`authMethod.maturity must be implemented or catalogue`);
    if (!Number.isInteger(a.suggestedLevel) || a.suggestedLevel < 1 || a.suggestedLevel > 10) errs.push('authMethod.suggestedLevel must be a whole number from 1 to 10');
    if (!['directory', 'admin-demo', 'none'].includes(a.provisioning)) errs.push(`authMethod.provisioning: unknown value ${a.provisioning}`);
  }
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
      if (/create\s+table/i.test(s) && !/\btenant\s+text\s+not\s+null\b/i.test(s)) errs.push(`migration ${mig.id}: every table needs a "tenant text not null" column (rows are isolated per tenant)`);
      if (/\bdrop\s+table\b/i.test(s)) errs.push(`migration ${mig.id}: drop table is not allowed in an up migration (declare the inverse in down)`);
    }
    for (const s of mig.down ?? []) {
      const t = /(?:create|alter|drop)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?([a-z0-9_]+)/gi;
      let x: RegExpExecArray | null;
      while ((x = t.exec(s))) if (!x[1].toLowerCase().startsWith(prefix)) errs.push(`migration ${mig.id} inverse: table ${x[1]} must start with ${prefix}`);
      if (/create\s+table/i.test(s)) errs.push(`migration ${mig.id} inverse: create table makes no sense in an inverse`);
    }
  }
  for (const s of m.install?.seed ?? []) if (!s.table.toLowerCase().startsWith(prefix)) errs.push(`seed table ${s.table} must start with ${prefix}`);
  const ns = `plg.${m.id ?? ''}.`;
  const hookNames = new Set((m.hooks ?? []).map((h) => h.name));
  for (const s of m.subscribes ?? []) {
    if (!s.name?.startsWith(ns)) errs.push(`subscribes: ${s.name} must be in the plugin's own namespace ${ns}*`);
    if (hookNames.has(s.name)) errs.push(`subscribes: ${s.name} is already a declared hook`);
    if (s.mode === 'blocking' && s.group) errs.push(`subscribes: ${s.name}: a group only applies to async (notify) kinds`);
    if (s.mode === 'async' && s.mandatory) errs.push(`subscribes: ${s.name}: mandatory only applies to blocking (control) kinds`);
  }
  for (const e of m.emits ?? []) {
    if (!e?.startsWith(ns)) errs.push(`emits: ${e} must be in the plugin's own namespace ${ns}*`);
  }
  if (m.entrypoints?.handlers !== undefined) {
    const h = m.entrypoints.handlers;
    if (typeof h !== 'string' || h.includes('..') || h.startsWith('/') || !h.endsWith('.mjs')) errs.push('entrypoints.handlers must be a relative .mjs path inside the plugin folder');
  }
  const seenRoutes = new Set<string>();
  for (const r of m.httpRoutes ?? []) {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method)) errs.push(`httpRoutes: unknown method ${r.method}`);
    if (typeof r.path !== 'string' || !r.path.startsWith('/')) errs.push(`httpRoutes: path must start with /`);
    if (r.handler !== undefined && !/^[a-zA-Z][a-zA-Z0-9:_/ -]*$/.test(r.handler)) errs.push(`httpRoutes: invalid handler name ${r.handler}`);
    if (r.auth !== undefined && !['user', 'admin', 'public'].includes(r.auth)) errs.push(`httpRoutes: unknown auth ${r.auth}`);
    const k = `${r.method} ${r.path}`;
    if (seenRoutes.has(k)) errs.push(`httpRoutes: ${k} declared twice`);
    seenRoutes.add(k);
  }
  const seenMenu = new Set<string>();
  for (const e of m.menu ?? []) {
    if (!e.id || !e.title) errs.push('menu: id and title are required');
    if (e.area !== undefined && !['admin', 'self-service'].includes(e.area)) errs.push(`menu ${e.id}: unknown area ${e.area}`);
    if (!e.group) errs.push(`menu ${e.id}: group is required`);
    if (typeof e.path !== 'string' || !e.path.startsWith('/')) errs.push(`menu ${e.id}: path must start with /`);
    if (seenMenu.has(e.id)) errs.push(`menu ${e.id} declared twice`);
    seenMenu.add(e.id);
  }
  errs.push(...validateFieldDecls(m.id, m.profileFields));
  if (m.base && m.extends) errs.push('a base plugin cannot extend another plugin');
  if (m.base && !(m.provides?.length)) errs.push('a base plugin must provide a slot');
  if (m.extends && !(m.provides?.length)) errs.push('a replacement plugin must provide the slot of its base');
  return errs;
}
