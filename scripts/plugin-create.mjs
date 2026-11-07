#!/usr/bin/env node
/**
 * plugin-create: scaffolds a folder plugin under plugins/ (plan: every plugin is a signed folder).
 *
 *   node scripts/plugin-create.mjs <id> --name "Human name" --kind notifier [--publisher iam-platform] [--hook notify.send]
 *
 * Then edit manifest.json + handlers.mjs and sign everything with `node scripts/plugin-dev-setup.mjs` (dev)
 * or `node scripts/plugin-pack.mjs plugins/<id>` (production key).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [id, ...flags] = process.argv.slice(2);
const opt = (n, d) => { const i = flags.indexOf(`--${n}`); return i >= 0 ? flags[i + 1] : d; };
if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) { console.error('usage: plugin-create.mjs <id> [--name N] [--kind K] [--publisher P] [--hook H]'); process.exit(2); }
const dir = join(root, 'plugins', id);
if (existsSync(dir)) { console.error(`${id}: folder already exists`); process.exit(1); }
mkdirSync(dir, { recursive: true });
const kind = opt('kind', 'notifier'), hook = opt('hook', '');
const manifest = {
  apiVersion: 'plugin/v3', id, version: '1.0.0', name: opt('name', id), publisher: opt('publisher', 'iam-platform'),
  kinds: [kind], hooks: hook ? [{ name: hook, mode: 'async' }] : [], settings: [],
  entrypoints: { handlers: 'handlers.mjs' }, security: { signed: true },
};
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(dir, 'handlers.mjs'), `export default {\n${hook ? `  '${hook}': async (payload, ctx) => ({ received: payload.template ?? true }),\n` : ''}};\n`);
console.log(`created plugins/${id} (manifest.json, handlers.mjs) - sign it with node scripts/plugin-dev-setup.mjs`);
