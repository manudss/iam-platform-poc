#!/bin/sh
# LYAM_BAO_UNSEAL_CMD for the isolated stack: unseal bao-iso from the isolated keys dir
# and wait ready. Never initializes, never touches policy or tokens.
# Usage: bao-unseal-isolated.sh <keys-dir>
set -eu
KEYS_DIR="${1:?keys dir}"
case "$KEYS_DIR" in /opt/lyam*|/var/lib/lyam*) echo "refusing production keys dir" >&2; exit 1;; esac
key="$(jq -r '.unseal_keys_b64[0]' "$KEYS_DIR/keys.json")"
sealed="$(docker exec -e BAO_ADDR=http://127.0.0.1:8200 bao-iso bao status -format=json | jq -r '.sealed')"
[ "$sealed" = "true" ] && docker exec -e BAO_ADDR=http://127.0.0.1:8200 bao-iso bao operator unseal "$key" >/dev/null
for i in 1 2 3 4 5 6; do
  [ "$(docker exec -e BAO_ADDR=http://127.0.0.1:8200 bao-iso bao status -format=json | jq -r '.sealed')" = "false" ] && exit 0
  sleep 5
done
echo "bao-iso stayed sealed" >&2; exit 1
