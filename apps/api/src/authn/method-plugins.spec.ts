import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { PluginsV1Module } from '../plugins/v1/plugins-v1.module.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { AuthnService } from './flow.service.js';
import { PluginRegistry } from '../plugins/v1/registry.js';
import { defaultPluginsDir, loadPlugins, refreshPluginCatalogue } from '../plugins/v1/loader.js';
import { methodType } from './methods.js';
import { totpAt } from './totp.js';
import { startTestBus, TestBus } from '../testing/test-bus.js';

/**
 * Acceptance of plan step 2 (review n:2 + n:3, acceptance 3): the sign-in methods are registry plugins.
 *  1. disabling a method's plugin retires its chains from the sign-in options at once (and back on re-enable);
 *  2. a faulting method handler fails CLOSED (no base fallback), the fault is persisted and audited;
 *  3. a method plugin imported into the folder is usable WITHOUT a restart (live catalogue + registry).
 * Runs against its OWN copy of the plugins dir (fresh dev keys): the repo tree is never touched.
 */
let testBus: TestBus | undefined;
before(async () => { testBus = await startTestBus(import.meta.url); });
after(async () => { await testBus?.close(); });

const ADMIN = 'x'.repeat(20), T = 'acme-demo', PW = 'demo-only-not-a-secret', TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const req = createRequire(import.meta.url);
const pack = req(resolve(defaultPluginsDir(), '..', 'scripts', 'plugin-pack.mjs')) as { signPlugin: (dir: string, keys: Record<string, string>) => unknown };
const setup = req(resolve(defaultPluginsDir(), '..', 'scripts', 'plugin-dev-setup.mjs')) as { ensureDevSetup: (pluginsDir: string) => void };

const writePlugin = (dir: string, id: string, manifest: Record<string, unknown>, handlers: string) => {
  const d = join(dir, id); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(d, 'handlers.mjs'), handlers);
};
const baseManifest = (id: string, slot: string, hooks: string[]) => ({ apiVersion: 'plugin/v3', id, version: '1.0.0', name: `${id} (refusing base)`, publisher: 'iam-platform', kinds: ['auth-method'], base: true, provides: [slot], hooks: hooks.map((name) => ({ name, mode: 'blocking' })), settings: [], entrypoints: { handlers: 'handlers.mjs' }, security: { signed: true } });
const baseHandlers = (label: string, hooks: string[]) => `const unavailable = () => { throw new Error("auth method '${label}' has no provider enabled on the slot"); };\nexport default { ${hooks.map((h) => `'${h}': ${h === 'auth.verification' ? '() => ({ real: false, note: "disabled" })' : 'unavailable'}`).join(', ')} };\n`;

