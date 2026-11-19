// Real PostgreSQL 17.12 qualification of deploy/oci/update.sh rollback SQL paths -
// the EXACT major the companion compose pins (postgres:17-alpine, currently 17.12).
// Server: zonky embedded PostgreSQL 17.12 binaries; clients: PGDG 17.12 psql/pg_dump.
// A forwarding docker stub sends every `docker exec pg <pg_dump|psql> ...` to the real
// client binaries against the live server; everything else is stubbed.
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PG17 = process.env.PG_BIN;
if (!PG17) throw new Error('PG_BIN must point to PostgreSQL 17.12 server binaries; put matching psql/pg_dump on PATH');
if (!spawnSync(join(PG17, 'postgres'), ['--version'], {encoding:'utf8'}).stdout.includes('17.12')) throw new Error('PostgreSQL 17.12 required');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const NEW = `ghcr.io/example/lyam:${SHA}`;
const OLD = 'ghcr.io/example/lyam:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PORT = 15443;
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'ok' : 'NOT OK'} - ${m}`); };

const dir = mkdtempSync(join(tmpdir(), 'lyam-pg-real-'));
const pgdata = join(dir, 'pgdata');
let r = spawnSync(join(PG17, 'initdb'), ['-D', pgdata, '-U', 'postgres', '--auth-local=trust', '--auth-host=trust', '-E', 'UTF8'], { encoding: 'utf8' });
if (r.status !== 0) { console.error('initdb failed', r.stderr); process.exit(1); }
r = spawnSync(join(PG17, 'pg_ctl'), ['-D', pgdata, '-l', join(dir, 'pg.log'), '-o', `-p ${PORT} -c listen_addresses=127.0.0.1`, '-w', 'start'], { encoding: 'utf8' });
if (r.status !== 0) { console.error('pg start failed', r.stderr); process.exit(1); }

const psql = (args, input) => spawnSync('psql', ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'postgres', ...args], { encoding: 'utf8', input });
// Mirror the companion compose: POSTGRES_USER becomes a superuser in the official image.
psql(['-d', 'postgres', '-c', 'CREATE ROLE lyam LOGIN SUPERUSER;']);
psql(['-d', 'postgres', '-c', 'CREATE DATABASE lyam OWNER lyam;']);
psql(['-U', 'lyam', '-d', 'lyam', '-c', 'CREATE TABLE activations(tenant text, seq int, commit text, state text);']);
psql(['-U', 'lyam', '-d', 'lyam', '-c', `INSERT INTO activations SELECT 't1', g, 'c'||g, 'recorded' FROM generate_series(1,7) g;`]);
// Objects with POSTGRES-SYNTHESIZED names (check / unique / expression index) and PG17's
// real not-null constraints (serial PRIMARY KEY): the schema capture must survive their
// drop+recreate (definition-based, never name-based) and the v4 query must run on 17.12.
psql(['-U', 'lyam', '-d', 'lyam', '-c', 'CREATE TABLE synth(id serial PRIMARY KEY, val int CHECK (val > 0), code text UNIQUE);']);
psql(['-U', 'lyam', '-d', 'lyam', '-c', 'CREATE INDEX ON synth (lower(code));']);
psql(['-U', 'lyam', '-d', 'lyam', '-c', `INSERT INTO synth(val, code) SELECT g, 'code'||g FROM generate_series(1,3) g;`]);

const stub = `#!/bin/sh
echo "docker $*" >> "$STUB_DIR/calls"
case "$1" in
  info|pull) exit 0 ;;
  image)
    if [ "$2" = "inspect" ]; then
      if [ "$3" = "-f" ]; then grep -qx "$5" "$STUB_DIR/images" && { echo x; exit 0; } || exit 1; fi
      ref="$3"; f="$STUB_DIR/labels/$(echo "$ref" | tr ' /:@' '____')"
      [ -f "$f" ] && cat "$f" || exit 1; exit 0
    fi ;;
  inspect) case "$*" in *State.Running*) echo false; exit 0 ;; esac; cat "$STUB_DIR/current" 2>/dev/null || exit 1 ;;
  stop|rm|start) exit 0 ;;
  run)
    for last; do :; done; echo "$last" > "$STUB_DIR/running"; exit 0 ;;
  exec)
    shift
    [ "$1" = "-i" ] && shift
    c="$1"; shift
    if [ "$c" = "pg" ]; then
      export PGHOST=127.0.0.1 PGPORT=${PORT}
      exec "$@"
    fi
    grep -qx "$(cat "$STUB_DIR/running" 2>/dev/null)" "$STUB_DIR/healthy" 2>/dev/null && exit 0 || exit 1 ;;
