#!/bin/bash
# deploy/oci/front-barrier-check.sh — prove the maintenance front gate on the real path,
# with EXPLICITLY SYNCHRONIZED steps (no sleep-based racing: every request is provably sent
# before/after the marker changes).
#
# Run on the VM against a THROWAWAY Caddy front (never the main one) watching the same
# marker directory. It proves that:
#   1. the app answers 200 through the front when the gate is OPEN (GET and POST),
#   2. a connection opened BEFORE the gate gets 503 on its NEXT request on the SAME
#      connection - synchronized: response 1 is fully read BEFORE the marker is created,
#      request 2 is provably sent after; the same connection then returns to 200 once the
#      marker is removed,
#   3. NEW requests while gated get 503 (GET and POST),
#   4. a concurrent burst across the gate transition only ever sees 503 (gate up) or 200
#      (gate down), never a half-gated code - synchronized: workers start only after the
#      gate is confirmed up, the marker is removed only after 6 results are recorded,
#   5. the front re-opens (200) after removal.
#
# Coverage limits (named, not hidden):
#   - a request already ROUTED when the gate appears completes normally; the updater stops
#     the container before any data change, draining in-flight work;
#   - WebSocket/upgraded connections and HTTP/2 stream reuse rely on Caddy's per-request
#     routing plus the container stop, and are NOT exercised here;
#   - run against a loopback test front, this does not cover the external HTTPS/IPv6 path;
#     run it against the real TLS origin (still on a throwaway site) to include TLS.
#
# Usage: IAM_PUBLIC_ORIGIN=https://127.0.0.1:9443 ./front-barrier-check.sh
set -euo pipefail

ORIGIN="${IAM_PUBLIC_ORIGIN:?set IAM_PUBLIC_ORIGIN}"
BARRIER_FILE="${LYAM_FRONT_BARRIER_FILE:-/var/lib/lyam-front-gate/MAINTENANCE}"
FAILED=0
WORK="$(mktemp -d)"
cleanup() { [ -n "${SSL_PID:-}" ] && kill "$SSL_PID" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

note() { echo "$1"; }
fail() { echo "FAIL $1" >&2; FAILED=1; }

check() { # description expected_code url [method]
  desc="$1"; want="$2"; url="$3"; method="${4:-GET}"
  # curl already prints 000 via -w on a failed connection: status and code stay separate.
  got="$(curl -sk -o /dev/null -w '%{http_code}' -X "$method" "$url" 2>/dev/null)" || true
  [ -n "$got" ] || got=000
  if [ "$got" = "$want" ]; then note "PASS $desc ($method $want)"; else fail "$desc ($method wanted $want, got $got)"; fi
}

gate_up()   { echo "drill-$$" > "$BARRIER_FILE"; chmod 644 "$BARRIER_FILE"; }
gate_down() { rm -f "$BARRIER_FILE"; }

# --- synchronized single-connection driver ------------------------------------------------
# HEAD carries no body: the response ends at the blank line, so reads never desynchronize.
HOSTPORT="${ORIGIN#*://}"; HOSTPORT="${HOSTPORT%%/*}"
HOST="${HOSTPORT%%:*}"; PORT="${HOSTPORT#*:}"; [ "$PORT" = "$HOSTPORT" ] && { case "$ORIGIN" in https:*) PORT=443 ;; *) PORT=80 ;; esac; }

SSL_PID=""
open_conn() {
  case "$ORIGIN" in
    https://*)
      mkfifo "$WORK/in" "$WORK/out"
      openssl s_client -quiet -connect "$HOST:$PORT" -servername "$HOST" < "$WORK/in" > "$WORK/out" 2>/dev/null &
      SSL_PID=$!
      exec 9>"$WORK/in" 8<"$WORK/out" ;;
    http://*)
      exec 9<>"/dev/tcp/$HOST/$PORT" 8<&9 ;;
    *) echo "unsupported origin scheme: $ORIGIN" >&2; exit 1 ;;
  esac
}
close_conn() { exec 9>&- 8<&- || true; [ -n "$SSL_PID" ] && { kill "$SSL_PID" 2>/dev/null || true; SSL_PID=""; }; }

