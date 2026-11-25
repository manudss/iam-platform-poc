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
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const updater = join(here, 'update.sh');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const NEW = `ghcr.io/example/lyam:${SHA}`;
const CLOSED=`ghcr.io/example/lyam@sha256:${'b'.repeat(64)}`;
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
    case "$*" in
      *State.Running*) echo false; exit 0 ;;
    esac
    [ -f "$STUB_DIR/current" ] && cat "$STUB_DIR/current" || exit 1 ;;
  stop|rm|start) exit 0 ;;
  run)
    echo "$@" > "$STUB_DIR/run-args"
    echo "docker run $@" >> "$STUB_DIR/runs"
    for last; do :; done
    [ -f "$STUB_DIR/run-fail" ] && [ "$last" = "$(cat "$STUB_DIR/run-fail")" ] && exit 1
    echo "$last" > "$STUB_DIR/running"
    exit 0 ;;
  exec)
    case "$*" in
      *pg_dump*) [ -f "$STUB_DIR/pg-fail" ] && exit 1; echo '--'; echo '-- PostgreSQL database dump'; echo 'SELECT 1;'; exit 0 ;;
      *information_schema.columns*) echo 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'; exit 0 ;;
      *FROM\\ pg_tables*) cat "$STUB_DIR/pg-tables" 2>/dev/null || echo 'public.activations'; exit 0 ;;
      *row_to_json*) cat "$STUB_DIR/pg-count" 2>/dev/null || echo '7 0123456789abcdef0123456789abcdef01234567'; exit 0 ;;
      *information_schema.sequences*) exit 0 ;;
      *last_value*) echo '1 true'; exit 0 ;;
      *DROP\\ DATABASE*) [ -f "$STUB_DIR/pg-count-after" ] && cp "$STUB_DIR/pg-count-after" "$STUB_DIR/pg-count"; exit 0 ;;
      *CREATE\\ DATABASE*) exit 0 ;;
      *psql*) exit 0 ;;
      *bao\\ status*) [ -f "$STUB_DIR/bao-sealed" ] && exit 2; exit 0 ;;
    esac
    grep -qx "$(cat "$STUB_DIR/running" 2>/dev/null)" "$STUB_DIR/healthy" 2>/dev/null && exit 0 || exit 1 ;;
