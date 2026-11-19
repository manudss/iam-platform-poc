#!/bin/sh
# Lyam persistent-demo updater (runs ON the host, e.g. an OCI VM).
#
# Rolls a new immutable image onto the existing data volume WITHOUT re-seeding and WITHOUT
# losing existing data. It refuses to run whenever preservation cannot be guaranteed:
#   - the image ref must be immutable (full commit-sha tag or @sha256: digest), never a moving tag;
#   - the image must carry the io.lyam.seed-modes label listing "never" (see demo/Dockerfile) -
#     an image that cannot disable seeding is refused, so a re-seed can never wipe the volume;
#   - the data directory must already hold a dataset (bootstrap is a separate manual step);
#   - a cold backup must succeed BEFORE the swap; the update aborts and the old container is
#     restarted when the backup fails;
#   - the new container must answer /healthz within the timeout, or the previous image is
#     rolled back (and the backup restored if the rollback itself fails);
#   - a pause file (default /opt/lyam/UPDATE_PAUSED) freezes updates deliberately (demo freeze).
#
# Configuration: a single env file (default /opt/lyam/lyam.env), KEY=VALUE lines, no quotes and
# no spaces in values. Application keys (IAM_PUBLIC_ORIGIN, IAM_PG_URL, IAM_BAO_ADDR,
# IAM_BAO_TOKEN, ...) are passed to the container with docker --env-file. Updater settings:
#   LYAM_CONTAINER           container name (default lyam)
#   LYAM_DATA_DIR            host data dir mounted at /data (default /opt/lyam/data)
#   LYAM_BACKUP_DIR          backup destination (default /opt/lyam/backups)
#   LYAM_PORT                host loopback port published to the container's 8080 (default 8080)
#   LYAM_DOCKER_NETWORK      optional docker network (e.g. lyam-net with pg/bao companions)
#   LYAM_HEALTH_TIMEOUT      seconds to wait for /healthz (default 420)
#   LYAM_BACKUP_KEEP         backup generations kept per kind (default 5)
#   LYAM_BACKUP_PG_CONTAINER optional PostgreSQL companion container to pg_dumpall before the swap
#   LYAM_BACKUP_PG_USER      pg_dumpall user (default postgres)
#   LYAM_BACKUP_BAO_DIR      optional host dir with the OpenBao file storage to archive
#   LYAM_PAUSE_FILE          freeze file (default /opt/lyam/UPDATE_PAUSED)
#
# Usage: update.sh --image ghcr.io/<owner>/<repo>:<full-commit-sha> [--env-file PATH]
# Exit codes: 0 updated, 1 refused (preconditions), 2 backup failed (old container restarted),
#             3 health failed (rollback attempted), 4 rollback failed (backup restore attempted).
set -eu

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
PG_USER="$(getconf LYAM_BACKUP_PG_USER)"; PG_USER="${PG_USER:-postgres}"
BAO_DIR="$(getconf LYAM_BACKUP_BAO_DIR)"
PAUSE_FILE="$(getconf LYAM_PAUSE_FILE)"; PAUSE_FILE="${PAUSE_FILE:-/opt/lyam/UPDATE_PAUSED}"

# --- preconditions (refuse, never improvise) -------------------------------------------------
command -v docker >/dev/null 2>&1 || fail 1 "docker not found on this host"
[ ! -e "$PAUSE_FILE" ] || fail 1 "updates are paused by $PAUSE_FILE (remove it to resume)"
echo "$IMAGE" | grep -Eq ':[0-9a-f]{40}$|@sha256:[0-9a-f]{64}$' \
  || fail 1 "image ref must be immutable (full commit-sha tag or @sha256: digest), got: $IMAGE"
[ -d "$DATA_DIR/dolt/.dolt" ] \
  || fail 1 "no Dolt dataset under $DATA_DIR - bootstrap once with IAM_DEMO_SEED_MODE=auto before using the updater (docs/oci-deploy.md)"
[ -f "$ENV_FILE" ] || fail 1 "env file $ENV_FILE missing (needs at least IAM_PUBLIC_ORIGIN=...)"

log "pulling $IMAGE"
docker pull "$IMAGE" >/dev/null

MODES="$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "io.lyam.seed-modes"}}' 2>/dev/null || true)"
case " $MODES " in
  *" never "*) ;;
  *) fail 1 "image $IMAGE does not support IAM_DEMO_SEED_MODE=never (io.lyam.seed-modes='$MODES'); refusing to roll it onto a data volume" ;;
esac

