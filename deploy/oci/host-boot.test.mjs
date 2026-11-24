// Contract of deploy/oci/host-boot.sh: PostgreSQL ready, THEN OpenBao unsealed, THEN the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const boot = join(here, 'host-boot.sh');

const DOCKER_STUB = `#!/bin/sh
echo "docker $*" >> "$STUB_DIR/calls"
case "$1" in
  start) exit 0 ;;
  exec)
    case "$*" in
      *pg_isready*) [ -f "$STUB_DIR/pg-down" ] && exit 1; exit 0 ;;
      *bao\\ status*) [ -f "$STUB_DIR/bao-sealed" ] && exit 2; exit 0 ;;
    esac
    [ -f "$STUB_DIR/app-sick" ] && exit 1; exit 0 ;;
  inspect)
    [ -f "$STUB_DIR/no-container" ] && exit 1
    case "$*" in
      *Config.Image*) cat "$STUB_DIR/image" 2>/dev/null || echo ghcr.io/example/lyam:current; exit 0 ;;
      *Config.Env*) cat "$STUB_DIR/container-env" 2>/dev/null; exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`;

function setup({ pg = true, bao = true, unseal = true, pgDown = false, appSick = false, frontDown = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lyam-boot-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'docker'), DOCKER_STUB);
  chmodSync(join(dir, 'bin', 'docker'), 0o755);
  writeFileSync(join(dir, 'bin', 'curl'), '#!/bin/sh\necho "curl $*" >> "$STUB_DIR/calls"\n[ -f "$STUB_DIR/front-down" ] && { echo 000; exit 7; }   # refused connection: curl prints 000 AND exits non-zero\necho 200\n');
  chmodSync(join(dir, 'bin', 'curl'), 0o755);
  const stub = join(dir, 'stub');
  mkdirSync(stub);
  if (pgDown) writeFileSync(join(stub, 'pg-down'), '');
  if (appSick) writeFileSync(join(stub, 'app-sick'), '');
  if (frontDown) writeFileSync(join(stub, 'front-down'), '');
  // A container built from this env file records the same IAM_* values it was given.
  writeFileSync(join(stub, 'container-env'), 'IAM_PUBLIC_ORIGIN=https://example.invalid\nPATH=/usr/bin\n');
  if (unseal) writeFileSync(join(dir, 'unseal.sh'), '#!/bin/sh\necho "unseal-only ran" >> "$STUB_DIR/calls"\nexit 0\n');
  writeFileSync(join(dir, 'update-stub.sh'), '#!/bin/sh\necho "update.sh $*" >> "$STUB_DIR/calls"\n[ -f "$STUB_DIR/update-fail" ] && exit 3\nexit 0\n');
  chmodSync(join(dir, 'update-stub.sh'), 0o755);
  const env = join(dir, 'lyam.env');
  writeFileSync(env, [
    'IAM_PUBLIC_ORIGIN=https://example.invalid',
    'LYAM_HEALTH_TIMEOUT=0',
    'LYAM_BOOT_TRIES=1',
    pg ? 'LYAM_BACKUP_PG_CONTAINER=pg' : '',
    bao ? 'LYAM_BACKUP_BAO_CONTAINER=bao' : '',
    unseal ? `LYAM_BAO_UNSEAL_CMD=STUB_DIR=${stub} sh ${join(dir, 'unseal.sh')}` : '',
    `LYAM_UPDATE_SCRIPT=${join(dir, 'update-stub.sh')}`,
  ].filter(Boolean).join('\n') + '\n');
  return { dir, stub, env };
}

function run(env) {
  const r = spawnSync('sh', [boot, env], {
    encoding: 'utf8',
    env: { PATH: `${dirname(env)}/bin:/usr/bin:/bin`, STUB_DIR: join(dirname(env), 'stub') },
  });
  const p = join(dirname(env), 'stub', 'calls');
  return { ...r, calls: existsSync(p) ? readFileSync(p, 'utf8') : '' };
}

test('boot order: pg ready, then bao unsealed, then the app, then health', () => {
  const { env } = setup();
  const r = run(env);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.calls.split('\n');
  const idx = (re) => lines.findIndex((l) => re.test(l));
  const pgStart = idx(/docker start pg/);
  const pgReady = idx(/pg_isready/);
  const baoStart = idx(/docker start bao/);
  const unseal = idx(/unseal-only ran/);
  const appStart = idx(/docker start lyam/);
  const health = idx(/docker exec lyam node/);
  assert.ok(pgStart > -1 && pgReady > pgStart, 'pg started then probed');
  assert.ok(baoStart > pgReady && unseal > baoStart, 'bao started after pg ready, then unsealed');
  assert.ok(appStart > unseal && health > appStart, 'app started after bao unsealed, then health-checked');
});

