import { inflateRawSync } from 'node:zlib';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HOOKS } from './hooks.js';
import { PluginManifest, validateManifest } from './manifest.js';
import { PluginError } from './registry.js';
import { LoadOptions, loadPlugins, verifyPackage } from './loader.js';

/**
 * Signed archive import (plan step 8): an administrator uploads a zip produced by
 * `node scripts/plugin-pack.mjs plugins/<id> --zip out.zip`. The package is unpacked in a staging
 * folder, validated with the SAME manifest rules as the loader, verified against the trust store
 * (hashes + Ed25519 signature, decision 3: no unsigned code), then moved into the plugins folder and
 * registered into the running registries. A restart also picks it up everywhere (the loader scans the
 * folder tree at boot). Per-tenant install/enable stays a separate, granted step (decision 6).
 */

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024, MAX_FILES = 64, MAX_FILE_BYTES = 4 * 1024 * 1024, MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

/** Minimal zip reader (stored and deflated entries): the counterpart of the writer in scripts/plugin-pack.mjs. */
export function unpackZip(buf: Buffer): Map<string, Buffer> {
  if (buf.length > MAX_ARCHIVE_BYTES) throw new PluginError('invalid-archive', 'archive too large (2 MB max)');
  // End of central directory: scan the tail for its signature (no comment is written by pack, but tolerate one).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new PluginError('invalid-archive', 'not a zip archive (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_FILES) throw new PluginError('invalid-archive', `too many files (${MAX_FILES} max)`);
  let off = buf.readUInt32LE(eocd + 16);
  if (off >= eocd) throw new PluginError('invalid-archive', 'central directory offset out of bounds');
  const out = new Map<string, Buffer>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (off + 46 > eocd + 22 || off + 46 > buf.length) throw new PluginError('invalid-archive', 'truncated central directory');
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new PluginError('invalid-archive', 'corrupt central directory');
    const method = buf.readUInt16LE(off + 10), flags = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 20), size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    if (off + 46 + nameLen + extraLen + commentLen > buf.length) throw new PluginError('invalid-archive', 'truncated central directory entry');
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) throw new PluginError('invalid-archive', 'encrypted entries are not supported');
    if (flags & 0x8) throw new PluginError('invalid-archive', 'data descriptors are not supported (repack with scripts/plugin-pack.mjs)');
    if (!name || name.endsWith('/') || !SAFE.test(name) || name.includes('..') || name.includes('\\') || name.includes('//')) throw new PluginError('invalid-archive', `unsafe file name ${JSON.stringify(name)}`);
    if (size > MAX_FILE_BYTES) throw new PluginError('invalid-archive', `${name} too large (4 MB max per file)`);
    total += size; if (total > MAX_TOTAL_BYTES) throw new PluginError('invalid-archive', 'unpacked content too large (8 MB max)');
    if (localOff + 30 > buf.length) throw new PluginError('invalid-archive', 'local header offset out of bounds');
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new PluginError('invalid-archive', 'corrupt local header');
    const lNameLen = buf.readUInt16LE(localOff + 26), lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) throw new PluginError('invalid-archive', `${name}: truncated data`);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    // Real decompression cap (P0-7): the declared size bounds the output buffer, so a lying header cannot
    // inflate past it (zip bomb stops at the cap instead of expanding in memory first).
    try { data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: size }) : (() => { throw new PluginError('invalid-archive', `unsupported compression method ${method}`); })(); }
    catch (e) { if (e instanceof PluginError) throw e; throw new PluginError('invalid-archive', `cannot inflate ${name}`); }
    if (data.length !== size) throw new PluginError('invalid-archive', `${name}: size mismatch`);
    out.set(name, data);
  }
  return out;
}

/**
 * Verifies and installs an archive into `pluginsDir` (staging -> verify -> atomic rename).
 * Returns the installed manifest. Refuses to overwrite an existing plugin folder.
 */
