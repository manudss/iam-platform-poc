#!/bin/sh
# Real OpenBao qualification of deploy/oci/companions/bao-bootstrap.sh (local, isolated).
set -u
S="$(CDPATH= cd -- "$(dirname "$0")" && pwd)/bao-bootstrap.sh"
BASE="$(mktemp -d)"
ADDR=http://127.0.0.1:18200
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "ok - $1"; }
bad()  { FAIL=$((FAIL+1)); echo "NOT OK - $1"; }
check(){ if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (values differ; hidden)"; fi }

rm -rf "$BASE"; mkdir -p "$BASE/storage" "$BASE/keys"
cat > "$BASE/bao.hcl" <<EOF
storage "pebbledb" {
  path = "$BASE/storage"
}
listener "tcp" {
  address = "127.0.0.1:18200"
  tls_disable = true
}
EOF

start_bao() { bao server -config="$BASE/bao.hcl" > "$BASE/server.log" 2>&1 & echo $! > "$BASE/pid"; }
stop_bao()  { kill "$(cat "$BASE/pid")" 2>/dev/null; wait "$(cat "$BASE/pid")" 2>/dev/null || true; sleep 1; }
wait_api()  { n=0; while ! BAO_ADDR=$ADDR bao status >/dev/null 2>&1 && ! BAO_ADDR=$ADDR bao status 2>/dev/null | grep -q .; do n=$((n+1)); [ $n -lt 50 ] || return 1; sleep 0.2; done; }

echo "== scenario 1: first install (fresh backend) =="
start_bao; wait_api || { bad "bao server starts"; exit 1; }
OUT="$(sh "$S" "$ADDR" "$BASE/keys" 2>&1)"; RC=$?
check $RC 0 "first install exits 0"
[ -s "$BASE/keys/keys.json" ] && [ "$(stat -c %a "$BASE/keys/keys.json")" = 600 ] && ok "keys.json written 0600" || bad "keys.json written 0600"
[ -s "$BASE/keys/api-token" ] && ok "scoped token minted" || bad "scoped token minted"
case "$OUT" in *"NEW scoped API token"*) ok "output announces the new token (env update needed)" ;; *) bad "output announces the new token" ;; esac
TOKEN="$(cat "$BASE/keys/api-token")"
BAO_ADDR=$ADDR BAO_TOKEN="$TOKEN" bao kv put secret/iam/plugins/test-plugin v=hello >/dev/null 2>&1 \
  && ok "scoped token can write iam/plugins/* (KV-v2 engine enabled)" || bad "scoped token can write iam/plugins/*"
GOT="$(BAO_ADDR=$ADDR BAO_TOKEN="$TOKEN" bao kv get -field=v secret/iam/plugins/test-plugin 2>/dev/null)"
check "$GOT" hello "scoped token reads back its write"
BAO_ADDR=$ADDR BAO_TOKEN="$TOKEN" bao kv put secret/other/x v=1 >/dev/null 2>&1 \
  && bad "scoped token is refused outside its policy" || ok "scoped token is refused outside its policy"

echo "== scenario 2: bao restart -> sealed -> --unseal-only =="
stop_bao; start_bao; wait_api
OUT="$(sh "$S" --unseal-only "$ADDR" "$BASE/keys" 2>&1)"; RC=$?
check $RC 0 "unseal-only after restart exits 0"
case "$OUT" in *"unsealed and ready"*) ok "unseal-only reports ready" ;; *) bad "unseal-only reports ready" ;; esac
check "$(cat "$BASE/keys/api-token")" "$TOKEN" "unseal-only never re-mints the token"
GOT="$(BAO_ADDR=$ADDR BAO_TOKEN="$TOKEN" bao kv get -field=v secret/iam/plugins/test-plugin 2>/dev/null)"
check "$GOT" hello "data survives the restart + unseal-only"

echo "== scenario 3: full re-run with a still-valid token =="
printf 'IAM_PUBLIC_ORIGIN=https://example.invalid\nIAM_BAO_TOKEN=%s\nOTHER=1\n' "$TOKEN" > "$BASE/lyam.env"
OUT="$(LYAM_ENV_FILE="$BASE/lyam.env" sh "$S" "$ADDR" "$BASE/keys" 2>&1)"; RC=$?
check $RC 0 "full re-run exits 0"
case "$OUT" in *"still valid for"*"unchanged"*) ok "no re-mint while the token is valid" ;; *) bad "no re-mint while the token is valid ($OUT)" ;; esac
check "$(cat "$BASE/keys/api-token")" "$TOKEN" "token file unchanged"

