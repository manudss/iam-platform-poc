// Small strict contract for this workflow's known, versioned shape. No YAML dependencies.
export const REQUIRED = ['control_policy', 'deployment_preflight', 'core', 'api', 'web', 'compose', 'demo-docker'];
export function assertPrCiContract(workflow) {
  const fail = message => { throw new Error(message); };
  const events = workflow.split('\njobs:')[0];
  if (!/^  pull_request:\n    types: \[opened, synchronize, reopened, ready_for_review\]$/m.test(events)) fail('every PR lifecycle must qualify, including drafts');
  if (!/^  merge_group:\n    types: \[checks_requested\]$/m.test(events)) fail('merge queue must qualify');
  if (/^\s+(paths|paths-ignore):/m.test(events)) fail('path-filtered checks can leave merges unqualified');
  if (!events.includes("github.event_name == 'pull_request' && 'current'")) fail('PR updates must cancel superseded PR runs');
  const jobs = Object.fromEntries([...workflow.matchAll(/^  ([a-z_-]+):\n([\s\S]*?)(?=^  [a-z_-]+:\n|$(?![\s\S]))/gm)].map(m => [m[1], m[2]]));
  for (const name of REQUIRED) if (!jobs[name]) fail('missing qualification job: ' + name);
  for (const name of REQUIRED.filter(n => !['control_policy', 'deployment_preflight'].includes(n))) {
    if (!jobs[name].includes('needs: [control_policy, deployment_preflight]')) fail('qualification must wait for cheap preflight: ' + name);
    if (/^    if:/m.test(jobs[name])) fail('qualification jobs may not be silently filtered: ' + name);
    if (!jobs[name].includes('ref: ${{ inputs.sha || github.sha }}')) fail('application checkout must use exact requested SHA: ' + name);
  }
  const pre = jobs.deployment_preflight;
  if (!pre.includes('ref: ${{ github.workflow_sha }}') || !pre.includes('working-directory: .ci-automation')) fail('preflight must test pinned controller');
  for (const path of ['ordered-queue.test.py', 'qualification.test.py', 'oci-plan.test.mjs', 'pr-ci-contract.test.mjs', 'host-boot.test.mjs', 'update.test.mjs']) if (!pre.includes(path)) fail('missing deployment preflight suite: ' + path);
  const gate = jobs.premerge;
  if (!gate || !gate.includes('if: always()') || !gate.includes('needs: [' + REQUIRED.join(', ') + ']')) fail('aggregate must run after every qualification outcome');
  if (!gate.includes("results[k]?.result !== 'success'") || !gate.includes('Object.keys(results).length !== expected.length') || !gate.includes('process.exit(1)')) fail('aggregate must refuse failed, skipped, missing and canceled jobs');
  return true;
}