test('a pg that never becomes ready stops the boot before bao and the app', () => {
  const { env } = setup({ pgDown: true });
  const r = run(env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PostgreSQL never became ready/);
  assert.doesNotMatch(r.calls, /docker start bao|docker start lyam/);
});

test('an unhealthy app after start fails the boot loudly', () => {
  const { env } = setup({ appSick: true });
  const r = run(env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /never became healthy/);
});

test('without companions only the app starts', () => {
  const { env } = setup({ pg: false, bao: false, unseal: false });
  const r = run(env);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.calls, /pg_isready|unseal-only/);
  assert.match(r.calls, /docker start lyam/);
});

test('env divergence (token re-minted into the file) forces a coordinated recreation, never a plain start', () => {
  const { env, dir, stub } = setup();
  writeFileSync(env, readFileSync(env, 'utf8') + 'IAM_BAO_TOKEN=new-file-token\n');
  writeFileSync(join(stub, 'container-env'), 'IAM_PUBLIC_ORIGIN=https://example.invalid\nIAM_BAO_TOKEN=old-container-token\nPATH=/usr/bin\n');
  writeFileSync(join(stub, 'image'), 'ghcr.io/example/lyam:0123456789abcdef0123456789abcdef01234567');
  const r = run(env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /update\.sh --image ghcr\.io\/example\/lyam:0123456789abcdef0123456789abcdef01234567 --env-file/, 'coordinated same-image recreation through the updater');
  assert.doesNotMatch(r.calls, /docker start lyam/, 'docker start is never used with a divergent env');
  const lines = r.calls.split('\n');
  const unseal = lines.findIndex((l) => /unseal-only ran/.test(l));
  const update = lines.findIndex((l) => l.startsWith('update.sh'));
  assert.ok(update > unseal, 'the recreation happens after the companions are ready');
});

test('a failed coordinated recreation fails the boot; the divergent app never starts', () => {
  const { env, stub } = setup();
  writeFileSync(env, readFileSync(env, 'utf8') + 'IAM_BAO_TOKEN=new-file-token\n');
  writeFileSync(join(stub, 'container-env'), 'IAM_PUBLIC_ORIGIN=https://example.invalid\nIAM_BAO_TOKEN=old-container-token\n');
  writeFileSync(join(stub, 'update-fail'), '');
  const r = run(env);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /NOT started with a divergent env/);
  assert.doesNotMatch(r.calls, /docker start lyam/);
});

test('a matching file/container env keeps the plain start', () => {
  const { env, stub } = setup();
  writeFileSync(env, readFileSync(env, 'utf8') + 'IAM_BAO_TOKEN=same-token\n');
  writeFileSync(join(stub, 'container-env'), 'IAM_PUBLIC_ORIGIN=https://example.invalid\nIAM_BAO_TOKEN=same-token\n');
  const r = run(env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /docker start lyam/);
  assert.doesNotMatch(r.calls, /update\.sh/);
});

test('any IAM_* parameter drift is caught (scope: every env-file application parameter)', () => {
  const { env, stub } = setup();
  writeFileSync(env, readFileSync(env, 'utf8') + 'IAM_PG_URL=postgres://new-host:5432/lyam\n');
  writeFileSync(join(stub, 'container-env'), 'IAM_PUBLIC_ORIGIN=https://example.invalid\nIAM_PG_URL=postgres://old-host:5432/lyam\n');
  const r = run(env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /divergence detected \( IAM_PG_URL\)/);
  assert.match(r.calls, /update\.sh --image/);
  assert.doesNotMatch(r.calls, /docker start lyam/);
});

test('a key REMOVED from the file but still baked into the container is a divergence (stale secret)', () => {
  const { env, stub } = setup();
  writeFileSync(join(stub, 'container-env'), 'IAM_PUBLIC_ORIGIN=https://example.invalid\nIAM_BAO_TOKEN=retired-container-token\n');
  const r = run(env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /divergence detected \( IAM_BAO_TOKEN\)/);
  assert.match(r.calls, /update\.sh --image/);
  assert.doesNotMatch(r.calls, /docker start lyam/, 'no plain start with a stale secret in the container');
});

test('a front that never comes up stops the boot before the app', () => {
  const { env } = setup({ frontDown: true });
  const r = run(env);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /front .* never came up/);
  assert.doesNotMatch(r.calls, /docker start lyam|update\.sh/);
});

test('host boot refuses closed recovery flag before starting companions',()=>{for(const args of [['--closed-recovery'],['a','b','--closed-recovery']]){const r=spawnSync('sh',[boot,...args],{encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/manual/);}});

test('persistent automation hold refuses boot start or recreate', () => {
  const { env } = setup();
  writeFileSync(env, readFileSync(env, 'utf8') + 'IAM_AUTOMATION_HOLD=1\n');
  const r = run(env);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /manual reviewed recovery required/);
  assert.doesNotMatch(r.calls, /docker start|update.sh/);
});