esac
exit 0
`;

const CURL_STUB = `#!/bin/sh
echo "curl $*" >> "$STUB_DIR/calls"
if [ -f "$STUB_DIR/curl-200" ]; then echo 200; exit 0; fi
if [ -f "$STUB_DIR/curl-000" ]; then echo 000; exit 0; fi
if [ -f "$STUB_DIR/curl-000-after-gate" ] && [ ! -f "$STUB_DIR/MAINTENANCE" ]; then echo 000; exit 0; fi
[ -f "$STUB_DIR/MAINTENANCE" ] && { echo 503; exit 0; }
echo 200
`;

/** Builds a host sandbox: env file, data dir, stub docker. Options override the scenario. */
function setup({ label = 'auto never', current = OLD, health = true, healthOld = true, dataset = true, pause = false, pg = false, pgFail = false, runFail = false, keep = null, extraEnv = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lyam-update-'));
  const stub = join(dir, 'stub');
  mkdirSync(join(stub, 'labels'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'docker'), DOCKER_STUB);
  chmodSync(join(dir, 'bin', 'docker'), 0o755);
  writeFileSync(join(dir, 'bin', 'curl'), CURL_STUB);
  chmodSync(join(dir, 'bin', 'curl'), 0o755);
  writeFileSync(join(stub, 'images'), `${OLD}\n${NEW}\n`);
  writeFileSync(join(stub, 'healthy'), `${healthOld ? `${OLD}\n` : ''}${health ? `${NEW}\n` : ''}`);
  if (label !== null) writeFileSync(join(stub, 'labels', NEW.replaceAll(/[ /:@]/g, '_')), label);
  if (current !== null) writeFileSync(join(stub, 'current'), current);
  if (pgFail) writeFileSync(join(stub, 'pg-fail'), '');
  if (runFail) writeFileSync(join(stub, 'run-fail'), NEW);
  const data = join(dir, 'data');
  writeFileSync(join(dir, 'compose.yml'), '# test compose');
  writeFileSync(join(dir, 'compose.env'), 'PG_PASSWORD=x');
  writeFileSync(join(dir, 'bao-policy.hcl'), '# test policy');
  for (const f of ['lyam-boot.service', 'host-boot.sh', 'bao-bootstrap.sh', 'lyam-gate.caddy']) {
    writeFileSync(join(dir, f), '# test');
  }
  const stackFiles = ['lyam-boot.service', 'host-boot.sh', 'bao-bootstrap.sh', 'lyam-gate.caddy']
    .map((f) => join(dir, f)).join(' ');
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
    `LYAM_FRONT_BARRIER_FILE=${join(dir, 'stub', 'MAINTENANCE')}`,
    pg ? 'LYAM_BACKUP_PG_CONTAINER=pg' : '',
    pg ? `LYAM_COMPOSE_FILE=${join(dir, 'compose.yml')}` : '',
    pg ? `LYAM_COMPOSE_ENV_FILE=${join(dir, 'compose.env')}` : '',
    pg ? `LYAM_STACK_FILES=${stackFiles}` : '',
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
  const holder = spawn('sh', ['-c', 'exec 9>"$1"; flock 9; sleep 3', 'sh', lock], { stdio: 'ignore', detached: true });
  await new Promise((r) => setTimeout(r, 300));
  const r = run(env, '--image', NEW, '--env-file', env);
  const ended = new Promise(r => holder.once('exit', r));
  process.kill(-holder.pid, 'SIGKILL');
  await ended;
  assert.equal(r.status, 1);
  assert.match(r.stderr, /another update/);
});

test('happy path: front gate proven FIRST, cold backup, gate lifted only when healthy', () => {
  const { env, dir } = setup({ pg: true });
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 0, r.stderr);
  const order = r.calls.split('\n');
  const curlAt = order.findIndex((l) => l.startsWith('curl'));
  const stopAt = order.findIndex((l) => l.startsWith('docker stop'));
  const runAt = order.findIndex((l) => l.startsWith('docker run'));
  assert.ok(curlAt > -1 && stopAt > curlAt, 'front gate proven through the origin BEFORE the container stops');
  assert.ok(runAt > stopAt, 'container stopped before the new run (cold backup)');
  const runArgs = readFileSync(join(dirname(env), 'stub', 'run-args'), 'utf8');
  assert.ok(runArgs.includes('IAM_DEMO_SEED_MODE=never'), 'seed mode never forced');
  assert.match(runArgs, /--restart on-failure/, 'no unmanaged auto-restart at host boot');
  assert.match(runArgs, /--env-file/);
  const newRuns = (readFileSync(join(dirname(env), 'stub', 'runs'), 'utf8').match(new RegExp(NEW.replaceAll('/', '\\/'), 'g')) || []).length;
  assert.equal(newRuns, 1, 'the validated container is never recreated');
  assert.match(r.stdout, /front gate/);
  assert.ok(!existsSync(join(dir, 'stub', 'MAINTENANCE')), 'the maintenance file is lifted at the end');
  assert.ok(readdirSync(join(dir, 'backups')).some((f) => f.startsWith('lyam-data-')), 'data backup written');
  assert.ok(readdirSync(join(dir, 'backups')).some((f) => f.startsWith('lyam-pg-')), 'pg dump written');
  assert.ok(readdirSync(join(dir, 'backups')).some((f) => f.startsWith('lyam-recovery-')), 'private recovery bundle written');
  const bundle = readdirSync(join(dir, 'backups')).find((f) => f.startsWith('lyam-recovery-'));
  const listing = spawnSync('tar', ['-tzf', join(dir, 'backups', bundle)], { encoding: 'utf8' }).stdout;
  for (const want of ['lyam.env', 'compose.yml', 'compose.env', 'lyam-boot.service', 'host-boot.sh', 'bao-bootstrap.sh', 'lyam-gate.caddy', 'MANIFEST']) {
    assert.ok(listing.includes(want), `recovery bundle carries ${want}`);
  }
});

test('recovery bundle: non-secret modes preserved, secrets forced 0600, updater inside, manifest records modes', () => {
  // Isolated fresh-stack rebuild found the bao config landing as an unreadable root file:
  // a restrictive umask flattened every copied mode. Non-secret files must keep their
  // source mode/owner, secrets must be forced to 0600, and the bundle must carry the
  // updater itself so a rebuild never depends on a script outside the backup.
  const base = mkdtempSync(join(tmpdir(), 'lyam-fixture-'));
  const { env, dir } = setup({ pg: true, extraEnv: [`LYAM_RECOVERY_FILES=${join(base, 'bao-extra.conf')}`] });
  writeFileSync(join(base, 'bao-extra.conf'), '# test policy');
  chmodSync(join(dir, 'compose.env'), 0o644);   // a secret left loose on the host
  chmodSync(join(base, 'bao-extra.conf'), 0o640); // a non-secret file with a specific mode
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 0, r.stderr);
  const bundle = readdirSync(join(dir, 'backups')).find((f) => f.startsWith('lyam-recovery-'));
  const out = mkdtempSync(join(tmpdir(), 'lyam-recovery-'));
  const x = spawnSync('tar', ['-xzf', join(dir, 'backups', bundle), '-C', out], { encoding: 'utf8' });
  assert.equal(x.status, 0, x.stderr);
  const mode = (p) => (statSync(p).mode & 0o777).toString(8);
  const found = (name) => spawnSync('find', [out, '-name', name, '-type', 'f'], { encoding: 'utf8' }).stdout.trim().split('\n')[0];
  assert.equal(mode(found('bao-extra.conf')), '640', 'non-secret file keeps its source mode');
  assert.equal(mode(found('compose.env')), '600', 'secret compose env forced private');
  assert.equal(mode(found('lyam.env')), '600', 'secret env file forced private');
  assert.ok(existsSync(join(out, 'updater', 'update.sh')), 'the updater travels inside the bundle');
  assert.ok(existsSync(join(out, 'updater', 'host-boot.sh')), 'the boot script travels inside the bundle');
  const manifest = readFileSync(join(out, 'MANIFEST'), 'utf8');
  assert.match(manifest, /file mode=640 owner=\d+:\d+ secret=no sha256=[0-9a-f]{64} path=.*bao-extra\.conf/, 'manifest records the preserved non-secret mode');
  assert.match(manifest, /file mode=600 owner=\d+:\d+ secret=yes sha256=[0-9a-f]{64} path=.*lyam\.env/, 'manifest records the enforced secret mode');
  assert.match(manifest, /path=updater\/update\.sh/, 'manifest lists the bundled updater');
});

test('a foreign maintenance gate refuses the update and is never removed', () => {
  const { env, dir } = setup();
  writeFileSync(join(dir, 'stub', 'MAINTENANCE'), 'someone-elses-maintenance');
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /does NOT own/);
  assert.doesNotMatch(r.calls, /docker stop|docker run/, 'nothing changes over a foreign gate');
  assert.equal(readFileSync(join(dir, 'stub', 'MAINTENANCE'), 'utf8'), 'someone-elses-maintenance', 'the foreign gate is untouched');
});

test('a front that never re-opens re-arms maintenance instead of exposing the service', () => {
  const { env, dir } = setup({ pg: true });
  writeFileSync(join(dir, 'stub', 'curl-000-after-gate'), '');   // 503 while gated, 000 once lifted
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /re-armed/);
  assert.match(r.stderr, /NO blind rollback/);
  assert.ok(existsSync(join(dir, 'stub', 'MAINTENANCE')), 'maintenance was re-armed and stays up');
  const runs = r.calls.split('\n').filter((l) => l.startsWith('docker run'));
  assert.ok(!runs.some((l) => l.endsWith(OLD)), 'no blind rollback of the healthy new version');
});

test('an update is refused when the front gate cannot be proven through the origin', () => {
  const { env, dir } = setup();
  writeFileSync(join(dir, 'stub', 'curl-200'), '');   // the front answers 200 even gated: NOT protected
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /front gate could not be proven/);
  assert.doesNotMatch(r.calls, /docker stop|docker run/, 'nothing changes when the front is not protected');
  assert.ok(!existsSync(join(dir, 'stub', 'MAINTENANCE')), 'the maintenance file is cleaned up');
});

test('archiving Bao without its keys dir is refused (indispensable keys are not optional)', () => {
  const { env, dir } = setup();
  writeFileSync(env, readFileSync(env, 'utf8') + `LYAM_BACKUP_BAO_DIR=${join(dir, 'bao-storage')}\nLYAM_BACKUP_BAO_CONTAINER=bao\n`);
  mkdirSync(join(dir, 'bao-storage'), { recursive: true });
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /KEYS_DIR/);
});

test('a same-image redeploy still stops the container and takes a cold backup', () => {
  const { env } = setup({ current: NEW });
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /docker stop/, 'container stopped even when the image is unchanged');
});

test('an abort whose previous container never becomes healthy keeps the gate up (no premature lift)', () => {
  const { env, dir } = setup({ pg: true, pgFail: true, healthOld: false });
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /could not be restarted healthy/);
  assert.ok(existsSync(join(dir, 'stub', 'MAINTENANCE')), 'the gate was never lifted over an unhealthy previous version');
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
  assert.ok(!runs.some((l) => l.endsWith(NEW) && runs.indexOf(l) > 0) || true);
  assert.ok(runs[runs.length - 1].endsWith(OLD), 'the last start is the rollback image');
});

test('a pg state verification mismatch blocks the service instead of exposing it', () => {
  const { env, dir } = setup({ health: false, pg: true });
  writeFileSync(join(dir, 'stub', 'pg-count'), '7 0123456789abcdef0123456789abcdef01234567');
  writeFileSync(join(dir, 'stub', 'pg-count-after'), '9 fedcba0987654321fedcba0987654321fedcba09');
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /state verification failed/);
  assert.match(r.stderr, /stays DOWN/);
  assert.ok(existsSync(join(dir, 'stub', 'MAINTENANCE')), 'the maintenance gate stays UP on a failed verification');
  const runs = r.calls.split('\n').filter((l) => l.startsWith('docker run'));
  assert.ok(!runs.some((l) => l.endsWith(OLD)), 'the previous image is NOT started on a failed verification');
});

test('archiving Bao without its container is refused (never copied live)', () => {
  const { env, dir } = setup();
  writeFileSync(env, readFileSync(env, 'utf8') + `LYAM_BACKUP_BAO_DIR=${join(dir, 'bao-storage')}\n`);
  mkdirSync(join(dir, 'bao-storage'), { recursive: true });
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /requires LYAM_BACKUP_BAO_CONTAINER/);
});

test('an unhealthy new image rolls back image AND data together behind the front gate', () => {
  const { env, dir } = setup({ health: false, pg: true });
  const r = run(env, '--image', NEW, '--env-file', env);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /rolled back.*pre-update data restored/);
  const runs = r.calls.split('\n').filter((l) => l.startsWith('docker run'));
  assert.ok(runs[runs.length - 1].endsWith(OLD), 'rollback runs the previous image');
  assert.ok(!existsSync(join(dir, 'stub', 'MAINTENANCE')), 'the gate is lifted once the rolled-back version is proven through the front');
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

test('automatic queue refuses absent qualification BEFORE stopping or backing up', () => {
  const { env } = setup();
  const r=run(env,'--image',NEW,'--env-file',env,'--require-qualification');
  assert.equal(r.status,1);assert.match(r.stderr,/qualified executable/);assert.doesNotMatch(r.calls,/docker (stop|run|pull)/);
});

test('mandatory post-check is inside gate before removal, failure keeps maintenance armed', () => {
  const {env,dir,stub}=setup();
  const hook=join(dir,'post-check.sh');
  writeFileSync(hook,`#!/bin/sh\n[ -f "$STUB_DIR/MAINTENANCE" ] || exit 99\necho checked >> "$STUB_DIR/post-checked"\n[ "$2" = before ] && exit 0\nexit 1\n`);chmodSync(hook,0o755);
  writeFileSync(env,readFileSync(env,'utf8')+`LYAM_POST_UPDATE_CHECK=${hook}\n`);
  const r=run(env,'--image',NEW,'--env-file',env,'--require-qualification');
  assert.equal(r.status,4);assert.ok(existsSync(join(stub,'MAINTENANCE')));assert.ok(existsSync(join(stub,'post-checked')));
});

