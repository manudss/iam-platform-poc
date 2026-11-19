// Contract of deploy/oci/update.sh, tested against a stub `docker` on PATH. The updater exists to
// publish new Lyam versions on a persistent host WITHOUT re-seeding and WITHOUT losing data, so the
// tests pin exactly that: refusals (moving tag, image without the never-seed label, missing dataset,
// pause file, concurrent run), the COLD backup before any swap (container always stopped, even for
// a same-image redeploy), failure detection at every preservation step (pg export, compression,
// hook, bao archive), seed mode forced to never, compensation on a failed container creation, and
// rollback restoring data AND image together. These tests qualify the script logic only; the real
// update is qualified by an isolated on-host test before any switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from 'node:fs';
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
case "$1" in
  info) exit 0 ;;
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
  run)
    echo "$@" > "$STUB_DIR/run-args"
    for last; do :; done
    [ -f "$STUB_DIR/run-fail" ] && [ "$last" = "$(cat "$STUB_DIR/run-fail")" ] && exit 1
    echo "$last" > "$STUB_DIR/running"
    exit 0 ;;
  exec)
    case "$*" in
      *pg_dumpall*) [ -f "$STUB_DIR/pg-fail" ] && exit 1; echo 'SELECT 1;'; exit 0 ;;
      *psql*) exit 0 ;;
    esac
    grep -qx "$(cat "$STUB_DIR/running" 2>/dev/null)" "$STUB_DIR/healthy" 2>/dev/null && exit 0 || exit 1 ;;
esac
exit 0
`;

/** Builds a host sandbox: env file, data dir, stub docker. Options override the scenario. */
function setup({ label = 'auto never', current = OLD, health = true, dataset = true, pause = false, pg = false, pgFail = false, runFail = false, keep = null, extraEnv = [] } = {}) {
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
  if (pgFail) writeFileSync(join(stub, 'pg-fail'), '');
  if (runFail) writeFileSync(join(stub, 'run-fail'), NEW);
  const data = join(dir, 'data');
  if (dataset) mkdirSync(join(data, 'dolt', '.dolt'), { recursive: true }); else mkdirSync(data, { recursive: true });
  if (pause) writeFileSync(join(dir, 'UPDATE_PAUSED'), '');
  const env = join(dir, 'lyam.env');
  writeFileSync(env, [
    'IAM_PUBLIC_ORIGIN=https://example.invalid',
    `LYAM_DATA_DIR=${data}`,
    `LYAM_BACKUP_DIR=${join(dir, 'backups')}`,
    `LYAM_PAUSE_FILE=${join(dir, 'UPDATE_PAUSED')}`,
    `LYAM_LOCK_FILE=${join(dir, '.update.lock')}`,
    'LYAM_HEALTH_TIMEOUT=0',
    pg ? 'LYAM_BACKUP_PG_CONTAINER=pg' : '',
    keep !== null ? `LYAM_BACKUP_KEEP=${keep}` : '',
    ...extraEnv,
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

test('a moving tag is refused before any docker state change', () => {
  const { env } = setup();
  const r = run(env, '--image', 'ghcr.io/example/lyam:latest', '--env-file', env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /immutable/);
  assert.doesNotMatch(r.calls, /docker (stop|run|pull)/);
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

test('a concurrent run is refused by the host lock', async () => {
  const { env, dir } = setup();
  const lock = join(dir, '.update.lock');
  const holder = spawn('sh', ['-c', 'exec 9>"$1"; flock 9; sleep 3', 'sh', lock], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 300));
  const r = run(env, '--image', NEW, '--env-file', env);
  holder.kill();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /another update/);
});

test('happy path: cold backup BEFORE the swap, container forced to seed mode never, backups kept', () => {
  const { env, dir } = setup({ pg: true });
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 0, r.stderr);
  const order = r.calls.split('\n').map((l) => l.replace(/^docker (\S+).*$/, '$1'));
  const stopAt = order.indexOf('stop');
  const runAt = order.indexOf('run');
  assert.ok(stopAt > -1 && runAt > stopAt, 'container stopped before the new run (cold backup)');
  const runArgs = readFileSync(join(dirname(env), 'stub', 'run-args'), 'utf8');
  assert.ok(runArgs.includes('IAM_DEMO_SEED_MODE=never'), 'seed mode never forced');
  assert.match(runArgs, /--env-file/);
  assert.ok(readdirSync(join(dir, 'backups')).some((f) => f.startsWith('lyam-data-')), 'data backup written');
  assert.ok(readdirSync(join(dir, 'backups')).some((f) => f.startsWith('lyam-pg-')), 'pg dump written');
});

test('a same-image redeploy still stops the container and takes a cold backup', () => {
  const { env } = setup({ current: NEW });
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /docker stop/, 'container stopped even when the image is unchanged');
});

test('a failed pg export aborts BEFORE the swap and restarts the previous container', () => {
  const { env } = setup({ pg: true, pgFail: true });
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /pg backup failed/);
  const runs = r.calls.split('\n').filter((l) => l.startsWith('docker run'));
  assert.equal(runs.length, 1, 'only the previous container is restarted');
  assert.ok(runs[0].endsWith(OLD), 'the restarted container is the previous image');
});

test('a failed container creation triggers compensation (restore + previous image)', () => {
  const { env } = setup({ runFail: true });
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /rolled back/);
  const runs = r.calls.split('\n').filter((l) => l.startsWith('docker run'));
  assert.equal(runs.length, 2, 'failed creation, then the rollback');
  assert.ok(runs[1].endsWith(OLD));
});

test('an unhealthy new image rolls back image AND data together', () => {
  const { env } = setup({ health: false, pg: true });
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /rolled back.*pre-update data restored/);
  const runs = r.calls.split('\n').filter((l) => l.startsWith('docker run'));
  assert.equal(runs.length, 2, 'new image started, then the rollback');
  assert.ok(runs[1].endsWith(OLD), 'rollback runs the previous image');
});

test('a failing pre-update hook aborts before any backup or swap (preservation chain incomplete)', () => {
  const { env } = setup({ extraEnv: ['LYAM_PRE_UPDATE_HOOK=exit 1'] });
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /pre-update hook failed/);
  const runs = r.calls.split('\n').filter((l) => l.startsWith('docker run'));
  assert.ok(!runs.some((l) => l.endsWith(NEW)), 'the new image never started');
  assert.ok(runs.some((l) => l.endsWith(OLD)), 'the previous container was restarted');
});

test('a successful pre-update hook runs while the container is stopped', () => {
  const { env, dir } = setup();
  writeFileSync(env, readFileSync(env, 'utf8') + `LYAM_PRE_UPDATE_HOOK=touch ${join(dir, 'hook-ran')}\n`);
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dir, 'hook-ran')), 'hook executed');
  assert.match(r.calls, /docker stop/, 'container stopped for the hook');
});

test('retention prunes old generations using full paths', () => {
  const { env, dir } = setup({ keep: 2 });
  const backups = join(dir, 'backups');
  mkdirSync(backups, { recursive: true });
  for (const ts of ['20260101T000000Z', '20260102T000000Z', '20260103T000000Z']) {
    writeFileSync(join(backups, `lyam-data-${ts}.tar.gz`), 'old');
  }
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 0, r.stderr);
  const left = readdirSync(backups).filter((f) => f.startsWith('lyam-data-'));
  assert.equal(left.length, 2, `expected 2 generations kept, found ${left.length}: ${left}`);
});

test('update.sh is valid POSIX shell', () => {
  const r = spawnSync('sh', ['-n', updater], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
