#!/bin/sh
# Lyam persistent-demo updater (runs ON the host, e.g. an OCI VM).
#
# Rolls a new immutable image onto the existing data volume WITHOUT re-seeding and WITHOUT
# losing existing data. It refuses to run whenever preservation cannot be guaranteed:
#   - the image ref must be immutable (full commit-sha tag or @sha256: digest), never a moving tag;
#   - the image must carry the io.lyam.seed-modes label listing "never" (see demo/Dockerfile) -
#     an image that cannot disable seeding is refused, so a re-seed can never wipe the volume;
#   - the data directory must already hold a dataset (bootstrap is a separate manual step);
#   - a host lock refuses concurrent runs (manual and pipeline runs can never overlap);
#   - the container is ALWAYS stopped before the backup (cold, consistent files), even when the
#     target image is the one already running;
#   - an optional pre-update hook (e.g. an OCI volume snapshot) must succeed while the container
#     is stopped; the swap never happens with an incomplete preservation chain;
#   - the cold backup must succeed BEFORE the swap: data directory tar, optional pg_dump
#     (its failure is detected, never hidden by the compression pipe; the FULL application
#     state - per-table count + order-independent content hash, schema-objects hash and
#     sequence values - is captured for post-restore verification),
#     optional OpenBao storage + keys tar taken while the Bao container is stopped, and a
#     private recovery bundle (env file, compose, bao config/policy, manifest);
#   - BEFORE the container stops, a FRONT GATE is proven through the public origin: a
#     maintenance marker this run OWNS (unique token inside) is dropped in a dedicated
#     front-readable directory, and the update only proceeds once $IAM_PUBLIC_ORIGIN answers
#     503. Host netfilter rules do NOT work here: Docker publishes loopback ports through
#     userland docker-proxy, so iptables never sees front traffic - the gate lives at the
#     real front and curl through the origin is the only proof. A gate this run did NOT
#     create is never removed (a pre-existing foreign gate refuses the update). The gate is
#     held until the new version - or the rolled-back previous one - is healthy, and it is
#     lifted only as remove + proven 200 through the origin; a failed lift RE-ARMS
#     maintenance (no blind rollback of possible new writes, no exposed unverified service).
#     Every other failure path KEEPS the gate up (fail closed).
#     Any failure rolls back image AND data together (the failed version may have migrated
#     the data, so an old image on a newer data state is not a safe rollback), including a
#     consistent PostgreSQL restore (integrity-checked dump, drop + recreate + replay
#     verified against the full pre-update state, with a postmortem dump kept) and the
#     OpenBao storage (stopped, restored, unsealed and waited-ready before the app starts);
#   - a pause file (default /opt/lyam/UPDATE_PAUSED) freezes updates deliberately (demo freeze).
#
# Run it as root (sudo) or as a user in the docker group: it reads the root-owned env file and
# talks to the docker socket. The GitHub pipeline runs it through `sudo`.
#
# Configuration: a single env file (default /opt/lyam/lyam.env), KEY=VALUE lines, no quotes and
# no spaces in values. Application keys (IAM_PUBLIC_ORIGIN, IAM_PG_URL, IAM_BAO_ADDR,
# IAM_BAO_TOKEN, ...) are passed to the container with docker --env-file. Updater settings:
#   LYAM_CONTAINER           container name (default lyam)
#   LYAM_DATA_DIR            host data dir mounted at /data (default /opt/lyam/data)
#   LYAM_BACKUP_DIR          backup destination (default /opt/lyam/backups)
#   LYAM_PORT                host loopback port published to the container's 8080 (default 8080)
#   The updater proves a FRONT GATE through the public origin BEFORE anything changes: it
#   drops its owned maintenance marker LYAM_FRONT_BARRIER_FILE (default
#   /var/lib/lyam-front-gate/MAINTENANCE - a dedicated 0755 directory the Caddy identity can
#   traverse; /opt/lyam is root-0700 and cannot host it) and refuses to proceed until
#   $IAM_PUBLIC_ORIGIN/healthz answers 503; the gate is lifted only when the new version - or
#   the rolled-back previous one - answers 200 through the origin, and a failed lift re-arms
#   it. Host iptables rules are useless for this (userland docker-proxy serves
#   loopback-published ports): curl through the origin is the only proof. curl and
#   IAM_PUBLIC_ORIGIN are required.
#   LYAM_DOCKER_NETWORK      optional docker network (e.g. lyam-net with pg/bao companions)
#   LYAM_HEALTH_TIMEOUT      seconds to wait for /healthz (default 420)
#   LYAM_BACKUP_KEEP         backup generations kept per kind (default 5)
#   LYAM_BACKUP_PG_CONTAINER optional PostgreSQL companion container to pg_dump before the swap
#   LYAM_BACKUP_PG_USER      pg_dump/psql user (default lyam, matches deploy/oci/companions)
#   LYAM_BACKUP_PG_DB        database name (default lyam)
#   LYAM_BACKUP_BAO_DIR      optional host dir with the OpenBao storage to archive; requires
#                            LYAM_BACKUP_BAO_CONTAINER (never archived live) AND
#                            LYAM_BACKUP_BAO_KEYS_DIR (the recovery chain is incomplete without it)
#   LYAM_BACKUP_BAO_CONTAINER OpenBao container: stopped during the archive, started + unsealed after
#   LYAM_BACKUP_BAO_KEYS_DIR REQUIRED with BAO_DIR: unseal key / root token / api token dir,
#                            archived with the storage (indispensable keys are not optional)
#   LYAM_FRONT_BARRIER_FILE maintenance marker watched by the Caddy front (default
#                            /var/lib/lyam-front-gate/MAINTENANCE; its directory must be
#                            traversable by the Caddy identity and hold ONLY this marker)
#   LYAM_COMPOSE_FILE        REQUIRED with the pg backup: companion compose file (recovery input)
#   LYAM_COMPOSE_ENV_FILE    REQUIRED with the pg backup: the compose .env holding PG_PASSWORD
#   LYAM_BAO_CONFIG_FILE     REQUIRED with BAO_DIR: bao server config (recovery input)
#   LYAM_BAO_POLICY_FILE     REQUIRED with BAO_DIR: the scoped API policy (recovery input)
#   LYAM_STACK_FILES         REQUIRED with companions: boot-time operational files (systemd
#                            unit, host-boot.sh, bao-bootstrap.sh, front-gate Caddy config) -
#                            all copied into the recovery bundle for a fresh-stack rebuild
#   LYAM_RECOVERY_FILES      optional space-separated extra files (compose file, bao.hcl,
#                            policy file) copied into the private recovery bundle; a configured
#                            but unreadable entry aborts the update
#   LYAM_BAO_UNSEAL_CMD      command that unseals and waits-ready the Bao companion (e.g.
#                            'sh /opt/lyam/bin/bao-bootstrap.sh --unseal-only'); without it the
#                            updater only waits for bao status and a sealed Bao blocks the swap
#   LYAM_PRE_UPDATE_HOOK     optional shell command run while the container is stopped, before
#                            the local backup (e.g. trigger a volume snapshot); a failure aborts
#   LYAM_PAUSE_FILE          freeze file (default /opt/lyam/UPDATE_PAUSED)
#   LYAM_LOCK_FILE           host lock (default /opt/lyam/.update.lock)
#
# Usage: update.sh --image ghcr.io/<owner>/<repo>:<full-commit-sha> [--env-file PATH]
# Exit codes: 0 updated, 1 refused (preconditions), 2 preservation failed (old container
#             restarted), 3 health/create failed (rollback done: image + data restored),
#             4 rollback failed (manual intervention).
#
# KNOWN LIMIT: a platform volume SNAPSHOT taken while PostgreSQL/OpenBao are running is
# crash-consistent only; the cold application archive and the per-kind backups above are the
# consistent layer. Keep the two layers distinct in any recovery plan.
set -eu
umask 077   # every artifact created below (backups, bundles, manifests) is private from creation

