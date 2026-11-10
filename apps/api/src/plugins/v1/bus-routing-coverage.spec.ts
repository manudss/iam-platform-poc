import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { BUS_CONTROL_KINDS, BUS_QUERY_KINDS } from './bus-kinds.js';
import { HOOKS } from './hooks.js';

/** Repo plugins dir, resolved like loader.defaultPluginsDir but WITHOUT importing the loader (its module-init
 * chain loads signed plugin packages, which a static coverage spec neither needs nor survives unsigned). */
const pluginsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../plugins');

/**
 * Regression guard for the PR #66 preview bug: the passkey plugin declared the blocking hook `auth.enroll`
 * and the self-service controller calls it through callSlot, but the kind was in NO bus set - so the call
 * threw `bus-unavailable` and the profile enrollment ended in a 500 on the hosted preview, while every unit
 * spec (which invokes the handlers directly) stayed green.
 *
 * Invariant: EVERY blocking hook is served somewhere the callers can reach:
 *  - BUS_CONTROL_KINDS: slot-targeted or mandatory blocking calls over the bus (callSlot / control);
 *  - BUS_QUERY_KINDS: merged blocking queries over the bus (queryHook);
 *  - IN_PROCESS: the documented exceptions that never travel on the bus (decision 8: ui.screens is answered
 *    from the manifest, access.decide runs as WASM inside the core).
 * A new blocking hook that forgets to pick one of these lists fails this test instead of failing in production.
 */
const IN_PROCESS = new Set(['ui.screens', 'access.decide']);

const covered = (hook: string) => BUS_CONTROL_KINDS.has(hook) || BUS_QUERY_KINDS.has(hook) || IN_PROCESS.has(hook);

describe('every blocking hook is routed (bus control/query or documented in-process exception)', () => {
  it('1. the hook catalogue has no unrouted blocking hook', () => {
    for (const [name, modes] of HOOKS) {
      if (!modes.includes('blocking')) continue;
      assert.ok(covered(name), `blocking hook '${name}' is in neither BUS_CONTROL_KINDS, BUS_QUERY_KINDS nor the in-process exceptions: its callers can only 500`);
    }
  });

  it('2. no shipped plugin declares a blocking hook the bus would not deliver', () => {
    for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      let manifest: { hooks?: { name: string; mode: string }[]; subscribes?: { name: string; mode?: string }[] };
      try { manifest = JSON.parse(readFileSync(join(pluginsDir, entry.name, 'manifest.json'), 'utf8')); } catch { continue; }
      for (const h of [...(manifest.hooks ?? []), ...(manifest.subscribes ?? [])]) {
        const mode = 'mode' in h && h.mode ? h.mode : 'blocking';
        if (mode !== 'blocking') continue;
        assert.ok(covered(h.name), `plugin ${entry.name} declares blocking hook '${h.name}', which is not routed: the plugin would never answer and the caller would fail closed with a 500`);
      }
    }
  });

  it('3. the bus sets stay inside the catalogue (no stale kind routed forever)', () => {
    for (const name of [...BUS_CONTROL_KINDS, ...BUS_QUERY_KINDS]) {
      assert.ok(HOOKS.has(name), `'${name}' is routed but no longer in the hook catalogue`);
      assert.ok(HOOKS.get(name)!.includes('blocking'), `'${name}' is routed as blocking but the catalogue says ${HOOKS.get(name)!.join('/')}`);
    }
  });
});
