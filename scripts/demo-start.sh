#!/usr/bin/env bash
# Start the full local demo (Dolt + core + API + console) on loopback. Ctrl-C stops the foreground console.
# In a Codespace, share port 4200 (Ports tab -> visibility Public) to give the demo a public URL.
set -uo pipefail
cd "$(dirname "$0")/.."
export DOLT_BIN="$(command -v dolt || echo "$HOME/.local/bin/dolt")"
(cd /tmp/iam-dolt && "$DOLT_BIN" sql-server -H 127.0.0.1 -P 3307 -l info > /tmp/iam-dolt/server.log 2>&1 &)
TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
(cd core && IAM_POLICY_FILE=../policies/demo.cedar IAM_CORE_STATE_DIR=/tmp/iam-core-state IAM_CORE_ADMIN_TOKEN="$TOKEN" ./target/debug/iam-core > /tmp/iam-core.log 2>&1 &)
(cd apps/api && IAM_CORE_URL=http://127.0.0.1:8081 IAM_CORE_ADMIN_TOKEN="$TOKEN" DOLT_HOST=127.0.0.1 DOLT_PORT=3307 DOLT_USER=root DOLT_PASSWORD= DOLT_DATABASE=iam node dist/main.js > /tmp/iam-api.log 2>&1 &)
echo "core: http://127.0.0.1:8081  api: http://127.0.0.1:3000  console: http://localhost:4200"
cd apps/web && npx ng serve
