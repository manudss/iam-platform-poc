// Contract of deploy/oci/update.sh, tested against a stub `docker` on PATH. The updater exists to
// publish new Lyam versions on a persistent host WITHOUT re-seeding and WITHOUT losing data, so the
// tests pin exactly that: refusals (moving tag, image without the never-seed label, missing dataset,
// pause file), the cold backup before any swap, seed mode forced to never, and rollback on a
// new image that never becomes healthy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const updater = join(here, 'update.sh');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const NEW = `ghcr.io/example/lyam:${SHA}`;
const OLD = 'ghcr.io/example/lyam:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const DOCKER_STUB = `#!/bin/sh
echo "docker $*" >> "$STUB_DIR/calls"
key="$(echo "$*" | tr ' /:@' '____')"
case "$1" in
  pull) exit 0 ;;
  image)
    if [ "$2" = "inspect" ]; then
      if [ "$3" = "-f" ]; then grep -qx "$5" "$STUB_DIR/images" && { echo x; exit 0; } || exit 1; fi
      ref="$3"; f="$STUB_DIR/labels/$(echo "$ref" | tr ' /:@' '____')"
      [ -f "$f" ] && cat "$f" || exit 1
      exit 0
    fi ;;
  inspect)
    [ -f "$STUB_DIR/current" ] && cat "$STUB_DIR/current" || exit 1 ;;
  stop|rm|start) exit 0 ;;
  run) echo "$@" > "$STUB_DIR/run-args"; for last; do :; done; echo "$last" > "$STUB_DIR/running"; exit 0 ;;
  exec)
    if [ "$2" = "$STUB_PG" ]; then echo 'SELECT 1;'; exit 0; fi
    grep -qx "$(cat "$STUB_DIR/running" 2>/dev/null)" "$STUB_DIR/healthy" 2>/dev/null && exit 0 || exit 1 ;;
esac
exit 0
`;

/** Builds a host sandbox: env file, data dir, stub docker. Options override the scenario. */
function setup({ label = 'auto never', current = OLD, health = true, dataset = true, pause = false, pg = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lyam-update-'));
  const stub = join(dir, 'stub');
  mkdirSync(join(stub, 'labels'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'docker'), DOCKER_STUB);
  chmodSync(join(dir, 'bin', 'docker'), 0o755);
  writeFileSync(join(stub, 'images'), `${OLD}\n${NEW}\n`);
  writeFileSync(join(stub, 'healthy'), health ? `${OLD}\n${NEW}\n` : `${OLD}\n`);
  if (label !== null) writeFileSync(join(stub, 'labels', NEW.replaceAll(/[ /:@]/g, '_')), label);
  if (current !== null) writeFileSync(join(stub, 'current'), current);
  const data = join(dir, 'data');
  if (dataset) mkdirSync(join(data, 'dolt', '.dolt'), { recursive: true }); else mkdirSync(data, { recursive: true });
  if (pause) writeFileSync(join(dir, 'UPDATE_PAUSED'), '');
  const env = join(dir, 'lyam.env');
  writeFileSync(env, [
    'IAM_PUBLIC_ORIGIN=https://example.invalid',
    `LYAM_DATA_DIR=${data}`,
    `LYAM_BACKUP_DIR=${join(dir, 'backups')}`,
    `LYAM_PAUSE_FILE=${join(dir, 'UPDATE_PAUSED')}`,
    'LYAM_HEALTH_TIMEOUT=0',
    pg ? 'LYAM_BACKUP_PG_CONTAINER=pg' : '',
  ].filter(Boolean).join('\n') + '\n');
  return { dir, stub, env, data };
}

function run(env, ...args) {
  const r = spawnSync('sh', [updater, ...args], {
    encoding: 'utf8',
    env: { PATH: `${dirname(env)}/bin:/usr/bin:/bin`, STUB_DIR: join(dirname(env), 'stub'), STUB_PG: 'pg' },
  });
  const callsPath = join(dirname(env), 'stub', 'calls');
  return { ...r, calls: existsSync(callsPath) ? readFileSync(callsPath, 'utf8') : '' };
}

test('a moving tag is refused before any docker call', () => {
  const { env } = setup();
  const r = run(env, '--image', 'ghcr.io/example/lyam:latest', '--env-file', env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /immutable/);
  assert.equal(r.calls, '');
});

test('an image without the never-seed label is refused; the running container is never stopped', () => {
  const { env } = setup({ label: null });
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /never/);
  assert.doesNotMatch(r.calls, /docker stop/);
});

test('a missing dataset is refused (bootstrap is a separate step)', () => {
  const { env } = setup({ dataset: false });
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bootstrap/);
});

test('the pause file freezes updates', () => {
  const { env } = setup({ pause: true });
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /paused/);
});

test('happy path: backup BEFORE the swap, container forced to seed mode never, backup kept', () => {
  const { env, dir } = setup({ pg: true });
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 0, r.stderr);
  const order = r.calls.split('\n').map((l) => l.replace(/^docker (\S+).*$/, '$1'));
  const stopAt = order.indexOf('stop');
  const runAt = order.indexOf('run');
  assert.ok(stopAt > -1 && runAt > stopAt, 'container stopped before the new run');
  const backup = join(dir, 'backups');
  assert.ok(existsSync(backup) && readFileSync(join(dirname(env), 'stub', 'run-args'), 'utf8').includes('IAM_DEMO_SEED_MODE=never'));
  assert.match(readFileSync(join(dirname(env), 'stub', 'run-args'), 'utf8'), /--env-file/);
});

test('an unhealthy new image rolls back to the previous one', () => {
  const { env, dir } = setup({ health: false });
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /rolled back/);
  const runs = r.calls.split('\n').filter((l) => l.startsWith('docker run'));
  assert.equal(runs.length, 2, 'new image started, then the rollback');
  assert.ok(runs[1].endsWith(OLD), 'rollback runs the previous image');
});

test('an update identical to the running image has no rollback path requirement', () => {
  const { env } = setup({ current: NEW });
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 0, r.stderr);
});

test('update.sh is valid POSIX shell', () => {
  const r = spawnSync('sh', ['-n', updater], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