log() { echo "[update $(date -u +%H:%M:%S)] $*"; }
fail() { code="$1"; shift; log "FATAL: $*" >&2; exit "$code"; }

IMAGE=""
ENV_FILE="/opt/lyam/lyam.env"
while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    *) fail 1 "unknown argument: $1" ;;
  esac
done
[ -n "$IMAGE" ] || fail 1 "--image is required"

getconf() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -n 1; }
CONTAINER="$(getconf LYAM_CONTAINER)"; CONTAINER="${CONTAINER:-lyam}"
DATA_DIR="$(getconf LYAM_DATA_DIR)"; DATA_DIR="${DATA_DIR:-/opt/lyam/data}"
BACKUP_DIR="$(getconf LYAM_BACKUP_DIR)"; BACKUP_DIR="${BACKUP_DIR:-/opt/lyam/backups}"
PORT="$(getconf LYAM_PORT)"; PORT="${PORT:-8080}"
NETWORK="$(getconf LYAM_DOCKER_NETWORK)"
HEALTH_TIMEOUT="$(getconf LYAM_HEALTH_TIMEOUT)"; HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-420}"
KEEP="$(getconf LYAM_BACKUP_KEEP)"; KEEP="${KEEP:-5}"
PG_CONTAINER="$(getconf LYAM_BACKUP_PG_CONTAINER)"
PG_USER="$(getconf LYAM_BACKUP_PG_USER)"; PG_USER="${PG_USER:-lyam}"
PG_DB="$(getconf LYAM_BACKUP_PG_DB)"; PG_DB="${PG_DB:-lyam}"
BAO_DIR="$(getconf LYAM_BACKUP_BAO_DIR)"
BAO_CONTAINER="$(getconf LYAM_BACKUP_BAO_CONTAINER)"
BAO_KEYS_DIR="$(getconf LYAM_BACKUP_BAO_KEYS_DIR)"
BAO_UNSEAL_CMD="$(getconf LYAM_BAO_UNSEAL_CMD)"
ORIGIN="$(getconf IAM_PUBLIC_ORIGIN)"; ORIGIN="${ORIGIN%/}"
COMPOSE_FILE="$(getconf LYAM_COMPOSE_FILE)"
COMPOSE_ENV_FILE="$(getconf LYAM_COMPOSE_ENV_FILE)"
BAO_CONFIG_FILE="$(getconf LYAM_BAO_CONFIG_FILE)"
BAO_POLICY_FILE="$(getconf LYAM_BAO_POLICY_FILE)"
STACK_FILES="$(getconf LYAM_STACK_FILES)"
RECOVERY_FILES="$(getconf LYAM_RECOVERY_FILES)"
HOOK="$(getconf LYAM_PRE_UPDATE_HOOK)"
PAUSE_FILE="$(getconf LYAM_PAUSE_FILE)"; PAUSE_FILE="${PAUSE_FILE:-/opt/lyam/UPDATE_PAUSED}"
LOCK_FILE="$(getconf LYAM_LOCK_FILE)"; LOCK_FILE="${LOCK_FILE:-/opt/lyam/.update.lock}"

