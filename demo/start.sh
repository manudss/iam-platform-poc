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
# Every public origin the console is reachable on needs its /callback registered (the IdP exact-matches).
# demo/public-redirect-uris.mjs adds the Render *.onrender.com URL (RENDER_EXTERNAL_URL) and any
# IAM_PUBLIC_ORIGIN_EXTRA origins on top of the canonical one.
export IAM_IDP_EXTRA_REDIRECT_URIS="$(PUBLIC_ORIGIN="$PUBLIC_ORIGIN" node /app/demo/public-redirect-uris.mjs)"
export IAM_ISSUER="${PUBLIC_ORIGIN}/core"
# SSO (oidc-provider plugin): applications reach the API through the edge under /api
export IAM_SSO_BASE_URL="${PUBLIC_ORIGIN}/api"
GATE_TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export IAM_AUTH_GATE_TOKEN="$GATE_TOKEN" IAM_AUTH_GATE_ADDR=127.0.0.1:3000
export IAM_WORKSPACE_MODE=1
export IAM_AUTHN_DEMO_SEED=1 IAM_DEMO_DATA_SEED=1
export IAM_DIRECTORY_AUTH=1 IAM_PLUGIN_STORE=dolt IAM_CREDENTIAL_FILE="$HOME_DIR/core-state/credentials.json"
# Required event bus: loopback only, random per-boot passwords, supervised restart.
command -v nats-server >/dev/null 2>&1 || { echo '[demo] nats-server is required' >&2; exit 1; }
supervise() { while true; do "$@" || true; echo '[demo] process exited; restarting in 2s' >&2; sleep 2; done; }
{
  NATS_PASS="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  NATS_API_PASS="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  # Conf of this boot: random password for the core user, demo subscriber users removed, JetStream store inside the demo home.
  sed -e "s/password: core-dev/password: $NATS_PASS/" -e "s/password: api-host-dev/password: $NATS_API_PASS/" -e '/user: sub-/d' -e "s#/tmp/iam-nats-js#$HOME_DIR/nats-js#" /app/conf/nats-local.conf > "$HOME_DIR/nats.conf"
  chmod 600 "$HOME_DIR/nats.conf"
  echo '[demo] starting nats-server on 127.0.0.1:4222 (core bus)'
  supervise nats-server -c "$HOME_DIR/nats.conf" >"$HOME_DIR/nats.log" 2>&1 &
  for i in $(seq 1 30); do node -e "require('net').connect(4222,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null && break; sleep 1; done
  export IAM_CORE_NATS_URL=127.0.0.1:4222 IAM_CORE_NATS_PASSWORD="$NATS_PASS"
  # Step 2: the API serves its plugins over the bus (same nats-server, its own restricted user).
  export IAM_BUS_NATS_URL=127.0.0.1:4222 IAM_BUS_NATS_USER=api-host IAM_BUS_NATS_PASSWORD="$NATS_API_PASS"
}
echo '[demo] starting iam-core on 127.0.0.1:8081'
supervise /app/iam-core >"$HOME_DIR/core.log" 2>&1 &

export IAM_CORE_URL="http://127.0.0.1:8081"
export DOLT_HOST=127.0.0.1 DOLT_PORT=3307 DOLT_USER=root DOLT_PASSWORD='' DOLT_DATABASE=iam
export API_PORT=3000
echo '[demo] starting NestJS API on 127.0.0.1:3000 (activation journal in memory: IAM_PG_URL unset on purpose)'
(cd /app/api && node --max-old-space-size="${API_MAX_OLD_SPACE:-192}" dist/main.js) >"$HOME_DIR/api.log" 2>&1 &

# Wait for the API (its Dolt connection needs the server above), then serve the console.
# A dead API must stop the container loudly (its log goes to a file, not stdout): serving the console
# behind a 502-ing /api is worse than no container at all.
api_up=0
for i in $(seq 1 60); do
  if node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then api_up=1; break; fi
  sleep 2
done
if [ "$api_up" != 1 ]; then echo '[demo] FATAL: NestJS API never came up on :3000 - api.log tail follows'; tail -100 "$HOME_DIR/api.log"; exit 1; fi
# Angular SSR server (login page rendered with the methods list in the first HTML): loopback only, behind the
# edge. Its server-side API calls go through the edge (same public paths as the browser).
# Warm the public sign-in options cache (first real call pays a cold Dolt, ~30 s on the free tier): the first
# /login SSR render must find it warm, or it would render the error state.
echo '[demo] warming the sign-in options cache'
node -e "fetch('http://127.0.0.1:3000/api/tenants/acme-demo/signin/options', { headers: { 'x-api-admin-token': process.env.IAM_API_ADMIN_TOKEN ?? '' }, signal: AbortSignal.timeout(60000) }).then(r => { console.log('[demo] options warm-up:', r.status); process.exit(0); }).catch(e => { console.log('[demo] options warm-up failed (the first visit will pay it):', e.message); process.exit(0); })"
echo '[demo] starting Angular SSR server on 127.0.0.1:4000'
IAM_WEB_API_ORIGIN="http://127.0.0.1:${PORT:-8080}" PORT=4000 supervise node /app/web/dist/web/server/server.mjs >"$HOME_DIR/ssr.log" 2>&1 &
ssr_up=0
for i in $(seq 1 30); do
  if node -e "fetch('http://127.0.0.1:4000/login').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then ssr_up=1; break; fi
  sleep 1
done
if [ "$ssr_up" != 1 ]; then echo '[demo] FATAL: SSR server never came up on :4000 - ssr.log tail follows'; tail -100 "$HOME_DIR/ssr.log"; exit 1; fi
echo '[demo] starting edge server on 0.0.0.0:'"${PORT:-8080}"'(public origin '"$PUBLIC_ORIGIN"')'
exec node /app/demo/server.mjs
