import { createHash, verify as verifySig, createPublicKey } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOKS, HookHandler } from './hooks.js';
import { PluginManifest, validateManifest } from './manifest.js';
import { PluginError, PluginImpl } from './registry.js';

/**
 * Folder loader (plan step 1): every plugin lives in its own folder under `plugins/`:
 *   plugins/<id>/manifest.json   the manifest (v3: entrypoints, httpRoutes, menu, security)
 *   plugins/<id>/handlers.mjs    hook handlers (default export: { '<hook>': (payload, ctx) => result })
 *   plugins/<id>/signature.json  package signature over the folder files (see scripts/plugin-pack.mjs)
 * The loader scans the folder tree, validates each manifest with the SAME rules as the registry, checks the
 * package signature against the trust store, and returns PluginImpl records ready for `registry.register`.
 * A replacement (`extends`) receives the REGISTERED base plugin's handlers as `ctx.base` (wired by the registry at register time).
 */

export interface SignatureFile { alg: 'ed25519'; publisher: string; files: Record<string, string>; signature: string }

/** Catalogue instances keyed by resolved plugins-dir configuration. Lazily created on globalThis: core adapters
 * call loadPluginModule at module scope while this very module is still evaluating (import cycle
 * loader -> manifest -> profile/fields -> loader), so ANY module-level const here is still in the temporal
 * dead zone at that point. */
function catalogues(): Map<string, PluginCatalogue> {
  const g = globalThis as { __iamPluginCatalogues?: Map<string, PluginCatalogue> };
  return (g.__iamPluginCatalogues ??= new Map<string, PluginCatalogue>());
}

export interface LoadOptions {
  /** Trust store: publisher -> base64 Ed25519 public key. Defaults to conf/plugin-trust.json next to the plugins dir. */
  trust?: Record<string, string>;
  /** Allow unsigned plugins (local development only, IAM_PLUGIN_UNSIGNED=1). Refused manifests still fail. */
  allowUnsigned?: boolean;
}

/** Default plugins dir: the repository `plugins/` folder (overridable with IAM_PLUGINS_DIR). */
export function defaultPluginsDir(): string {
  if (process.env.IAM_PLUGINS_DIR) return resolve(process.env.IAM_PLUGINS_DIR);
  // dist/plugins/v1/loader.js -> repo root is four levels up; src layout (ts-node) is one level shallower.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of ['../../../../../plugins', '../../../../plugins', '../../../plugins']) {
    const dir = resolve(here, up);
    if (existsSync(dir)) return dir;
  }
  return resolve(process.cwd(), 'plugins');
}

function loadTrust(dir: string): Record<string, string> {
  if (process.env.IAM_PLUGIN_TRUST) {
    const path = resolve(process.env.IAM_PLUGIN_TRUST);
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>) : {};
  }
  const path = resolve(dir, '..', 'conf', 'plugin-trust.json');
  // P0-3: keys are NEVER generated at runtime. A missing trust store means every verification fails (boot is
  // refused), in development as in production. Development provisions its keys with the explicit command
  // `node scripts/plugin-dev-setup.mjs` (or `npm run plugins:setup`); production ships its own trust store.
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>) : {};
}

/** Canonical serialization (sorted keys) so the signature does not depend on key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** Every file of the package, relative paths, signature.json excluded. Symlinks are reported, not followed. */
function packageFiles(dir: string): { files: string[]; symlinks: string[] } {
  const files: string[] = []; const symlinks: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue; // same convention as the signer (scripts/plugin-pack.mjs)
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) { symlinks.push(r); continue; }
      if (e.isDirectory()) { walk(r); continue; }
      if (r !== 'signature.json') files.push(r);
    }
  };
  walk('');
  return { files, symlinks };
}

/** Verifies signature.json against the folder files and the trust store. Returns the problems found (empty = valid).
 * Exhaustive (P0-2): every file of the package must be signed, the manifest and the declared entrypoints must be
 * covered, the manifest publisher must be the signing publisher, escaping paths and symlinks are refused. */
