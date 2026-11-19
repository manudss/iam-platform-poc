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
#     (its failure is detected, never hidden by the compression pipe) and optional OpenBao
#     storage tar taken while the Bao container is stopped;
#   - the new container must be creatable AND answer /healthz within the timeout; it starts on a
#     CANARY loopback port first, so the public front (Caddy -> LYAM_PORT) serves NOTHING during
#     the update window: no visitor write can happen and be silently lost by the rollback. Only a
#     healthy canary is re-published on the real port. Any failure rolls back image AND data
#     together (the failed version may have migrated the data, so an old image on a newer data
#     state is not a safe rollback), including a consistent PostgreSQL restore (drop + recreate +
#     verified replay, with a postmortem dump of the failed state kept) and the OpenBao storage
#     (stopped, restored, unsealed and waited-ready before the app starts);
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
#   LYAM_CANARY_PORT         loopback port for the pre-publish health gate (default 18080)
#   LYAM_DOCKER_NETWORK      optional docker network (e.g. lyam-net with pg/bao companions)
#   LYAM_HEALTH_TIMEOUT      seconds to wait for /healthz (default 420)
#   LYAM_BACKUP_KEEP         backup generations kept per kind (default 5)
#   LYAM_BACKUP_PG_CONTAINER optional PostgreSQL companion container to pg_dump before the swap
#   LYAM_BACKUP_PG_USER      pg_dump/psql user (default lyam, matches deploy/oci/companions)
#   LYAM_BACKUP_PG_DB        database name (default lyam)
#   LYAM_BACKUP_BAO_DIR      optional host dir with the OpenBao file storage to archive;
#                            requires LYAM_BACKUP_BAO_CONTAINER (never archived live)
#   LYAM_BACKUP_BAO_CONTAINER OpenBao container: stopped during the archive, started + unsealed after
#   LYAM_BACKUP_BAO_KEYS_DIR optional OpenBao keys dir (unseal key, root token, api token) archived
#                            with the storage - the recovery chain is incomplete without it
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
CANARY_PORT="$(getconf LYAM_CANARY_PORT)"; CANARY_PORT="${CANARY_PORT:-18080}"
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
if [ -n "$BAO_DIR" ] && [ -z "$BAO_CONTAINER" ]; then
  fail 1 "LYAM_BACKUP_BAO_DIR requires LYAM_BACKUP_BAO_CONTAINER (a live Bao is never archived)"
fi

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
  set -- -d --name "$CONTAINER" --restart unless-stopped \
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
  run_container "$PREVIOUS" "$PORT"
}

# --- cold backup (container stopped: consistent files) ---------------------------------------
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
    restart_previous || fail 4 "pre-update hook failed AND the previous container could not be restarted - manual intervention"
    fail 2 "pre-update hook failed; update aborted, previous container restarted"
  fi
fi

abort_preservation() {
  restart_previous || fail 4 "$1 AND the previous container could not be restarted - manual intervention"
  fail 2 "$1; update aborted, previous container restarted"
}

DATA_BACKUP="$BACKUP_DIR/lyam-data-$TS.tar.gz"
log "backup: $DATA_DIR -> $DATA_BACKUP"
tar -C "$(dirname "$DATA_DIR")" -czf "$DATA_BACKUP" "$(basename "$DATA_DIR")" \
  || abort_preservation "data backup failed"
[ -s "$DATA_BACKUP" ] || abort_preservation "data backup is empty"

if [ -n "$PG_CONTAINER" ]; then
  PG_BACKUP="$BACKUP_DIR/lyam-pg-$TS.sql.gz"
  PG_COUNT_FILE="$BACKUP_DIR/.pg-count-$TS"
  log "backup: pg_dump $PG_CONTAINER/$PG_DB -> $PG_BACKUP"
  # Journal size before the swap, for the post-restore verification (best effort: unknown when
  # the table does not exist yet).
  PG_COUNT_PRE="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc 'SELECT count(*) FROM activations' 2>/dev/null || true)"
  case "$PG_COUNT_PRE" in ''|*[!0-9]*) PG_COUNT_PRE=unknown ;; esac
  echo "$PG_COUNT_PRE" > "$PG_COUNT_FILE"
  # No pipe can hide a failed export here: the dump lands in a plain file first, its exit code
  # and size are checked, and only then is it compressed.
  if ! docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$PG_DB" > "$BACKUP_DIR/.pg-$TS.sql" 2>/dev/null \
     || [ ! -s "$BACKUP_DIR/.pg-$TS.sql" ]; then
    rm -f "$BACKUP_DIR/.pg-$TS.sql" "$PG_COUNT_FILE"
    abort_preservation "pg backup failed (pg_dump did not produce a dump)"
  fi
  gzip -f "$BACKUP_DIR/.pg-$TS.sql" && mv "$BACKUP_DIR/.pg-$TS.sql.gz" "$PG_BACKUP" \
    || abort_preservation "pg backup compression failed"
fi

