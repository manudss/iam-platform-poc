#!/bin/sh
# Isolated OpenBao bootstrap over docker exec (a fresh runner has no host bao CLI).
# Initializes bao-iso ONLY if never initialized - with a FICTIVE single-key setup
# (1 share, threshold 1: the whole backend is throwaway), unseals, enables KV v2,
# writes TWO scoped policies and mints TWO tokens:
#   - app token (policy api)            -> <keys-dir>/api-token -> IAM_BAO_TOKEN
#   - qualification metadata token       -> <keys-dir>/qualification-token (baoTokenFile)
# Plus ONE persistent fictive sentinel key (below). The metadata token is separate on
# purpose: the app policy must not gain metadata
# Usage: bao-bootstrap-isolated.sh <keys-dir> <env-file> [policy-file] [metadata-policy-file]
set -eu
KEYS_DIR="${1:?keys dir}"
ENV_FILE="${2:?update.sh env file}"
HERE="$(cd "$(dirname "$0")" && pwd)"
POLICY_FILE="${3:-$HERE/bao-policy.hcl}"
META_POLICY_FILE="${4:-$HERE/bao-policy-metadata.hcl}"
CONTAINER=bao-iso

case "$KEYS_DIR" in /opt/lyam*|/var/lib/lyam*) echo "refusing production keys dir" >&2; exit 1;; esac
umask 077
mkdir -p "$KEYS_DIR"; chmod 700 "$KEYS_DIR"
KEYS="$KEYS_DIR/keys.json"; TOKEN_FILE="$KEYS_DIR/api-token"; QUAL_TOKEN_FILE="$KEYS_DIR/qualification-token"

bao_exec() { docker exec -e BAO_ADDR=http://127.0.0.1:8200 "$CONTAINER" bao "$@"; }

initialized="$(bao_exec status -format=json 2>/dev/null | jq -r '.initialized // false' || echo false)"
if [ "$initialized" != "true" ]; then
  rm -f "$KEYS" "$TOKEN_FILE" "$QUAL_TOKEN_FILE"
  bao_exec operator init -key-shares=1 -key-threshold=1 -format=json > "$KEYS"
fi
key="$(jq -r '.unseal_keys_b64[0]' "$KEYS")"
root="$(jq -r '.root_token' "$KEYS")"
[ "$key" != "null" ] && [ "$root" != "null" ] || { echo "keys.json unreadable" >&2; exit 1; }
sealed="$(bao_exec status -format=json | jq -r '.sealed')"
[ "$sealed" = "true" ] && bao_exec operator unseal "$key" >/dev/null
i=0
while [ $i -lt 6 ]; do
  [ "$(bao_exec status -format=json | jq -r '.sealed')" = "false" ] && break
  sleep 5; i=$((i + 1))
done
[ "$(bao_exec status -format=json | jq -r '.sealed')" = "false" ] || { echo "bao-iso stayed sealed" >&2; exit 1; }

authed() { docker exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN="$root" "$CONTAINER" bao "$@"; }
authed secrets enable -path=secret kv-v2 2>/dev/null || true
docker cp "$POLICY_FILE" "$CONTAINER:/tmp/bao-policy.hcl"
docker cp "$META_POLICY_FILE" "$CONTAINER:/tmp/bao-policy-metadata.hcl"
authed policy write api /tmp/bao-policy.hcl >/dev/null
authed policy write qualification-metadata /tmp/bao-policy-metadata.hcl >/dev/null
if [ ! -s "$TOKEN_FILE" ]; then
  authed token create -policy=api -format=json | jq -r '.auth.client_token' > "$TOKEN_FILE"
fi
# access. Fictive isolated stack only: refuses production paths. Never prints a secret.
if [ ! -s "$QUAL_TOKEN_FILE" ]; then
  authed token create -policy=qualification-metadata -format=json | jq -r '.auth.client_token' > "$QUAL_TOKEN_FILE"
fi
# Qualification inventory sentinel. The covered metadata root (secret/metadata/iam) must
# never be EMPTY in the isolated stack: LIST on an empty path answers 404 by design
# (openbao/openbao#213), which fails the qualification capture UNKNOWN (stage=BAO_WALK).
# The production stack has real entries; the isolated stack writes nothing under iam/
# (app policy: workflow-connections/plugins rw, iam/pg read-only), so this ONE persistent
# FICTIVE key keeps the isolated inventory non-empty by construction. Written once with
# the bootstrap ROOT token. The app token has no grant on it.
# Absence check: ONLY an authoritative HTTP 404 from the exact metadata endpoint
# authorizes the create. Any other status, a transport failure or an unexpected schema
# stops WITHOUT writing: a blind create could bump current_version of an existing key
# and break the before/after metadata hash comparison.
SENT_BODY="$KEYS_DIR/.sentinel-check.$$"
if ! SENT_CODE="$(curl -sS -o "$SENT_BODY" -w '%{http_code}' -H "X-Vault-Token: $root" "http://127.0.0.1:8200/v1/secret/metadata/iam/qualification-sentinel")"; then
  rm -f "$SENT_BODY"; echo "sentinel metadata check unreachable; refusing any write" >&2; exit 1
fi
case "$SENT_CODE" in
  404)
    rm -f "$SENT_BODY"
    authed kv put secret/iam/qualification-sentinel purpose="isolated-qualification-inventory-sentinel" note="fictive-constant-no-secret-material" >/dev/null ;;
  200)
    # Exactly ONE JSON document with a valid metadata schema: jq without -s accepts an
    # empty body (exit 0, no output) and multi-document bodies document by document.
    if ! jq -s -e 'length == 1 and (.[0].data.current_version | type == "number" and . >= 1 and . == floor)' "$SENT_BODY" >/dev/null; then
      rm -f "$SENT_BODY"; echo "sentinel metadata schema unexpected; refusing any write" >&2; exit 1
    fi
    rm -f "$SENT_BODY" ;;
  *)
    rm -f "$SENT_BODY"; echo "sentinel metadata check status $SENT_CODE not authoritative; refusing any write" >&2; exit 1 ;;
esac
token="$(cat "$TOKEN_FILE")"
# Atomic env sync (same contract as companions/bao-bootstrap.sh).
tmp="$ENV_FILE.tmp.$$"
sed "s/^IAM_BAO_TOKEN=.*/IAM_BAO_TOKEN=$token/" "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
echo "bao-iso bootstrapped (1/1 fictive keys; app + qualification-metadata tokens in $KEYS_DIR)"
