#!/bin/sh
# Host-boot ordering for the persistent Lyam demo (docs/oci-deploy.md): the companions must be
# READY before the app starts, at every host boot and every manual recovery:
#   1. PostgreSQL up and accepting connections (pg_isready);
#   2. OpenBao up, unsealed and answering (bao-bootstrap.sh --unseal-only);
#   3. lyam app container started (IAM_DEMO_SEED_MODE=never; the updater owns image changes).
# Only steps whose companion is configured run. A companion that never becomes ready stops the
# boot (exit 1) instead of letting the app start against absent persistence.
# Driven by the same env file as update.sh (default /opt/lyam/lyam.env). Hook it into the host
# boot with deploy/oci/lyam-boot.service.
set -eu

ENV_FILE="${1:-/opt/lyam/lyam.env}"
getconf() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -n 1; }
CONTAINER="$(getconf LYAM_CONTAINER)"; CONTAINER="${CONTAINER:-lyam}"
PORT="$(getconf LYAM_PORT)"; PORT="${PORT:-8080}"
PG_CONTAINER="$(getconf LYAM_BACKUP_PG_CONTAINER)"
PG_USER="$(getconf LYAM_BACKUP_PG_USER)"; PG_USER="${PG_USER:-lyam}"
BAO_CONTAINER="$(getconf LYAM_BACKUP_BAO_CONTAINER)"
UNSEAL_CMD="$(getconf LYAM_BAO_UNSEAL_CMD)"
HEALTH_TIMEOUT="$(getconf LYAM_HEALTH_TIMEOUT)"; HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-420}"
BOOT_TRIES="$(getconf LYAM_BOOT_TRIES)"; BOOT_TRIES="${BOOT_TRIES:-60}"

log() { echo "[boot $(date -u +%H:%M:%S)] $*"; }
fail() { log "FATAL: $*" >&2; exit 1; }

wait_loop() { # $1 description, rest: probe command; LYAM_BOOT_TRIES x 5s
  desc="$1"; shift
  n=0
  while ! "$@" >/dev/null 2>&1; do
    n=$((n + 1)); [ "$n" -lt "$BOOT_TRIES" ] || return 1
    sleep 5
  done
}

if [ -n "$PG_CONTAINER" ]; then
  log "starting PostgreSQL companion $PG_CONTAINER"
  docker start "$PG_CONTAINER" >/dev/null
  wait_loop "pg ready" docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" \
    || fail "PostgreSQL never became ready; not starting the app"
  log "PostgreSQL ready"
fi

if [ -n "$BAO_CONTAINER" ]; then
  log "starting OpenBao companion $BAO_CONTAINER"
  docker start "$BAO_CONTAINER" >/dev/null
  if [ -n "$UNSEAL_CMD" ]; then
    sh -c "$UNSEAL_CMD" || fail "OpenBao could not be unsealed; not starting the app"
  else
    wait_loop "bao ready" docker exec "$BAO_CONTAINER" bao status \
      || fail "OpenBao never became ready (sealed?); not starting the app"
  fi
  log "OpenBao unsealed and ready"
fi

log "starting $CONTAINER (seed mode: never)"
docker start "$CONTAINER" >/dev/null
waited=0
while :; do
  if docker exec "$CONTAINER" node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    log "$CONTAINER healthy on :$PORT"
    exit 0
  fi
  [ "$waited" -lt "$HEALTH_TIMEOUT" ] || fail "$CONTAINER never became healthy after boot"
  sleep 5; waited=$((waited + 5))
done
