#!/bin/sh
# Idempotent bootstrap of the persistent demo OpenBao companion (docs/oci-deploy.md).
#   - initializes the backend ONLY if it has never been initialized (never re-initializes);
#   - unseals it when sealed (safe to re-run after every bao container restart);
#   - writes the scoped API policy and mints a fresh periodic scoped token for the Lyam API.
# Never prints a secret: unseal key + root token live in <keys-dir>/keys.json (root 0600), the
# scoped API token in <keys-dir>/api-token (root 0600). Output is status words only.
#
# Usage: bao-bootstrap.sh [bao-addr] [keys-dir] [policy-file]
#   bao-addr    default http://127.0.0.1:8200 (the host loopback publication of the bao service)
#   keys-dir    default /opt/lyam/bao-keys (must be root-owned; created 0700)
#   policy-file default bao-policy.hcl next to this script
#
# Needs the bao CLI on the host (or run inside the bao container with docker exec and
# BAO_ADDR=http://127.0.0.1:8200, keys-dir on a mounted path).
set -eu

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

json_field() { sed -n "s/.*\"$2\" *: *\"\([^\"]*\)\".*/\1/p" "$1" | head -n 1; }

STATUS="$(bao status -format=json 2>/dev/null || echo '{}')"
INITIALIZED="$(echo "$STATUS" | sed -n 's/.*"initialized" *: *\([a-z]*\).*/\1/p' | head -n 1)"
SEALED="$(echo "$STATUS" | sed -n 's/.*"sealed" *: *\([a-z]*\).*/\1/p' | head -n 1)"

if [ "$INITIALIZED" != "true" ]; then
  if [ -s "$KEYS" ]; then
    echo "refused: the backend reports not-initialized but $KEYS already holds keys - investigate before any init" >&2
    exit 1
  fi
  bao operator init -key-shares=1 -key-threshold=1 -format=json > "$KEYS"
  chmod 600 "$KEYS"
  STATUS="$(bao status -format=json)"
  SEALED="$(echo "$STATUS" | sed -n 's/.*"sealed" *: *\([a-z]*\).*/\1/p' | head -n 1)"
fi

UNSEAL_KEY="$(json_field "$KEYS" unseal_keys_b64)"
ROOT_TOKEN="$(json_field "$KEYS" root_token)"
[ -n "$UNSEAL_KEY" ] && [ -n "$ROOT_TOKEN" ] || { echo "could not read the unseal key / root token from $KEYS" >&2; exit 1; }

if [ "$SEALED" = "true" ]; then
  bao operator unseal "$UNSEAL_KEY" >/dev/null
fi

export BAO_TOKEN="$ROOT_TOKEN"
bao policy write lyam-demo-connections "$POLICY_FILE" >/dev/null

# Periodic (30 days) scoped token: renewable by its period, so the API never silently loses its
# secrets the way the old 24h demo token did. Written to a root-only file, never printed.
bao token create -orphan -policy=lyam-demo-connections -period=720h -display-name=lyam-api -format=json \
  | sed -n 's/.*"client_token" *: *"\([^"]*\)".*/\1/p' | head -n 1 > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
[ -s "$TOKEN_FILE" ] || { echo "no scoped token was issued" >&2; exit 1; }

echo "bao ok: unsealed, policy lyam-demo-connections written, scoped API token refreshed in $TOKEN_FILE"
