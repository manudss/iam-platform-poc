#!/bin/sh
# Read-only OCI diagnostic. Runs ON THE HOST (sudo sh -s, script piped over ssh stdin). Fixed: no argument.
# Prints ONLY validated booleans, integers, fixed enums, hex SHAs/digests. Anything unexpected prints "unexpected"/"unknown".
# Does NOT execute ordered-queue.py (it appends/chmods state.json.lock and takes flock): state.json is only read and parsed.
# Never reads lyam.env, never prints env values, state content, DB rows or messages.
set -u
ROOT=/opt/lyam
C=lyam
main() {
echo "diag.version=2"
echo "host.utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "--- runtime"
if docker inspect "$C" >/dev/null 2>&1; then
  insp() { docker inspect -f "$1" "$C" 2>/dev/null; }
  ENVFLAGS="$(insp '{{range .Config.Env}}{{println .}}{{end}}' | python3 -c '
import re,sys
hold=None; commit="absent"
for l in sys.stdin.read().splitlines():
    if l.startswith("IAM_AUTOMATION_HOLD="): hold = "1" if l == "IAM_AUTOMATION_HOLD=1" else "invalid"
    m = re.fullmatch(r"IAM_APP_COMMIT=([0-9a-f]{7,40})", l)
    if m: commit = m.group(1)
print("container.hold_env=%s" % (hold or "absent")); print("container.app_commit=%s" % commit)')"
  printf '%s\n' "$ENVFLAGS"
  { insp '{{.Config.Image}}'; insp '{{.Image}}'; insp '{{.State.Running}}'; insp '{{.RestartCount}}'; insp '{{.State.StartedAt}}'; insp '{{.State.ExitCode}}'; } | python3 -c '
import re,sys
v=(sys.stdin.read().split("\n")+[""]*6)[:6]
def ok(p,s): return s if re.fullmatch(p,s) else "unexpected"
print("container.image_ref=" + ok(r"ghcr\.io/manudss/iam-platform-poc(:[A-Za-z0-9._-]{1,64})?(@sha256:[0-9a-f]{64})?", v[0]))
print("container.image_id=" + ok(r"sha256:[0-9a-f]{64}", v[1]))
print("container.running=" + ok(r"true|false", v[2]))
print("container.restart_count=" + ok(r"[0-9]{1,6}", v[3]))
print("container.started_at=" + ok(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{8,20}Z", v[4]))
print("container.exit_code=" + ok(r"-?[0-9]{1,3}", v[5]))'
  # HOLD as captured by the running API at startup (log line written by main.ts), booleans only.
  echo "container.api_hold_log=$(timeout 15 docker exec "$C" node -e "
const fs=require('node:fs');let t='';try{t=fs.readFileSync('/data/api.log','utf8')}catch{console.log('unknown');process.exit(0)}
const a=[...t.matchAll(/automation hold: (\{[^\n]+\})/g)];if(!a.length){console.log('absent');process.exit(0)}
try{const j=JSON.parse(a[a.length-1][1]);console.log('held='+(j.held===true)+',settingPresent='+(j.settingPresent===true))}catch{console.log('unknown')}" 2>/dev/null || echo unknown)"
  probe() { timeout 15 docker exec "$C" node -e "fetch('$2').then(r=>console.log(r.status)).catch(()=>console.log('err'))" 2>/dev/null | grep -E '^[0-9]{3}$' || echo err; }
  # front proxy (demo/server.mjs, constant 200), API (apps/api health controller) and core (iam-core /health): status codes only.
  echo "container.front_healthz_8080=$(probe front http://127.0.0.1:8080/healthz)"
  echo "container.api_health_3000=$(probe api http://127.0.0.1:3000/health)"
  echo "container.core_health_8081=$(probe core http://127.0.0.1:8081/health)"
else
  echo "container.present=false"
fi
echo "--- locks"
for f in "$ROOT/UPDATE_PAUSED" "$ROOT/.update.lock" /var/lib/lyam-front-gate/MAINTENANCE /var/lib/lyam-front-gate/OPS-MAINTENANCE; do
  n="$(basename "$f")"
  if [ -e "$f" ]; then echo "file.$n.present=true mtime=$(stat -c %Y "$f" 2>/dev/null | grep -E '^[0-9]+$' || echo unknown)"; else echo "file.$n.present=false"; fi
done
echo "note.gate_paths=default (LYAM_FRONT_BARRIER_FILE/LYAM_OPS_BARRIER_FILE overrides not read)"
echo "unit.lyam-boot.active=$(systemctl is-active lyam-boot 2>/dev/null | grep -E '^(active|inactive|failed|activating|deactivating)$' || echo unknown)"
echo "--- journal"
S="$ROOT/deploy-queue/state.json"
if [ -f "$S" ]; then echo "state.sha256=$(sha256sum "$S" | cut -c1-64)"; else echo "state.present=false"; fi
python3 - "$S" <<'PY'
import json, re, sys
SHA = re.compile(r"[a-f0-9]{40}")
MODES = {"ui-open-automation-held", "normal", "closed-recovery", "in-place"}
def p(k, v): print("journal.%s=%s" % (k, v))
try:
    s = json.load(open(sys.argv[1]))
    h = s["history"]; last = h[-1]
except Exception:
    p("parse", "unknown"); raise SystemExit
def sha(x): return x if isinstance(x, str) and SHA.fullmatch(x) else "unexpected"
def cnt(x): return len(x) if isinstance(x, (list, dict)) else ("none" if x in (None, False) else "unexpected")
p("format", s.get("format") if s.get("format") in (1, 2, 3) else "unexpected")
p("history_length", len(h))
p("last_delivered_sha", sha(last.get("sha")))
D = last.get("digest")
p("last_delivered_digest", D if isinstance(D, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", D) else "unexpected")
p("last_delivered_mode", last.get("mode") if last.get("mode") in MODES else ("absent" if last.get("mode") is None else "other"))
p("pending", cnt(s.get("pending"))); p("failed", cnt(s.get("failed")))
p("resume_required", s["resume_required"] if isinstance(s.get("resume_required"), bool) else "absent_or_unexpected")
p("recovery_fence", sha(s["recovery_fence"]) if "recovery_fence" in s else "absent")
p("opening_intent_present", "true" if s.get("opening_intent") else "false")
r = s.get("resumptions")
p("resumptions_count", len(r) if isinstance(r, list) else "absent")
try: p("last_resumption_observed_sha", sha(r[-1]["observed_running"]["sha"]))
except Exception: p("last_resumption_observed_sha", "absent")
PY
}
OUT="$(main)"
printf '%s\n' "$OUT"
BAD="$(printf '%s\n' "$OUT" | grep -cE '^container\.present=false$|^state\.present=false$|=(unknown|unexpected|err|invalid)( |$)|absent_or_unexpected' || true)"
if [ "$BAD" -eq 0 ]; then echo "diag.complete=true"; echo "diag.problem_lines=0"; else echo "diag.complete=false"; echo "diag.problem_lines=$BAD"; exit 3; fi
