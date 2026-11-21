#!/bin/bash
# deploy/oci/isolated/run-isolated-cycle.sh — the executable isolated nominal
# qualification cycle. Usage: run-isolated-cycle.sh <ISO_WORK>
#
# Runs ONE full update.sh cycle (real OLD image -> real NEW image, migration 0002) on a
# throwaway stack, then a NEGATIVE re-run on a FULLY REBUILT throwaway stack (compose
# down -v: fresh PG, fresh Bao, fresh data) with a policy that omits the verifier entry:
# by update.sh design the healthy NEW version then stays BEHIND the re-armed gate
# (exit 4, image NEW, origin 503, log shows the missing-verifier cause; NO rollback -
# that closed failure is exactly what #118 proved).
#
# HARD REFUSALS, all before any mutation:
#   - ISO_WORK canonical (realpath -m: no symlink, no '..'), absolute, NOT pre-existing,
#     under the runner temp dir in CI (or /tmp with the explicit non-CI opt-in), and
#     never resolving under a production path;
#   - no container (any state) named lyam/pg/bao (production) or api-iso/pg-iso/bao-iso/
#     caddy-iso (pre-existing -iso resources would be reused/destroyed), no
#     lyam-iso-net network, no lyam-isolated_pg-iso-data volume, no container of either
#     verified image (the controller's container discovery is global);
#   - LYAM_FRONT_BARRIER_FILE always explicit, canonical, inside ISO_WORK, never the
#     production default of front-barrier-check.sh;
#   - rendered config: no leftover placeholder, every referenced checkout file exists,
#     no production path, policy keeps its isolatedLoopbackTest marker and no https origin;
#   - the reviewed test verifier's sha256 equals the pinned value before install.
#
# Bounds, stated plainly: the ISO_WORK creation and the deterministic config render
# deliberately PRECEDE the docker checks (that order is what makes them unit-testable
# with a stub daemon); on a mid-cycle failure this script stops wherever it failed and
# does NOT guarantee cleanup - the throwaway runner is destroyed as a whole instead.
set -euo pipefail

RAW_WORK="${1:?usage: run-isolated-cycle.sh <ISO_WORK>}"
ISO="$(cd "$(dirname "$0")" && pwd)"          # <repo>/deploy/oci/isolated
OCI="$(cd "$ISO/.." && pwd)"                 # <repo>/deploy/oci
ROOT="$(cd "$ISO/../../.." && pwd)"        # <repo> (isolated -> oci -> deploy -> repo)

OLD_IMAGE='ghcr.io/manudss/iam-platform-poc@sha256:accbd340a59db8a87762f9cdb338a6aca70f92f99a5a5c9e5ba2425f8f3eb3de'
NEW_IMAGE='ghcr.io/manudss/iam-platform-poc@sha256:7c5ce38f03b378afbb060e6092706a03503c47eac58c2cbca943d15d0d652201'
VERIFIER_PIN='23306e2a7c0a2bf98efbb62d1986a54cd29ce655a4267211eb978ee0f5a2f8d5'
PG_PASSWORD='fictive-only-not-a-real-password'

fail() { echo "FATAL: $*" >&2; exit 1; }

[ -f "$ROOT/.github/workflows/ci.yml" ] || fail "repo root not resolved from $ISO"