export function verifyPackage(dir: string, trust: Record<string, string>): string[] {
  const sigPath = join(dir, 'signature.json');
  if (!existsSync(sigPath)) return ['signature.json missing (sign the plugin with scripts/plugin-pack.mjs)'];
  let sig: SignatureFile;
  try { sig = JSON.parse(readFileSync(sigPath, 'utf8')) as SignatureFile; } catch { return ['signature.json is not valid JSON']; }
  const errs: string[] = [];
  if (sig.alg !== 'ed25519') errs.push(`signature: unknown algorithm ${sig.alg}`);
  const key = trust[sig.publisher];
  if (!key) errs.push(`signature: untrusted publisher ${sig.publisher}`);
  const signed = new Set(Object.keys(sig.files ?? {}));
  for (const [file, hash] of Object.entries(sig.files ?? {})) {
    if (file.includes('..') || file.startsWith('\\') || file.startsWith('/')) { errs.push(`signature: invalid file entry ${file}`); continue; }
    const p = join(dir, file);
    if (!existsSync(p)) { errs.push(`signature: ${file} listed but missing`); continue; }
    const actual = createHash('sha256').update(readFileSync(p)).digest('hex');
    if (actual !== hash) errs.push(`signature: ${file} was modified after signing`);
  }
  // The signed inventory must cover the WHOLE package: an added, unsigned file is a rejection, not a blind spot.
  const { files, symlinks } = packageFiles(dir);
  for (const s of symlinks) errs.push(`signature: symlink ${s} is not allowed in a plugin package`);
  for (const f of files) if (!signed.has(f)) errs.push(`signature: ${f} is present but not signed`);
  // The manifest must be signed and must agree with the signature about who published the package.
  if (!signed.has('manifest.json')) errs.push('signature: manifest.json is not signed');
  else if (existsSync(join(dir, 'manifest.json'))) {
    try {
      const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as PluginManifest;
      if (m.publisher && m.publisher !== sig.publisher) errs.push(`signature: manifest publisher ${m.publisher} differs from signing publisher ${sig.publisher}`);
      for (const ep of Object.values(m.entrypoints ?? {})) if (typeof ep === 'string' && !signed.has(ep)) errs.push(`signature: entrypoint ${ep} is not signed`);
    } catch { errs.push('manifest.json is not valid JSON'); }
  }
  if (!errs.length && key) {
    const payload = canonical({ alg: sig.alg, publisher: sig.publisher, files: sig.files });
    try {
      if (!verifySig(null, Buffer.from(payload), createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' }), Buffer.from(sig.signature, 'base64'))) errs.push('signature: invalid signature');
    } catch { errs.push('signature: invalid signature'); }
  }
  return errs;
}

/** Package security check shared by every load path (P0-1): provenance and integrity BEFORE any import. */
function verifyPluginPackage(pdir: string, manifest: PluginManifest, trust: Record<string, string>, allowUnsigned: boolean) {
  // No sandbox (decision 3), but a signed, integrity-checked package. The signature is verified whenever the
  // manifest asks for it, the plugin ships code, or a signature is present.
  const mustVerify = manifest.security?.signed === true || !!manifest.entrypoints?.handlers || existsSync(join(pdir, 'signature.json'));
  if (mustVerify) {
    const sigErrs = verifyPackage(pdir, trust);
    if (sigErrs.length && !(allowUnsigned && sigErrs.every((e) => e.startsWith('signature.json missing')))) throw new PluginError('signature-invalid', `${manifest.id}: ${sigErrs.join('; ')}`);
  }
}

/**
 * The ONE verified way for core code (adapters) to import a plugin file (P0-1). The package signature is
 * verified first; a rejected package has NO load effect (the file is never imported). Any file of the signed
 * inventory can be loaded this way (handlers, engine, model, helpers).
 */
export function loadPluginModule<T = unknown>(id: string, file: string, opts: LoadOptions = {}): T {
  return pluginCatalogue(defaultPluginsDir(), opts).module<T>(id, file);
}

interface ScannedPlugin { manifest: PluginManifest; handlers?: Record<string, HookHandler>; factory?: () => Record<string, HookHandler>; }

/** Scans and verifies every plugin folder under `dir` (one level of folders). Factory modules stay factories so
 * each registration can get fresh handler state; use loadPlugins/pluginCatalogue for the PluginImpl view. */
function scanPlugins(dir: string, opts: LoadOptions): ScannedPlugin[] {
  const trust = opts.trust ?? loadTrust(dir);
  const allowUnsigned = opts.allowUnsigned ?? process.env.IAM_PLUGIN_UNSIGNED === '1';
  const req = createRequire(import.meta.url);
  const impls: ScannedPlugin[] = [];
  if (!existsSync(dir)) return impls;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_') || entry.name === 'examples') continue;
    const pdir = join(dir, entry.name);
    const mpath = join(pdir, 'manifest.json');
    if (!existsSync(mpath)) continue;
    const manifest = JSON.parse(readFileSync(mpath, 'utf8')) as PluginManifest;
    if (manifest.id !== entry.name) throw new PluginError('invalid-manifest', `${entry.name}: manifest id must be the folder name`);
    const errs = validateManifest(manifest, HOOKS);
    if (errs.length) throw new PluginError('invalid-manifest', `${entry.name}: ${errs.join('; ')}`);
    verifyPluginPackage(pdir, manifest, trust, allowUnsigned);
    for (const sc of manifest.screens ?? []) if (sc.render === 'component' && !existsSync(join(pdir, sc.component!))) throw new PluginError('invalid-manifest', `${entry.name}: screen ${sc.id} component ${sc.component} is missing from the signed package`);
    let scanned: ScannedPlugin = { manifest, handlers: {} };
    if (manifest.entrypoints?.handlers) {
      const mod = req(resolve(pdir, manifest.entrypoints.handlers));
      const exp = mod.default ?? mod;
      // A module may export the handler record directly, or a factory (fresh state per registration).
      scanned = typeof exp === 'function' ? { manifest, factory: exp as () => Record<string, HookHandler> } : { manifest, handlers: exp as Record<string, HookHandler> };
    }
    impls.push(scanned);
  }
  return impls;
}

/** Materializes a scanned plugin into a PluginImpl (factory modules produce fresh handler state per call). */
function materialize(s: ScannedPlugin): PluginImpl {
  return { manifest: s.manifest, handlers: s.factory ? s.factory() : (s.handlers ?? {}) };
}

/** Loads every plugin folder under `dir` (one level of folders). Bases come first so replacements can be wrapped.
 * Replacements (`extends`) are NOT wrapped here: the registry wraps them at register() against the base
 * actually registered there, which may carry runtime overrides (see registry.ts). ctx.base is set there. */
export function loadPlugins(dir: string = defaultPluginsDir(), opts: LoadOptions = {}): PluginImpl[] {
  // Registration order matters (step 2): a replacement requires its base to be registered first, so the list is
  // topologically ordered - bases first, then each plugin after the one it extends.
  const impls = scanPlugins(dir, opts).map(materialize);
  const byId = new Map(impls.map((i) => [i.manifest.id, i]));
  const ordered: PluginImpl[] = [], placed = new Set<string>();
  for (let pass = 0; placed.size < impls.length && pass <= impls.length; pass++)
    for (const i of impls) {
      if (placed.has(i.manifest.id)) continue;
      const ext = i.manifest.extends;
      if (ext && byId.has(ext) && !placed.has(ext)) continue;
      ordered.push(i); placed.add(i.manifest.id);
    }
  return ordered;
}

/**
 * The ONE verified catalogue, shared by every consumer and every branch registry (P1). The folder scan and the
 * package signature verifications happen ONCE per plugins-dir configuration and process, instead of each
 * consumer rescanning (builtin exports, the lockout factory, the auth-methods list and every loadPluginModule
 * adapter each used to rescan or re-verify). The catalogue is built lazily on first use and invalidated
 * explicitly through refreshPluginCatalogue() after any plugin-affecting action (archive import, uninstall,
 * enable/disable...) or the admin refresh endpoint. A spec that points IAM_PLUGINS_DIR/IAM_PLUGIN_TRUST at a
 * fixture gets its own catalogue: the cache key carries the resolved configuration.
 */
export interface PluginCatalogue {
  /** The plugins directory this catalogue was built from. */
  dir: string;
  /** Every verified plugin, fresh handler state per call. Scans + verifies ALL packages on first use. */
  impls(): PluginImpl[];
  /** One plugin by id (fresh handler state), or undefined. Scans on first use like impls(). */
  get(id: string): PluginImpl | undefined;
  /** Import any file of a verified package (handlers, engine, model, helpers). Only THIS package is read and
   * verified (lazily, once per catalogue): core adapters call this at module scope while the manifest module
   * is still evaluating (import cycle loader -> manifest -> profile/fields -> loader), so a full scan here
   * would touch not-yet-initialized code. Verification is exhaustive (P0-2), so every in-package file is
   * signature-covered. */
  module<T>(id: string, file: string): T;
}
export function pluginCatalogue(dir: string = defaultPluginsDir(), opts: LoadOptions = {}): PluginCatalogue {
  const trust = opts.trust ?? loadTrust(dir);
  const allowUnsigned = opts.allowUnsigned ?? process.env.IAM_PLUGIN_UNSIGNED === '1';
  const key = JSON.stringify([resolve(dir), trust, allowUnsigned]);
  const hit = catalogues().get(key);
  if (hit) return hit;
  let scanned: ScannedPlugin[] | undefined;
  let byId: Map<string, ScannedPlugin> | undefined;
  const verified = new Set<string>();
  const scan = () => {
    if (!scanned) { scanned = scanPlugins(dir, { trust, allowUnsigned }); byId = new Map(scanned.map((x) => [x.manifest.id, x])); }
    return byId!;
  };
  const req = createRequire(import.meta.url);
  const cat: PluginCatalogue = {
    dir,
    impls: () => { scan(); return scanned!.map(materialize); },
    get: (id) => { const x = scan().get(id); return x ? materialize(x) : undefined; },
    module: <T>(id: string, file: string): T => {
      if (file.includes('..') || file.startsWith('/') || file.startsWith('\\')) throw new PluginError('invalid-manifest', `${id}: invalid module path ${file}`);
      const pdir = join(dir, id);
      if (!verified.has(id)) {
        const mpath = join(pdir, 'manifest.json');
        if (!existsSync(mpath)) throw new PluginError('invalid-manifest', `${id}: manifest.json missing`);
        const manifest = JSON.parse(readFileSync(mpath, 'utf8')) as PluginManifest;
        if (manifest.id !== id) throw new PluginError('invalid-manifest', `${id}: manifest id must be the folder name`);
        verifyPluginPackage(pdir, manifest, trust, allowUnsigned);
        verified.add(id);
      }
      return req(resolve(pdir, file)) as T;
    },
  };
  catalogues().set(key, cat);
  return cat;
}
/** Drops every cached catalogue: the next read re-scans and re-verifies. Call after any plugin-affecting action. */
export function refreshPluginCatalogue(): void { catalogues().clear(); }
