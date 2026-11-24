import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPrCiContract } from './pr-ci-contract.mjs';
const source = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
test('current workflow qualifies PRs and deployment controllers before expensive builds', () => assert.equal(assertPrCiContract(source), true));
for (const [name, before, after] of [
  ['missing synchronize', 'opened, synchronize, reopened', 'opened, reopened'],
  ['missing merge queue', '  merge_group:', '  not_merge_group:'],
  ['path filters', '  pull_request:\n', '  pull_request:\n    paths: [apps/**]\n'],
  ['skipped integration job', '  compose:\n', '  compose:\n    if: false\n'],
  ['unpinned target', 'ref: ${{ inputs.sha || github.sha }}', 'ref: main'],
  ['missing cheap dependency', 'needs: [control_policy, deployment_preflight]', 'needs: control_policy'],
  ['missing deployment test', 'ordered-queue.test.py', 'omitted.py'],
  ['aggregate skipped after failure', '    if: always()\n    needs: [control_policy, deployment_preflight, core, api, web, compose, demo-docker]', '    if: success()\n    needs: [control_policy, deployment_preflight, core, api, web, compose, demo-docker]'],
  ['aggregate accepts skipped', "results[k]?.result !== 'success'", "results[k]?.result === 'failure'"],
  ['missing qualification', '  demo-docker:\n', '  lost:\n'],
]) test('refuses ' + name, () => { assert.notEqual(source.replace(before, after), source); assert.throws(() => assertPrCiContract(source.replace(before, after))); });

const code = source.split("          node - <<'NODE'\n")[1].split('          NODE')[0];
const passed = Object.fromEntries(['control_policy','deployment_preflight','core','api','web','compose','demo-docker'].map(k => [k, { result: 'success' }]));
function execute(results) { return spawnSync(process.execPath, ['-e', code], { env: { ...process.env, QUALIFICATION_RESULTS: JSON.stringify(results) }, encoding: 'utf8' }).status; }
test('actual aggregate script accepts only all successes', () => assert.equal(execute(passed), 0));
for (const status of ['failure', 'cancelled', 'skipped', 'pending', '']) test('actual aggregate rejects ' + JSON.stringify(status), () => assert.notEqual(execute({ ...passed, api: { result: status } }), 0));
test('actual aggregate rejects missing and extra jobs', () => { const missing = { ...passed }; delete missing.api; assert.notEqual(execute(missing), 0); assert.notEqual(execute({ ...passed, extra: { result: 'success' } }), 0); });