echo "== scenario 3b: still-valid token but DIVERGED env value -> resync without re-mint =="
printf 'IAM_PUBLIC_ORIGIN=https://example.invalid\nIAM_BAO_TOKEN=diverged-old-value\nOTHER=1\n' > "$BASE/lyam.env"
OUT="$(LYAM_ENV_FILE="$BASE/lyam.env" sh "$S" "$ADDR" "$BASE/keys" 2>&1)"; RC=$?
check $RC 0 "reuse-resync run exits 0"
check "$(cat "$BASE/keys/api-token")" "$TOKEN" "no re-mint on the reuse path"
case "$OUT" in *"DIVERGED"*"resynchronized"*) ok "resync is announced" ;; *) bad "resync is announced ($OUT)" ;; esac
check "$(sed -n 's/^IAM_BAO_TOKEN=//p' "$BASE/lyam.env")" "$TOKEN" "env file resynchronized to the stored token"
check "$(grep -c '^OTHER=1$' "$BASE/lyam.env")" 1 "other env lines preserved on resync"
check "$(stat -c %a "$BASE/lyam.env")" 600 "env file stays 0600 on resync"

echo "== scenario 4: unreachable backend =="
OUT="$(BAO_WAIT_TRIES=2 sh "$S" http://127.0.0.1:18299 "$BASE/keys" 2>&1)"; RC=$?
check $RC 1 "unreachable exits 1"
case "$OUT" in *unreachable*) ok "unreachable is diagnosed" ;; *) bad "unreachable is diagnosed" ;; esac

echo "== scenario 5: storage wiped but keys kept -> refuse to re-init =="
stop_bao; rm -rf "$BASE/storage"; mkdir -p "$BASE/storage"; start_bao; wait_api
OUT="$(sh "$S" "$ADDR" "$BASE/keys" 2>&1)"; RC=$?
check $RC 1 "re-init with existing keys is refused"
case "$OUT" in *refused*investigate*) ok "refusal explains why" ;; *) bad "refusal explains why ($OUT)" ;; esac

echo "== scenario 6: sealed-status parse under set -e (fresh sealed backend, --unseal-only before init) =="
stop_bao; rm -rf "$BASE/storage" "$BASE/keys"; mkdir -p "$BASE/storage" "$BASE/keys"; start_bao; wait_api
OUT="$(sh "$S" --unseal-only "$ADDR" "$BASE/keys" 2>&1)"; RC=$?
check $RC 1 "unseal-only on a never-initialized backend is refused"
case "$OUT" in *"run the full bootstrap once first"*) ok "refusal is explicit" ;; *) bad "refusal is explicit ($OUT)" ;; esac

echo "== scenario 7: dead stored token -> re-mint + atomic env sync =="
OUT="$(sh "$S" "$ADDR" "$BASE/keys" 2>&1)"; RC=$?
check $RC 0 "re-init on the wiped backend exits 0"
printf 'IAM_PUBLIC_ORIGIN=https://example.invalid\nIAM_BAO_TOKEN=old-token-value\nOTHER=1\n' > "$BASE/lyam.env"
echo garbage > "$BASE/keys/api-token"
OUT="$(LYAM_ENV_FILE="$BASE/lyam.env" sh "$S" "$ADDR" "$BASE/keys" 2>&1)"; RC=$?
check $RC 0 "re-mint on a dead stored token exits 0"
NEWTOKEN="$(cat "$BASE/keys/api-token")"
[ -n "$NEWTOKEN" ] && [ "$NEWTOKEN" != garbage ] && ok "token file re-minted" || bad "token file re-minted"
case "$OUT" in *"lyam.env updated"*) ok "env sync announced" ;; *) bad "env sync announced ($OUT)" ;; esac
check "$(sed -n 's/^IAM_BAO_TOKEN=//p' "$BASE/lyam.env")" "$NEWTOKEN" "env file atomically updated to the new token"
check "$(grep -c '^OTHER=1$' "$BASE/lyam.env")" 1 "other env lines preserved"
check "$(stat -c %a "$BASE/lyam.env")" 600 "env file stays 0600"

echo "== scenario 8: bounded wait for a bao that is still starting (listen race) =="
stop_bao
( sleep 1; start_bao ) &
OUT="$(sh "$S" --unseal-only "$ADDR" "$BASE/keys" 2>&1)"; RC=$?
wait
check $RC 0 "unseal-only waits for a bao that binds after the first probe"
case "$OUT" in *unreachable*) bad "no premature unreachable verdict" ;; *) ok "no premature unreachable verdict" ;; esac

stop_bao
echo
echo "bao-bootstrap real-service test: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
