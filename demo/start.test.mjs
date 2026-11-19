// demo/start.sh seed-mode guard: the mode is validated BEFORE any data-directory work, so a typo
// (or an unset-but-checked mode) can never reach the seed path. These tests run the real script
// only up to that first guard; anything later needs the full service image.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
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

test('startup enters versioned prepare after probe, under a lifetime lock, never legacy seed hooks', () => {
  const source = readFileSync(start, 'utf8');
  assert.ok(source.indexOf('flock -n 9') < source.indexOf('dolt init'));
  assert.ok(source.indexOf('dolt-state.mjs') < source.indexOf('cli.js prepare'));
  assert.match(source, /cli\.js prepare "\$DB_STATE" \|\| exit 1/);
  assert.doesNotMatch(source, /dolt sql < \/app\/data\/demo/);
  assert.doesNotMatch(source, /export IAM_AUTHN_DEMO_SEED=1|export IAM_DEMO_DATA_SEED=1/);
  assert.match(source, /unset IAM_AUTHN_DEMO_SEED IAM_DEMO_DATA_SEED/);
});

test('the operator wrapper takes the SAME lock and forbids startup/seed commands', () => {
  const source = readFileSync(join(here, '../deploy/oci/data-migrations.sh'), 'utf8');
  assert.match(source, /exec flock --nonblock "\$HOME_DIR\/\.boot\.lock"/);
  const r = spawnSync('sh', [join(here, '../deploy/oci/data-migrations.sh'), 'prepare', 'empty'], {encoding:'utf8'});
  assert.notEqual(r.status, 0);
});