export function installArchive(pluginsDir: string, buf: Buffer, opts: LoadOptions = {}): PluginManifest {
  const files = unpackZip(buf);
  // Accept either a flat package (manifest.json at the root) or one single top-level folder named after the plugin.
  let prefix = '';
  if (!files.has('manifest.json')) {
    const tops = new Set([...files.keys()].map((n) => n.split('/')[0]));
    if (tops.size !== 1) throw new PluginError('invalid-archive', 'manifest.json must be at the archive root or under a single top-level folder');
    prefix = [...tops][0] + '/';
    if (!files.has(prefix + 'manifest.json')) throw new PluginError('invalid-archive', 'manifest.json missing');
  }
  let manifest: PluginManifest;
  try { manifest = JSON.parse(files.get(prefix + 'manifest.json')!.toString('utf8')) as PluginManifest; }
  catch { throw new PluginError('invalid-manifest', 'manifest.json is not valid JSON'); }
  if (prefix && prefix !== `${manifest.id}/`) throw new PluginError('invalid-manifest', `top-level folder must be the plugin id (${manifest.id})`);
  const errs = validateManifest(manifest, HOOKS);
  if (errs.length) throw new PluginError('invalid-manifest', `${manifest.id ?? '?'}: ${errs.join('; ')}`);
  if (!SAFE.test(manifest.id) || manifest.id.includes('/')) throw new PluginError('invalid-manifest', 'invalid plugin id');
  const target = resolve(pluginsDir, manifest.id);
  if (existsSync(target)) throw new PluginError('already-exists', `plugin ${manifest.id} is already present (remove it first)`);
  // Every archived file must sit under the package root; signature.json must be part of the archive.
  if (!files.has(prefix + 'signature.json')) throw new PluginError('signature-invalid', 'signature.json missing (sign the plugin with scripts/plugin-pack.mjs)');
  const staging = resolve(pluginsDir, `.staging-${randomBytes(6).toString('hex')}`);
  try {
    for (const [name, data] of files) {
      const rel = name.slice(prefix.length);
      if (!rel) continue;
      const dest = join(staging, rel);
      mkdirSync(resolve(dest, '..'), { recursive: true });
      writeFileSync(dest, data);
    }
    // Decision 3: signature is MANDATORY for an archive import, whatever the manifest says.
    const sigErrs = verifyPackage(staging, opts.trust ?? loadTrustFor(pluginsDir));
    if (sigErrs.length) throw new PluginError('signature-invalid', `${manifest.id}: ${sigErrs.join('; ')}`);
    mkdirSync(pluginsDir, { recursive: true });
    renameSync(staging, target);
  } catch (e) { rmSync(staging, { recursive: true, force: true }); throw e; }
  return manifest;
}

/** Trust store for an archive import: same source as the loader (env or conf/plugin-trust.json next to the plugins dir). */
function loadTrustFor(pluginsDir: string): Record<string, string> {
  if (process.env.IAM_PLUGIN_TRUST && existsSync(resolve(process.env.IAM_PLUGIN_TRUST))) return JSON.parse(readFileSync(resolve(process.env.IAM_PLUGIN_TRUST), 'utf8')) as Record<string, string>;
  const path = resolve(pluginsDir, '..', 'conf', 'plugin-trust.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>) : {};
}

/** Loads the freshly installed plugin from disk (full loader checks: manifest, signature, handlers, replacement wrapping). */
export function loadInstalledPlugin(pluginsDir: string, id: string, opts: LoadOptions = {}) {
  const impl = loadPlugins(pluginsDir, opts).find((i) => i.manifest.id === id);
  if (!impl) throw new PluginError('invalid-manifest', `${id}: the loader refused the installed folder`);
  return impl;
}

/** Removes a plugin folder that was imported by mistake. Only folders that pass a manifest read are touched. */
export function removeInstalledPlugin(pluginsDir: string, id: string) {
  if (!SAFE.test(id) || id.includes('/')) throw new PluginError('invalid-manifest', 'invalid plugin id');
  const dir = resolve(pluginsDir, id);
  if (!existsSync(join(dir, 'manifest.json'))) throw new PluginError('unknown-plugin', `no plugin folder ${id}`);
  rmSync(dir, { recursive: true, force: true });
}
