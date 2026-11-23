import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The first main release containing this control. A missing control is not a
// reason to skip: only proven strict ancestors of this release are legacy.
export const CONTROLS = Object.freeze([Object.freeze({
  id: 'password_eye',
  path: 'scripts/password-eye-ui-e2e.cjs',
  introducedBy: 'fa0acdc00895c96acfe52fb217864de101464b37',
}), Object.freeze({
  id: 'gallery_bootstrap',
  path: 'scripts/gallery-bootstrap.test.mjs',
  introducedBy: '25a0898391422f0da8e9f88c562296ca1f867605',
}), Object.freeze({
  id: 'gallery_preferences',
  path: 'scripts/gallery-preferences.test.mjs',
  introducedBy: 'aa999916b8e01450bda05a0a7b33261fe79929f6',
}), Object.freeze({
  id: 'dev_stack_check',
  path: 'scripts/dev-stack-check.mjs',
  introducedBy: 'f86f87777796193bb16f08216b343e98e9b5af4e',
})]);
const SHA = /^[a-f0-9]{40}$/;
function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error('CI policy Git read failed: ' + args[0]);
  return r.stdout.trim();
}
function ancestor(repo, before, after) {
  const r = spawnSync('git', ['merge-base', '--is-ancestor', before, after], { cwd: repo, encoding: 'utf8' });
  if (r.error || ![0, 1].includes(r.status)) throw new Error('CI policy ancestry is unverifiable');
  return r.status === 0;
}
export function controlPlan(repo, target, controls = CONTROLS) {
  if (!SHA.test(target)) throw new Error('CI policy requires a full lowercase SHA');
  git(repo, ['cat-file', '-e', target + '^{commit}']);
  const policyRevision = git(repo, ['rev-parse', 'HEAD']);
  if (!ancestor(repo, target, policyRevision)) throw new Error('target is outside the policy revision history');
  const decisions = controls.map(control => {
    if (!SHA.test(control.introducedBy)) throw new Error('invalid policy introduction SHA');
    git(repo, ['cat-file', '-e', control.introducedBy + '^{commit}']);
    if (!ancestor(repo, control.introducedBy, policyRevision)) throw new Error('control introduction is outside the policy revision history');
    const entry = git(repo, ['ls-tree', target, '--', control.path]);
    if (entry) {
      if (!/^100(?:644|755) blob /.test(entry)) throw new Error('control is not a regular source file: ' + control.id);
      if (Number(git(repo, ['cat-file', '-s', target + ':' + control.path])) < 1) throw new Error('control file is empty: ' + control.id);
      return { ...control, required: true, reason: 'control-source-present' };
    }
    if (target !== control.introducedBy && ancestor(repo, target, control.introducedBy)) {
      return { ...control, required: false, reason: 'proven-strict-ancestor-of-control-release' };
    }
    throw new Error('required control missing or release applicability unknown: ' + control.id);
  });
  return { format: 1, target, policyRevision, controls: decisions };
}
// Audit every referenced source script, not only the controls already known to policy.
// Caller-policy tools and the explicitly caller-owned automation checkout are checked
// against the caller revision. Feature exemptions must be wired to their plan output.
export function auditReferences(repo, target, plan, workflow) {
  const evidence = [];
  const policyTools = new Set(['scripts/ci-controls.mjs', 'scripts/ci-controls.test.mjs']);
  const blocks = workflow.split(/(?=^      - )/m);
  for (const block of blocks) {
    const paths = [...new Set(block.match(/(?:scripts|demo|deploy)\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|py)/g) ?? [])];
    for (const path of paths) {
      const callerOwned = policyTools.has(path) || block.includes('working-directory: .ci-automation');
      const revision = callerOwned ? plan.policyRevision : target;
      const present = git(repo, ['ls-tree', revision, '--', path]);
      const control = plan.controls.find(c => c.path === path);
      if (!present && !(control && !control.required && !callerOwned)) throw new Error('unmapped or required script reference missing: ' + path);
      if (control && !control.required && !callerOwned && !block.includes("if: needs.control_policy.outputs." + control.id + "_required == 'true'")) throw new Error('legacy feature reference is not protected by its policy output: ' + path);
      evidence.push({ path, source: callerOwned ? 'caller-policy' : present ? 'target' : 'explicit-legacy-feature-exemption' });
    }
    if (block.includes('docker cp') && block.includes('/tmp/gallery-browser') && !block.includes("if: needs.control_policy.outputs.gallery_bootstrap_required == 'true'")) throw new Error('Gallery bundle copy is outside its feature-control guard');
  }
  return evidence;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [target, output] = process.argv.slice(2);
  if (!output) throw new Error('control plan output path required');
  const plan = controlPlan(process.cwd(), target);
  const workflow = git(process.cwd(), ['show', plan.policyRevision + ':.github/workflows/ci.yml']);
  plan.references = auditReferences(process.cwd(), target, plan, workflow);
  plan.boundaryAudits = CONTROLS.map(control => {
    const previous = git(process.cwd(), ['rev-parse', control.introducedBy + '^1']);
    const legacy = controlPlan(process.cwd(), previous);
    return { target: previous, references: auditReferences(process.cwd(), previous, legacy, workflow) };
  });
  writeFileSync(output, JSON.stringify(plan, null, 2) + '\n');
  for (const control of plan.controls) {
    console.error('CI control ' + control.id + ': ' + control.reason);
    console.log(control.id + '_required=' + String(control.required));
  }
}
