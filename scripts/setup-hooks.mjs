#!/usr/bin/env node
/**
 * Activates the repository git hooks (core.hooksPath = .githooks) so the pre-commit hook regenerates
 * docs/event-inventory.md on every commit that touches an event-circuit source. Runs as the `prepare`
 * script of apps/api (npm ci / npm install), i.e. as part of the documented local setup - nothing to
 * configure by hand. Idempotent, cross-platform, and a silent no-op outside a git checkout (Docker
 * image builds, packaged sources): it never fails the install that invoked it.
 */
import { execFileSync } from 'node:child_process';

try {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let current = '';
  try {
    current = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* unset: git config --get exits 1 */ }
  if (current === '.githooks') {
    // Already active: nothing to do.
  } else if (current) {
    console.log(`setup-hooks: existing core.hooksPath '${current}' left untouched; to use the repository hooks, point it at .githooks or merge them into your own hook.`);
  } else {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'ignore' });
    console.log('setup-hooks: git hooks activated (core.hooksPath = .githooks)');
  }
} catch {
  // Not a git checkout, or git unavailable: nothing to activate, never fail the install.
}
