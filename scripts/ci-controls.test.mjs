import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { controlPlan } from './ci-controls.mjs';

describe('versioned CI control applicability', () => {
  function fixture(run) {
    const repo = mkdtempSync(join(tmpdir(), 'ci-controls-'));
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const commit = (message) => { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
    try {
      git('init', '-q'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.invalid');
      writeFileSync(join(repo, 'README'), 'fictional source\n'); const legacy = commit('before control');
      writeFileSync(join(repo, 'control.mjs'), 'export const control = true;\n'); const introducedBy = commit('introduce control');
      writeFileSync(join(repo, 'README'), 'newer fictional source\n'); const current = commit('after control');
      const controls = [{ id: 'fixture', path: 'control.mjs', introducedBy }];
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
    rmSync(join(repo,'control.mjs')); const removed=commit('remove required control');
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
    writeFileSync(join(repo,'control.mjs'),''); const empty=commit('empty required control');
    assert.throws(()=>controlPlan(repo,empty,controls),/empty/);
    for(const input of ['main','HEAD',current.slice(0,7),current.toUpperCase()]) assert.throws(()=>controlPlan(repo,input,controls),/full lowercase SHA/);
  }));
  it('refuses symlink controls and an introduction outside policy history', () => fixture(({repo,git,commit,legacy,controls}) => {
    rmSync(join(repo,'control.mjs')); symlinkSync('README',join(repo,'control.mjs')); const target=commit('symlink control');
    assert.throws(()=>controlPlan(repo,target,controls),/not a regular source file/);
    git('checkout','-q',legacy);
    assert.throws(()=>controlPlan(repo,legacy,controls),/introduction is outside/);
  }));

});