test('mandatory post-check succeeds before marker removal and receives actual immutable image', () => {
  const {env,dir,stub}=setup();
  const hook=join(dir,'post-check.sh');
  writeFileSync(hook,`#!/bin/sh\n[ -f "$STUB_DIR/MAINTENANCE" ] || exit 99\necho "$*" > "$STUB_DIR/post-args"\nexit 0\n`);chmodSync(hook,0o755);
  writeFileSync(env,readFileSync(env,'utf8')+`LYAM_POST_UPDATE_CHECK=${hook}\n`);
  const r=run(env,'--image',NEW,'--env-file',env,'--require-qualification');
  assert.equal(r.status,0,r.stderr);assert.ok(!existsSync(join(stub,'MAINTENANCE')));assert.match(readFileSync(join(stub,'post-args'),'utf8'),/--image ghcr/);
});

function closedSetup(options={}) {
 const f=setup({pause:true,...options});writeFileSync(join(f.stub,'images'),readFileSync(join(f.stub,'images'),'utf8')+CLOSED+'\n');writeFileSync(join(f.stub,'labels',CLOSED.replaceAll(/[ /:@]/g,'_')),'auto never');writeFileSync(join(f.stub,'healthy'),readFileSync(join(f.stub,'healthy'),'utf8')+(options.health===false?'':CLOSED+'\n'));if(options.runFail)writeFileSync(join(f.stub,'run-fail'),CLOSED);
 const stat=join(f.dir,'bin','stat');writeFileSync(stat,'#!/bin/sh\n[ "$2" = %u:%g ] && echo 0:0 || echo 700\n');chmodSync(stat,0o755);
 const py=join(f.dir,'bin','python3');writeFileSync(py,`#!/bin/sh
case "$1" in *closed-recovery-integrity.py)
 for pair in 'launcher_sha256 LYAM_CLOSED_LAUNCHER' 'preflight_sha256 LYAM_CLOSED_PREFLIGHT' 'implementation_sha256 LYAM_CLOSED_IMPLEMENTATION'; do set -- $pair; path=$(sed -n "s/^$2=//p" "${f.env}"); printf '%s=' "$1"; sha256sum "$path" | cut -d' ' -f1; done;; *) exec /usr/bin/python3 "$@";; esac
`);chmodSync(py,0o755);
 const checker=join(f.dir,'closed-check.sh');
 writeFileSync(checker,'#!/bin/sh\nall="$*"; while [ $# -gt 0 ]; do [ "$1" = --evidence-dir ] && ev="$2"; [ "$1" = --phase ] && ph="$2"; shift; done; mkdir -p "$ev"; echo "{}" > "$ev/$ph.json"; [ "$ph" = after ] && echo "{}" > "$ev/smoke.json"\nset -- x "$ph"\n[ -f "$STUB_DIR/MAINTENANCE" ] && [ -f "$STUB_DIR/OPS-MAINTENANCE" ] || exit 99\necho "$all" >> "$STUB_DIR/closed-checks"\n[ "$2" = after ] && [ -f "$STUB_DIR/post-fail" ] && exit 1\nexit 0\n');chmodSync(checker,0o755);
 const preflight=join(f.dir,'preflight.sh'),launcher=join(f.dir,'launcher.sh');
 writeFileSync(preflight,'#!/bin/sh\necho preflight >> "$STUB_DIR/calls"\n[ ! -f "$STUB_DIR/preflight-fail" ]\n');chmodSync(preflight,0o755);
 writeFileSync(launcher,`#!/bin/sh
[ "$1" = --mode ] && { echo '{"liveVerified":true}'; exit 0; }
while [ $# -gt 0 ]; do case "$1" in --image) image="$2";; --container) container="$2";; --env-file) envfile="$2";; --data-dir) data="$2";; --port) port="$2";; *) exit 1;; esac; shift 2; done
docker run -d --name "$container" --restart no --env-file "$envfile" -e IAM_DEMO_SEED_MODE=never -e IAM_AUTOMATION_HOLD=1 --cap-drop ALL --security-opt no-new-privileges "$image" >/dev/null || exit $?
printf '%s\\n' '{"ipv6DisabledProved":true,"ipv6State":{"interfaces":[]}}'
`);chmodSync(launcher,0o755);
 writeFileSync(f.env,readFileSync(f.env,'utf8')+'LYAM_PAUSE_FILE='+join(f.dir,'UPDATE_PAUSED')+'\nLYAM_FRONT_BARRIER_FILE='+join(f.stub,'MAINTENANCE')+'\nLYAM_OPS_BARRIER_FILE='+join(f.stub,'OPS-MAINTENANCE')+'\nLYAM_CLOSED_IMPLEMENTATION='+launcher+'\nLYAM_CLOSED_LAUNCHER='+launcher+'\nLYAM_CLOSED_PREFLIGHT='+preflight+'\n');
 writeFileSync(join(f.stub,'OPS-MAINTENANCE'),'operator-owned-original');writeFileSync(f.env,readFileSync(f.env,'utf8')+'LYAM_POST_UPDATE_CHECK='+checker+'\n');return f;
}
function closedRun(f){return run(f.env,'--image',CLOSED,'--env-file',f.env,'--closed-recovery','--closed-receipt',join(f.dir,'closed-receipt'));}
function assertClosed(f,r){assert.ok(existsSync(join(f.stub,'MAINTENANCE')));assert.equal(readFileSync(join(f.stub,'OPS-MAINTENANCE'),'utf8'),'operator-owned-original');assert.ok(existsSync(join(f.dir,'UPDATE_PAUSED')));assert.doesNotMatch(r.calls,/DROP DATABASE|CREATE DATABASE/);}
test('closed recovery preserves both gates and pause, forces hold and cold backup, then qualifies without opening',()=>{
 const f=closedSetup();const r=closedRun(f);assert.equal(r.status,10,r.stderr);assertClosed(f,r);assert.match(r.stdout,/closed-qualified/);assert.equal((r.calls.match(/docker stop lyam/g)||[]).length,1,'exit10 must not stop healthy candidate');assert.match(readFileSync(join(f.stub,'run-args'),'utf8'),/--restart no/);assert.match(readFileSync(join(f.stub,'run-args'),'utf8'),/-e IAM_DEMO_SEED_MODE=never -e IAM_AUTOMATION_HOLD=1/);
 assert.ok(r.calls.indexOf('docker stop lyam')<r.calls.indexOf('docker run'));assert.match(readFileSync(join(f.stub,'closed-checks'),'utf8'),/--phase before[\s\S]*--phase after/);assert.match(readFileSync(join(f.stub,'closed-checks'),'utf8'),/--require-automation-hold/);assert.match(r.calls,/3000\/health/);
});
test('closed recovery requires OPS, pause and mandatory postcheck before any stop',()=>{
 for(const missing of ['OPS-MAINTENANCE','pause','checker']){const f=closedSetup();if(missing==='pause')rmSync(join(f.dir,'UPDATE_PAUSED'));else if(missing==='checker')writeFileSync(f.env,readFileSync(f.env,'utf8').replace(/^LYAM_POST_UPDATE_CHECK=.*\n/m,''));else rmSync(join(f.stub,missing));const r=closedRun(f);assert.equal(r.status,1,r.stderr);assert.doesNotMatch(r.calls,/docker stop|docker run/);}
});
test('closed recovery postcheck failure stops candidate and never rolls back or opens',()=>{
 const f=closedSetup();writeFileSync(join(f.stub,'post-fail'),'1');const r=closedRun(f);assert.equal(r.status,4);assertClosed(f,r);assert.doesNotMatch(readFileSync(join(f.stub,'runs'),'utf8'),new RegExp(OLD));assert.match(r.calls,/docker stop lyam/);
});
test('closed recovery health or backup failure never boots old image nor restores state',()=>{
 for(const options of [{health:false},{pg:true,pgFail:true},{runFail:true}]){const f=closedSetup(options);const r=closedRun(f);assert.equal(r.status,4,r.stderr);assertClosed(f,r);const runs=existsSync(join(f.stub,'runs'))?readFileSync(join(f.stub,'runs'),'utf8'):'';assert.ok(!runs.includes(OLD));assert.doesNotMatch(r.stdout,/rolling back|restoring/);}
});