# --- preconditions (refuse, never improvise) -------------------------------------------------
command -v docker >/dev/null 2>&1 || fail 1 "docker not found on this host"
docker info >/dev/null 2>&1 || fail 1 "docker is not accessible to this user (run with sudo, or add the user to the docker group)"
[ -r "$ENV_FILE" ] || fail 1 "env file $ENV_FILE missing or unreadable (run with sudo: it is root-owned 0600)"
[ ! -e "$PAUSE_FILE" ] || fail 1 "updates are paused by $PAUSE_FILE (remove it to resume)"
echo "$IMAGE" | grep -Eq ':[0-9a-f]{40}$|@sha256:[0-9a-f]{64}$' \
  || fail 1 "image ref must be immutable (full commit-sha tag or @sha256: digest), got: $IMAGE"
[ -d "$DATA_DIR/dolt/.dolt" ] \
  || fail 1 "no Dolt dataset under $DATA_DIR - bootstrap once with IAM_DEMO_SEED_MODE=auto before using the updater (docs/oci-deploy.md)"

echo "$PG_USER" | grep -Eq '^[A-Za-z0-9_]+$' && echo "$PG_DB" | grep -Eq '^[A-Za-z0-9_]+$' \
  || fail 1 "LYAM_BACKUP_PG_USER / LYAM_BACKUP_PG_DB must be plain identifiers"
if [ -n "$BAO_DIR" ]; then
  [ -n "$BAO_CONTAINER" ] \
    || fail 1 "LYAM_BACKUP_BAO_DIR requires LYAM_BACKUP_BAO_CONTAINER (a live Bao is never archived)"
  [ -n "$BAO_KEYS_DIR" ] && [ -d "$BAO_KEYS_DIR" ] \
    || fail 1 "LYAM_BACKUP_BAO_DIR requires LYAM_BACKUP_BAO_KEYS_DIR pointing at the unseal-key/token dir - the recovery chain is incomplete without it"
  [ -n "$BAO_CONFIG_FILE" ] && [ -r "$BAO_CONFIG_FILE" ] \
    || fail 1 "LYAM_BACKUP_BAO_DIR requires LYAM_BAO_CONFIG_FILE (bao.hcl) readable - the bao service cannot be rebuilt without it"
  [ -n "$BAO_POLICY_FILE" ] && [ -r "$BAO_POLICY_FILE" ] \
    || fail 1 "LYAM_BACKUP_BAO_DIR requires LYAM_BAO_POLICY_FILE (bao-policy.hcl) readable - the scoped access cannot be rebuilt without it"
fi
if [ -n "$PG_CONTAINER" ]; then
  [ -n "$COMPOSE_FILE" ] && [ -r "$COMPOSE_FILE" ] \
    || fail 1 "LYAM_BACKUP_PG_CONTAINER requires LYAM_COMPOSE_FILE readable - the pg companion cannot be rebuilt without it"
  [ -n "$COMPOSE_ENV_FILE" ] && [ -r "$COMPOSE_ENV_FILE" ] \
    || fail 1 "LYAM_BACKUP_PG_CONTAINER requires LYAM_COMPOSE_ENV_FILE readable (the compose .env holding PG_PASSWORD) - the pg companion cannot be rebuilt without its password"
fi
if [ -n "$PG_CONTAINER" ] || [ -n "$BAO_DIR" ]; then
  [ -n "$STACK_FILES" ] \
    || fail 1 "LYAM_STACK_FILES must list the boot-time operational files (systemd unit, host-boot.sh, bao-bootstrap.sh, front-gate Caddy config) - a fresh stack cannot be rebuilt without them"
  for f in $STACK_FILES; do
    [ -r "$f" ] || fail 1 "LYAM_STACK_FILES entry $f is missing or unreadable"
  done
fi
command -v curl >/dev/null 2>&1 \
  || fail 1 "curl not found on this host: the front barrier must be proven through the public origin"
[ -n "$ORIGIN" ] \
  || fail 1 "IAM_PUBLIC_ORIGIN missing in $ENV_FILE: the front barrier is proven through the public origin"
for f in $RECOVERY_FILES; do
  [ -r "$f" ] || fail 1 "LYAM_RECOVERY_FILES entry $f is missing or unreadable"
done

