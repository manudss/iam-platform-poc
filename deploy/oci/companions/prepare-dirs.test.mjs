// Contract of deploy/oci/companions/prepare-dirs.sh: bind-mount host dirs are created with
// the image default user's ownership, including installation from an ABSENT directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const prep = join(here, 'prepare-dirs.sh');

const DOCKER_STUB = `#!/bin/sh
echo "docker $*" >> "$STUB_DIR/calls"
case "$*" in
  "run --rm --entrypoint id test-image -u") echo 1000; exit 0 ;;
  "run --rm --entrypoint id test-image -g") echo 1001; exit 0 ;;
  "run --rm --entrypoint id broken-image -u") exit 1 ;;
esac
exit 0
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'lyam-prepdirs-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'docker'), DOCKER_STUB);
  chmodSync(join(dir, 'bin', 'docker'), 0o755);
  // install -o needs root; the stub records the intended ownership and just creates the dir.
  writeFileSync(join(dir, 'bin', 'install'), '#!/bin/sh\necho "install $*" >> "$STUB_DIR/calls"\nfor last; do :; done\nmkdir -p "$last"\n');
  chmodSync(join(dir, 'bin', 'install'), 0o755);
  const stub = join(dir, 'stub');
  mkdirSync(stub);
  return { dir, stub };
}

function run(dir, ...args) {
  const r = spawnSync('sh', [prep, ...args], {
    encoding: 'utf8',
    env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, STUB_DIR: join(dir, 'stub') },
  });
  const p = join(dir, 'stub', 'calls');
  return { ...r, calls: existsSync(p) ? readFileSync(p, 'utf8') : '' };
}

test('an ABSENT bind dir is created with the image default user ownership', () => {
  const { dir } = setup();
  const target = join(dir, 'bao-storage');
  assert.ok(!existsSync(target), 'precondition: the directory is absent');
  const r = run(dir, 'test-image', target);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(statSync(target).isDirectory(), 'the directory was created');
  assert.match(r.stdout, /owner 1000:1001 from test-image default user/);
  assert.match(r.calls, /--entrypoint id test-image -u/, 'the uid is read from the image, never hardcoded');
  assert.match(r.calls, /install -d -m 700 -o 1000 -g 1001/, 'private dir owned by the image default user');
});

test('re-running fixes ownership of an EXISTING dir (idempotent)', () => {
  const { dir } = setup();
  const target = join(dir, 'bao-storage');
  const r1 = run(dir, 'test-image', target);
  const r2 = run(dir, 'test-image', target);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r2.status, 0, r2.stderr);
});

test('an image whose uid cannot be read fails closed', () => {
  const { dir } = setup();
  const target = join(dir, 'bao-storage');
  const r = run(dir, 'broken-image', target);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /could not read the default uid/);
  assert.ok(!existsSync(target), 'no directory is created from an unknown owner');
});
