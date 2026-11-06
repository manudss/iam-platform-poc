#!/usr/bin/env bash
# Start the full local demo (Dolt + core + API + console) on loopback. Ctrl-C stops the foreground console.
# In a Codespace, share port 4200 (Ports tab -> visibility Public) to give the demo a public URL.
set -uo pipefail
cd "$(dirname "$0")/.."
export DOLT_BIN="$(command -v dolt || echo "$HOME/.local/bin/dolt")"
# Public origin of the console: the Codespaces forwarded URL for port 4200 when in a Codespace,
# else loopback. The IdP refuses unregistered redirect URIs, so register this origin's /callback.
if [ -n "${CODESPACE_NAME:-}" ] && [ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
  PUBLIC_ORIGIN="https://${CODESPACE_NAME}-4200.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
else
  PUBLIC_ORIGIN="http://localhost:4200"
fi
export IAM_IDP_EXTRA_REDIRECT_URIS="${IAM_IDP_EXTRA_REDIRECT_URIS:-${PUBLIC_ORIGIN}/callback}"
echo "console public origin: $PUBLIC_ORIGIN (share port 4200 to make it reachable)"
TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
# NATS is a required base process. Supervise it and the core, never switch to local handlers.
NATS_BIN="${NATS_SERVER_BIN:-$(command -v nats-server || true)}"
if [ -z "$NATS_BIN" ]; then echo "nats-server is required; install it before starting the demo" >&2; exit 1; fi
pids=()
cleanup() { trap - EXIT INT TERM; for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; wait; }
trap cleanup EXIT INT TERM
(cd /tmp/iam-dolt && exec "$DOLT_BIN" sql-server -H 127.0.0.1 -P 3307 -l info > /tmp/iam-dolt/server.log 2>&1) & pids+=("$!")
supervise() {
  trap 'kill "${child:-}" 2>/dev/null || true; exit' TERM INT
  while true; do "$@" & child=$!; wait "$child" || true; sleep 2; done
}
supervise "$NATS_BIN" -c conf/nats-local.conf > /tmp/iam-nats.log 2>&1 & pids+=("$!")
for i in {1..50}; do (echo > /dev/tcp/127.0.0.1/4222) >/dev/null 2>&1 && break; sleep .2; done
supervise env IAM_CORE_NATS_URL=127.0.0.1:4222 IAM_CORE_NATS_PASSWORD=core-dev IAM_POLICY_FILE=policies/demo.cedar IAM_CORE_STATE_DIR=/tmp/iam-core-state IAM_CORE_ADMIN_TOKEN="$TOKEN" IAM_IDP_EXTRA_REDIRECT_URIS="$IAM_IDP_EXTRA_REDIRECT_URIS" core/target/debug/iam-core > /tmp/iam-core.log 2>&1 & pids+=("$!")
for i in {1..100}; do curl -fsS http://127.0.0.1:8081/health >/dev/null 2>&1 && break; sleep .2; done
(cd apps/api && exec env IAM_BUS_NATS_URL=127.0.0.1:4222 IAM_BUS_NATS_USER=api-host IAM_BUS_NATS_PASSWORD=api-host-dev IAM_CORE_URL=http://127.0.0.1:8081 IAM_CORE_ADMIN_TOKEN="$TOKEN" IAM_API_ADMIN_TOKEN="$TOKEN" DOLT_HOST=127.0.0.1 DOLT_PORT=3307 DOLT_USER=root DOLT_PASSWORD= DOLT_DATABASE=iam node dist/main.js > /tmp/iam-api.log 2>&1) & pids+=("$!")
echo "admin capability token for simulation / plugin admin (type it in the console field): $TOKEN"
echo "core: http://127.0.0.1:8081  api: http://127.0.0.1:3000  console: http://localhost:4200"
cd apps/web && npx ng serve