# --- ISO_WORK: canonicalize BEFORE creating anything (defect: /tmp/../opt/lyam escapes) --
case "$RAW_WORK" in /*) ;; *) fail "ISO_WORK must be absolute" ;; esac
ISO_WORK="$(realpath -m "$RAW_WORK")"
[ "$ISO_WORK" = "$RAW_WORK" ] || fail "ISO_WORK must be canonical (no symlink, no '..'): $RAW_WORK resolves to $ISO_WORK"
case "$ISO_WORK" in
  /|/opt|/opt/*|/var/lib/lyam*|/etc|/etc/*) fail "ISO_WORK must be a disposable directory, got $ISO_WORK" ;;
esac
if [ "${CI:-}" = "true" ]; then
  [ -n "${RUNNER_TEMP:-}" ] || fail "CI without RUNNER_TEMP"
  case "$ISO_WORK" in "$RUNNER_TEMP"/*) ;; *) fail "in CI, ISO_WORK must live under RUNNER_TEMP" ;; esac
else
  [ -n "${ALLOW_NON_CI_RUNNER:-}" ] || fail "refusing outside CI without ALLOW_NON_CI_RUNNER=1 (scratch-VM runs set it explicitly)"
  case "$ISO_WORK" in /tmp/*) ;; *) fail "outside CI, ISO_WORK must live under /tmp" ;; esac
fi
[ ! -e "$ISO_WORK" ] || fail "ISO_WORK must be created new by this run, it already exists: $ISO_WORK"
for tool in docker jq python3 curl realpath; do command -v "$tool" >/dev/null || fail "$tool missing"; done

# --- render config (checkout = repo ROOT, so <checkout>/deploy/oci/isolated/... resolves) -
mkdir -p "$ISO_WORK"/{data,backups,gate,bao-storage,bao-keys,evidence}
ENV_FILE="$ISO_WORK/lyam.env"
COMPOSE_ENV="$ISO_WORK/compose.env"
POLICY="$ISO_WORK/qualification.isolated.json"
POLICY_NEG="$ISO_WORK/qualification.isolated.no-verifier.json"
VROOT="$ISO_WORK/oci"

sed -e "s|<iso-work>|$ISO_WORK|g" -e "s|<checkout>|$ROOT|g" \
  "$ISO/lyam.isolated.env.example" > "$ENV_FILE"
printf 'ISO_WORK=%s\nPG_PASSWORD=%s\n' "$ISO_WORK" "$PG_PASSWORD" > "$COMPOSE_ENV"
cp "$ISO/bao.hcl" "$ISO_WORK/bao.hcl"
cp "$ISO/Caddyfile.isolated" "$ISO_WORK/Caddyfile"
printf '{"username":"demo-alice","password":"demo-only-not-a-secret"}\n' > "$ISO_WORK/auth.json"
# ^ public fictional seed credentials (docs/local-setup.md); never a real secret.
jq --arg v "$VROOT/isolated/verify-0002-isolated-test.py" --arg a "$ISO_WORK/auth.json" --arg t "$ISO_WORK/bao-keys/qualification-token" \
  '.authFile=$a | .baoTokenFile=$t | .transformationVerifiers["ghcr.io/manudss/iam-platform-poc@sha256:7c5ce38f03b378afbb060e6092706a03503c47eac58c2cbca943d15d0d652201"]=$v' \
  "$ISO/qualification.isolated.example.json" > "$POLICY"
jq 'del(.transformationVerifiers)' "$POLICY" > "$POLICY_NEG"

# Rendered-config refusals: no leftover placeholder, every referenced file exists,
# no production path, marker and origins intact.
! grep -q '<iso-work>\|<checkout>' "$ENV_FILE" "$POLICY" || fail "unrendered placeholder left in config"
while IFS= read -r path; do
  [ -e "$path" ] || fail "rendered config references a missing file: $path"
done < <(grep -o "$ROOT[^ ]*" "$ENV_FILE" | sort -u)
! grep -q '/opt/lyam\|/var/lib/lyam-front-gate' "$POLICY" "$ENV_FILE" || fail "production path leaked into rendered config"
grep -q '"isolatedLoopbackTest": true' "$POLICY" || fail "rendered policy lost its isolated marker"
jq -e '[.origins[] | select(startswith("https://"))] | length == 0' "$POLICY" >/dev/null \
  || fail "isolated policy must not carry an https origin"
[ "$(jq -r .tenant "$POLICY")" = "acme-demo" ] || fail "policy tenant must match the seeded tenant (acme-demo)"

# --- daemon and pre-existing resources (any state), still before any mutation -------------
docker info >/dev/null 2>&1 || fail "docker unavailable"
names="$(docker ps -aq --format '{{.Names}}')"
for n in lyam pg bao; do printf '%s\n' "$names" | grep -qx "$n" && fail "production container $n present"; done
for n in api-iso pg-iso bao-iso caddy-iso; do printf '%s\n' "$names" | grep -qx "$n" && fail "pre-existing $n would be reused or destroyed"; done
docker network inspect lyam-iso-net >/dev/null 2>&1 && fail "pre-existing lyam-iso-net network"
docker volume inspect lyam-isolated_pg-iso-data >/dev/null 2>&1 && fail "pre-existing lyam-isolated_pg-iso-data volume"
[ -z "$(docker ps -q --filter "ancestor=$NEW_IMAGE")" ] || fail "a container of the NEW image is already running"
[ -z "$(docker ps -q --filter "ancestor=$OLD_IMAGE")" ] || fail "a container of the OLD image is already running"

# --- reviewed verifier, pinned and installed with the layout its imports require ---------
echo "$VERIFIER_PIN  $ISO/verify-0002-isolated-test.py" | sha256sum -c - >/dev/null \
  || fail "test verifier sha256 differs from the reviewed pin"
sudo install -D -o root -m 0600 "$OCI/qualification.py" "$VROOT/qualification.py"
sudo install -D -o root -m 0600 "$OCI/qualification-container.mjs" "$VROOT/qualification-container.mjs"
sudo install -D -o root -m 0700 "$ISO/verify-0002-isolated-test.py" "$VROOT/isolated/verify-0002-isolated-test.py"
# chown/chmod in place (install file->same-file fails; reproduced 2026-11-21).
# Policies: root 0600, read by the controller running as root via sudo. ENV_FILE stays
# owned by the runner user (0600): bao-bootstrap-isolated.sh rewrites it ATOMICALLY to
# sync the app token (at both stack_up calls), and update.sh runs under sudo - root
# reads a user-owned 0600 file. (Prod hardens ownership to root; the runner keeps the
# same secrecy semantics with the writable owner the bootstrap needs.)
sudo chown root:root "$POLICY" "$POLICY_NEG"
sudo chmod 0600 "$POLICY" "$POLICY_NEG"
chmod 0600 "$ENV_FILE"

# --- throwaway stack ----------------------------------------------------------------------
compose() { docker compose --env-file "$COMPOSE_ENV" -f "$ISO/docker-compose.isolated.yml" "$@"; }
health() { docker exec api-iso node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; }
front_code() { curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/healthz || true; }

stack_up() {  # companions + bao bootstrap + OLD-image app + front; a FULL before state
  compose up -d pg-iso bao-iso
  local i=0
  while [ $i -lt 30 ]; do docker exec pg-iso pg_isready -U lyam -d lyam >/dev/null 2>&1 && break; sleep 2; i=$((i + 1)); done
  docker exec pg-iso pg_isready -U lyam -d lyam >/dev/null || fail "pg-iso not ready"
  bash "$ISO/bao-bootstrap-isolated.sh" "$ISO_WORK/bao-keys" "$ENV_FILE"
  docker run -d --name api-iso --restart on-failure \
    -p 127.0.0.1:8081:8080 -v "$ISO_WORK/data:/data" \
    --env-file "$ENV_FILE" --network lyam-iso-net "$OLD_IMAGE" >/dev/null
  i=0; while [ $i -lt 60 ]; do health && break; sleep 5; i=$((i + 1)); done
  health || fail "api-iso (OLD image) never became healthy"
  compose up -d caddy-iso
  i=0; while [ $i -lt 12 ]; do [ "$(front_code)" = "200" ] && break; sleep 5; i=$((i + 1)); done
  [ "$(front_code)" = "200" ] || fail "front never proxied the backend"
}

stack_down() {  # everything, volumes included: the next stack is provably fresh
  docker rm -f api-iso >/dev/null 2>&1 || true
  compose down -v >/dev/null
  sudo rm -rf "$ISO_WORK/data" "$ISO_WORK/bao-storage" "$ISO_WORK/bao-keys"
  mkdir -p "$ISO_WORK/data" "$ISO_WORK/bao-storage" "$ISO_WORK/bao-keys"
}

stack_up

# --- gate drill, always with an explicit disposable barrier file --------------------------
export LYAM_FRONT_BARRIER_FILE="$ISO_WORK/gate/MAINTENANCE"
[ "$(realpath -m "$LYAM_FRONT_BARRIER_FILE")" = "$LYAM_FRONT_BARRIER_FILE" ] || fail "barrier path not canonical"
case "$LYAM_FRONT_BARRIER_FILE" in "$ISO_WORK"/*) ;; *) fail "barrier file escaped ISO_WORK" ;; esac
[ "$LYAM_FRONT_BARRIER_FILE" != "/var/lib/lyam-front-gate/MAINTENANCE" ] || fail "production barrier default refused"
IAM_PUBLIC_ORIGIN=http://127.0.0.1:8080 bash "$OCI/front-barrier-check.sh"

# --- preconditions, verified not assumed ---------------------------------------------------
ledger="$(docker exec api-iso cat /data/migrations/journal.json)"
printf '%s' "$ledger" | jq -e '.format == 1 and (.pending | not) and ([.entries[].id] | index("0002") | not) and (.entries[-1].id == "0001")' >/dev/null \
  || fail "seed ledger is not the expected BEFORE state (stopped at 0001, no 0002)"
# Host-proven Dolt 2.6.1 CLI shape (same as the reviewed verifier's dolt_query).
rules="$(docker exec -i api-iso dolt --host 127.0.0.1 --port 3307 --no-tls -u root --password '' \
  --use-db=iam sql -r json -q "SELECT count(*) AS c FROM policy_rules WHERE set_name='default' AND id='screen-account-blocks'")"
printf '%s' "$rules" | jq -e '(.rows | length) == 1 and (.rows[0].c | tonumber) == 0' >/dev/null \
  || fail "account-blocks rule already present or Dolt read UNKNOWN - preconditions unproven"
docker exec pg-iso psql -U lyam -d lyam -tAc 'SELECT count(*) FROM public.activations' >/dev/null \
  || fail "activations table unreadable - preconditions unproven"

# --- preflight (operator checklist tool; the gate is the cycle itself) ---------------------
sudo python3 "$OCI/update-preflight.py" --image "$NEW_IMAGE" --policy "$POLICY" --verifier-sha256 "$VERIFIER_PIN"

# --- POSITIVE: the nominal cycle, gate lifted by update.sh itself --------------------------
sudo -E env LYAM_ISOLATED_POLICY="$POLICY" \
  bash "$OCI/update.sh" --require-qualification --image "$NEW_IMAGE" --env-file "$ENV_FILE" \
  | tee "$ISO_WORK/evidence/positive-update.log"
[ "$(docker inspect -f '{{.Config.Image}}' api-iso)" = "$NEW_IMAGE" ] || fail "container is not the NEW image after a green update"
[ "$(front_code)" = "200" ] || fail "front not open after a green update"
echo "POSITIVE CYCLE: nominal qualification passed, gate lifted by update.sh"

# --- NEGATIVE: a FULLY REBUILT fresh BEFORE stack, policy without the verifier entry -------
stack_down
stack_up
set +e
sudo -E env LYAM_ISOLATED_POLICY="$POLICY_NEG" \
  bash "$OCI/update.sh" --require-qualification --image "$NEW_IMAGE" --env-file "$ENV_FILE" \
  > "$ISO_WORK/evidence/negative-update.log" 2>&1
neg_rc=$?
set -e
# update.sh by design: healthy NEW version, qualification fails, gate re-armed, NO blind
# rollback -> exit 4, container NEW, origin 503. Anything else is a protocol failure.
[ "$neg_rc" -eq 4 ] || fail "negative run rc=$neg_rc, expected exactly 4 (gate re-armed, no rollback)"
[ "$(docker inspect -f '{{.Config.Image}}' api-iso)" = "$NEW_IMAGE" ] || fail "negative run must keep the NEW image behind the gate (no blind rollback)"
[ "$(front_code)" = "503" ] || fail "negative run left the gate OPEN"
# Cause proof WITHOUT parsing masked logs: the controller prints only a generic
# 'Qualification failed or UNKNOWN' (qualification.py __main__ masks exceptions), so the
# decision path is re-derived from the captured evidence with a structured diagnostic:
# the captured before/after differ exactly by ['dolt'] AND the negative policy has no
# verifier entry for the NEW digest. That conjunction is precisely the fail-closed branch.
# The qualification evidence directories are root-owned 0700 (the controller runs as
# root): selection, validation and reading of EVID_NEG all happen inside this ONE
# privileged block - no unprivileged ls/cat of root evidence.
sudo ISO_WORK="$ISO_WORK" python3 - "$VROOT/qualification.py" "$POLICY_NEG" "$NEW_IMAGE" <<'PYDIAG'
import importlib.util, json, os, sys
from pathlib import Path
module_path, policy_path, new_image = sys.argv[1:4]
work = Path(os.environ['ISO_WORK'])
spec = importlib.util.spec_from_file_location('qualification_controller', module_path)
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)
policy = q.policy_load(policy_path, isolated_loopback=True)
dirs = sorted((work / 'backups').glob('qualification-*'), key=lambda d: d.stat().st_mtime)
if not dirs:
    raise SystemExit('no qualification evidence directory found')
evid = dirs[-1]
before_file = evid / 'before.json'
if not before_file.is_file():
    raise SystemExit('negative run captured no before evidence')
afters = sorted(evid.glob('after-*.json'))
if len(afters) != 1:
    raise SystemExit('expected exactly one after capture in the negative evidence')
before = json.loads(before_file.read_text())
after = json.loads(afters[0].read_text())
if q.compare(before, after, policy) != ['dolt']:
    raise SystemExit('negative transition changed more than the declared Dolt transformation')
if policy.get('transformationVerifiers', {}).get(new_image):
    raise SystemExit('negative policy unexpectedly carries a verifier entry')
print('negative cause proven from', evid.name,
      ': declared Dolt transition + no verifier for the digest = fail-closed branch')
PYDIAG
echo "NEGATIVE CYCLE: closed failure reproduced exactly (rc=4, NEW behind gate, cause proven from evidence)"

# --- evidence and cleanup ------------------------------------------------------------------
# Privileged export of the whole capture set (root 0700 dirs) into a runner-readable
# package for the artifact upload. NO masked fallback: if the export fails, the run
# fails here - an announced archive that never copied is not evidence.
sudo ISO_WORK="$ISO_WORK" RUNNER_UID="$(id -u)" RUNNER_GID="$(id -g)" python3 - <<'PYEXP'
import os, shutil, sys
from pathlib import Path
work = Path(os.environ['ISO_WORK'])
uid, gid = int(os.environ['RUNNER_UID']), int(os.environ['RUNNER_GID'])
out = work / 'evidence' / 'captures'
if out.exists():
    shutil.rmtree(out)
out.mkdir(parents=True)
count = 0
for src in sorted((work / 'backups').glob('qualification-*')):
    dst = out / src.name
    shutil.copytree(src, dst)
    count += sum(1 for f in dst.rglob('*') if f.is_file())
for path in [out, *[p for p in out.rglob('*')]]:
    os.chown(path, uid, gid)
print('evidence export:', count, 'files from', len(list(out.iterdir())), 'capture sets')
PYEXP
( cd "$ISO_WORK/evidence" && find . -type f ! -name SHA256SUMS -exec sha256sum {} + > SHA256SUMS )
# The negative run's marker belongs to this throwaway run; removing it here is drill
# cleanup, valid only because the whole stack is disposable.
rm -f "$ISO_WORK/gate/MAINTENANCE"
docker rm -f api-iso >/dev/null
compose down -v >/dev/null
echo "ISOLATED CYCLE COMPLETE - evidence in $ISO_WORK/evidence"