# --- write barrier at the REAL front (Caddy maintenance gate) --------------------------------
# A network-level barrier does NOT work here: Docker publishes loopback ports through a
# userland proxy, so host->127.0.0.1 traffic never crosses netfilter (proven on the host: the
# rule counter stays at 0 and writes pass). The barrier therefore lives at the REAL front:
# Caddy answers 503 for every request - including requests on already-open, reused
# connections, which Caddy routes per-request - while a maintenance FILE exists (one-time
# Caddy snippet, docs/oci-deploy.md). The updater only touches/removes that file, and PROVES
# the gate at runtime through the public origin: the probe must return 503 while the gate is
# up (anything else = the front is not actually gated = refuse/fail closed) and 200 once it
# is lifted.
# The marker lives in a DEDICATED directory the front can traverse: /opt/lyam is root-0700
# (private data), and Caddy cannot stat a marker inside it. $BARRIER_DIR is 0755 root:root and
# holds ONLY the marker - no private file ever belongs there. The marker carries this run's
# ownership TOKEN: a gate this run did not create is never removed, and a pre-existing foreign
# gate refuses the update (someone else's maintenance is not ours to lift). The marker file
# itself is 0644 (its content is a non-secret token) so any front identity can stat/read it.
BARRIER_FILE="$(getconf LYAM_FRONT_BARRIER_FILE)"; BARRIER_FILE="${BARRIER_FILE:-/var/lib/lyam-front-gate/MAINTENANCE}"
GATE_TOKEN="lyam-update:$$:$(date -u +%Y%m%dT%H%M%SZ)"
BARRIER_ACTIVE=0
front_probe() { curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$ORIGIN/healthz" 2>/dev/null || true; }
barrier_verify() { [ "$(front_probe)" = 503 ]; }
front_verify() { [ "$(front_probe)" = 200 ]; }
barrier_add() {
  [ ! -e "$BARRIER_FILE" ] || return 2   # a gate this run does NOT own is already in place
  mkdir -p "$(dirname "$BARRIER_FILE")" || return 1
  chmod 755 "$(dirname "$BARRIER_FILE")" || return 1
  echo "$GATE_TOKEN" > "$BARRIER_FILE" || return 1
  chmod 644 "$BARRIER_FILE" || return 1
  BARRIER_ACTIVE=1
  barrier_verify
}
barrier_remove() {
  [ "$BARRIER_ACTIVE" = 1 ] || return 0
  [ "$(cat "$BARRIER_FILE" 2>/dev/null)" = "$GATE_TOKEN" ] || return 1   # not ours: never delete
  rm -f "$BARRIER_FILE" || return 1
  BARRIER_ACTIVE=0
}
barrier_rearm() {
  echo "$GATE_TOKEN" > "$BARRIER_FILE" 2>/dev/null || return 1
  chmod 644 "$BARRIER_FILE" 2>/dev/null || true
  BARRIER_ACTIVE=1
  barrier_verify
}
# The ONLY way out of a gated window: remove OUR marker, then prove the front answers 200
# again. If either step fails the gate is RE-ARMED - the service stays behind maintenance
# rather than exposed in an unverified state.
gate_lift() {
  if barrier_remove && front_verify; then return 0; fi
  barrier_rearm || log "WARNING: maintenance could not be re-armed at $BARRIER_FILE"
  return 1
}
# An interruption mid-update leaves the state unknown: keep the gate UP (fail closed).
trap 'log "interrupted: the maintenance gate stays UP at $BARRIER_FILE - verify the service state manually"; exit 4' INT TERM

# One run at a time: the pipeline and a manual run must never interleave stops/backups/swaps.
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
command -v flock >/dev/null 2>&1 && { flock -n 9 || fail 1 "another update is running (lock $LOCK_FILE)"; }

log "pulling $IMAGE"
docker pull "$IMAGE" >/dev/null

MODES="$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "io.lyam.seed-modes"}}' 2>/dev/null || true)"
case " $MODES " in
  *" never "*) ;;
  *) fail 1 "image $IMAGE does not support IAM_DEMO_SEED_MODE=never (io.lyam.seed-modes='$MODES'); refusing to roll it onto a data volume" ;;
esac

# The running container's image - including when it IS the target image (redeploy of the same
# version to apply an env change): still stopped for a cold backup, still the rollback image.
PREVIOUS="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"
if [ -n "$PREVIOUS" ] && [ "$(docker image inspect -f x "$PREVIOUS" 2>/dev/null || true)" != x ]; then
  fail 1 "rollback image $PREVIOUS is not available locally; refusing to update without a rollback path"
fi

run_container() {
  img="$1"; port="$2"
  # on-failure, never unless-stopped: an unmanaged auto-restart at host boot would start the
  # app BEFORE the companions are ready, short-circuiting the systemd/host-boot.sh ordering.
  set -- -d --name "$CONTAINER" --restart on-failure \
    -p "127.0.0.1:$port:8080" -v "$DATA_DIR:/data" \
    --env-file "$ENV_FILE" -e IAM_DEMO_SEED_MODE=never
  if [ -n "$NETWORK" ]; then set -- "$@" --network "$NETWORK"; fi
  docker run "$@" "$img" >/dev/null
}

health() {
  # The probe runs INSIDE the container (no host curl dependency); the canary/real port split
  # above is what guarantees a not-yet-healthy version is never published on the public port.
  waited=0
  while :; do
    if docker exec "$CONTAINER" node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    [ "$waited" -lt "$HEALTH_TIMEOUT" ] || return 1
    sleep 5; waited=$((waited + 5))
  done
}

# The app must never start against a sealed/absent Bao: unseal + wait-ready, or fail the path.
bao_ready() {
  [ -n "$BAO_CONTAINER" ] || return 0
  if [ -n "$BAO_UNSEAL_CMD" ]; then
    sh -c "$BAO_UNSEAL_CMD"
    return $?
  fi
  n=0
  while :; do
    docker exec "$BAO_CONTAINER" bao status >/dev/null 2>&1 && return 0
    n=$((n + 1)); [ "$n" -lt 12 ] || return 1
    sleep 5
  done
}

restart_previous() {
  [ -n "$PREVIOUS" ] || return 0
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  bao_ready || return 1
  run_container "$PREVIOUS" "$PORT" || return 1
  # The gate must only lift over a HEALTHY previous version: lifting right after the run
  # probes a still-booting app, fails the 200, re-arms and strands the update (reproduced).
  health
}

