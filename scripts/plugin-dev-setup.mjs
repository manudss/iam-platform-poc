#!/usr/bin/env node
/**
 * plugin-dev-setup: generates the local development signing keys (never committed), writes the trust store
 * conf/plugin-trust.json, and signs every plugin under plugins/. Run it after a fresh clone:
 *
 *   node scripts/plugin-dev-setup.mjs
 *
 * The API loader (apps/api/src/plugins/v1/loader.ts) also runs it automatically when the trust store is
 * missing, so a plain `npm test` or `node dist/main.js` just works on a fresh clone.
 * The private keys live in conf/plugin-dev-key.json (gitignored, DEMO ONLY - a dev key only ever verifies
 * packages signed on the same machine). Production ships its own trust store and signs plugins with its own
 * keys (scripts/plugin-pack.mjs --key).
 */
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signPlugin } from './plugin-pack.mjs';

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function writeAtomic(path, content, mode) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, mode === undefined ? {} : { mode });
  renameSync(tmp, path);
}

/** Serializes the one-time setup: parallel test workers must not race key generation and signing. */
function withLock(confDir, fn) {
  const lock = join(confDir, '.plugin-dev-setup.lock');
  for (let i = 0; ; i++) {
    try { mkdirSync(lock); break; } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      if (i > 300) { try { rmSync(lock, { recursive: true }); } catch { /* another process beat us */ } continue; } // ~30s: stale lock
      sleep(100);
    }
  }
  try { fn(); } finally { try { rmSync(lock, { recursive: true }); } catch { /* already gone */ } }
}

export function ensureDevSetup(pluginsDir) {
  const confDir = resolve(pluginsDir, '..', 'conf');
  // The demo Dockerfile build stage copies only apps/api + scripts + plugins, so conf/ may not exist there yet.
  mkdirSync(confDir, { recursive: true });
  const keyPath = join(confDir, 'plugin-dev-key.json');
  const trustPath = join(confDir, 'plugin-trust.json');
  // Signing always re-runs under the lock (source files change during development); only key generation is one-time.
  withLock(confDir, () => {
  const privateKeys = existsSync(keyPath) ? JSON.parse(readFileSync(keyPath, 'utf8')) : {};
  const trust = existsSync(trustPath) ? JSON.parse(readFileSync(trustPath, 'utf8')) : {};
  const pubs = new Set();
  for (const e of readdirSync(pluginsDir, { withFileTypes: true })) {
    const mp = join(pluginsDir, e.name, 'manifest.json');
    if (e.isDirectory() && existsSync(mp)) pubs.add(JSON.parse(readFileSync(mp, 'utf8')).publisher);
  }
  let changed = false;
  for (const p of pubs) {
    if (!privateKeys[p]) {
      const pair = generateKeyPairSync('ed25519', { publicKeyEncoding: { format: 'der', type: 'spki' }, privateKeyEncoding: { format: 'der', type: 'pkcs8' } });
      privateKeys[p] = pair.privateKey.toString('base64');
      trust[p] = pair.publicKey.toString('base64');
      changed = true;
    } else if (!trust[p]) {
      trust[p] = createPublicKey({ key: Buffer.from(privateKeys[p], 'base64'), format: 'der', type: 'pkcs8' }).export({ format: 'der', type: 'spki' }).toString('base64');
      changed = true;
    }
  }
  if (!existsSync(keyPath) || changed) writeAtomic(keyPath, JSON.stringify(privateKeys, null, 2) + '\n', 0o600);
  if (changed || !existsSync(trustPath)) writeAtomic(trustPath, JSON.stringify(trust, null, 2) + '\n');
  for (const e of readdirSync(pluginsDir, { withFileTypes: true })) {
    const pdir = join(pluginsDir, e.name);
    if (e.isDirectory() && existsSync(join(pdir, 'manifest.json'))) signPlugin(pdir, privateKeys);
  }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plugins');
  ensureDevSetup(dir);
  console.log(`dev keys + trust store ready (conf/plugin-dev-key.json, conf/plugin-trust.json), plugins signed under ${dir}`);
}