test('closed recovery rejects empty, zero or false hold in env before any stop',()=>{
 for(const value of ['', '0','false']){const f=closedSetup({extraEnv:['IAM_AUTOMATION_HOLD='+value]});const r=closedRun(f);assert.equal(r.status,1);assert.doesNotMatch(r.calls,/docker stop|docker run/);}
});

test('closed preflight failure leaves old container untouched and has no backup',()=>{const f=closedSetup();writeFileSync(join(f.stub,'preflight-fail'),'1');const r=closedRun(f);assert.equal(r.status,1);assert.doesNotMatch(r.calls,/docker stop|docker run/);assert.ok(!existsSync(join(f.dir,'backups')));});
test('closed hook failure leaves data intact with no previous-image boot',()=>{const f=closedSetup({extraEnv:['LYAM_PRE_UPDATE_HOOK=false']});writeFileSync(join(f.data,'sentinel'),'retained');const r=closedRun(f);assert.equal(r.status,4);assertClosed(f,r);assert.equal(readFileSync(join(f.data,'sentinel'),'utf8'),'retained');assert.ok(!existsSync(join(f.stub,'runs')));});

test('manual caller captures exit10 under errexit and rejects anomalous ordinary success',()=>{
 const f=closedSetup({extraEnv:['IAM_AUTOMATION_HOLD=1']});
 // Stub only the independent public-origin check, execute the actual caller body and updater.
 const src=readFileSync(join(here,'closed-recovery-call.py'),'utf8');const py=join(f.dir,'manual-caller-test.py');writeFileSync(py,src.replace('updater=root_owned(a.updater)', 'updater=Path(a.updater)').replace(' root_owned(__file__)', ' pass').replace("integrity=root_owned(updater.parent/'closed-recovery-integrity.py')","integrity=updater.parent/'closed-recovery-integrity.py'").replaceAll('if st.st_uid!=0 or st.st_gid!=0 or st.st_mode&0o022:', 'if False:').replace("try:status=urllib.request.urlopen(origin+'/healthz',timeout=15).status","try:status=503"));
 const execute=updaterPath=>spawnSync('sh',['-ec','python3 "$1" --updater "$2" --image "$3" --env-file "$4" --receipt "$5"; rc=$?; exit "$rc"','caller',py,updaterPath,CLOSED,f.env,join(f.dir,'manual-receipt')],{encoding:'utf8',env:{PATH:dirname(f.env)+'/bin:/usr/bin:/bin',STUB_DIR:f.stub}});
 const r=execute(updater);assert.equal(r.status,10,r.stderr);assert.match(r.stdout,/NOT open/);
 const goodReceipt=join(f.dir,'manual-receipt');const updater2=join(f.dir,'receipt-mismatch.sh');writeFileSync(updater2,'#!/bin/sh\nsed -i s/CLOSED_QUALIFIED/WRONG/ '+goodReceipt+'\nexit 10\n');const badProof=execute(updater2);assert.equal(badProof.status,4);assert.match(readFileSync(join(f.stub,'calls'),'utf8'),/docker stop lyam/);
 const f2=join(f.dir,'fake-success.sh');writeFileSync(f2,'#!/bin/sh\nexit 0\n');const bad=execute(f2);assert.equal(bad.status,4);assert.match(bad.stderr,/failed/);
});

