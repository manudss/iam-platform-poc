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
esac
exit 0
`;

function setup({ pg = true, bao = true, unseal = true, pgDown = false, appSick = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lyam-boot-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'docker'), DOCKER_STUB);
  chmodSync(join(dir, 'bin', 'docker'), 0o755);
  const stub = join(dir, 'stub');
  mkdirSync(stub);
  if (pgDown) writeFileSync(join(stub, 'pg-down'), '');
  if (appSick) writeFileSync(join(stub, 'app-sick'), '');
  if (unseal) writeFileSync(join(dir, 'unseal.sh'), '#!/bin/sh\necho "unseal-only ran" >> "$STUB_DIR/calls"\nexit 0\n');
  const env = join(dir, 'lyam.env');
  writeFileSync(env, [
    'IAM_PUBLIC_ORIGIN=https://example.invalid',
    'LYAM_HEALTH_TIMEOUT=0',
    'LYAM_BOOT_TRIES=1',
    pg ? 'LYAM_BACKUP_PG_CONTAINER=pg' : '',
    bao ? 'LYAM_BACKUP_BAO_CONTAINER=bao' : '',
    unseal ? `LYAM_BAO_UNSEAL_CMD=STUB_DIR=${stub} sh ${join(dir, 'unseal.sh')}` : '',
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
  const health = idx(/healthz/);
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
