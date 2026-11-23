// Regression for the fresh-visit personal-page failure: a session on My profile (or a personal plugin
// screen) has NO working branch, and the packaged component route used to answer 400 "Choose a working
// data branch before using administration" for every plugin component (password, passkeys, TOTP, PIN, SSO).
// The route is a sign-in-only READ of the plugin's signed folder: with no x-iam-branch it now resolves the
// LIVE configuration ('main'); an explicit branch keeps its exact view and validation.
import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluginsAdminController } from './plugins-admin.controller.js';
import { branchContext } from '../../workspace/context.js';

const T = 'acme-demo';
const manifest = { id: 'auth-totp', profileComponents: [{ id: 'totp', title: 'Authenticator app (TOTP)', component: 'screens/profile.mjs', surfaces: { self: 'manage', admin: 'manage' }, order: 20 }], screens: [] };
const regFor = (active: boolean) => ({
  impl: (id: string) => (id === 'auth-totp' ? { manifest } : undefined),
  isActive: () => active,
});
function resStub() {
  const out: { type?: string; body?: unknown } = {};
  return { res: { type: (c: string) => ({ send: (b: unknown) => { out.type = c; out.body = b; } }) }, out };
}
function ctl(active: Record<string, boolean>, seen: string[]) {
  const branches = { get: async (b: string) => { seen.push(b); return regFor(active[b] ?? false); } };
  return new PluginsAdminController(regFor(true) as never, branches as never);
}
const COMPONENT = ['screens', 'profile.mjs'];
const NOUSER = { user: {} };

test('asset route: a fresh personal page (no working branch) resolves LIVE instead of HTTP 400', async () => {
  process.env.IAM_WORKSPACE_MODE = '1';
  try {
    const seen: string[] = []; const c = ctl({ main: true }, seen);
    const { res, out } = resStub();
    await branchContext.run({ branch: undefined }, () => c.screenAsset(T, 'auth-totp', COMPONENT, res as never, NOUSER as never));
    assert.deepEqual(seen, ['main'], 'no header: the live configuration answers');
    assert.match(String(out.type), /text\/javascript/);
    assert.ok(String(out.body).length > 0, 'the real packaged component bytes are served');
  } finally { delete process.env.IAM_WORKSPACE_MODE; }
});

test('asset route: no header and the plugin is inactive on main = refused (the live gate still applies)', async () => {
  process.env.IAM_WORKSPACE_MODE = '1';
  try {
    const seen: string[] = []; const c = ctl({ main: false }, seen);
    const { res } = resStub();
    await assert.rejects(
      branchContext.run({ branch: undefined }, () => c.screenAsset(T, 'auth-totp', COMPONENT, res as never, NOUSER as never)),
      /not enabled on this branch/);
    assert.deepEqual(seen, ['main'], 'the live configuration was consulted, then refused');
  } finally { delete process.env.IAM_WORKSPACE_MODE; }
});

test('asset route: a branch-test token without header keeps its OWN branch view, never main', async () => {
  process.env.IAM_WORKSPACE_MODE = '1';
  try {
    const bound = { user: { branch: 'feature-x' } };
    // Enabled on the bound branch, inactive on main: the bound branch serves (not the live gate).
    const seen1: string[] = []; const c1 = ctl({ main: false, 'feature-x': true }, seen1);
    const { res: r1, out } = resStub();
    await branchContext.run({ branch: undefined }, () => c1.screenAsset(T, 'auth-totp', COMPONENT, r1 as never, bound as never));
    assert.deepEqual(seen1, ['feature-x'], 'the token branch is resolved, not main');
    assert.match(String(out.type), /text\/javascript/);
    // Inactive on the bound branch, active on main: refused — main must not leak into a branch-test session.
    const seen2: string[] = []; const c2 = ctl({ main: true, 'feature-x': false }, seen2);
    const { res: r2 } = resStub();
    await assert.rejects(
      branchContext.run({ branch: undefined }, () => c2.screenAsset(T, 'auth-totp', COMPONENT, r2 as never, bound as never)),
      /not enabled on this branch/);
    assert.deepEqual(seen2, ['feature-x'], 'isolation: the live configuration never answers a branch-test session');
  } finally { delete process.env.IAM_WORKSPACE_MODE; }
});

test('asset route: an explicit branch keeps its view (plugin inactive on it = refused as before)', async () => {
  process.env.IAM_WORKSPACE_MODE = '1';
  try {
    const seen: string[] = []; const c = ctl({ main: true, 'personal/demo-alice': false }, seen);
    const { res } = resStub();
    await assert.rejects(
      branchContext.run({ branch: 'personal/demo-alice' }, () => c.screenAsset(T, 'auth-totp', COMPONENT, res as never, NOUSER as never)),
      /not enabled on this branch/);
    assert.deepEqual(seen, ['personal/demo-alice'], 'an explicit header still selects its own branch');
  } finally { delete process.env.IAM_WORKSPACE_MODE; }
});

test('asset route: outside workspace mode the shared registry serves, unchanged', async () => {
  delete process.env.IAM_WORKSPACE_MODE;
  const seen: string[] = []; const c = ctl({}, seen);
  const { res, out } = resStub();
  await branchContext.run({ branch: undefined }, () => c.screenAsset(T, 'auth-totp', COMPONENT, res as never, NOUSER as never));
  assert.deepEqual(seen, [], 'no per-branch registry is resolved outside workspace mode');
  assert.match(String(out.type), /text\/javascript/);
});

test('asset route: an undeclared file of the package is still never served', async () => {
  process.env.IAM_WORKSPACE_MODE = '1';
  try {
    const seen: string[] = []; const c = ctl({ main: true }, seen);
    const { res } = resStub();
    await assert.rejects(
      branchContext.run({ branch: undefined }, () => c.screenAsset(T, 'auth-totp', ['handlers.mjs'], res as never, NOUSER as never)),
      /not a declared component/);
  } finally { delete process.env.IAM_WORKSPACE_MODE; }
});
