#!/bin/sh
# Idempotent bootstrap / unseal of the persistent demo OpenBao companion (docs/oci-deploy.md).
#
# Full mode (first setup):
#   - initializes the backend ONLY if it has never been initialized (never re-initializes);
#   - unseals it when sealed (safe to re-run after every bao container restart);
#   - enables the KV-v2 engine at secret/ when missing;
#   - writes the scoped API policy;
#   - mints the scoped API token ONCE. A stored token is only reused while its REMAINING
#     lifetime covers the time left until the planned demo end (LYAM_DEMO_UNTIL, default
#     2026-12-16); otherwise a new one is minted and synchronized ATOMICALLY into the app
#     env file (LYAM_ENV_FILE, default /opt/lyam/lyam.env) - the token inside a RUNNING
#     container's env cannot be hot-swapped, so a running app must then be recreated from
#     the env file (update.sh does that on its next run; the script says so loudly).
# --unseal-only mode (host boot, updater compensation paths): unseal + wait-ready ONLY;
#   never touches policy or tokens.
#
# Never prints a secret: unseal key + root token live in <keys-dir>/keys.json (0600), the
# scoped API token in <keys-dir>/api-token (0600). Output is status words only.
#
# Usage: bao-bootstrap.sh [--unseal-only] [bao-addr] [keys-dir] [policy-file]
#   bao-addr    default http://127.0.0.1:8200 (host loopback publication of the bao service)
#   keys-dir    default /opt/lyam/bao-keys (created 0700)
#   policy-file default bao-policy.hcl next to this script
set -eu

UNSEAL_ONLY=0
if [ "${1:-}" = "--unseal-only" ]; then UNSEAL_ONLY=1; shift; fi
ADDR="${1:-http://127.0.0.1:8200}"
KEYS_DIR="${2:-/opt/lyam/bao-keys}"
HERE="$(cd "$(dirname "$0")" && pwd)"
POLICY_FILE="${3:-$HERE/bao-policy.hcl}"

command -v bao >/dev/null 2>&1 || { echo "bao CLI not found on this host" >&2; exit 1; }
export BAO_ADDR="$ADDR"
umask 077
mkdir -p "$KEYS_DIR"
chmod 700 "$KEYS_DIR"
KEYS="$KEYS_DIR/keys.json"
TOKEN_FILE="$KEYS_DIR/api-token"
ENV_FILE="${LYAM_ENV_FILE:-/opt/lyam/lyam.env}"
DEMO_UNTIL="${LYAM_DEMO_UNTIL:-2026-12-16}"
# Coverage required from any token, minted or reused: the real time left until the planned
# demo end, never an arbitrary floor (the API never renews tokens - a token that dies before
# the teardown silently cuts it off its secrets). Floor of one day once the date has passed.
NOW_S="$(date +%s)"
UNTIL_S="$(date -d "$DEMO_UNTIL 23:59:59" +%s 2>/dev/null || echo 0)"
case "$UNTIL_S" in ''|*[!0-9]*) UNTIL_S=0 ;; esac
REQUIRED_TTL=$(( UNTIL_S - NOW_S ))
[ "$REQUIRED_TTL" -ge 86400 ] || REQUIRED_TTL=86400

# bao status exits 0 (unsealed), 1 (error/unreachable) or 2 (sealed) and still prints JSON in
# every reachable case - capture output and code separately, never mask one with the other.
bao_status() {
  set +e
  OUT="$(bao status -format=json 2>/dev/null)"
  CODE=$?
  set -e
  [ -n "$OUT" ] || return 1
  echo "$OUT"
}
field() { echo "$2" | sed -n "s/.*\"$1\" *: *\([a-z]*\).*/\1/p" | head -n 1; }

# Bounded wait for the LISTENER first: a just-(re)started bao takes a moment to bind, and an
# "unreachable" verdict is only legitimate AFTER the budget expires - never on the first try
# (reproduced: bootstrap querying right after `docker start bao` failed unreachable).
n=0
while :; do
  STATUS="$(bao_status)" && break
  n=$((n + 1))
  [ "$n" -lt "${BAO_WAIT_TRIES:-30}" ] || { echo "bao unreachable at $ADDR after $n tries" >&2; exit 1; }
  sleep 1
done
INITIALIZED="$(field initialized "$STATUS")"
SEALED="$(field sealed "$STATUS")"
case "$INITIALIZED" in true|false) ;; *) echo "could not parse bao status" >&2; exit 1 ;; esac