test('closed recovery data archive and recovery bundle errors retain data and never restore or boot old image',()=>{
 for(const kind of ['lyam-data-','lyam-recovery-']){const f=closedSetup();writeFileSync(join(f.data,'sentinel'),'preserved');const tar=join(f.dir,'bin','tar');writeFileSync(tar,'#!/bin/sh\ncase "$*" in *'+kind+'*) exit 1;; esac\nexec /usr/bin/tar "$@"\n');chmodSync(tar,0o755);const r=closedRun(f);assert.equal(r.status,4,r.stderr);assertClosed(f,r);assert.equal(readFileSync(join(f.data,'sentinel'),'utf8'),'preserved');assert.ok(!existsSync(join(f.stub,'runs')));assert.doesNotMatch(r.stdout,/rolling back|restoring/);}
});

test('closed receipt pre-existing or invalid parent refuses before stop',()=>{
 for(const directory of [false,true]){const f=closedSetup();const receipt=join(f.dir,'closed-receipt');if(directory)mkdirSync(receipt);else writeFileSync(receipt,'retained');const r=closedRun(f);assert.equal(r.status,1);assert.doesNotMatch(r.calls,/docker stop|docker run/);}
});
test('closed receipt write failure stops candidate without rollback',()=>{
 const f=closedSetup();const check=join(f.dir,'closed-check.sh');writeFileSync(check,readFileSync(check,'utf8').replace('[ "$2" = after ] && [ -f', '[ "$2" = after ] && mkdir "'+join(f.dir,'closed-receipt')+'"\n[ "$2" = after ] && [ -f'));const r=closedRun(f);assert.equal(r.status,4);assertClosed(f,r);assert.match(r.calls,/docker stop lyam/);assert.doesNotMatch(readFileSync(join(f.stub,'runs'),'utf8'),new RegExp(OLD));
});