# --- cold backup (front gated, container stopped: consistent files) ---------------------------
# The front gate goes up BEFORE anything changes: visitors get a clean 503 from Caddy for the
# whole window (including on reused connections), the gate is proven through the public origin,
# and an unprovable gate refuses the update before any state change.
log "front gate: enabling maintenance at the real front ($ORIGIN answers 503 until the end)"
barrier_rc=0; barrier_add || barrier_rc=$?
[ "$barrier_rc" -ne 2 ] \
  || fail 1 "a maintenance gate this run does NOT own is already in place at $BARRIER_FILE - refusing to update over someone else's maintenance"
[ "$barrier_rc" -eq 0 ] \
  || { barrier_remove; fail 1 "the front gate could not be proven through $ORIGIN (expected 503 while gated) - refusing to update: the front is NOT protected"; }
TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
if [ -n "$PREVIOUS" ]; then
  log "stopping $CONTAINER (running $PREVIOUS)"
  docker stop "$CONTAINER" >/dev/null
fi

# Optional platform-side preservation (e.g. an OCI volume snapshot): runs while the container
# is stopped, BEFORE the local backup, so the snapshot is consistent. A failing hook aborts.
if [ -n "$HOOK" ]; then
  log "running pre-update hook"
  if ! sh -c "$HOOK"; then
    restart_previous || fail 4 "pre-update hook failed AND the previous container could not be restarted healthy - the maintenance gate stays UP - manual intervention"
    gate_lift || fail 4 "pre-update hook failed; the previous container was restarted BUT the front could not be proven open - maintenance re-armed at $BARRIER_FILE, diagnose the front manually"
    fail 2 "pre-update hook failed; update aborted, previous container restarted, front re-opened"
  fi
fi

abort_preservation() {
  restart_previous || fail 4 "$1 AND the previous container could not be restarted healthy - the maintenance gate stays UP - manual intervention"
  gate_lift || fail 4 "$1; the previous container was restarted BUT the front could not be proven open - maintenance re-armed at $BARRIER_FILE, diagnose the front manually"
  fail 2 "$1; update aborted, previous container restarted, front re-opened"
}

DATA_BACKUP="$BACKUP_DIR/lyam-data-$TS.tar.gz"
log "backup: $DATA_DIR -> $DATA_BACKUP"
tar -C "$(dirname "$DATA_DIR")" -czf "$DATA_BACKUP" "$(basename "$DATA_DIR")" \
  || abort_preservation "data backup failed"
[ -s "$DATA_BACKUP" ] || abort_preservation "data backup is empty"

# Full application state capture. Content: for every user table, the row count AND an
# order-independent content hash (same count never means same data - constant-cardinality
# edits change the hash). Schema: a NORMALIZED, SEMANTICALLY STABLE export - columns with
# defaults and nullability, constraint DEFINITIONS (pg_get_constraintdef: the semantic
# expression, never the catalog name - synthetic names embed internal identifiers that
# change on drop+recreate of an identical schema, reproduced in the isolated failure test);
# c.contype is CAST to text explicitly: PG17 rejects the implicit "char"||text concatenation),
# index definitions with the index NAME stripped (same reason), views, functions and
# sequence definitions - one line per object, ordered, hashed as a whole. A genuinely
# different constraint/index/column changes the definition and the hash; a mere synthetic
# NAME change does not. Sequences: the FULL runtime state (last_value + is_called) of
# every sequence. Every query runs with ON_ERROR_STOP: an enumeration or read failure aborts
# the capture, it is never ignored (a failed capture aborts the update on the backup path and
# keeps the service down on the restore path).
pg_state_capture() {
  _out="$1"
  : > "$_out"
  _psql() { docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tA -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null; }
  _schema="$(_psql "SELECT md5(coalesce(string_agg(line, E'\\n' ORDER BY line), '')) FROM (
      SELECT 'col '||table_schema||'.'||table_name||'.'||column_name||' '||udt_name||' '||is_nullable||' '||coalesce(column_default,'') AS line FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema')
      UNION ALL SELECT 'con '||n.nspname||'.'||coalesce(cl.relname,'')||' '||c.contype::text||' '||pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace LEFT JOIN pg_class cl ON cl.oid=c.conrelid WHERE n.nspname NOT IN ('pg_catalog','information_schema')
      UNION ALL SELECT 'idx '||schemaname||'.'||tablename||' '||regexp_replace(indexdef, '^(CREATE (UNIQUE )?INDEX )\\S+', '\\1') FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog','information_schema')
      UNION ALL SELECT 'view '||table_schema||'.'||table_name||' '||coalesce(view_definition,'') FROM information_schema.views WHERE table_schema NOT IN ('pg_catalog','information_schema')
      UNION ALL SELECT 'fun '||routine_schema||'.'||routine_name||' '||routine_type||' '||coalesce(routine_definition,'') FROM information_schema.routines WHERE routine_schema NOT IN ('pg_catalog','information_schema')
      UNION ALL SELECT 'seqdef '||sequence_schema||'.'||sequence_name||' '||data_type||' '||start_value||' '||minimum_value||' '||maximum_value||' '||increment FROM information_schema.sequences WHERE sequence_schema NOT IN ('pg_catalog','information_schema')
    ) s")" || return 1
  case "$_schema" in ''|*' '*) return 1 ;; esac
  echo "schema $_schema" >> "$_out"
  _tables="$(_psql "SELECT format('%I.%I', schemaname, tablename) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1")" || return 1
  _ok=1
  OLDIFS="$IFS"; IFS='
