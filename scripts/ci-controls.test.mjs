import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CONTROLS, controlPlan, auditReferences } from './ci-controls.mjs';

describe('versioned CI control applicability', () => {
  function fixture(run) {
    const repo = mkdtempSync(join(tmpdir(), 'ci-controls-'));
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const commit = (message) => { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
    try {
      git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.invalid');
      writeFileSync(join(repo, 'README'), 'fictional source\n'); const legacy = commit('before control');
      mkdirSync(join(repo,'scripts'));
      writeFileSync(join(repo, 'scripts/control.mjs'), 'export const control = true;\n'); const introducedBy = commit('introduce control');
      writeFileSync(join(repo, 'README'), 'newer fictional source\n'); const current = commit('after control');
      const controls = [{ id: 'fixture', path: 'scripts/control.mjs', introducedBy }];
      run({ repo, git, commit, legacy, introducedBy, current, controls });
    } finally { rmSync(repo, { recursive: true, force: true }); }
  }
  it('records an explicit exemption only for a proven strict predecessor', () => fixture(({repo,legacy,controls}) => {
    const plan = controlPlan(repo, legacy, controls);
    assert.equal(plan.controls[0].required, false);
    assert.equal(plan.controls[0].reason, 'proven-strict-ancestor-of-control-release');
    assert.equal(plan.target, legacy); assert.match(plan.policyRevision, /^[a-f0-9]{40}$/);
  }));
  it('requires the control at introduction and on subsequent versions', () => fixture(({repo,introducedBy,current,controls}) => {
    for (const target of [introducedBy,current]) assert.equal(controlPlan(repo,target,controls).controls[0].required,true);
  }));
  it('refuses a control deleted after its introduction', () => fixture(({repo,commit,controls}) => {
    rmSync(join(repo,'scripts/control.mjs')); const removed=commit('remove required control');
    assert.throws(()=>controlPlan(repo,removed,controls),/required control missing/);
  }));
  it('refuses a divergent missing-control revision instead of inferring legacy from absence', () => fixture(({repo,git,commit,legacy,controls}) => {
    git('checkout','-qb','divergent',legacy); writeFileSync(join(repo,'README'),'divergent fictional source\n'); const target=commit('divergent');
    // Bring the introduction into the policy history, without putting it in the target history.
    git('checkout','-q',controls[0].introducedBy); git('merge','--no-ff','-m','join histories',target);
    assert.throws(()=>controlPlan(repo,target,controls),/applicability unknown/);
  }));
  it('refuses a target outside the policy history and unavailable object IDs', () => fixture(({repo,git,current,controls}) => {
    git('checkout','-q',controls[0].introducedBy);
    assert.throws(()=>controlPlan(repo,current,controls),/outside the policy/);
    assert.throws(()=>controlPlan(repo,'0'.repeat(40),controls),/Git read failed/);
  }));
  it('refuses empty controls and non-SHA input', () => fixture(({repo,commit,current,controls}) => {
    writeFileSync(join(repo,'scripts/control.mjs'),''); const empty=commit('empty required control');
    assert.throws(()=>controlPlan(repo,empty,controls),/empty/);
    for(const input of ['main','HEAD',current.slice(0,7),current.toUpperCase()]) assert.throws(()=>controlPlan(repo,input,controls),/full lowercase SHA/);
  }));
  it('refuses symlink controls and an introduction outside policy history', () => fixture(({repo,git,commit,legacy,controls}) => {
    rmSync(join(repo,'scripts/control.mjs')); symlinkSync('README',join(repo,'scripts/control.mjs')); const target=commit('symlink control');
    assert.throws(()=>controlPlan(repo,target,controls),/not a regular source file/);
    git('checkout','-q',legacy);
    assert.throws(()=>controlPlan(repo,legacy,controls),/introduction is outside/);
  }));

  it('audits every script reference and requires the guard for legacy feature exemptions', () => fixture(({repo,legacy,controls}) => {
    const plan=controlPlan(repo,legacy,controls);
    const guarded="      - name: feature\n        if: needs.control_policy.outputs.fixture_required == 'true'\n        run: node scripts/control.mjs\n";
    assert.equal(auditReferences(repo,legacy,plan,guarded)[0].source,'explicit-legacy-feature-exemption');
    assert.throws(()=>auditReferences(repo,legacy,plan,'      - run: node scripts/control.mjs'),/not protected/);
    assert.throws(()=>auditReferences(repo,legacy,plan,'      - run: node scripts/new-check.mjs'),/unmapped or required/);
  }));
  it('refuses a Gallery bundle copy outside the bootstrap guard', () => fixture(({repo,legacy,controls}) => {
    const plan=controlPlan(repo,legacy,controls);
    assert.throws(()=>auditReferences(repo,legacy,plan,'      - run: docker cp fixture:/browser /tmp/gallery-browser'),/bundle copy/);
    assert.deepEqual(auditReferences(repo,legacy,plan,"      - name: bootstrap\n        if: needs.control_policy.outputs.gallery_bootstrap_required == 'true'\n        run: docker cp fixture:/browser /tmp/gallery-browser"),[]);
  }));

  it('maps the Gallery acknowledgement control and audits its actual historical boundaries', () => {
    const repo = process.cwd();
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    const c = CONTROLS.find(c => c.id === 'gallery_preferences');
    assert.equal(c.path, 'scripts/gallery-preferences.test.mjs');
    const workflow = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
    for (const target of [git('rev-parse','HEAD'), 'fa0acdc00895c96acfe52fb217864de101464b37', '25a0898391422f0da8e9f88c562296ca1f867605', git('rev-parse',c.introducedBy+'^1')]) {
      const plan = controlPlan(repo, target);
      const entry = plan.controls.find(x => x.id === c.id);
      assert.equal(entry.required, target === c.introducedBy || target === git('rev-parse','HEAD'));
      auditReferences(repo, target, plan, workflow);
    }
  });

});