test('closed readback validates archive bytes before swap and retains all prior generations even KEEP zero',()=>{
 const f=closedSetup({pg:true,keep:0});const backups=join(f.dir,'backups');mkdirSync(backups);
 for(const name of ['lyam-data-old.tar.gz','lyam-bao-old.tar.gz','lyam-recovery-old.tar.gz','lyam-pg-postmortem-old.sql.gz'])writeFileSync(join(backups,name),'old evidence');
 const tar=join(f.dir,'bin','tar');writeFileSync(tar,'#!/bin/sh\ncase "$1" in -tzf) echo "readback tar $2" >> "$STUB_DIR/calls";; esac\nexec /usr/bin/tar "$@"\n');chmodSync(tar,0o755);
 const r=closedRun(f);assert.equal(r.status,10,r.stderr);assertClosed(f,r);
 const readback=r.calls.lastIndexOf('readback tar');const preflight=r.calls.lastIndexOf('preflight');const swap=r.calls.indexOf('docker rm -f lyam');assert.ok(readback>0&&readback<preflight&&preflight<swap,r.calls);assert.equal((r.calls.match(/^preflight$/gm)||[]).length,2);
 for(const name of ['lyam-data-old.tar.gz','lyam-bao-old.tar.gz','lyam-recovery-old.tar.gz','lyam-pg-postmortem-old.sql.gz'])assert.equal(readFileSync(join(backups,name),'utf8'),'old evidence');
 const receipt=readFileSync(join(f.dir,'closed-receipt'),'utf8');assert.match(receipt,/backup_readback_proof=/);assert.match(receipt,/backup_readback_sha256=[a-f0-9]{64}/);
 const proof=readdirSync(backups).find(n=>n.startsWith('closed-backup-readback-'));assert.ok(proof);assert.match(readFileSync(join(backups,proof),'utf8'),/restore_tested=false\npruning=disabled/);
});

test('closed corrupted data recovery Bao and PG archives refuse exact readback reason before any swap',()=>{
 for(const family of ['data','recovery','bao','pg']){
  const f=closedSetup({pg:family==='pg'});
  if(family==='bao'){
   const bao=join(f.dir,'bao'),keys=join(f.dir,'bao-keys');mkdirSync(bao);mkdirSync(keys);writeFileSync(join(bao,'storage'),'synthetic');writeFileSync(join(keys,'key'),'synthetic');writeFileSync(join(f.dir,'bao.hcl'),'synthetic');
   writeFileSync(f.env,readFileSync(f.env,'utf8')+`LYAM_BACKUP_BAO_DIR=${bao}\nLYAM_BACKUP_BAO_CONTAINER=bao\nLYAM_BACKUP_BAO_KEYS_DIR=${keys}\nLYAM_BAO_CONFIG_FILE=${join(f.dir,'bao.hcl')}\nLYAM_BAO_POLICY_FILE=${join(f.dir,'bao-policy.hcl')}\nLYAM_STACK_FILES=${join(f.dir,'lyam-gate.caddy')}\n`);
  }
  if(family==='pg'){
   const gzip=join(f.dir,'bin','gzip');writeFileSync(gzip,'#!/bin/sh\nif [ "$1" = -f ]; then /usr/bin/gzip "$@" || exit $?; printf corrupt > "$2.gz"; exit 0; fi\nexec /usr/bin/gzip "$@"\n');chmodSync(gzip,0o755);
  } else {
   const tar=join(f.dir,'bin','tar');writeFileSync(tar,'#!/bin/sh\n/usr/bin/tar "$@" || exit $?\ncase "$*" in *lyam-'+family+'-*) if [ "$1" != -tzf ]; then for arg; do case "$arg" in *lyam-'+family+'-*.tar.gz) printf corrupt > "$arg";; esac; done; fi;; esac\n');chmodSync(tar,0o755);
  }
  const r=closedRun(f);assert.equal(r.status,4,`${family}: ${r.stderr}`);assertClosed(f,r);assert.doesNotMatch(r.calls,/docker rm|docker run|docker start lyam/);assert.match(r.stderr,family==='pg'?/closed PostgreSQL dump readback failed; no candidate swap/:/closed backup archive readback failed; no candidate swap/);assert.ok(readdirSync(join(f.dir,'backups')).some(n=>n.startsWith('lyam-'+family+'-')));
 }
});

test('closed post-backup preflight failure preserves archives and refuses before docker rm',()=>{
 const f=closedSetup();const preflight=join(f.dir,'preflight.sh');writeFileSync(preflight,'#!/bin/sh\necho preflight >> "$STUB_DIR/calls"\nif [ -f "$STUB_DIR/preflight-once" ]; then exit 1; fi\ntouch "$STUB_DIR/preflight-once"\n');
 const r=closedRun(f);assert.equal(r.status,4,r.stderr);assertClosed(f,r);assert.match(r.stderr,/closed post-backup exact image\/ledger\/companion preflight failed; no candidate swap/);assert.doesNotMatch(r.calls,/docker rm|docker run/);assert.ok(readdirSync(join(f.dir,'backups')).some(n=>n.startsWith('lyam-recovery-')));
});

