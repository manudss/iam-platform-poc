#!/bin/sh
# Hosted-demo start: one container, fictional data only. Re-seeds from scratch whenever the data
# directory is empty (free hosts wipe the filesystem on restart/spin-down: a fresh demo each time).
set -e
HOME_DIR="${IAM_DEMO_HOME:-/data}"
PUBLIC_ORIGIN="${IAM_PUBLIC_ORIGIN:-http://localhost:${PORT:-8080}}"
mkdir -p "$HOME_DIR/dolt" "$HOME_DIR/core-state"

echo '[demo] dolt init + seed (fictional data)'
cd "$HOME_DIR/dolt"
dolt config --global --add user.name poc 2>/dev/null || true
dolt config --global --add user.email poc@example.invalid 2>/dev/null || true
[ -d .dolt ] || dolt init --fun >/dev/null
if ! dolt sql -q "select count(*) from iam.assignments" >/dev/null 2>&1; then
  dolt sql < /app/data/demo/01-schema.sql
fi
echo '[demo] starting dolt sql-server on 127.0.0.1:3307'
GOMEMLIMIT="${DOLT_GOMEMLIMIT:-250MiB}" dolt sql-server -H 127.0.0.1 -P 3307 -l info >"$HOME_DIR/dolt.log" 2>&1 &

# Per-boot random admin tokens (never committed, never reused across restarts).
CORE_TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export IAM_CORE_ADMIN_TOKEN="$CORE_TOKEN"
# Admin capability token for the API (simulation / plugin admin): random per boot, server-side only;
# demo/server.mjs attaches it to proxied /api calls so demo visitors never see or type it.
API_TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export IAM_API_ADMIN_TOKEN="$API_TOKEN"
# The edge attaches the capability to every call, so the API also requires the verified subject to be a demo administrator.
# Anyone else (including accounts created through public sign-up) is refused on admin routes.
export IAM_API_ADMIN_SUBJECTS="${IAM_API_ADMIN_SUBJECTS:-demo-alice}"
export IAM_POLICY_FILE=/app/policies/demo.cedar
export IAM_CORE_STATE_DIR="$HOME_DIR/core-state"
export IAM_IDP_EXTRA_REDIRECT_URIS="${PUBLIC_ORIGIN}/callback,http://localhost:4200/callback"
export IAM_ISSUER="${PUBLIC_ORIGIN}/core"
GATE_TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export IAM_AUTH_GATE_TOKEN="$GATE_TOKEN" IAM_AUTH_GATE_ADDR=127.0.0.1:3000
export IAM_WORKSPACE_MODE=1
export IAM_AUTHN_DEMO_SEED=1
export IAM_DIRECTORY_AUTH=1 IAM_PLUGIN_STORE=dolt IAM_CREDENTIAL_FILE="$HOME_DIR/core-state/credentials.json"
echo '[demo] starting iam-core on 127.0.0.1:8081'
/app/iam-core >"$HOME_DIR/core.log" 2>&1 &

export IAM_CORE_URL="http://127.0.0.1:8081"
export DOLT_HOST=127.0.0.1 DOLT_PORT=3307 DOLT_USER=root DOLT_PASSWORD='' DOLT_DATABASE=iam
export API_PORT=3000
echo '[demo] starting NestJS API on 127.0.0.1:3000 (activation journal in memory: IAM_PG_URL unset on purpose)'
(cd /app/api && node --max-old-space-size="${API_MAX_OLD_SPACE:-192}" dist/main.js) >"$HOME_DIR/api.log" 2>&1 &

# Wait for the API (its Dolt connection needs the server above), then serve the console.
for i in $(seq 1 60); do
  if node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then break; fi
  sleep 2
done
echo '[demo] starting edge server on 0.0.0.0:'"${PORT:-8080}"'(public origin '"$PUBLIC_ORIGIN"')'
exec node /app/demo/server.mjs