'
  for _t in $_tables; do
    _row="$(_psql "SELECT count(*)||' '||md5(coalesce(string_agg(m, '' ORDER BY m), '')) FROM (SELECT md5(row_to_json(x)::text) AS m FROM $_t x) s")" || _ok=0
    case "$_row" in ''|*'  '*) _ok=0 ;; esac
    [ "$_ok" = 1 ] || break
    echo "table $_t $_row" >> "$_out"
  done
  _seqs="$(_psql "SELECT format('%I.%I', sequence_schema, sequence_name) FROM information_schema.sequences WHERE sequence_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1")" || _ok=0
  if [ "$_ok" = 1 ]; then
    for _s in $_seqs; do
      _lv="$(_psql "SELECT last_value||' '||is_called FROM $_s")" || _ok=0
      case "$_lv" in *[0-9]' true'|*[0-9]' false') ;; *) _ok=0 ;; esac
      [ "$_ok" = 1 ] || break
      echo "sequence $_s $_lv" >> "$_out"
    done
  fi
  IFS="$OLDIFS"
  [ "$_ok" = 1 ]
}

if [ -n "$PG_CONTAINER" ]; then
  PG_BACKUP="$BACKUP_DIR/lyam-pg-$TS.sql.gz"
  PG_STATE_FILE="$BACKUP_DIR/.pg-state-$TS"
  log "backup: pg_dump $PG_CONTAINER/$PG_DB -> $PG_BACKUP"
  pg_state_capture "$PG_STATE_FILE" \
    || abort_preservation "pg state capture failed (unknown counts are never ignored)"
  # No pipe can hide a failed export here: the dump lands in a plain file first, its exit code
  # and size are checked, and only then is it compressed.
  if ! docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" > "$BACKUP_DIR/.pg-$TS.sql" 2>/dev/null \
     || [ ! -s "$BACKUP_DIR/.pg-$TS.sql" ]; then
    rm -f "$BACKUP_DIR/.pg-$TS.sql" "$PG_STATE_FILE"
    abort_preservation "pg backup failed (pg_dump did not produce a dump)"
  fi
  gzip -f "$BACKUP_DIR/.pg-$TS.sql" && mv "$BACKUP_DIR/.pg-$TS.sql.gz" "$PG_BACKUP" \
    || abort_preservation "pg backup compression failed"
fi

if [ -n "$BAO_DIR" ]; then
  BAO_BACKUP="$BACKUP_DIR/lyam-bao-$TS.tar.gz"
  log "backup: $BAO_DIR${BAO_KEYS_DIR:+ + $BAO_KEYS_DIR} -> $BAO_BACKUP (OpenBao stopped during the archive)"
  docker stop "$BAO_CONTAINER" >/dev/null || abort_preservation "could not stop $BAO_CONTAINER for a consistent backup"
  [ "$(docker inspect -f '{{.State.Running}}' "$BAO_CONTAINER" 2>/dev/null)" = "false" ] \
    || { docker start "$BAO_CONTAINER" >/dev/null 2>&1 || true; abort_preservation "$BAO_CONTAINER did not actually stop - a live Bao is never archived"; }
  bao_ok=1
  set -- -C "$(dirname "$BAO_DIR")" "$(basename "$BAO_DIR")"
  if [ -n "$BAO_KEYS_DIR" ] && [ -d "$BAO_KEYS_DIR" ]; then
    set -- "$@" -C "$(dirname "$BAO_KEYS_DIR")" "$(basename "$BAO_KEYS_DIR")"
  fi
  tar -czf "$BAO_BACKUP" "$@" || bao_ok=0
  [ -s "$BAO_BACKUP" ] || bao_ok=0
  docker start "$BAO_CONTAINER" >/dev/null || true
  # A Bao that stays sealed/unready here is NOT a warning: the app cannot serve without its
  # secrets, so the update aborts (and the previous container only restarts once Bao is ready).
  bao_ready || abort_preservation "OpenBao did not become ready/unsealed after the backup archive"
  [ "$bao_ok" = 1 ] || abort_preservation "bao backup failed"
fi

# Private recovery bundle: everything needed to rebuild the service from these backups -
# env file (root 0600), compose / bao config (mandatory when the companions are configured),
# extra recovery files, the updater itself (a fresh stack rebuilds from the bundle alone,
# never from a script living outside the backup), and a manifest of this generation. The
# tree is PRESERVED (cp -p --parents), never flattened: two files with the same basename
# can never collide, and NON-secret files keep their source mode/owner so a restore leaves
# them readable by the container user (a flat 0600-root copy made the bao config unreadable
# inside the container on a fresh-stack rebuild). Secret files (the env file and the
# compose env) are forced to root 0600 whatever their source mode. The manifest records
# mode/owner/secret/sha256 for every file so the restore can verify and re-apply them. The
# staging dir is 0700 and the archive 0600 from creation (umask 077 above).
RECOVERY="$BACKUP_DIR/lyam-recovery-$TS.tar.gz"
STAGE="$BACKUP_DIR/.recovery-$TS"
mkdir -m 700 -p "$STAGE"
rec_ok=1
BUNDLE_FILES="$ENV_FILE ${COMPOSE_FILE:-} ${COMPOSE_ENV_FILE:-} ${BAO_CONFIG_FILE:-} ${BAO_POLICY_FILE:-} $STACK_FILES $RECOVERY_FILES"
SECRET_FILES="$ENV_FILE ${COMPOSE_ENV_FILE:-}"
for f in $BUNDLE_FILES; do
  [ -n "$f" ] || continue
  cp -p --parents "$f" "$STAGE" 2>/dev/null || rec_ok=0
