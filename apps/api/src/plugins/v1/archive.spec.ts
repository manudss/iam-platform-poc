import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { unpackZip, installArchive, loadInstalledPlugin } from './archive.js';
import { PluginRegistry } from './registry.js';
import { MemoryMigrationStore, MemorySettingsStore } from './memory-stores.js';
import { defaultPluginsDir } from './loader.js';

/**
 * Plan step 8: signed archive import. Builds a tiny plugin in a temp publisher workspace (dev keys from
 * scripts/plugin-dev-setup.mjs, never committed), packs it with scripts/plugin-pack.mjs --zip, and imports
 * it into a temp server plugins dir. No bus, no Dolt: pure package verification.
 */
const req = createRequire(import.meta.url);
const pack = req(resolve(defaultPluginsDir(), '..', 'scripts', 'plugin-pack.mjs')) as {
  signPlugin: (dir: string, keys: Record<string, string>) => { id: string; files: number };
  packZip: (dir: string, out: string) => string;
};
const setup = req(resolve(defaultPluginsDir(), '..', 'scripts', 'plugin-dev-setup.mjs')) as { ensureDevSetup: (pluginsDir: string) => void };

describe('signed archive import (step 8)', () => {
  let root: string, pubPlugins: string, trust: Record<string, string>, keys: Record<string, string>;
  let n = 0;
  const freshSrv = () => { const d = join(root, `srv-${++n}`, 'plugins'); mkdirSync(d, { recursive: true }); return d; };
  const MANIFEST = JSON.stringify({ apiVersion: 'plugin/v3', id: 'acme-hello', version: '1.0.0', name: 'Acme Hello', publisher: 'iam-platform', kinds: ['profile'], hooks: [], settings: [], security: { signed: true } }, null, 2);
  const HANDLERS = 'export default {};\n';
  function makePlugin(mutate?: (dir: string) => void) {
    const dir = join(pubPlugins, 'acme-hello');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), MANIFEST);
    writeFileSync(join(dir, 'handlers.mjs'), HANDLERS);
    pack.signPlugin(dir, keys);           // sign first
    mutate?.(dir);                        // a tamperer edits AFTER signing
    const zip = join(root, `acme-hello-${Math.random().toString(36).slice(2)}.zip`);
    pack.packZip(dir, zip);
    return readFileSync(zip);
  }
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'iam-archive-'));
    pubPlugins = join(root, 'pub', 'plugins');
    mkdirSync(pubPlugins, { recursive: true });
    mkdirSync(join(root, 'pub', 'conf'), { recursive: true }); // ensureDevSetup expects the conf folder to exist (committed in the repo)
    // The key generator scans the plugins dir for publishers: seed one manifest first.
    mkdirSync(join(pubPlugins, 'acme-hello'), { recursive: true });
    writeFileSync(join(pubPlugins, 'acme-hello', 'manifest.json'), JSON.stringify({ id: 'acme-hello', publisher: 'iam-platform' }));
    setup.ensureDevSetup(pubPlugins);     // publisher keys + trust store, generated locally
    trust = JSON.parse(readFileSync(join(root, 'pub', 'conf', 'plugin-trust.json'), 'utf8'));
    const k = JSON.parse(readFileSync(join(root, 'pub', 'conf', 'plugin-dev-key.json'), 'utf8')); delete k._comment; keys = k;
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('unpackZip round-trips a packed archive', () => {
    const files = unpackZip(makePlugin());
    assert.equal(files.get('manifest.json')!.toString(), MANIFEST);
    assert.equal(files.get('handlers.mjs')!.toString(), HANDLERS);
  });

  it('rejects an entry whose name escapes the package', () => {
    const zip = makePlugin();
    const tampered = Buffer.from(zip.toString('latin1').split('handlers.mjs').join('..ndlers.mjs'), 'latin1'); // same length, now contains '..'
    assert.throws(() => unpackZip(tampered), /unsafe file name/);
  });

  it('installs a valid signed archive and the loader + registry take it', async () => {
    const srv = freshSrv(); const m = installArchive(srv, makePlugin(), { trust });
    assert.equal(m.id, 'acme-hello');
    assert.ok(existsSync(join(srv, 'acme-hello', 'signature.json')));
    const impl = loadInstalledPlugin(srv, 'acme-hello', { trust });
    const reg = new PluginRegistry(new MemoryMigrationStore(), new MemorySettingsStore(), () => {});
    reg.register(impl);
    assert.ok(reg.list('acme-demo').some((p) => p.id === 'acme-hello'));
  });

  it('refuses a file modified after signing', () => {
    const zip = makePlugin((dir) => writeFileSync(join(dir, 'handlers.mjs'), 'export default { evil: true };\n'));
    const srv = freshSrv(); assert.throws(() => installArchive(srv, zip, { trust }), /modified after signing/);
    assert.ok(!existsSync(join(srv, 'acme-hello')), 'no leftover folder after a refused import');
  });

  it('refuses an unsigned archive (decision 3: no unsigned code)', () => {
    // packZip always includes signature.json: strip its central-directory entry from a signed archive.
    const zip = makePlugin();
    let eocd = zip.length - 22; while (zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    const cd = zip.readUInt32LE(eocd + 16); let off = cd, start = -1, size = 0;
    for (let k = 0; k < zip.readUInt16LE(eocd + 10); k++) {
      const nameLen = zip.readUInt16LE(off + 28), extraLen = zip.readUInt16LE(off + 30), commentLen = zip.readUInt16LE(off + 32);
      const name = zip.subarray(off + 46, off + 46 + nameLen).toString();
      if (name === 'signature.json') { start = off; size = 46 + nameLen + extraLen + commentLen; break; }
      off += 46 + nameLen + extraLen + commentLen;
    }
    assert.ok(start >= 0 && size > 0);
    const bare = Buffer.concat([zip.subarray(0, start), zip.subarray(start + size)]);
    let e2 = bare.length - 22; while (bare.readUInt32LE(e2) !== 0x06054b50) e2--;
    bare.writeUInt16LE(bare.readUInt16LE(e2 + 8) - 1, e2 + 8); bare.writeUInt16LE(bare.readUInt16LE(e2 + 10) - 1, e2 + 10);
    bare.writeUInt32LE(bare.readUInt32LE(e2 + 12) - size, e2 + 12);
    assert.throws(() => installArchive(freshSrv(), bare, { trust }), /signature/);
  });

  it('refuses an untrusted publisher', () => {
    assert.throws(() => installArchive(freshSrv(), makePlugin(), { trust: {} }), /untrusted publisher/);
  });

  it('refuses to overwrite an existing plugin folder', () => {
    const srv = freshSrv();
    installArchive(srv, makePlugin(), { trust });
    assert.throws(() => installArchive(srv, makePlugin(), { trust }), /already present/);
  });
});
