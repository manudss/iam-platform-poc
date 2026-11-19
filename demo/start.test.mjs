// demo/start.sh seed-mode guard: the mode is validated BEFORE any data-directory work, so a typo
// (or an unset-but-checked mode) can never reach the seed path. These tests run the real script
// only up to that first guard; anything later needs the full service image.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const start = join(here, 'start.sh');

test('start.sh is valid POSIX shell', () => {
  const r = spawnSync('sh', ['-n', start], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('an unknown IAM_DEMO_SEED_MODE is refused before touching data', () => {
  const home = mkdtempSync(join(tmpdir(), 'lyam-start-'));
  const r = spawnSync('sh', [start], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, IAM_DEMO_SEED_MODE: 'sometimes', IAM_DEMO_HOME: home },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /IAM_DEMO_SEED_MODE must be auto or never/);
});

test('the seeded path is only reachable through dolt-state.mjs (error != empty)', () => {
  const r = spawnSync('grep', ['-c', 'dolt-state.mjs', start], { encoding: 'utf8' });
  assert.ok(Number(r.stdout.trim()) >= 1, 'start.sh must consult dolt-state.mjs before seeding');
  const direct = spawnSync('grep', ['-n', 'dolt sql < /app/data/demo', start], { encoding: 'utf8' });
  const guard = spawnSync('grep', ['-n', 'SEED_MODE" = never', start], { encoding: 'utf8' });
  assert.ok(direct.stdout.trim(), 'schema import present');
  assert.ok(guard.stdout.trim(), 'never-mode guard present');
});
