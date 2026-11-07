#!/usr/bin/env node
/**
 * plugin-extend: scaffolds a REPLACEMENT plugin from a base one (decision 2: the base is replaceable).
 * The new plugin keeps the base's hooks, settings and slots as a superset (checked by plugin-validate.mjs);
 * its handlers start as thin wrappers over ctx.base so it behaves like the base until customized.
 *
 *   node scripts/plugin-extend.mjs <base-id> <new-id> [--publisher iam-platform]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [baseId, id, ...flags] = process.argv.slice(2);
const opt = (n, d) => { const i = flags.indexOf(`--${n}`); return i >= 0 ? flags[i + 1] : d; };
if (!baseId || !id || !/^[a-z][a-z0-9-]*$/.test(id)) { console.error('usage: plugin-extend.mjs <base-id> <new-id> [--publisher P]'); process.exit(2); }
const baseDir = join(root, 'plugins', baseId), dir = join(root, 'plugins', id);
if (!existsSync(join(baseDir, 'manifest.json'))) { console.error(`${baseId}: no such base plugin under plugins/`); process.exit(1); }
if (existsSync(dir)) { console.error(`${id}: folder already exists`); process.exit(1); }
const base = JSON.parse(readFileSync(join(baseDir, 'manifest.json'), 'utf8'));
if (!base.base) { console.error(`${baseId} is not a base plugin (base: true)`); process.exit(1); }
const manifest = { ...base, id, name: opt('name', `${base.name} (replacement)`), publisher: opt('publisher', base.publisher), base: false, extends: baseId };
delete manifest.install; // a replacement installs nothing itself: the base already did
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(dir + '/handlers.mjs', `// Replacement of ${baseId}: every handler delegates to the base until you customize it.\nexport default {\n${(base.hooks ?? []).map((h) => `  '${h.name}': (payload, ctx) => ctx.base['${h.name}'](payload, ctx),`).join('\n')}\n};\n`);
console.log(`created plugins/${id} extending ${baseId} - sign it with node scripts/plugin-dev-setup.mjs`);
