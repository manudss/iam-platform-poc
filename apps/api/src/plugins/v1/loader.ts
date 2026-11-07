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
  if (!existsSync(path)) {
    // No committed secrets: dev signing keys are generated locally, never committed (decision 3 still applies:
    // every plugin is signature-verified against this local trust store). Production ships its own trust store.
    const setup = createRequire(import.meta.url)(resolve(dir, '..', 'scripts', 'plugin-dev-setup.mjs')) as { ensureDevSetup: (d: string) => void };
    setup.ensureDevSetup(dir);
  }
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

/** Loads every plugin folder under `dir` (one level of folders). Bases come first so replacements can be wrapped. */
export function loadPlugins(dir: string = defaultPluginsDir(), opts: LoadOptions = {}): PluginImpl[] {
  const trust = opts.trust ?? loadTrust(dir);
  const allowUnsigned = opts.allowUnsigned ?? process.env.IAM_PLUGIN_UNSIGNED === '1';
  const req = createRequire(import.meta.url);
  const impls: PluginImpl[] = [];
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
    // Package security (decision 3): no sandbox, but a signed, integrity-checked package. The signature is
    // verified whenever the manifest asks for it (security.signed), the plugin ships code, or a signature is present.
    const mustVerify = manifest.security?.signed === true || !!manifest.entrypoints?.handlers || existsSync(join(pdir, 'signature.json'));
    if (mustVerify) {
      const sigErrs = verifyPackage(pdir, trust);
      if (sigErrs.length && !(allowUnsigned && sigErrs.every((e) => e.startsWith('signature.json missing')))) throw new PluginError('signature-invalid', `${entry.name}: ${sigErrs.join('; ')}`);
    }
    let handlers: Record<string, HookHandler> = {};
    if (manifest.entrypoints?.handlers) {
      const mod = req(resolve(pdir, manifest.entrypoints.handlers));
      const exp = mod.default ?? mod;
      // A module may export the handler record directly, or a factory (fresh state per registration).
      handlers = typeof exp === 'function' ? (exp() as Record<string, HookHandler>) : (exp as Record<string, HookHandler>);
    }
    impls.push({ manifest, handlers });
  }
  // Replacements (`extends`) are NOT wrapped here: the registry wraps them at register() against the base
  // actually registered there, which may carry runtime overrides (see registry.ts). ctx.base is set there.
  return impls;
}
