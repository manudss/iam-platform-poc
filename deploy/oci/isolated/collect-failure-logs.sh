#!/bin/bash
# deploy/oci/isolated/collect-failure-logs.sh <ISO_WORK> [run-exit-code]
#
# Bounded failure diagnostics for the isolated harness: ONE fixed-schema JSON
# document (per container: status, restart count, exit code, read status, and
# counters of a FIXED list of diagnostic patterns - see diagnose-containers.py).
# Raw container log lines are processed in memory only and discarded: no original
# line, value or error text ever reaches disk, stdout or the artifact. Read
# failures are marked in the JSON with fixed enums and reported loudly by
# container NAME only. Any gap makes this script exit non-zero - the CALLER's
# trap still preserves the run's original exit code. evidence/ ownership is
# restored to the runner for the artifact upload.
set -uo pipefail

ISO_WORK="${1:?usage: collect-failure-logs.sh <ISO_WORK> [run-exit-code]}"
RUN_RC="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$ISO_WORK/evidence"
DOC="$OUT/container-diagnostics.json"

if ! mkdir -p "$OUT" 2>/dev/null; then
  sudo mkdir -p "$OUT" || { echo "diagnostics: cannot create $OUT" >&2; exit 1; }
fi

tmp="$ISO_WORK/.container-diagnostics.json"
rm -f "$tmp"
rc=0
python3 "$HERE/diagnose-containers.py" "$ISO_WORK" "$RUN_RC" > "$tmp" || rc=$?
case "$rc" in 0|2) ;; *)
  echo "diagnostics: diagnose-containers FAILED (rc=$rc)" >&2
  rm -f "$tmp"
  exit 1 ;;
esac
if ! { [ -s "$tmp" ] && python3 -c 'import json, sys; json.load(open(sys.argv[1]))' "$tmp" 2>/dev/null; }; then
  echo "diagnostics: diagnose-containers produced no valid JSON" >&2
  rm -f "$tmp"
  exit 1
fi
if ! { mv "$tmp" "$DOC" 2>/dev/null || sudo mv "$tmp" "$DOC"; }; then
  echo "diagnostics: FAILED to store container-diagnostics.json" >&2
  rm -f "$tmp"
  exit 1
fi

if [ -n "$(find "$DOC" ! -user "$(id -u)" -print -quit 2>/dev/null)" ]; then
  sudo chown "$(id -u):$(id -g)" "$DOC" \
    || { echo "diagnostics: FAILED to restore runner ownership on $DOC" >&2; exit 1; }
fi

if [ "$rc" = 2 ]; then
  echo "FAILURE DIAGNOSTICS INCOMPLETE: one or more containers could not be read (marked in container-diagnostics.json)" >&2
  exit 1
fi
echo "failure diagnostics: fixed-schema container-diagnostics.json in evidence/" >&2
exit 0