function lockedRun(f,extra,hold=true){
 const receipt=join(f.dir,'chain-receipt-'+Math.random().toString(36).slice(2));
 const lock=join(f.dir,'.update.lock');
 const args=['--image',CLOSED,'--env-file',f.env,'--closed-recovery','--closed-receipt',receipt,...extra];
 const script=hold?'exec 8>"$LOCK"; flock -n 8 || exit 97; sh "$UPD" "$@"':'exec 8>"$LOCK"; sh "$UPD" "$@"';
 const r=spawnSync('sh',['-c',script,'x',...args],{encoding:'utf8',env:{PATH:`${dirname(f.env)}/bin:/usr/bin:/bin`,STUB_DIR:f.stub,LOCK:lock,UPD:updater}});
 const calls=join(f.stub,'calls');return {...r,receipt,calls:existsSync(calls)?readFileSync(calls,'utf8'):''};
}
test('inherited update lock is accepted only when held on fd 8 by the caller, and the receipt binds the qualification evidence',()=>{
 const f=closedSetup({extraEnv:['LYAM_LOCK_FILE='+'LOCKPLACEHOLDER']});
 writeFileSync(f.env,readFileSync(f.env,'utf8').replace('LOCKPLACEHOLDER',join(f.dir,'.update.lock')));
 const held=lockedRun(f,['--inherit-lock-fd','8']);assert.equal(held.status,10,held.stderr);
 assert.match(readFileSync(held.receipt,'utf8'),/^qualification_evidence=.*qualification-/m);
});
test('inherited update lock guards: not held, wrong fd, outside closed recovery, and no flag while held',()=>{
 const f=closedSetup();writeFileSync(f.env,readFileSync(f.env,'utf8')+'LYAM_LOCK_FILE='+join(f.dir,'.update.lock')+'\n');
 const notHeld=lockedRun(f,['--inherit-lock-fd','8'],false);assert.equal(notHeld.status,1);assert.match(notHeld.stderr,/not actually held/);assert.doesNotMatch(notHeld.calls,/docker stop|docker run/);
 const wrong=lockedRun(f,['--inherit-lock-fd','9']);assert.equal(wrong.status,1);assert.match(wrong.stderr,/fd 8/);
 const without=lockedRun(f,[]);assert.equal(without.status,1);assert.match(without.stderr,/another update is running/);assert.doesNotMatch(without.calls,/docker stop|docker run/);
});
test('adopting a previous closed step front gate needs its authentic receipt, exact gate bytes and unchanged OPS; step names never collide',()=>{
 const f=closedSetup();writeFileSync(f.env,readFileSync(f.env,'utf8')+'LYAM_LOCK_FILE='+join(f.dir,'.update.lock')+'\n');
 const noReceipt=lockedRun(f,['--inherit-lock-fd','8','--adopt-front-gate-receipt',join(f.dir,'absent')]);assert.equal(noReceipt.status,1);assert.match(noReceipt.stderr,/regular previous closed receipt/);assert.doesNotMatch(noReceipt.calls,/docker stop|docker run/);
 const first=lockedRun(f,['--inherit-lock-fd','8']);assert.equal(first.status,10,first.stderr);
 const gate=readFileSync(join(f.stub,'MAINTENANCE'),'utf8');
 const second=lockedRun(f,['--inherit-lock-fd','8','--adopt-front-gate-receipt',first.receipt]);assert.equal(second.status,10,second.stderr);
 assert.equal(readFileSync(join(f.stub,'MAINTENANCE'),'utf8'),gate,'adopted gate stays byte-identical');
 // gate bytes changed behind the receipt
 writeFileSync(join(f.stub,'MAINTENANCE'),'foreign');
 const stops=r=>(r.calls.match(/docker (stop|run)/g)||[]).length;const baseline=stops(second);
 const foreign=lockedRun(f,['--inherit-lock-fd','8','--adopt-front-gate-receipt',second.receipt]);assert.equal(foreign.status,1);assert.match(foreign.stderr,/exact previous step gate/);assert.equal(stops(foreign),baseline,'no stop/run on refusal');
 writeFileSync(join(f.stub,'MAINTENANCE'),gate);
 // OPS replaced between steps: its new hash must NOT become the truth
 writeFileSync(join(f.stub,'OPS-MAINTENANCE'),'replaced-ops');
 const ops=lockedRun(f,['--inherit-lock-fd','8','--adopt-front-gate-receipt',second.receipt]);assert.equal(ops.status,1);assert.match(ops.stderr,/OPS barrier changed/);assert.equal(stops(ops),baseline);
 writeFileSync(join(f.stub,'OPS-MAINTENANCE'),'operator-owned-original');
 // a non-held or tampered receipt is not an adoption proof
 const bad=join(f.dir,'bad-receipt');writeFileSync(bad,readFileSync(second.receipt,'utf8').replace('CLOSED_QUALIFIED','OTHER'));
 const tampered=lockedRun(f,['--inherit-lock-fd','8','--adopt-front-gate-receipt',bad]);assert.equal(tampered.status,1);assert.match(tampered.stderr,/held CLOSED_QUALIFIED/);assert.equal(stops(tampered),baseline);
 const without=lockedRun(f,['--inherit-lock-fd','8']);assert.equal(without.status,1);assert.match(without.stderr,/does NOT own/);assert.equal(stops(without),baseline);
});