if [ "$INITIALIZED" = "false" ]; then
  if [ "$UNSEAL_ONLY" = 1 ]; then
    echo "refused: backend not initialized; run the full bootstrap once first" >&2
    exit 1
  fi
  if [ -s "$KEYS" ]; then
    echo "refused: the backend reports not-initialized but $KEYS already holds keys - investigate before any init" >&2
    exit 1
  fi
  bao operator init -key-shares=1 -key-threshold=1 -format=json > "$KEYS"
  chmod 600 "$KEYS"
  SEALED="true"
fi

# bao operator init pretty-prints the key array over several lines: read the first element,
# whether it sits on the same line as the key or on the next one.
UNSEAL_KEY="$(sed -n 's/.*"unseal_keys_b64" *: *\["\([^"]*\)"\].*/\1/p' "$KEYS" | head -n 1)"
if [ -z "$UNSEAL_KEY" ]; then
  UNSEAL_KEY="$(sed -n '/"unseal_keys_b64"/{n;s/[^"]*"\([^"]*\)".*/\1/p;q;}' "$KEYS")"
fi
ROOT_TOKEN="$(sed -n 's/.*"root_token" *: *"\([^"]*\)".*/\1/p' "$KEYS" | head -n 1)"
[ -n "$UNSEAL_KEY" ] && [ -n "$ROOT_TOKEN" ] || { echo "could not read the unseal key / root token from $KEYS" >&2; exit 1; }

if [ "$SEALED" = "true" ]; then
  bao operator unseal "$UNSEAL_KEY" >/dev/null
fi

# Wait until really unsealed and answering.
n=0
while :; do
  STATUS="$(bao_status)" && [ "$(field sealed "$STATUS")" = "false" ] && break
  n=$((n + 1)); [ "$n" -lt 30 ] || { echo "bao still not ready after 30s" >&2; exit 1; }
  sleep 1
done
echo "bao unsealed and ready at $ADDR"
[ "$UNSEAL_ONLY" = 1 ] && exit 0

export BAO_TOKEN="$ROOT_TOKEN"

# The dev-mode store mounts secret/ implicitly; a real backend does not - enable KV-v2 once.
if ! bao secrets list -format=json 2>/dev/null | grep -q '"secret/"'; then
  bao secrets enable -path=secret -version=2 kv >/dev/null
fi

bao policy write lyam-demo-connections "$POLICY_FILE" >/dev/null

# The target stack container is resolved ONCE, before both sync paths (reuse-resync and
# mint-sync): the container name comes from LYAM_CONTAINER (process env, then the env
# file), never silently assumed - a message naming the wrong stack is a mis-targeting risk.
TARGET_CONTAINER="${LYAM_CONTAINER:-}"
if [ -z "$TARGET_CONTAINER" ] && [ -f "$ENV_FILE" ]; then
  TARGET_CONTAINER="$(sed -n 's/^LYAM_CONTAINER=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)"
fi
[ -n "$TARGET_CONTAINER" ] || TARGET_CONTAINER="lyam"

# sync_env_token <description>: synchronize the stored token into the app env file
# ATOMICALLY (pure-shell rewrite: the token never transits through a process argument
# list). A RUNNING container still holds the previous token in its process env - env edits
# never reach it - so it must be RECREATED from the env file (docker restart/start do NOT
# reload env); update.sh does that on its next run and host-boot.sh enforces it at boot.
# Returns 1 when the env file carries no IAM_BAO_TOKEN line at all (caller guides instead).
sync_env_token() {
  NEW_TOKEN="$(cat "$TOKEN_FILE")"
  [ -f "$ENV_FILE" ] && grep -q '^IAM_BAO_TOKEN=' "$ENV_FILE" || return 1
  TMP_ENV="$ENV_FILE.tmp.$$"
  while IFS= read -r _line || [ -n "$_line" ]; do
    case "$_line" in
      IAM_BAO_TOKEN=*) printf 'IAM_BAO_TOKEN=%s\n' "$NEW_TOKEN" ;;
      *) printf '%s\n' "$_line" ;;
    esac
  done < "$ENV_FILE" > "$TMP_ENV" || return 2
  chmod 600 "$TMP_ENV" && mv "$TMP_ENV" "$ENV_FILE" || return 2
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$TARGET_CONTAINER"; then
    echo "$1: $ENV_FILE updated; the RUNNING container named '$TARGET_CONTAINER' (verified via docker ps) still holds the previous token - recreate THAT container from $ENV_FILE (docker restart/start do NOT reload env)"
  else
    echo "$1: $ENV_FILE updated; no RUNNING container named '$TARGET_CONTAINER' found - the next start of THAT stack picks it up (host-boot.sh enforces the env/container match)"
  fi
  return 0
}