done
# The updater profile is part of the backup: scripts, boot unit and companions of the
# EXACT version that produced these archives, under updater/ in the bundle.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
mkdir -p "$STAGE/updater"
for f in update.sh host-boot.sh prepare-dirs.sh front-barrier-check.sh lyam-boot.service lyam.env.example; do
  [ -f "$SCRIPT_DIR/$f" ] && { cp -p "$SCRIPT_DIR/$f" "$STAGE/updater/" || rec_ok=0; }
done
[ -d "$SCRIPT_DIR/companions" ] && { cp -rp "$SCRIPT_DIR/companions" "$STAGE/updater/" || rec_ok=0; }
# Secrets stay strictly private no matter how loose the host copy was.
for f in $SECRET_FILES; do
  [ -n "$f" ] && [ -f "$STAGE$f" ] || continue
  chmod 600 "$STAGE$f" || rec_ok=0
  [ "$(id -u)" = 0 ] && { chown 0:0 "$STAGE$f" || rec_ok=0; }
done
MANIFEST="$STAGE/MANIFEST"
{
  echo "timestamp=$TS"
  echo "previous_image=${PREVIOUS:-none}"
  echo "target_image=$IMAGE"
  echo "data_backup=$(basename "$DATA_BACKUP") sha256=$(sha256sum "$DATA_BACKUP" | cut -d' ' -f1)"
  [ -n "${PG_BACKUP:-}" ] && echo "pg_backup=$(basename "$PG_BACKUP") sha256=$(sha256sum "$PG_BACKUP" | cut -d' ' -f1)"
  [ -n "${PG_STATE_FILE:-}" ] && { echo "pg_state:"; sed 's/^/  /' "$PG_STATE_FILE"; }
  [ -n "${BAO_BACKUP:-}" ] && echo "bao_backup=$(basename "$BAO_BACKUP") sha256=$(sha256sum "$BAO_BACKUP" | cut -d' ' -f1)"
  [ -n "${BAO_KEYS_DIR:-}" ] && echo "bao_keys_included=yes"
  echo "front_barrier_file=$BARRIER_FILE"
  for f in $BUNDLE_FILES; do
    [ -n "$f" ] && [ -f "$STAGE$f" ] || continue
    s=no
    case " $SECRET_FILES " in *" $f "*) s=yes ;; esac
    echo "file mode=$(stat -c '%a' "$STAGE$f") owner=$(stat -c '%u:%g' "$STAGE$f") secret=$s sha256=$(sha256sum "$STAGE$f" | cut -d' ' -f1) path=$f"
  done
  find "$STAGE/updater" -type f | while read -r u; do
    rel=${u#"$STAGE/"}
    echo "file mode=$(stat -c '%a' "$u") owner=$(stat -c '%u:%g' "$u") secret=no sha256=$(sha256sum "$u" | cut -d' ' -f1) path=$rel"
  done
} > "$MANIFEST"
tar -C "$STAGE" -czf "$RECOVERY" . 2>/dev/null || rec_ok=0
rm -rf "$STAGE"
[ "$rec_ok" = 1 ] && [ -s "$RECOVERY" ] || abort_preservation "recovery bundle failed"

prune() { ls -1t "$BACKUP_DIR"/$1 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r f; do rm -f "$f"; done; }
prune 'lyam-data-*.tar.gz'; prune 'lyam-pg-*.sql.gz'; prune 'lyam-bao-*.tar.gz'; prune 'lyam-recovery-*.tar.gz'

# --- swap (front still gated: the probe runs inside the container) ----------------------------
# The validated container is never recreated: the very container that passes the health gate
# is the one that serves when the gate lifts.
log "starting $CONTAINER from $IMAGE (seed mode: never)"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
CREATE_OK=1
run_container "$IMAGE" "$PORT" || CREATE_OK=0
if [ "$CREATE_OK" = 1 ] && bao_ready && health; then
  # The gate lifts ONLY here, and a failed lift RE-ARMS it: no blind rollback of this
  # version's possible writes, no exposed-but-unverified service either.
  gate_lift || fail 4 "the new version is healthy BUT the front could not be proven open (gate removal or 200-probe failed) - maintenance re-armed at $BARRIER_FILE, the service stays behind it; NO blind rollback (visitor writes may already exist on this version): diagnose the front path manually"
  log "healthy: $CONTAINER now runs $IMAGE; the front serves it (proven through $ORIGIN); data preserved (backup $DATA_BACKUP)"
  exit 0
fi
[ "$CREATE_OK" = 1 ] || log "the new container could not be created"
[ "$CREATE_OK" = 0 ] || log "the new image never became healthy within ${HEALTH_TIMEOUT}s"

# --- compensation: data AND image together -----------------------------------------------------
# The failed version may have migrated the Dolt schema or plugin state at boot: an old image
# reading a newer data state is NOT a safe rollback, so the pre-update backup is restored first.
# No visitor write can be lost: the front gate has answered 503 to every request since before
# the swap began and stays up until the rolled-back previous version is healthy. Every fail-4
# path below KEEPS the maintenance gate UP: the service is down or unverified, and a gate this
# run owns is only ever lifted by gate_lift (remove + proven 200, re-armed otherwise).
log "rolling back: restoring the pre-update data and starting the previous image"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

rm -rf "$DATA_DIR.restore-tmp"
mkdir -p "$DATA_DIR.restore-tmp"
tar -C "$DATA_DIR.restore-tmp" -xzf "$DATA_BACKUP" || fail 4 "update failed AND the data restore failed - restore $DATA_BACKUP manually"
rm -rf "$DATA_DIR"
mv "$DATA_DIR.restore-tmp/$(basename "$DATA_DIR")" "$DATA_DIR"
rm -rf "$DATA_DIR.restore-tmp"