if [ -n "$BAO_DIR" ]; then
  BAO_BACKUP="$BACKUP_DIR/lyam-bao-$TS.tar.gz"
  log "backup: $BAO_DIR${BAO_KEYS_DIR:+ + $BAO_KEYS_DIR} -> $BAO_BACKUP (OpenBao stopped during the archive)"
  docker stop "$BAO_CONTAINER" >/dev/null || abort_preservation "could not stop $BAO_CONTAINER for a consistent backup"
  bao_ok=1
  set -- -C "$(dirname "$BAO_DIR")" "$(basename "$BAO_DIR")"
  if [ -n "$BAO_KEYS_DIR" ] && [ -d "$BAO_KEYS_DIR" ]; then
    set -- "$@" -C "$(dirname "$BAO_KEYS_DIR")" "$(basename "$BAO_KEYS_DIR")"
  fi
  tar -czf "$BAO_BACKUP" "$@" || bao_ok=0
  [ -s "$BAO_BACKUP" ] || bao_ok=0
  docker start "$BAO_CONTAINER" >/dev/null || true
  bao_ready || { log "WARNING: OpenBao did not become ready/unsealed after the backup archive"; }
  [ "$bao_ok" = 1 ] || abort_preservation "bao backup failed"
fi

prune() { ls -1t "$BACKUP_DIR"/$1 2>/dev/null | tail -n "+$((KEEP + 1))" | while read -r f; do rm -f "$f"; done; }
prune 'lyam-data-*.tar.gz'; prune 'lyam-pg-*.sql.gz'; prune 'lyam-bao-*.tar.gz'

# --- swap: canary first, publish only when healthy --------------------------------------------
# The new version starts on the CANARY loopback port: the public front still points at LYAM_PORT,
# where NOTHING listens during the window (the old container is stopped). Visitors get a clean
# 502, and no write can reach a version the rollback would then silently discard.
log "canary: starting $CONTAINER from $IMAGE on loopback :$CANARY_PORT (seed mode: never)"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
CREATE_OK=1
run_container "$IMAGE" "$CANARY_PORT" || CREATE_OK=0
CANARY_OK=0
if [ "$CREATE_OK" = 1 ] && bao_ready && health; then
  CANARY_OK=1
else
  [ "$CREATE_OK" = 1 ] || log "the new container could not be created"
  [ "$CREATE_OK" = 0 ] || log "the new image never became healthy within ${HEALTH_TIMEOUT}s"
fi

if [ "$CANARY_OK" = 1 ]; then
  log "canary healthy: publishing $IMAGE on :$PORT"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if run_container "$IMAGE" "$PORT" && health; then
    log "healthy: $CONTAINER now runs $IMAGE on :$PORT; data preserved (backup $DATA_BACKUP)"
    exit 0
  fi
  log "the healthy canary failed once published on :$PORT"
fi

# --- compensation: data AND image together -----------------------------------------------------
# The failed version may have migrated the Dolt schema or plugin state at boot: an old image
# reading a newer data state is NOT a safe rollback, so the pre-update backup is restored first.
# No visitor write can be lost: nothing was published on the public port during the window.
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
  PG_COUNT_PRE="$(cat "${PG_COUNT_FILE:-/dev/null}" 2>/dev/null || echo unknown)"
  psql_admin() { docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 -c "$1" >/dev/null 2>&1; }
  psql_admin "DROP DATABASE IF EXISTS \"$PG_DB\"" \
    || fail 4 "update failed AND the pg drop failed; the service stays DOWN - restore $PG_BACKUP manually"
  psql_admin "CREATE DATABASE \"$PG_DB\"" \
    || fail 4 "update failed AND the pg recreate failed; the service stays DOWN - restore $PG_BACKUP manually"
  zcat "$PG_BACKUP" | docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -q >/dev/null 2>&1 \
    || fail 4 "update failed AND the pg replay failed; the service stays DOWN - restore $PG_BACKUP manually"
  PG_COUNT_POST="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc 'SELECT count(*) FROM activations' 2>/dev/null || true)"
  case "$PG_COUNT_POST" in ''|*[!0-9]*) PG_COUNT_POST=unknown ;; esac
  if [ "$PG_COUNT_PRE" != unknown ] && [ "$PG_COUNT_POST" != "$PG_COUNT_PRE" ]; then
    fail 4 "update failed AND the journal verification failed ($PG_COUNT_PRE -> $PG_COUNT_POST activations); the service stays DOWN - verify $PG_BACKUP manually"
  fi
  rm -f "${PG_COUNT_FILE:-/dev/null}"
fi

if [ -n "$BAO_DIR" ] && [ -f "${BAO_BACKUP:-}" ]; then
  log "rollback: restoring the OpenBao storage (stopped, restored, unsealed, waited-ready)"
  docker stop "$BAO_CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$BAO_DIR"
  mkdir -p "$BAO_DIR"
  tar -C "$(dirname "$BAO_DIR")" -xzf "$BAO_BACKUP" || log "WARNING: bao restore failed - restore $BAO_BACKUP manually"
  docker start "$BAO_CONTAINER" >/dev/null 2>&1 || true
  bao_ready || fail 4 "update failed AND OpenBao did not become ready/unsealed after the restore; the service stays DOWN - unseal manually"
fi

if [ -n "$PREVIOUS" ]; then
  run_container "$PREVIOUS" "$PORT" || fail 4 "update failed AND the rollback container could not start; the pre-update backup was restored into $DATA_DIR - verify manually"
  health && fail 3 "update failed; rolled back to $PREVIOUS with the pre-update data restored (backup $DATA_BACKUP)"
  fail 4 "update failed AND the rollback to $PREVIOUS never became healthy; the pre-update backup was restored into $DATA_DIR - verify manually"
fi
fail 4 "update failed with no previous image to roll back to; the pre-update backup was restored into $DATA_DIR - verify the service manually"
