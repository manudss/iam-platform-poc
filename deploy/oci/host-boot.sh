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
# The front must be UP before anything it gates: the coordinated recreation proves its gate
# through the origin, and a boot that races Caddy would fail randomly. Bounded wait - any
# HTTP code counts; 000 means the front itself is not answering yet.
ORIGIN="$(getconf IAM_PUBLIC_ORIGIN)"; ORIGIN="${ORIGIN%/}"
if [ -n "$ORIGIN" ] && command -v curl >/dev/null 2>&1; then
  n=0
  # curl ALREADY prints 000 (its -w format) on a refused/failed connection: the HTTP code and
  # the command status are read separately, never concatenated (a doubled "000000" would look
  # like a live front).
  while :; do
    FRONT_CODE="$(curl -sk --max-time 5 -o /dev/null -w '%{http_code}' "$ORIGIN/healthz" 2>/dev/null)" || true
    [ "$FRONT_CODE" = "000" ] || break
    n=$((n + 1)); [ "$n" -lt "$BOOT_TRIES" ] || fail "the front at $ORIGIN never came up; not starting the app (its gate could not be proven)"
    sleep 5
  done
  log "front answering at $ORIGIN"
fi
# docker start does NOT reload the env - not even on a stopped container. When the env file
# drifted from the container's recorded env (a bao-bootstrap re-mint syncs IAM_BAO_TOKEN into
# the file; the container still holds the previous value), a plain start would RESUME WITH A
# DIVERGENT ENVIRONMENT. Comparison scope: the UNION of the IAM_* application parameters
# sourced from the env file AND the explicit persistence keys below - a key REMOVED from the
# file but still baked into the container is a divergence too (a stale secret would keep
# serving). Image-baked non-IAM defaults (PATH and friends) are immutable and excluded by
# design. Never serve that: recreate from the env file through the updater's
# own coordinated same-image redeploy (cold backup, front gate, health gate), and fail the
# boot if that recreation fails.
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  CONT_ENV="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER" 2>/dev/null || true)"
  DIVERGED=""
  DIVERGE_KEYS="$( { sed -n 's/^\(IAM_[A-Za-z0-9_]*\)=.*/\1/p' "$ENV_FILE" 2>/dev/null
                    printf '%s\n' IAM_BAO_TOKEN IAM_PG_URL IAM_BAO_ADDR IAM_PUBLIC_ORIGIN; } | sort -u )"
  for key in $DIVERGE_KEYS; do
    fv="$(getconf "$key")"
    cv="$(printf '%s\n' "$CONT_ENV" | sed -n "s/^$key=//p" | head -n 1)"
    [ "$fv" = "$cv" ] || DIVERGED="$DIVERGED $key"
  done
  if [ -n "$DIVERGED" ]; then
    UPDATE_SCRIPT="$(getconf LYAM_UPDATE_SCRIPT)"; UPDATE_SCRIPT="${UPDATE_SCRIPT:-/opt/lyam/bin/update.sh}"
    IMG="$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"
    log "env divergence detected ($DIVERGED): docker start would resume with stale env - coordinated same-image recreation through $UPDATE_SCRIPT"
    [ -n "$IMG" ] || fail "env divergence ($DIVERGED) but the container image is unknown; the app is NOT started with a divergent env"
    sh "$UPDATE_SCRIPT" --image "$IMG" --env-file "$ENV_FILE" \
      || fail "the coordinated recreation failed (the updater keeps the front gate up); the app is NOT started with a divergent env"
    log "recreated from the env file, healthy; boot ordering complete"
    exit 0
  fi
fi
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
