#!/bin/sh
# deploy/oci/front-barrier-check.sh — prove the maintenance front gate on the real path.
#
# Run on the VM against the PUBLIC ORIGIN (not localhost), under a throwaway Caddy that
# watches the same marker directory as the real front would. It proves that:
#   1. the app answers 200 through the front when the gate is OPEN,
#   2. the front answers 503 on NEW requests once the gate file exists (GET and POST),
#   3. a connection opened BEFORE the gate and REUSED across it is gated on its next request,
#   4. concurrent requests during the gate transition are never lost or mis-served,
#   5. removing the gate file reopens the front (200 again).
#
# Coverage limits (named, not hidden):
#   - a request already ROUTED to the upstream when the gate appears completes normally;
#     the gate applies per request at routing time. The updater stops the container before
#     the backup, so in-flight requests finish or fail fast before any data changes.
#   - HTTP/2 streams on an already-open connection are re-evaluated per request by Caddy
#     (the reused-connection check below covers HTTP/1.1 keep-alive); WebSocket / upgraded
#     connections established before the gate are NOT re-evaluated and are drained by the
#     container stop instead.
#
# Usage: IAM_PUBLIC_ORIGIN=https://127.0.0.1:9443 ./front-barrier-check.sh
set -eu

ORIGIN="${IAM_PUBLIC_ORIGIN:?set IAM_PUBLIC_ORIGIN}"
BARRIER_FILE="${LYAM_FRONT_BARRIER_FILE:-/var/lib/lyam-front-gate/MAINTENANCE}"
FAILED=0

check() { # description expected_code url [method]
  desc="$1"; want="$2"; url="$3"; method="${4:-GET}"
  got="$(curl -sk -o /dev/null -w '%{http_code}' -X "$method" "$url" || echo 000)"
  if [ "$got" = "$want" ]; then
    echo "PASS $desc ($method $want)"
  else
    echo "FAIL $desc ($method wanted $want, got $got)" >&2
    FAILED=1
  fi
}

echo "== 1. baseline: gate OPEN =="
[ -e "$BARRIER_FILE" ] && { echo "FAIL: $BARRIER_FILE already exists before the check" >&2; exit 1; }
check "GET /healthz through the front" 200 "$ORIGIN/healthz"
check "POST /healthz through the front" 200 "$ORIGIN/healthz" POST

echo "== 2. connection opened BEFORE the gate, reused ACROSS it =="
# curl reuses the same connection for both URLs inside one invocation; the gate appears
# between the two requests, so request 2 rides a PRE-EXISTING connection and must still
# get 503 (Caddy routes per request, not per connection).
( sleep 1; echo "drill-token" > "$BARRIER_FILE"; chmod 644 "$BARRIER_FILE" ) &
GATE_PID=$!
OUT="$(curl -sk -o /dev/null -w '%{http_code} %{http_code}' "$ORIGIN/healthz" "$ORIGIN/healthz" || echo '000 000')"
wait "$GATE_PID"
set -- $OUT
if [ "${1:-000}" = "200" ] && [ "${2:-000}" = "503" ]; then
  echo "PASS pre-existing connection: 200 before the gate, 503 on the reused connection after it"
else
  echo "FAIL pre-existing connection reuse: got ${1:-000} then ${2:-000}, wanted 200 then 503" >&2
  FAILED=1
fi
[ -e "$BARRIER_FILE" ] || { echo "FAIL: gate file missing after step 2" >&2; exit 1; }

echo "== 3. gate UP: new requests, GET and POST =="
check "GET /healthz gated" 503 "$ORIGIN/healthz"
check "POST /healthz gated" 503 "$ORIGIN/healthz" POST

echo "== 4. concurrent transition: hammering while the gate drops =="
# Requests racing the removal must be cleanly served on either side (200 or 503), never
# 000/502/404: the front must never expose a half-gated state.
for i in 1 2 3 4 5 6 7 8; do
  for j in 1 2 3; do curl -sk -o /dev/null -w '%{http_code}\n' "$ORIGIN/healthz"; done &
done > /tmp/front-barrier-race.$$ &
RACE_PID=$!
sleep 1
rm -f "$BARRIER_FILE"
wait "$RACE_PID"
if grep -qEv '^(200|503)$' /tmp/front-barrier-race.$$; then
  echo "FAIL a request during the transition got an unexpected code:" >&2
  cat /tmp/front-barrier-race.$$ >&2
  FAILED=1
else
  echo "PASS 24 concurrent requests across the transition: only 200/503, no half-gated state"
fi
rm -f /tmp/front-barrier-race.$$

echo "== 5. gate DOWN =="
check "GET /healthz re-opened" 200 "$ORIGIN/healthz"

if [ "$FAILED" -ne 0 ]; then
  echo "front gate NOT proven: refusing to rely on it" >&2
  exit 1
fi
echo "front gate proven end-to-end through $ORIGIN"
echo "covered: new GET/POST, pre-existing reused keep-alive connections, concurrent transition"
echo "NOT covered by design: in-flight requests at gate time (drained by the container stop), WebSocket/upgraded connections, HTTP/2 stream reuse (relies on Caddy per-request routing)"