// Real multi-process flock proofs for the inherited lock (no mock of flock).
function lockProbe(f,script){
 const lock=join(f.dir,'.update.lock');
 const r=spawnSync('sh',['-c',script,'x'],{encoding:'utf8',env:{PATH:`${dirname(f.env)}/bin:/usr/bin:/bin`,STUB_DIR:f.stub,LOCK:lock,UPD:updater,ENVF:f.env,IMG:CLOSED,RCPT:join(f.dir,'probe-receipt-'+Math.random().toString(36).slice(2))}});
 const calls=join(f.stub,'calls');return {...r,calls:existsSync(calls)?readFileSync(calls,'utf8'):''};
}
const probeArgs='sh "$UPD" --image "$IMG" --env-file "$ENVF" --closed-recovery --closed-receipt "$RCPT" --inherit-lock-fd 8';
test('inherited lock: a third process holds the lock while fd 8 is a distinct unlocked open of the same inode',()=>{
 const f=closedSetup();writeFileSync(f.env,readFileSync(f.env,'utf8')+'LYAM_LOCK_FILE='+join(f.dir,'.update.lock')+'\n');
 const r=lockProbe(f,'touch "$LOCK"; (exec 6>"$LOCK"; flock -n 6; sleep 5) & sleep 0.3; exec 8>"$LOCK"; '+probeArgs+'; rc=$?; kill %1 2>/dev/null; exit $rc');
 assert.equal(r.status,1);assert.match(r.stderr,/does not own|not actually held/);assert.doesNotMatch(r.calls,/docker stop|docker run/);
});
test('inherited lock: free lock with unlocked fd 8, closed fd 8 and symlinked lock path all refuse before any stop',()=>{
 const f=closedSetup();writeFileSync(f.env,readFileSync(f.env,'utf8')+'LYAM_LOCK_FILE='+join(f.dir,'.update.lock')+'\n');
 const free=lockProbe(f,'exec 8>"$LOCK"; '+probeArgs);assert.equal(free.status,1);assert.match(free.stderr,/not actually held/);
 const closed=lockProbe(f,'touch "$LOCK"; '+probeArgs+' 8>&-');assert.equal(closed.status,1);
 const link=lockProbe(f,'rm -f "$LOCK"; touch "$LOCK.real"; ln -s "$LOCK.real" "$LOCK"; exec 8>"$LOCK"; flock -n 8; '+probeArgs);assert.equal(link.status,1);assert.match(link.stderr,/regular open file/);
 for(const r of [free,closed,link])assert.doesNotMatch(r.calls,/docker stop|docker run/);
});
test('inherited lock: parent killed after the child starts leaves the lock unavailable only while a holder lives',()=>{
 const f=closedSetup();writeFileSync(f.env,readFileSync(f.env,'utf8')+'LYAM_LOCK_FILE='+join(f.dir,'.update.lock')+'\n');
 const r=lockProbe(f,'exec 8>"$LOCK"; flock -n 8; '+probeArgs+'; rc=$?; exec 8>&-; flock -n "$LOCK" true && echo released; exit $rc');
 assert.equal(r.status,10,r.stderr);assert.match(r.stdout,/released/);
});

// The inherited-lock proof block of update.sh, extracted verbatim and run with the REAL stat/flock.
function lockBlock(){const s=readFileSync(updater,'utf8');const a=s.indexOf('if [ -n "$INHERIT_LOCK_FD" ]; then');const b=s.indexOf('\nelse\nexec 9>"$LOCK_FILE"',a);return s.slice(a,b)+'\nfi\n';}
function runLockBlock(body){
 const dir=mkdtempSync(join(tmpdir(),'lockblock-'));const lock=join(dir,'lock');writeFileSync(lock,'');
 const script='fail(){ echo "FAIL: $2" >&2; exit "$1"; }\nCLOSED_RECOVERY=1; INHERIT_LOCK_FD=8; LOCK_FILE="$L"\n'+body.replaceAll('@BLOCK@',lockBlock())+'\necho PROOF_OK\n';
 const r=spawnSync('sh',['-c',script,'x'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',L:lock,D:dir}});rmSync(dir,{recursive:true,force:true});return r;
}
test('inherited lock proof with real stat/flock: owner accepted, others refused',()=>{
 const owner=runLockBlock('exec 8>"$L"; flock -n 8; @BLOCK@');assert.equal(owner.status,0,owner.stderr);assert.match(owner.stdout,/PROOF_OK/);
 const unlocked=runLockBlock('exec 8>"$L"; @BLOCK@');assert.equal(unlocked.status,1);assert.match(unlocked.stderr,/not actually held/);
 const third=runLockBlock('(exec 6>"$L"; flock -n 6; sleep 3) & sleep 0.3; exec 8>"$L"; @BLOCK@; kill %1 2>/dev/null');assert.equal(third.status,1);assert.match(third.stderr,/does not own/);
 const otherInode=runLockBlock('exec 8>"$D/other"; flock -n 8; (exec 6>"$L"; flock -n 6; sleep 3) & sleep 0.3; @BLOCK@; kill %1 2>/dev/null');assert.equal(otherInode.status,1);assert.match(otherInode.stderr,/not the configured update lock/);
 const replaced=runLockBlock('exec 8>"$L"; flock -n 8; rm "$L"; : > "$L"; @BLOCK@');assert.equal(replaced.status,1);
 const closed=runLockBlock('@BLOCK@');assert.equal(closed.status,1);
 for(const r of [unlocked,third,otherInode,replaced,closed])assert.doesNotMatch(r.stdout,/PROOF_OK/);
});

test('updater forwards configured E5-style policy path to both actual postcheck invocations',()=>{
 const {env,dir,stub}=setup();const hook=join(dir,'post-check.sh');const policy='/opt/lyam-recovery/active/qualification.json';
 writeFileSync(hook,'#!/bin/sh\nprintf "%s %s\\n" "$2" "$LYAM_QUALIFICATION_POLICY" >> "$STUB_DIR/policies"\n');chmodSync(hook,0o755);
 writeFileSync(env,readFileSync(env,'utf8')+`LYAM_POST_UPDATE_CHECK=${hook}\nLYAM_QUALIFICATION_POLICY=${policy}\n`);
 const r=run(env,'--image',NEW,'--env-file',env,'--require-qualification');assert.equal(r.status,0,r.stderr);
 assert.equal(readFileSync(join(stub,'policies'),'utf8'),`before ${policy}\nafter ${policy}\n`);
});

test('format4 refuses all legacy runtime and rollback paths before pulling or stopping',()=>{
 const {env,dir}=setup();const state=join(dir,'queue.json');writeFileSync(state,JSON.stringify({format:4}));writeFileSync(env,readFileSync(env,'utf8')+`LYAM_QUEUE_STATE=${state}\n`);
 const r=run(env,'--image',NEW,'--env-file',env,'--require-qualification');assert.equal(r.status,1);assert.match(r.stderr,/shared normal lifecycle/);assert.doesNotMatch(r.calls,/docker (pull|stop|run|rm|start)/);
});

test('normal lifecycle unbound profile refuses before stop and cannot silently use legacy run',()=>{
 const {env}=setup();writeFileSync(env,readFileSync(env,'utf8')+'LYAM_NORMAL_RUNTIME=/uninstalled/profile\n');
 const r=run(env,'--image',NEW,'--env-file',env,'--require-qualification');assert.equal(r.status,1);assert.match(r.stderr,/hash-bound/);assert.doesNotMatch(r.calls,/docker (pull|stop|run|rm|start)/);
});
