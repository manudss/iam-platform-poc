import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { describe, it, before, after } from 'node:test';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { PluginsV1Module } from './plugins-v1.module.js';
import { PluginError, PluginRegistry } from './registry.js';
import { AuthGuard } from '../../auth/auth.guard.js';
import { defaultPluginsDir, loadPlugins, refreshPluginCatalogue } from './loader.js';
import { engineHttpError, resolveEngine } from './engines.js';
import { startTestBus, TestBus } from '../../testing/test-bus.js';

/** Step 3 acceptance: business plugins (SSO protocols, workflow engine, MCP gateway, connectors) serve
 * ENGINE slots through the registry - no core route is hardwired to a plugin's code.
 *
 *  - fail closed: with no provider enabled, a slot resolves to its refusing base and resolveEngine
 *    throws PluginError `no-provider` (the adapters map it to 404/503: the surface is DOWN);
 *  - live takeover: a plugin extending the base is picked by resolveEngine as soon as it is enabled,
 *    and disabling it returns the slot to the refusing base, without any core change or restart;
 *  - the 7 shipped business plugins all declare their base + slot, and the loader orders bases first.
 *
 * Runs against its OWN copy of the plugins dir (fresh dev keys): the repo tree is never touched. */
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const T = 'acme-demo';
const req = createRequire(import.meta.url);
const pack = req(resolve(defaultPluginsDir(), '..', 'scripts', 'plugin-pack.mjs')) as { signPlugin: (dir: string, keys: Record<string, string>) => unknown };

const SLOTS: { slot: string; base: string; plugin: string }[] = [
  { slot: 'sso.oidc', base: 'sso-oidc-base', plugin: 'oidc-provider' },
  { slot: 'sso.saml', base: 'sso-saml-base', plugin: 'saml-idp' },
  { slot: 'workflows.engine', base: 'workflows-engine-base', plugin: 'workflows-iga' },
  { slot: 'mcp.gateway', base: 'mcp-gateway-base', plugin: 'mcp-gateway' },
  { slot: 'connector.csv', base: 'connector-csv-base', plugin: 'csv-connector' },
  { slot: 'connector.scim', base: 'connector-scim-base', plugin: 'scim-connector' },
  { slot: 'connector.app', base: 'connector-app-base', plugin: 'app-connector' },
];

const writePlugin = (dir: string, id: string, manifest: Record<string, unknown>, handlers: string) => {
  const d = join(dir, id); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(d, 'handlers.mjs'), handlers);
};

const fakeEnginePlugin = (id: string, base: string, slot: string, kind: string, marker: string): [Record<string, unknown>, string] => [
  { apiVersion: 'plugin/v3', id, version: '1.0.0', name: `${id} (test engine)`, publisher: 'iam-platform',
    kinds: [kind], extends: base, provides: [slot], hooks: [], settings: [], // a replacement keeps its base's kind
    entrypoints: { handlers: 'handlers.mjs' }, security: { signed: true } },
  `export const marker = '${marker}';\nexport default {};\n`,
];

