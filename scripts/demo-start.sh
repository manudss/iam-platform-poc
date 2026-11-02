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
(cd /tmp/iam-dolt && "$DOLT_BIN" sql-server -H 127.0.0.1 -P 3307 -l info > /tmp/iam-dolt/server.log 2>&1 &)
TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
# Core bus: start a local nats-server (conf/nats-local.conf) when the binary is installed; the core then connects to it.
NATS_BIN="${NATS_SERVER_BIN:-$(command -v nats-server || true)}"
CORE_NATS=""
if [ -n "$NATS_BIN" ]; then
  ("$NATS_BIN" -c conf/nats-local.conf > /tmp/iam-nats.log 2>&1 &)
  sleep 1
  CORE_NATS="1"
  echo "core bus: nats-server on 127.0.0.1:4222 (GET http://127.0.0.1:8081/v1/bus shows a live self-test)"
else
  echo "core bus: nats-server not installed, the core runs without the bus (behaviour unchanged)"
fi
(cd core && ${CORE_NATS:+IAM_CORE_NATS_URL=127.0.0.1:4222 IAM_CORE_NATS_PASSWORD=core-dev} IAM_POLICY_FILE=../policies/demo.cedar IAM_CORE_STATE_DIR=/tmp/iam-core-state IAM_CORE_ADMIN_TOKEN="$TOKEN" IAM_IDP_EXTRA_REDIRECT_URIS="$IAM_IDP_EXTRA_REDIRECT_URIS" ./target/debug/iam-core > /tmp/iam-core.log 2>&1 &)
(cd apps/api && ${CORE_NATS:+IAM_BUS_NATS_URL=127.0.0.1:4222 IAM_BUS_NATS_USER=api-host IAM_BUS_NATS_PASSWORD=api-host-dev} IAM_CORE_URL=http://127.0.0.1:8081 IAM_CORE_ADMIN_TOKEN="$TOKEN" IAM_API_ADMIN_TOKEN="$TOKEN" DOLT_HOST=127.0.0.1 DOLT_PORT=3307 DOLT_USER=root DOLT_PASSWORD= DOLT_DATABASE=iam node dist/main.js > /tmp/iam-api.log 2>&1 &)
echo "admin capability token for simulation / plugin admin (type it in the console field): $TOKEN"
echo "core: http://127.0.0.1:8081  api: http://127.0.0.1:3000  console: http://localhost:4200"
cd apps/web && npx ng serve