if [ -s "$TOKEN_FILE" ]; then
  LOOKUP="$(BAO_TOKEN="$(cat "$TOKEN_FILE")" bao token lookup -format=json 2>/dev/null || true)"
  TTL_LEFT="$(echo "$LOOKUP" | sed -n 's/.*"ttl" *: *\([0-9]*\).*/\1/p' | head -n 1)"
  case "$TTL_LEFT" in ''|*[!0-9]*) TTL_LEFT=0 ;; esac
  # Reuse only while the REMAINING lifetime covers the whole period until the demo end.
  if [ "$TTL_LEFT" -ge "$REQUIRED_TTL" ]; then
    # A still-valid token is only half of the invariant: the env file must CARRY it. A
    # diverged line (manual edit, partial restore, older file) is resynchronized with the
    # same atomic rewrite used after a mint, with the same running-container caveat.
    if [ -f "$ENV_FILE" ] && grep -q '^IAM_BAO_TOKEN=' "$ENV_FILE"; then
      if [ "$(sed -n 's/^IAM_BAO_TOKEN=//p' "$ENV_FILE" | tail -n 1)" = "$(cat "$TOKEN_FILE")" ]; then
        echo "scoped API token in $TOKEN_FILE is still valid for ${TTL_LEFT}s (covers the ${REQUIRED_TTL}s left until $DEMO_UNTIL); $ENV_FILE already carries it; unchanged"
      else
        sync_env_token "stored scoped API token reused (still valid ${TTL_LEFT}s) but $ENV_FILE had DIVERGED from it - resynchronized"
      fi
    else
      echo "stored scoped API token reused (still valid ${TTL_LEFT}s, covers the ${REQUIRED_TTL}s left until $DEMO_UNTIL) - no IAM_BAO_TOKEN line in $ENV_FILE: set it from $TOKEN_FILE for the stack you intend, and (re)create that stack's app container"
    fi
    exit 0
  fi
  [ "$TTL_LEFT" -gt 0 ] && echo "stored token only has ${TTL_LEFT}s left; ${REQUIRED_TTL}s are needed to cover the demo until $DEMO_UNTIL: re-minting" >&2
fi

# Scoped token with an explicit 40-day TTL: it outlives the planned demo window with margin
# and is destroyed with the VM. There is NO automatic renewal - the API does not renew leases
# (documented POC scope) and a periodic token without a renewer would still expire.
MINT_TTL_S=3456000
[ "$MINT_TTL_S" -ge "$REQUIRED_TTL" ] || { echo "the mint TTL ${MINT_TTL_S}s no longer covers the ${REQUIRED_TTL}s left until $DEMO_UNTIL - shorten the demo or raise the mint TTL" >&2; exit 1; }
MINT_TTL_H=$(( (MINT_TTL_S + 3599) / 3600 ))
bao token create -orphan -policy=lyam-demo-connections -ttl=${MINT_TTL_H}h -explicit-max-ttl=${MINT_TTL_H}h -display-name=lyam-api -format=json \
  | sed -n 's/.*"client_token" *: *"\([^"]*\)".*/\1/p' | head -n 1 > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
[ -s "$TOKEN_FILE" ] || { echo "no scoped token was issued" >&2; exit 1; }

# The granted TTL is MEASURED, not assumed from the request: a silently shorter token would
# cut the API off its secrets before the demo end.
LOOKUP="$(BAO_TOKEN="$(cat "$TOKEN_FILE")" bao token lookup -format=json 2>/dev/null)" \
  || { echo "the new token could not be verified" >&2; exit 1; }
TTL_GRANTED="$(echo "$LOOKUP" | sed -n 's/.*"ttl" *: *\([0-9]*\).*/\1/p' | head -n 1)"
case "$TTL_GRANTED" in ''|*[!0-9]*) echo "the granted TTL could not be measured" >&2; exit 1 ;; esac
[ "$TTL_GRANTED" -ge "$REQUIRED_TTL" ] \
  || { echo "granted TTL ${TTL_GRANTED}s does not cover the ${REQUIRED_TTL}s left until $DEMO_UNTIL - adjust the mint parameters" >&2; exit 1; }

# Synchronize the new token into the app env file ATOMICALLY (see sync_env_token).
SYNC_RC=0
sync_env_token "NEW scoped API token (granted TTL ${TTL_GRANTED}s measured)" || SYNC_RC=$?
[ "$SYNC_RC" -ne 2 ] || { echo "env synchronization failed" >&2; exit 1; }
if [ "$SYNC_RC" = 1 ]; then
  echo "NEW scoped API token in $TOKEN_FILE (granted TTL ${TTL_GRANTED}s measured) - no IAM_BAO_TOKEN line in $ENV_FILE: set it from this file for the stack you intend, and (re)create that stack's app container"
fi