describe('business plugins serve registry engine slots (step 3 acceptance)', () => {
  let app: INestApplication, reg: PluginRegistry, pluginsDir: string, keys: Record<string, string>;
  const envSave = { d: process.env.IAM_PLUGINS_DIR, t: process.env.IAM_PLUGIN_TRUST, a: process.env.IAM_API_ADMIN_TOKEN, g: process.env.IAM_AUTH_GATE_TOKEN };
  let root: string;
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'iam-bizslots-'));
    pluginsDir = join(root, 'plugins');
    cpSync(defaultPluginsDir(), pluginsDir, { recursive: true });
    // Plugin code anchors its dependency resolution at its own package.json and resolution walks up:
    // give the copied tree the real shared install (step 4).
    symlinkSync(resolve(defaultPluginsDir(), '..', 'node_modules'), join(root, 'node_modules'), 'dir');
    mkdirSync(join(root, 'conf'), { recursive: true });
    const setup = req(resolve(defaultPluginsDir(), '..', 'scripts', 'plugin-dev-setup.mjs')) as { ensureDevSetup: (d: string) => void };
    setup.ensureDevSetup(pluginsDir);
    const k = JSON.parse(readFileSync(join(root, 'conf', 'plugin-dev-key.json'), 'utf8')); delete k._comment; keys = k;
    process.env.IAM_PLUGINS_DIR = pluginsDir;
    process.env.IAM_PLUGIN_TRUST = join(root, 'conf', 'plugin-trust.json');
    process.env.IAM_API_ADMIN_TOKEN = 'x'.repeat(20); process.env.IAM_AUTH_GATE_TOKEN = 'gate-token-1234';
    const mod = await Test.createTestingModule({ imports: [PluginsV1Module] }).overrideGuard(AuthGuard).useValue({ canActivate: () => true }).compile();
    app = mod.createNestApplication(); await app.init();
    reg = app.get(PluginRegistry);
  });
  after(async () => {
    await app.close();
    process.env.IAM_PLUGINS_DIR = envSave.d; process.env.IAM_PLUGIN_TRUST = envSave.t;
    process.env.IAM_API_ADMIN_TOKEN = envSave.a; process.env.IAM_AUTH_GATE_TOKEN = envSave.g;
    refreshPluginCatalogue();
    rmSync(root, { recursive: true, force: true });
  });

  const engineOf = (slot: string, scope: object) =>
    resolveEngine<{ marker?: string; by: string }>(async () => reg, T, slot, 'handlers.mjs', ((mod: { marker?: string }, impl: { manifest: { id: string } }) => ({ marker: mod.marker, by: impl.manifest.id })) as never, scope);

  it('1. every business slot fails closed with no provider enabled (the refusing base never serves)', async () => {
    for (const { slot, base } of SLOTS) {
      const impl = reg.resolve(T, slot);
      assert.equal(impl.manifest.id, base, `${slot}: with nothing enabled the slot holds its refusing base`);
      assert.equal(impl.manifest.base, true);
      const err = await engineOf(slot, {}).then(() => null, (e: unknown) => e);
      assert.ok(err instanceof PluginError && (err as PluginError).code === 'no-provider', `${slot}: resolveEngine refuses to serve the base`);
      assert.throws(() => engineHttpError(err), (e: unknown) => e instanceof HttpException && (e as HttpException).getStatus() === 404, `${slot}: adapters answer 404 (surface down, not silently served)`);
    }
  });

  it('2. a replacement takes over its slot live; disabling returns the slot to the base', async () => {
    const scope = {}; // one adapter instance
    for (const { slot, base, kind } of [{ slot: 'sso.oidc', base: 'sso-oidc-base', kind: 'connector' }, { slot: 'workflows.engine', base: 'workflows-engine-base', kind: 'workflow' }]) {
      const id = `test-${slot.replace(/\./g, '-')}-engine`;
      const [manifest, handlers] = fakeEnginePlugin(id, base, slot, kind, `engine-of-${id}`);
      writePlugin(pluginsDir, id, manifest, handlers);
      pack.signPlugin(join(pluginsDir, id), keys);
      refreshPluginCatalogue();
      reg.register(loadPlugins(pluginsDir).find((i) => i.manifest.id === id)!);
      await reg.install(T, id, {});
      await reg.enable(T, id, {});
      const first = await engineOf(slot, scope);
      assert.equal(first.by, id, `${slot}: the enabled replacement serves the slot`);
      assert.equal(first.marker, `engine-of-${id}`, 'the engine comes from the plugin folder, not from core');
      const again = await engineOf(slot, scope);
      assert.equal(again, first, 'the adapter-scoped cache reuses the live provider engine');
      const otherScope = await engineOf(slot, {});
      assert.notEqual(otherScope, first, 'another adapter instance gets its own engine (no dep leak across instances)');
      await reg.disable(T, id);
      assert.equal(reg.resolve(T, slot).manifest.id, base, 'disabled: the slot is back on its refusing base');
      await assert.rejects(() => engineOf(slot, scope), (e: unknown) => e instanceof PluginError && (e as PluginError).code === 'no-provider', 'disabled: fail closed again, no fallback to the old engine');
      await reg.enable(T, id, {});
      assert.equal((await engineOf(slot, scope)).by, id, 're-enabled: the replacement serves again without a restart');
      await reg.disable(T, id); // leave the slot on its base for the next test
    }
  });

  it('3. the 7 shipped business plugins declare their base and slot, bases load first', () => {
    const all = loadPlugins(pluginsDir);
    const byId = new Map(all.map((i) => [i.manifest.id, i]));
    for (const { slot, base, plugin } of SLOTS) {
      const b = byId.get(base), p = byId.get(plugin);
      assert.ok(b, `${base} is shipped`); assert.ok(p, `${plugin} is shipped`);
      assert.equal(b!.manifest.base, true); assert.equal(b!.manifest.provides?.[0], slot);
      assert.equal(p!.manifest.extends, base, `${plugin} extends its base`);
      assert.deepEqual(p!.manifest.provides, [slot], `${plugin} provides exactly its slot`);
      assert.ok(all.indexOf(b!) < all.indexOf(p!), `${base} loads before ${plugin} (topological order)`);
    }
  });
});