esac
exit 0
`;
const stubDir = join(dir, 'stub');
mkdirSync(join(stubDir, 'labels'), { recursive: true });
mkdirSync(join(dir, 'bin'));
writeFileSync(join(dir, 'bin', 'docker'), stub); chmodSync(join(dir, 'bin', 'docker'), 0o755);
writeFileSync(join(dir, 'bin', 'curl'), '#!/bin/sh\necho "curl $*" >> "$STUB_DIR/calls"\n[ -f "$STUB_DIR/MAINTENANCE" ] && { echo 503; exit 0; }\necho 200\n');
chmodSync(join(dir, 'bin', 'curl'), 0o755);
writeFileSync(join(stubDir, 'images'), `${OLD}\n${NEW}\n`);
writeFileSync(join(stubDir, 'healthy'), `${OLD}\n`);          // NEW never becomes healthy -> rollback
writeFileSync(join(stubDir, 'labels', NEW.replaceAll(/[ /:@]/g, '_')), 'auto never');
writeFileSync(join(stubDir, 'current'), OLD);
mkdirSync(join(dir, 'data', 'dolt', '.dolt'), { recursive: true });
const envFile = join(dir, 'lyam.env');
writeFileSync(join(dir, 'compose.yml'), '# test compose');
writeFileSync(join(dir, 'compose.env'), 'PG_PASSWORD=x');
for (const f of ['lyam-boot.service', 'host-boot.sh', 'bao-bootstrap.sh', 'lyam-gate.caddy']) {
  writeFileSync(join(dir, f), '# test');
}
writeFileSync(envFile, [
  'IAM_PUBLIC_ORIGIN=https://example.invalid',
  `LYAM_DATA_DIR=${join(dir, 'data')}`,
  `LYAM_BACKUP_DIR=${join(dir, 'backups')}`,
  `LYAM_PAUSE_FILE=${join(dir, 'UPDATE_PAUSED')}`,
  `LYAM_LOCK_FILE=${join(dir, '.update.lock')}`,
  'LYAM_HEALTH_TIMEOUT=0',
  'LYAM_BACKUP_PG_CONTAINER=pg',
  `LYAM_COMPOSE_FILE=${join(dir, 'compose.yml')}`,
  `LYAM_COMPOSE_ENV_FILE=${join(dir, 'compose.env')}`,
  `LYAM_STACK_FILES=${join(dir, 'lyam-boot.service')} ${join(dir, 'host-boot.sh')} ${join(dir, 'bao-bootstrap.sh')} ${join(dir, 'lyam-gate.caddy')}`,
  `LYAM_FRONT_BARRIER_FILE=${join(stubDir, 'MAINTENANCE')}`,
  'LYAM_BACKUP_PG_USER=lyam',
  'LYAM_BACKUP_PG_DB=lyam',
].join('\n') + '\n');

const run = () => spawnSync('sh', [join(repo, 'deploy/oci/update.sh'), '--image', NEW, '--env-file', envFile], {
  encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, STUB_DIR: stubDir },
});
const countLyam = () => psql(['-d', 'lyam', '-tAc', 'SELECT count(*) FROM activations']).stdout.trim();

// Scenario 1: unhealthy new image -> rollback with REAL drop/recreate/replay.
r = run();
const calls = readFileSync(join(stubDir, 'calls'), 'utf8');
ok(r.status === 3, `unhealthy new image -> exit 3 rolled back (got ${r.status}: ${r.stderr.trim()})`);
ok(/docker exec pg pg_dump -U lyam -d lyam/.test(calls), 'real pg_dump produced the pre-update backup');
ok(/-c DROP DATABASE IF EXISTS/.test(calls), 'rollback dropped the database (real psql)');
ok(/-c CREATE DATABASE/.test(calls), 'rollback recreated the database (real psql)');
ok(countLyam() === '7', `journal fully restored into a clean database (${countLyam()}/7 rows)`);
ok(psql(['-d', 'lyam', '-tAc', 'SELECT count(*) FROM synth']).stdout.trim() === '3', 'synthetic-named constraints/index recreated and verified by the stable capture (3/3 rows)');
const backups = readdirSync(join(dir, 'backups'));
ok(backups.some((f) => f.startsWith('lyam-pg-postmortem-')), 'postmortem dump of the failed state kept');
ok(backups.some((f) => /^lyam-pg-\d/.test(f)), 'pre-update dump kept');

// Scenario 2: DROP fails (lingering session holds the database) -> exit 4, service stays DOWN.
const linger = spawn('psql', ['-h', '127.0.0.1', '-p', String(PORT), '-U', 'postgres', '-d', 'lyam', '-c', 'SELECT pg_sleep(60);']);
await new Promise((res) => setTimeout(res, 1500));
const r2 = run();
linger.kill();
ok(r2.status === 4, `failed DROP (lingering session) -> exit 4, service stays DOWN (got ${r2.status}: ${r2.stderr.trim().slice(0, 120)})`);
ok(/pg drop failed/.test(r2.stderr) && /stays DOWN/.test(r2.stderr), 'exit 4 names the failed drop and the DOWN state');
ok(countLyam() === '7', `the untouched database still holds its rows (${countLyam()}/7)`);

spawnSync(join(PG17, 'pg_ctl'), ['-D', pgdata, '-m', 'immediate', 'stop'], { encoding: 'utf8' });
console.log(`\nupdater real-PG test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
