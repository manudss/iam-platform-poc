# Behavioral test of bao-bootstrap-isolated.sh with stub `docker` and `curl` on PATH
# emulating the bao CLI subset and the exact metadata endpoint (same stub pattern as
# run-isolated-cycle). Focus: the qualification-inventory sentinel — created ONLY on an
# authoritative HTTP 404 from the exact metadata endpoint; any other status, transport
# failure or unexpected schema stops without any write; never rewritten when present
# (current_version stability keeps the before/after metadata hash comparison intact);
# fictive constant payload; no token value ever printed. Requires: jq (skip otherwise).
import json,os,shutil,subprocess,tempfile,unittest
from pathlib import Path
SCRIPT=Path(__file__).with_name('bao-bootstrap-isolated.sh')
JQ=shutil.which('jq')
STUB_DOCKER=r'''#!/bin/sh
# stub docker: emulates `docker exec [-e K=V]... bao-iso bao ...` and `docker cp ...`
STATE="$STUB_STATE"
if [ "$1" = "cp" ]; then exit 0; fi
if [ "$1" != "exec" ]; then echo "stub docker: unhandled $*" >&2; exit 1; fi
shift
while [ "$1" = "-e" ]; do shift 2; done
shift 2
cmd="$1"; shift || true
case "$cmd" in
  status) cat "$STATE/status.json" ;;
  operator)
    if [ "$1" = "init" ]; then cat "$STATE/init.json"; fi ;;
  secrets) exit 0 ;;
  policy) exit 0 ;;
  token) printf '{"auth":{"client_token":"fixture-token-%s"}}\n' "${2#-policy=}" ;;
  kv)
    sub="$1"; shift
    case "$sub" in
      put)
        path="$1"; shift
        mkdir -p "$STATE/kv/$(dirname "$path")"
        v=1; [ -f "$STATE/kv/$path.version" ] && v=$(( $(cat "$STATE/kv/$path.version") + 1 ))
        echo "$v" > "$STATE/kv/$path.version"
        echo "$*" > "$STATE/kv/$path.payload"
        echo "$path" >> "$STATE/puts" ;;
    esac ;;
  *) echo "stub docker: unhandled $cmd $*" >&2; exit 1 ;;
esac
exit 0
'''
STUB_CURL=r'''#!/bin/sh
# stub curl for the exact sentinel metadata endpoint. Modes via STUB_CURL_MODE:
#   auto (default): 404 while absent, 200 with valid schema once present
#   403 / 500: fixed status ; transport: exit 7 without output ; badschema: 200 wrong schema
OUT=""; W=""; URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) OUT="$2"; shift 2 ;;
    -w) W="$2"; shift 2 ;;
    -H) shift 2 ;;
    -sS) shift ;;
    *) URL="$1"; shift ;;
  esac
done
MODE="${STUB_CURL_MODE:-auto}"
code=""
if [ "$URL" != "http://127.0.0.1:8200/v1/secret/metadata/iam/qualification-sentinel" ]; then
  echo "stub curl: unexpected URL" >&2; exit 2
fi
case "$MODE" in
  auto)
    if [ -f "$STUB_STATE/kv/secret/iam/qualification-sentinel.version" ]; then
      printf '{"data":{"current_version":%s}}' "$(cat "$STUB_STATE/kv/secret/iam/qualification-sentinel.version")" > "$OUT"; code=200
    else
      printf '{"errors":["no metadata found"]}' > "$OUT"; code=404
    fi ;;
  badschema) printf '{"data":{"current_version":"oops"}}' > "$OUT"; code=200 ;;
  empty200) : > "$OUT"; code=200 ;;
  multidoc) printf '{"data":{"current_version":1}}\n{"data":{"current_version":1}}\n' > "$OUT"; code=200 ;;
  transport) echo "stub curl: connection refused" >&2; exit 7 ;;
  *) printf '{"errors":["stub status"]}' > "$OUT"; code="$MODE" ;;
esac
printf '%s' "$(printf '%s' "$W" | sed "s/%{http_code}/$code/")"
exit 0
'''
@unittest.skipUnless(JQ,'jq required')
class Bootstrap(unittest.TestCase):
 def setUp(self):
  self.d=tempfile.TemporaryDirectory();root=Path(self.d.name)
  self.keys=root/'keys';self.env=root/'lyam.env';self.env.write_text('IAM_BAO_TOKEN=\nOTHER=1\n')
  self.state=root/'state';(self.state/'kv').mkdir(parents=True)
  (self.state/'status.json').write_text('{"initialized":false,"sealed":false}')
  (self.state/'init.json').write_text('{"unseal_keys_b64":["Zml4dHVyZQ=="],"root_token":"fixture-root-token"}')
  self.bin=root/'bin';self.bin.mkdir()
  docker=self.bin/'docker';docker.write_text(STUB_DOCKER);docker.chmod(0o755)
  curl=self.bin/'curl';curl.write_text(STUB_CURL);curl.chmod(0o755)
  self.run_env=dict(os.environ,PATH=str(self.bin)+':'+os.environ['PATH'],STUB_STATE=str(self.state))
 def tearDown(self):self.d.cleanup()
 def run_script(self,mode=None):
  env=dict(self.run_env)
  if mode:env['STUB_CURL_MODE']=mode
  return subprocess.run(['sh',str(SCRIPT),str(self.keys),str(self.env)],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
 def version(self):return self.state/'kv/secret/iam/qualification-sentinel.version'
 def payload(self):return self.state/'kv/secret/iam/qualification-sentinel.payload'
 def puts(self):return self.state/'puts'
 def test_sentinel_written_once_when_inventory_empty(self):
  r=self.run_script();self.assertEqual(r.returncode,0,r.stderr)
  self.assertEqual(self.version().read_text().strip(),'1')
  payload=self.payload().read_text()
  self.assertIn('purpose=isolated-qualification-inventory-sentinel',payload)
  self.assertIn('fictive',payload);self.assertNotIn('fixture-root-token',payload)
  self.assertIn('bootstrapped',r.stdout)
  for leak in ['fixture-root-token','fixture-token-api','fixture-token-qualification-metadata']:
   self.assertNotIn(leak,r.stdout);self.assertNotIn(leak,r.stderr)
  self.assertIn('IAM_BAO_TOKEN=fixture-token-api',self.env.read_text())
  self.assertIn('OTHER=1',self.env.read_text())
 def test_sentinel_never_rewritten_on_rerun(self):
  self.assertEqual(self.run_script().returncode,0)
  self.assertEqual(self.run_script().returncode,0)
  self.assertEqual(self.version().read_text().strip(),'1','a rewrite bumps current_version and breaks before/after hash equality')
  self.assertEqual(self.puts().read_text().count('qualification-sentinel'),1)
 def test_sentinel_key_under_covered_metadata_root(self):
  self.assertEqual(self.run_script().returncode,0)
  # Covered root: secret/metadata/iam (policy bao-policy-metadata.hcl, walk root).
  # kv data path secret/iam/qualification-sentinel maps to metadata path
  # secret/metadata/iam/qualification-sentinel: LIST of the root returns it.
  puts=self.puts().read_text().splitlines()
  self.assertEqual(puts,['secret/iam/qualification-sentinel'])
  self.assertTrue(puts[0].startswith('secret/iam/'),'sentinel must live under the covered root')
 def test_non_404_status_stops_without_write(self):
  for mode in ['403','500']:
   r=self.run_script(mode)
   self.assertEqual(r.returncode,1,mode)
   self.assertIn('refusing any write',r.stderr)
   self.assertFalse(self.version().exists(),mode)
   self.assertFalse(self.puts().exists(),mode)
 def test_transport_failure_stops_without_write(self):
  r=self.run_script('transport')
  self.assertEqual(r.returncode,1)
  self.assertIn('refusing any write',r.stderr)
  self.assertFalse(self.version().exists());self.assertFalse(self.puts().exists())
 def test_bad_schema_stops_without_write(self):
  r=self.run_script('badschema')
  self.assertEqual(r.returncode,1)
  self.assertIn('refusing any write',r.stderr)
  self.assertFalse(self.version().exists());self.assertFalse(self.puts().exists())
 def test_empty_200_body_stops_without_write(self):
  # jq without -s would accept an empty body (exit 0, no output): must refuse.
  r=self.run_script('empty200')
  self.assertEqual(r.returncode,1)
  self.assertIn('refusing any write',r.stderr)
  self.assertFalse(self.version().exists());self.assertFalse(self.puts().exists())
 def test_multi_document_200_stops_without_write(self):
  # Two schema-valid documents is not one authoritative metadata object: must refuse.
  r=self.run_script('multidoc')
  self.assertEqual(r.returncode,1)
  self.assertIn('refusing any write',r.stderr)
  self.assertFalse(self.version().exists());self.assertFalse(self.puts().exists())
 def test_present_key_survives_failed_rechecks_unchanged(self):
  self.assertEqual(self.run_script().returncode,0)
  self.assertEqual(self.version().read_text().strip(),'1')
  for mode in ['403','500','transport','badschema','empty200','multidoc']:
   self.assertEqual(self.run_script(mode).returncode,1,mode)
  self.assertEqual(self.version().read_text().strip(),'1')
  self.assertEqual(self.puts().read_text().count('qualification-sentinel'),1)
  self.assertEqual(self.run_script().returncode,0)
  self.assertEqual(self.version().read_text().strip(),'1')
if __name__=='__main__':unittest.main()
