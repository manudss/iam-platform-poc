#!/bin/sh
# deploy/oci/front-barrier-check.sh — prove the maintenance front gate on the real path.
#
# Run on the VM against the PUBLIC ORIGIN (not localhost). It proves that:
#   1. the app answers 200 through the front when the gate is OPEN,
#   2. the front answers 503 on NEW requests once the gate file exists,
#   3. requests on a REUSED keep-alive connection are ALSO gated,
#   4. POSTs (writes) are gated, not only GETs,
#   5. removing the gate file reopens the front (200 again).
#
# Usage: IAM_PUBLIC_ORIGIN=https://89-168-55-36.sslip.io ./front-barrier-check.sh
set -eu

ORIGIN="${IAM_PUBLIC_ORIGIN:?set IAM_PUBLIC_ORIGIN}"
BARRIER_FILE="${LYAM_FRONT_BARRIER_FILE:-/opt/lyam/MAINTENANCE}"
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

echo "== 2. gate UP =="
touch "$BARRIER_FILE"
chmod 600 "$BARRIER_FILE"
sleep 1
check "GET /healthz gated" 503 "$ORIGIN/healthz"
check "POST /healthz gated" 503 "$ORIGIN/healthz" POST

echo "== 3. reused keep-alive connection must ALSO be gated =="
# Two requests on the same TCP/TLS connection: the second must be 503 too.
OUT="$(curl -sk -o /dev/null -w '%{http_code} %{http_code}' "$ORIGIN/healthz" "$ORIGIN/healthz" || echo '000 000')"
set -- $OUT
if [ "${2:-000}" = "503" ]; then
  echo "PASS reused connection gated (second request 503)"
else
  echo "FAIL reused connection: second request got ${2:-000} instead of 503" >&2
  FAILED=1
fi

echo "== 4. concurrent writes during the gate =="
for i in 1 2 3 4 5; do
  curl -sk -o /dev/null -w '%{http_code}\n' -X POST "$ORIGIN/healthz" &
done > /tmp/front-barrier-posts.$$
wait
if grep -qv '^503$' /tmp/front-barrier-posts.$$; then
  echo "FAIL a concurrent POST did not get 503:" >&2
  cat /tmp/front-barrier-posts.$$ >&2
  FAILED=1
else
  echo "PASS 5 concurrent POSTs all gated (503)"
fi
rm -f /tmp/front-barrier-posts.$$

echo "== 5. gate DOWN =="
rm -f "$BARRIER_FILE"
sleep 1
check "GET /healthz re-opened" 200 "$ORIGIN/healthz"

if [ "$FAILED" -ne 0 ]; then
  echo "front gate NOT proven: refusing to rely on it" >&2
  exit 1
fi
echo "front gate proven end-to-end through $ORIGIN"
