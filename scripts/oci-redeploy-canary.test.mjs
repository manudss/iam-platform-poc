import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('OCI test canary keeps exact-SHA receipts and ordered host delivery', () => {
  const workflow = readFileSync(new URL('../.github/workflows/oci-deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /qualified-plan.json/);
  assert.match(workflow, /StrictHostKeyChecking=yes/);
  assert.match(workflow, /inputs.qualification_only != true/);
  assert.match(workflow, /oci-plan.mjs receipts/);
});
