#!/bin/bash
# deploy/oci/isolated/run-qualification-isolated.sh — LYAM_POST_UPDATE_CHECK wrapper for
# the ISOLATED nominal qualification cycle only (never production).
#
# update.sh calls its post-update checker with fixed arguments and offers no isolated
# mode, no --policy passthrough (host-verified gap). This wrapper is the explicit
# integration point: it forwards update.sh's arguments to qualification.py, adding
#   --isolated-loopback-test --policy "$LYAM_ISOLATED_POLICY"
# so the cycle produces ISOLATED_LOOPBACK_NO_PUBLIC_TLS_PROOF evidence against a test
# policy built from scratch - never the production policy.
#
# Refusals (fail closed):
#   - LYAM_ISOLATED_POLICY unset or empty;
#   - LYAM_ISOLATED_POLICY resolving to /opt/lyam/qualification.json (production policy).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
POLICY="${LYAM_ISOLATED_POLICY:?set LYAM_ISOLATED_POLICY to the isolated test policy path}"

if [ "$(readlink -f "$POLICY")" = "/opt/lyam/qualification.json" ]; then
  echo "refusing the production qualification policy path" >&2
  exit 1
fi
[ -r "$POLICY" ] || { echo "test policy not readable: $POLICY" >&2; exit 1; }

# Content refusal, not just path refusal: an isolated cycle only ever runs against a
# policy that DECLARES itself isolated. Production policies never carry this marker,
# so a prod policy copied under an innocent name still fails here.
grep -q '"isolatedLoopbackTest"[[:space:]]*:[[:space:]]*true' "$POLICY" \
  || { echo "policy lacks isolatedLoopbackTest: true - not an isolated test policy" >&2; exit 1; }

exec python3 "$HERE/../qualification.py" \
  --policy "$POLICY" --isolated-loopback-test "$@"