http_head() { # prints the status code of one HEAD /healthz on the open connection
  printf 'HEAD /healthz HTTP/1.1\r\nHost: %s\r\n\r\n' "$HOST" >&9
  local line code
  IFS=' ' read -r _ code _ <&8
  while IFS= read -r line <&8; do [ "$line" = $'\r' ] && break; done
  echo "${code%$'\r'}"
}

note "== 1. baseline: gate OPEN =="
[ -e "$BARRIER_FILE" ] && { echo "FAIL: $BARRIER_FILE already exists before the check" >&2; exit 1; }
check "GET /healthz through the front" 200 "$ORIGIN/healthz"
check "POST /healthz through the front" 200 "$ORIGIN/healthz" POST

note "== 2. SYNCHRONIZED: one connection, 200 -> gate up -> 503 -> gate down -> 200 =="
open_conn
C1="$(http_head)"                       # response fully read BEFORE the marker exists
gate_up                                 # the gate appears now, and only now
C2="$(http_head)"                       # SAME pre-existing connection, provably after the gate
gate_down
C3="$(http_head)"                       # SAME connection, back to open
close_conn
[ "$C1" = 200 ] && [ "$C2" = 503 ] && [ "$C3" = 200 ] \
  && note "PASS pre-existing connection: 200 before, 503 across the gate, 200 after (single synchronized connection)" \
  || fail "pre-existing connection: got $C1/$C2/$C3, wanted 200/503/200"

note "== 3. gate UP: new GET and POST =="
gate_up
check "GET /healthz gated" 503 "$ORIGIN/healthz"
check "POST /healthz gated" 503 "$ORIGIN/healthz" POST

note "== 4. SYNCHRONIZED concurrent transition + distinct post-lift wave =="
RES="$WORK/results"; : > "$RES"; GO="$WORK/go"
for i in $(seq 1 12); do
  ( while [ ! -f "$GO" ]; do sleep 0.01; done
    curl -sk -o /dev/null -w '%{http_code}\n' "$ORIGIN/healthz" >> "$RES" ) &
done
touch "$GO"                              # workers start only now, gate provably up
n=0; while [ "$(wc -l < "$RES")" -lt 6 ]; do sleep 0.05; n=$((n+1)); [ "$n" -lt 200 ] && continue; break; done
gate_down                                # lifted only after 6 requests already answered under the gate
wait
EARLY="$(head -n 6 "$RES" | sort -u)"
if grep -qEv '^(200|503)$' "$RES"; then
  fail "a request during the transition got an unexpected code: $(sort -u "$RES" | tr '\n' ' ')"
elif [ "$EARLY" != "503" ]; then
  fail "the first 6 synchronized results were not all 503 (gate was up): $(echo "$EARLY" | tr '\n' ' ')"
else
  note "PASS 12 synchronized requests across the transition: 503 while gated, only 200/503, no half-gated state"
fi
# Distinct wave AFTER the lift: proves the 200 (the transition wave may legitimately have
# finished entirely under the gate).
RES2="$WORK/results2"; : > "$RES2"
for i in $(seq 1 6); do
  curl -sk -o /dev/null -w '%{http_code}\n' "$ORIGIN/healthz" >> "$RES2" &
done
wait
if [ "$(sort -u "$RES2")" = "200" ]; then
  note "PASS post-lift wave: 6/6 requests 200 after the gate came down"
else
  fail "post-lift wave: wanted all 200, got $(sort -u "$RES2" | tr '\n' ' ')"
fi

note "== 5. gate DOWN =="
check "GET /healthz re-opened" 200 "$ORIGIN/healthz"

if [ "$FAILED" -ne 0 ]; then
  echo "front gate NOT proven: refusing to rely on it" >&2
  exit 1
fi
note "front gate proven end-to-end through $ORIGIN"
note "covered: new GET/POST, a PRE-EXISTING reused connection (synchronized), a synchronized concurrent transition"
note "NOT covered by design: in-flight requests at gate time (drained by the container stop), WebSocket/upgraded connections, HTTP/2 stream reuse; loopback runs do not cover the external TLS/IPv6 path"
