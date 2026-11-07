#!/usr/bin/env node
/**
 * plugin-validate: checks plugin folders - manifest validity (same rules as the loader), package signature
 * against the trust store, and extension compatibility (a replacement must extend a registered base and keep
 * its hooks and settings as a superset, so enabling it never breaks a working slot).
 *
 *   node scripts/plugin-validate.mjs [plugin-dir ...]   # default: every folder under plugins/
 *
 * Requires a build first (npm run build in apps/api): the manifest/signature rules live in the API sources,
 * single source of truth.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'apps', 'api', 'dist', 'plugins', 'v1');
if (!existsSync(join(dist, 'manifest.js'))) { console.error('run `npm run build` in apps/api first (validation rules are compiled from the API sources)'); process.exit(2); }
const { validateManifest } = await import(join(dist, 'manifest.js'));
const { verifyPackage } = await import(join(dist, 'loader.js'));
const { HOOKS } = await import(join(dist, 'hooks.js'));

const dirs = process.argv.slice(2).length ? process.argv.slice(2).map((d) => resolve(d))
  : readdirSync(join(root, 'plugins'), { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_') && e.name !== 'examples').map((e) => join(root, 'plugins', e.name));

const trustPath = process.env.IAM_PLUGIN_TRUST ?? join(root, 'conf', 'plugin-trust.json');
const trust = existsSync(trustPath) ? JSON.parse(readFileSync(trustPath, 'utf8')) : {};

let bad = 0;
const manifests = new Map();
for (const dir of dirs) {
  const mpath = join(dir, 'manifest.json');
  if (!existsSync(mpath)) { console.error(`${dir}: manifest.json missing`); bad++; continue; }
  const m = JSON.parse(readFileSync(mpath, 'utf8'));
  manifests.set(m.id ?? dir, { m, dir });
  const errs = validateManifest(m, HOOKS);
  if (m.id !== readdirSync && m.id !== undefined && m.id !== dir.split('/').pop()) errs.push('manifest id must be the folder name');
  for (const e of errs) { console.error(`${m.id ?? dir}: ${e}`); bad++; }
  const sigErrs = verifyPackage(dir, trust);
  for (const e of sigErrs) { console.error(`${m.id ?? dir}: ${e}`); bad++; }
}
// Extension compatibility (decision: a replacement keeps the base's hooks and settings as a superset).
for (const { m } of manifests.values()) {
  if (!m.extends) continue;
  const base = manifests.get(m.extends);
  if (!base) { console.error(`${m.id}: base plugin ${m.extends} is not present`); bad++; continue; }
  if (!base.m.base) { console.error(`${m.id}: ${m.extends} is not a base plugin`); bad++; continue; }
  const bh = new Set((base.m.hooks ?? []).map((h) => h.name));
  for (const h of bh) if (!(m.hooks ?? []).some((x) => x.name === h)) { console.error(`${m.id}: missing base hook ${h}`); bad++; }
  const bs = new Set((base.m.settings ?? []).map((s) => s.key));
  for (const k of bs) if (!(m.settings ?? []).some((x) => x.key === k)) { console.error(`${m.id}: missing base setting ${k}`); bad++; }
}
if (bad) { console.error(`${bad} problem(s)`); process.exit(1); }
console.log(`ok: ${dirs.length} plugin(s) valid`);
