#!/bin/sh
# Idempotent bootstrap / unseal of the persistent demo OpenBao companion (docs/oci-deploy.md).
#
# Full mode (first setup):
#   - initializes the backend ONLY if it has never been initialized (never re-initializes);
#   - unseals it when sealed (safe to re-run after every bao container restart);
#   - enables the KV-v2 engine at secret/ when missing;
#   - writes the scoped API policy;
#   - mints the scoped API token ONCE (reused while still valid; a new one is only minted
#     when the stored one no longer works, and the script then says loudly that the app
#     environment must be updated - the token inside a running container's env cannot be
#     synchronized automatically).
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

STATUS="$(bao_status)" || { echo "bao unreachable at $ADDR" >&2; exit 1; }
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

if [ -s "$TOKEN_FILE" ] && BAO_TOKEN="$(cat "$TOKEN_FILE")" bao token lookup >/dev/null 2>&1; then
  echo "scoped API token in $TOKEN_FILE is still valid; unchanged"
  exit 0
fi

# Scoped token with an explicit 40-day TTL: it outlives the planned demo window (teardown
# mid-December) with margin, and is destroyed with the VM. There is NO automatic renewal -
# the API does not renew leases (documented POC scope) and a periodic token without a
# renewer would still expire. If the demo outlives the token: re-run this script and restart
# the lyam container with the fresh IAM_BAO_TOKEN (docs/oci-deploy.md).
bao token create -orphan -policy=lyam-demo-connections -ttl=960h -explicit-max-ttl=960h -display-name=lyam-api -format=json \
  | sed -n 's/.*"client_token" *: *"\([^"]*\)".*/\1/p' | head -n 1 > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
[ -s "$TOKEN_FILE" ] || { echo "no scoped token was issued" >&2; exit 1; }

# The granted TTL is MEASURED, not assumed from the request: a silently shorter token would
# cut the API off its secrets mid-demo. Require at least 28 days.
LOOKUP="$(BAO_TOKEN="$(cat "$TOKEN_FILE")" bao token lookup -format=json 2>/dev/null)" \
  || { echo "the new token could not be verified" >&2; exit 1; }
TTL_GRANTED="$(echo "$LOOKUP" | sed -n 's/.*"ttl" *: *\([0-9]*\).*/\1/p' | head -n 1)"
case "$TTL_GRANTED" in ''|*[!0-9]*) echo "the granted TTL could not be measured" >&2; exit 1 ;; esac
[ "$TTL_GRANTED" -ge 2419200 ] \
  || { echo "granted TTL ${TTL_GRANTED}s is shorter than 28 days - adjust the mint parameters" >&2; exit 1; }

echo "NEW scoped API token in $TOKEN_FILE (granted TTL ${TTL_GRANTED}s measured) - set IAM_BAO_TOKEN from it in the app env file and (re)start the app container"