if [ -n "$PG_CONTAINER" ] && [ -f "${PG_BACKUP:-}" ]; then
  log "rollback: consistent PostgreSQL restore of $PG_DB (drop + recreate + verified replay)"
  # Forensics first: keep the failed version's post-failure state instead of deleting it blind.
  if docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" > "$BACKUP_DIR/.pg-postmortem-$TS.sql" 2>/dev/null \
     && [ -s "$BACKUP_DIR/.pg-postmortem-$TS.sql" ]; then
    gzip -f "$BACKUP_DIR/.pg-postmortem-$TS.sql"
    mv "$BACKUP_DIR/.pg-postmortem-$TS.sql.gz" "$BACKUP_DIR/lyam-pg-postmortem-$TS.sql.gz"
    log "postmortem dump of the failed state kept at $BACKUP_DIR/lyam-pg-postmortem-$TS.sql.gz"
  else
    rm -f "$BACKUP_DIR/.pg-postmortem-$TS.sql"
    log "WARNING: no postmortem dump of the failed PostgreSQL state"
  fi
  psql_admin() { docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 -c "$1" >/dev/null 2>&1; }
  # Integrity and decompression are verified SEPARATELY, before anything destructive.
  gzip -t "$PG_BACKUP" 2>/dev/null \
    || fail 4 "update failed AND the pg dump is corrupt (gzip); the service stays DOWN - verify $PG_BACKUP manually"
  zcat "$PG_BACKUP" 2>/dev/null | head -n 5 | grep -q 'PostgreSQL database dump' \
    || fail 4 "update failed AND the pg dump header is missing; the service stays DOWN - verify $PG_BACKUP manually"
  psql_admin "DROP DATABASE IF EXISTS \"$PG_DB\"" \
    || fail 4 "update failed AND the pg drop failed; the service stays DOWN - restore $PG_BACKUP manually"
  psql_admin "CREATE DATABASE \"$PG_DB\"" \
    || fail 4 "update failed AND the pg recreate failed; the service stays DOWN - restore $PG_BACKUP manually"
  zcat "$PG_BACKUP" | docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -q >/dev/null 2>&1 \
    || fail 4 "update failed AND the pg replay failed; the service stays DOWN - restore $PG_BACKUP manually"
  # Full application state: every user table's count must match the pre-update capture exactly.
  PG_STATE_POST="$BACKUP_DIR/.pg-state-post-$TS"
  if ! pg_state_capture "$PG_STATE_POST"; then
    rm -f "$PG_STATE_POST"
    fail 4 "update failed AND the post-restore state could not be captured (unknown counts are never ignored); the service stays DOWN - verify $PG_BACKUP manually"
  fi
  if ! cmp -s "${PG_STATE_FILE:-/dev/null}" "$PG_STATE_POST"; then
    log "state mismatch (pre -> post):"
    diff "${PG_STATE_FILE:-/dev/null}" "$PG_STATE_POST" | grep -E '^[<>]' | sed 's/^/    /' >&2 || true
    rm -f "$PG_STATE_POST"
    fail 4 "update failed AND the PostgreSQL state verification failed; the service stays DOWN - verify $PG_BACKUP manually"
  fi
  rm -f "$PG_STATE_POST" "${PG_STATE_FILE:-/dev/null}"
fi

if [ -n "$BAO_DIR" ] && [ -f "${BAO_BACKUP:-}" ]; then
  log "rollback: restoring the OpenBao storage (proven stop, complete restore, unseal, wait-ready)"
  # No destruction without a PROVEN stop: a live Bao writing during the restore would corrupt it.
  docker stop "$BAO_CONTAINER" >/dev/null 2>&1 || true
  [ "$(docker inspect -f '{{.State.Running}}' "$BAO_CONTAINER" 2>/dev/null)" = "false" ] \
    || fail 4 "update failed AND the OpenBao container could not be stopped before the restore; the service stays DOWN - stop $BAO_CONTAINER and restore $BAO_BACKUP manually"
  rm -rf "$BAO_DIR"
  mkdir -p "$BAO_DIR"
  # No resume without a COMPLETE restore.
  tar -C "$(dirname "$BAO_DIR")" -xzf "$BAO_BACKUP" \
    || fail 4 "update failed AND the OpenBao restore is incomplete; the service stays DOWN - restore $BAO_BACKUP manually"
  docker start "$BAO_CONTAINER" >/dev/null 2>&1 || true
  bao_ready || fail 4 "update failed AND OpenBao did not become ready/unsealed after the restore; the service stays DOWN - unseal manually"
fi

if [ -n "$PREVIOUS" ]; then
  run_container "$PREVIOUS" "$PORT" || fail 4 "update failed AND the rollback container could not start; the pre-update backup was restored into $DATA_DIR - verify manually"
  if health; then
    gate_lift || fail 4 "rolled back and healthy BUT the front could not be proven open - maintenance re-armed at $BARRIER_FILE, diagnose the front manually"
    fail 3 "update failed; rolled back to $PREVIOUS with the pre-update data restored (backup $DATA_BACKUP); the front is open again"
  fi
  fail 4 "update failed AND the rollback to $PREVIOUS never became healthy; the pre-update backup was restored into $DATA_DIR - verify manually"
fi
fail 4 "update failed with no previous image to roll back to; the pre-update backup was restored into $DATA_DIR - verify the service manually"