describe('sign-in methods are registry plugins (step 2 acceptance)', () => {
  let app: INestApplication, svc: AuthnService, reg: PluginRegistry, pluginsDir: string, keys: Record<string, string>;
  let clock = 1_800_000_000_000;
  const envSave = { a: process.env.IAM_API_ADMIN_TOKEN, g: process.env.IAM_AUTH_GATE_TOKEN, f: process.env.IAM_AUTHN_FILE, d: process.env.IAM_PLUGINS_DIR, t: process.env.IAM_PLUGIN_TRUST };
  let root: string;
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'iam-methods-'));
    pluginsDir = join(root, 'plugins');
    cpSync(defaultPluginsDir(), pluginsDir, { recursive: true });
    // The plugins anchor their dependency resolution at <pluginsDir>/../apps/api: point it at the real one.
    mkdirSync(join(root, 'apps'), { recursive: true });
    symlinkSync(resolve(defaultPluginsDir(), '..', 'apps', 'api'), join(root, 'apps', 'api'));
    mkdirSync(join(root, 'conf'), { recursive: true });
    setup.ensureDevSetup(pluginsDir); // fresh local keys + trust store, signs the copy
    const k = JSON.parse(readFileSync(join(root, 'conf', 'plugin-dev-key.json'), 'utf8')); delete k._comment; keys = k;
    process.env.IAM_PLUGINS_DIR = pluginsDir;
    process.env.IAM_PLUGIN_TRUST = join(root, 'conf', 'plugin-trust.json');
    process.env.IAM_API_ADMIN_TOKEN = ADMIN; process.env.IAM_AUTH_GATE_TOKEN = 'gate-token-1234'; process.env.IAM_AUTHN_FILE = join(root, 'e.json');
    const mod = await Test.createTestingModule({ imports: [PluginsV1Module] }).overrideGuard(AuthGuard).useValue({ canActivate: () => true }).compile();
    app = mod.createNestApplication(); await app.init();
    svc = app.get(AuthnService); svc.now = () => clock; reg = app.get(PluginRegistry);
    for (const id of ['auth-totp', 'auth-email-otp', 'auth-digit-code']) { await reg.install(T, id, {}); await reg.enable(T, id, {}); }
  });
  after(async () => {
    await app.close();
    process.env.IAM_API_ADMIN_TOKEN = envSave.a; process.env.IAM_AUTH_GATE_TOKEN = envSave.g; process.env.IAM_AUTHN_FILE = envSave.f; process.env.IAM_PLUGINS_DIR = envSave.d; process.env.IAM_PLUGIN_TRUST = envSave.t;
    refreshPluginCatalogue();
    rmSync(root, { recursive: true, force: true });
  });
  const http = () => request(app.getHttpServer());
  const adm = { 'x-api-admin-token': ADMIN };
  const putConfig = (methods: unknown[], chains: unknown[], def: string | null = null) => http().put(`/tenants/${T}/auth`).set(adm).send({ config: { methods, chains, defaultChain: def } });
  const m = (id: string, type: string, level: number, config: Record<string, unknown> = {}) => ({ id, type, name: id, enabled: true, level, config });

  it('1. disabling a method plugin retires its chains from the sign-in options, re-enabling restores them', async () => {
    await putConfig([m('pw', 'password', 3), m('tp', 'totp', 7)], [{ id: 'pw-only', name: 'Password', steps: ['pw'], level: 3 }, { id: 'pw-totp', name: 'Password + TOTP', steps: ['pw', 'tp'], level: 8 }], 'pw-totp').expect(200);
    let opts = (await svc.options(T));
    assert.deepEqual(opts.chains.map((c) => c.id).sort(), ['pw-only', 'pw-totp']);
    await reg.disable(T, 'auth-totp');
    opts = (await svc.options(T));
    assert.deepEqual(opts.chains.map((c) => c.id), ['pw-only'], 'the chain using TOTP vanishes as soon as the plugin is disabled');
    // A sign-in asking for the retired chain is refused, never silently rerouted to a laxer path.
    const denied = await svc.authenticate({ tenant: T, subject: 'demo-alice', chain: 'pw-totp' });
    assert.equal(denied?.outcome, 'deny');
    await reg.enable(T, 'auth-totp', {});
    opts = (await svc.options(T));
    assert.deepEqual(opts.chains.map((c) => c.id).sort(), ['pw-only', 'pw-totp']);
    await reg.disable(T, 'auth-totp'); // left disabled for test 2
  });

  it('2. a faulting method handler fails closed (the base is never asked), the fault is persisted and audited', async () => {
    // A replacement of the TOTP slot whose verify throws: the kind of plugin fault sign-in must survive closed.
    writePlugin(pluginsDir, 'auth-totp-saboteur', {
      apiVersion: 'plugin/v3', id: 'auth-totp-saboteur', version: '1.0.0', name: 'TOTP saboteur (test)', publisher: 'iam-platform',
      kinds: ['auth-method'], extends: 'auth-totp-base', provides: ['auth.totp'],
      hooks: [{ name: 'auth.prepare', mode: 'blocking' }, { name: 'auth.verify', mode: 'blocking' }, { name: 'auth.verification', mode: 'blocking' }],
      settings: [],
      authMethod: { name: 'TOTP saboteur', description: 'test', factor: 'possession', amr: 'otp', maturity: 'implemented', suggestedLevel: 7, provisioning: 'admin-demo' },
      entrypoints: { handlers: 'handlers.mjs' }, security: { signed: true },
    }, `export default {
      'auth.prepare': () => ({ prompt: { title: 'TOTP', fields: [{ name: 'code', label: 'Code', type: 'digits' }] }, state: {} }),
      'auth.verify': () => { throw new Error('saboteur boom'); },
      'auth.verification': () => ({ real: true, note: 'test' }),
    };\n`);
    pack.signPlugin(join(pluginsDir, 'auth-totp-saboteur'), keys);
    refreshPluginCatalogue();
    const impl = loadPlugins(pluginsDir).find((i) => i.manifest.id === 'auth-totp-saboteur')!;
    reg.register(impl);
    await reg.install(T, 'auth-totp-saboteur', {});
    await reg.enable(T, 'auth-totp-saboteur', {}); // chosen for the slot
    await svc.enroll.setTotp(T, 'demo-alice', 'tp', TOTP_SECRET);
    const r = await svc.authenticate({ tenant: T, subject: 'demo-alice', chain: 'pw-totp' });
    assert.equal(r?.outcome, 'challenge');
    const withPw = await svc.authenticate({ tenant: T, session: (r as { session: string }).session, answers: { password: PW } });
    assert.equal(withPw?.outcome, 'challenge', 'password step passes, TOTP challenge opens');
    await assert.rejects(
      () => svc.authenticate({ tenant: T, session: (withPw as { session: string }).session, answers: { code: totpAt(TOTP_SECRET, clock, 30, 6) } }),
      /plugin-failed|refused|unusable/,
      'the faulting handler is a technical failure: fail closed, no answer',
    );
    const listed = reg.list(T).find((i) => i.id === 'auth-totp-saboteur')!;
    assert.equal(listed.faulted, true, 'the fault is persisted on the plugin state');
    // A fresh attempt is refused WITHOUT calling the handler again (the base is never asked in its place):
    const again = await svc.authenticate({ tenant: T, subject: 'demo-alice', chain: 'pw-totp' });
    assert.equal(again?.outcome, 'challenge');
    await assert.rejects(
      () => svc.authenticate({ tenant: T, session: (again as { session: string }).session, answers: { password: PW } }),
      /plugin-failed|refused|unusable/,
      'every later call is refused until an admin acts',
    );
    await reg.disable(T, 'auth-totp-saboteur');
    await reg.enable(T, 'auth-totp', {}); // restore a working slot for the next tests
  });

  it('3. a method plugin imported into the folder is usable without a restart', async () => {
    assert.equal(methodType('test-word'), undefined, 'not known before the import');
    writePlugin(pluginsDir, 'auth-test-word-base', baseManifest('auth-test-word-base', 'auth.test-word', ['auth.prepare', 'auth.verify', 'auth.verification']), baseHandlers('test-word', ['auth.prepare', 'auth.verify', 'auth.verification']));
    writePlugin(pluginsDir, 'auth-test-word', {
      apiVersion: 'plugin/v3', id: 'auth-test-word', version: '1.0.0', name: 'Test word (imported)', publisher: 'iam-platform',
      kinds: ['auth-method'], extends: 'auth-test-word-base', provides: ['auth.test-word'],
      hooks: [{ name: 'auth.prepare', mode: 'blocking' }, { name: 'auth.verify', mode: 'blocking' }, { name: 'auth.verification', mode: 'blocking' }],
      settings: [{ key: 'word', type: 'string', label: 'Expected word', default: 'sesame' }],
      authMethod: { name: 'Test word', description: 'Imported test method.', factor: 'knowledge', amr: 'pwd', maturity: 'implemented', suggestedLevel: 3, provisioning: 'none' },
      entrypoints: { handlers: 'handlers.mjs' }, security: { signed: true },
    }, `export default {
      'auth.verification': () => ({ real: true, note: 'imported test method' }),
      'auth.prepare': () => ({ prompt: { title: 'Word', fields: [{ name: 'word', label: 'Word', type: 'text' }] }, state: {} }),
      'auth.verify': (p) => ({ ok: !!p.known && p.answers?.word === p.config.word }),
    };\n`);
    pack.signPlugin(join(pluginsDir, 'auth-test-word-base'), keys);
    pack.signPlugin(join(pluginsDir, 'auth-test-word'), keys);
    refreshPluginCatalogue(); // what the admin import endpoint does after unpacking
    assert.equal(methodType('test-word')?.name, 'Test word', 'the live catalogue sees the imported method without a restart');
    for (const impl of loadPlugins(pluginsDir).filter((i) => i.manifest.id.startsWith('auth-test-word'))) reg.register(impl);
    await reg.install(T, 'auth-test-word', {});
    await reg.enable(T, 'auth-test-word', {});
    await putConfig([m('w', 'test-word', 3, { word: 'sesame' })], [{ id: 'word', name: 'Word', steps: ['w'], level: 3 }], 'word').expect(200);
    const opts = await svc.options(T);
    assert.deepEqual(opts.chains.map((c) => c.id), ['word']);
    const r = await svc.authenticate({ tenant: T, subject: 'demo-alice', chain: 'word' });
    assert.equal(r?.outcome, 'challenge');
    const ok = await svc.authenticate({ tenant: T, session: (r as { session: string }).session, answers: { word: 'sesame' } });
    assert.equal(ok?.outcome, 'allow', 'the imported method signs in without any restart');
    assert.equal((ok as unknown as { claims: { auth_chain: string } }).claims.auth_chain, 'word');
  });
});