PREVIOUS="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"
if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" = "$IMAGE" ]; then PREVIOUS=""; fi
if [ -n "$PREVIOUS" ] && [ "$(docker image inspect -f x "$PREVIOUS" 2>/dev/null || true)" != x ]; then
  fail 1 "rollback image $PREVIOUS is not available locally; refusing to update without a rollback path"
fi

run_container() {
  img="$1"
  set -- -d --name "$CONTAINER" --restart unless-stopped \
    -p "127.0.0.1:$PORT:8080" -v "$DATA_DIR:/data" \
    --env-file "$ENV_FILE" -e IAM_DEMO_SEED_MODE=never
  if [ -n "$NETWORK" ]; then set -- "$@" --network "$NETWORK"; fi
  docker run "$@" "$img" >/dev/null
}

health() {
  waited=0
  while :; do
    if docker exec "$CONTAINER" node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    [ "$waited" -lt "$HEALTH_TIMEOUT" ] || return 1
    sleep 5; waited=$((waited + 5))
  done
}

# --- cold backup (container stopped: consistent files) ---------------------------------------
TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
if [ -n "$PREVIOUS" ]; then
  log "stopping $CONTAINER (was $PREVIOUS)"
  docker stop "$CONTAINER" >/dev/null
fi

restart_previous() {
  [ -n "$PREVIOUS" ] || return 0
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  run_container "$PREVIOUS"
}

DATA_BACKUP="$BACKUP_DIR/lyam-data-$TS.tar.gz"
log "backup: $DATA_DIR -> $DATA_BACKUP"
if ! tar -C "$(dirname "$DATA_DIR")" -czf "$DATA_BACKUP" "$(basename "$DATA_DIR")" || [ ! -s "$DATA_BACKUP" ]; then
  log "backup failed; restarting the previous container unchanged"
  restart_previous || fail 4 "backup failed AND the previous container could not be restarted - manual intervention"
  fail 2 "backup failed; update aborted, previous container restarted"
fi

if [ -n "$PG_CONTAINER" ]; then
  PG_BACKUP="$BACKUP_DIR/lyam-pg-$TS.sql.gz"
  log "backup: pg_dumpall $PG_CONTAINER -> $PG_BACKUP"
  if ! docker exec "$PG_CONTAINER" pg_dumpall -U "$PG_USER" 2>/dev/null | gzip > "$PG_BACKUP" || [ ! -s "$PG_BACKUP" ]; then
    restart_previous || fail 4 "pg backup failed AND the previous container could not be restarted - manual intervention"
    fail 2 "pg backup failed; update aborted, previous container restarted"
  fi
fi

if [ -n "$BAO_DIR" ]; then
  BAO_BACKUP="$BACKUP_DIR/lyam-bao-$TS.tar.gz"
  log "backup: $BAO_DIR -> $BAO_BACKUP"
  if ! tar -C "$(dirname "$BAO_DIR")" -czf "$BAO_BACKUP" "$(basename "$BAO_DIR")" || [ ! -s "$BAO_BACKUP" ]; then
    restart_previous || fail 4 "bao backup failed AND the previous container could not be restarted - manual intervention"
    fail 2 "bao backup failed; update aborted, previous container restarted"
  fi
fi

prune() { ls -1t "$BACKUP_DIR"/"$1" 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r f; do rm -f "$BACKUP_DIR/$f"; done; }
prune 'lyam-data-*.tar.gz'; prune 'lyam-pg-*.sql.gz'; prune 'lyam-bao-*.tar.gz'

# --- swap -------------------------------------------------------------------------------------
log "starting $CONTAINER from $IMAGE (seed mode: never)"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
run_container "$IMAGE"

if health; then
  log "healthy: $CONTAINER now runs $IMAGE; data preserved (backup $DATA_BACKUP)"
  exit 0
fi

log "the new image never became healthy within ${HEALTH_TIMEOUT}s"
if [ -n "$PREVIOUS" ]; then
  log "rolling back to $PREVIOUS"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  run_container "$PREVIOUS"
  health && fail 3 "update failed; rolled back to $PREVIOUS (data untouched, backup $DATA_BACKUP)"
fi
log "rollback failed too; restoring the backup into $DATA_DIR"
rm -rf "$DATA_DIR.restore-tmp"
mkdir -p "$DATA_DIR.restore-tmp"
tar -C "$DATA_DIR.restore-tmp" -xzf "$DATA_BACKUP"
rm -rf "$DATA_DIR"
mv "$DATA_DIR.restore-tmp/$(basename "$DATA_DIR")" "$DATA_DIR"
rm -rf "$DATA_DIR.restore-tmp"
[ -n "$PREVIOUS" ] && { run_container "$PREVIOUS" || true; }
fail 4 "update AND rollback failed; the backup was restored into $DATA_DIR - verify the service manually"
