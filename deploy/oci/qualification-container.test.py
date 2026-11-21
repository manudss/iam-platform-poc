# Drives the real qualification-container.mjs under node inside a bwrap sandbox with a
# fixture /data, a stub dolt binary and a fixture OpenBao HTTP server. Asserts the
# closed-enum stage attribution at the exception boundary and that stderr never leaks
# exception content. Requires: node, bwrap (skip otherwise).
import json,os,re,shutil,subprocess,tempfile,threading,http.server,unittest
from pathlib import Path
MJS=Path(__file__).with_name('qualification-container.mjs')
NODE=shutil.which('node');BWRAP=shutil.which('bwrap')
DOLT_OK='''#!/bin/sh
if [ -n "$DOLT_STUB_FAIL" ]; then printf '%s' "$DOLT_STUB_FAIL" >&2; exit 1; fi
sql=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-q" ]; then sql="$a"; fi
  prev="$a"
done
case "$sql" in
  "SHOW DATABASES") printf '%s' '{"rows":[{"Database":"iam"},{"Database":"mysql"}]}' ;;
  "SELECT name, hash FROM dolt_branches ORDER BY name") printf '%s' '{"rows":[{"name":"main","hash":"h1"}]}' ;;
  "SELECT DOLT_HASHOF_DB('WORKING') AS root") printf '%s' '{"rows":[{"root":"r1"}]}' ;;
  *) exit 1 ;;
esac
exit 0
'''
MASKED=re.compile(r'^Qualification UNKNOWN or failed \(stage=([A-Z_]+)\)\. Preserve private evidence and keep maintenance armed\.\n$')
class Bao:
 def __init__(self,health,sealed,listing,metadata):
  class H(http.server.BaseHTTPRequestHandler):
   def log_message(self,*a):pass
   def _send(self,status,obj):
    body=json.dumps(obj).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
   def do_GET(self):
    if self.path=='/v1/sys/health':self._send(health,{'initialized':True,'sealed':sealed,'standby':False});return
    m=re.fullmatch(r'/v1/secret/metadata/iam/([^/]+)',self.path)
    if m and m.group(1) in metadata:self._send(200,{'data':metadata[m.group(1)]});return
    self._send(404,{'errors':['fixture: unknown path']})
   def do_LIST(self):
    if self.path=='/v1/secret/metadata/iam':
     if listing is None:self._send(404,{'errors':['fixture: no entries']})
     else:self._send(200,{'data':{'keys':listing}})
     return
    self._send(404,{'errors':['fixture: unknown path']})
  self.server=http.server.HTTPServer(('127.0.0.1',0),H);self.port=self.server.server_address[1]
  threading.Thread(target=self.server.serve_forever,daemon=True).start()
 def stop(self):self.server.shutdown();self.server.server_close()
def run_mjs(mode,payload,with_dolt_dir=True,dolt_fail=None,raw=False):
 with tempfile.TemporaryDirectory() as d:
  work=Path(d);(work/'bin').mkdir();(work/'data').mkdir()
  if with_dolt_dir:(work/'data'/'dolt').mkdir()
  stub=work/'bin'/'dolt';stub.write_text(DOLT_OK);stub.chmod(0o755)
  env={'PATH':'/work/bin:/usr/local/bin:/usr/bin:/bin','HOME':'/work'}
  if dolt_fail:env['DOLT_STUB_FAIL']=dolt_fail
  cmd=[BWRAP,'--tmpfs','/','--ro-bind','/usr','/usr','--ro-bind','/bin','/bin','--ro-bind','/lib','/lib','--ro-bind','/sbin','/sbin','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--bind',str(work),'/work','--bind',str(work/'data'),'/data']
  if os.path.isdir('/lib64'):cmd+=['--ro-bind','/lib64','/lib64']
  if os.path.isdir('/etc'):cmd+=['--ro-bind','/etc','/etc']
  for k,v in env.items():cmd+=['--setenv',k,v]
  # Production invocation shape: source via -e (docker run --entrypoint node ... -e SOURCE capture)
  cmd+=['--',NODE,'--input-type=module','-e',MJS.read_text(),mode]
  return subprocess.run(cmd,input=payload if raw else json.dumps(payload),text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120)
@unittest.skipUnless(NODE and BWRAP,'node+bwrap required')
class ContainerStages(unittest.TestCase):
 def payload(self,port,running=True):return {'running':running,'baoAddress':'http://127.0.0.1:'+str(port),'baoToken':'fixture-token','baoMetadataRoots':['secret/metadata/iam']}
 def test_capture_happy_path(self):
  bao=Bao(200,False,['pg'],{'pg':{'current_version':1}})
  try:r=run_mjs('capture',self.payload(bao.port))
  finally:bao.stop()
  self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(r.stderr,'')
  out=json.loads(r.stdout)
  self.assertEqual(out['dolt'],[{'database':'iam','branch':'main','head':'h1','root':'r1'}])
  self.assertEqual(sorted(out['bao']),['secret/metadata/iam/pg'])
 def test_empty_bao_inventory_fails_at_bao_walk(self):
  # Local proof of the empty-isolated-Bao-inventory candidate: LIST 404 on an empty
  # metadata root deterministically fails the capture, attributed to BAO_WALK only.
  bao=Bao(200,False,None,{})
  try:r=run_mjs('capture',self.payload(bao.port))
  finally:bao.stop()
  self.assertEqual(r.returncode,1)
  m=MASKED.fullmatch(r.stderr);self.assertIsNotNone(m,r.stderr);self.assertEqual(m.group(1),'BAO_WALK')
  for leak in ['Error','404','fixture','Traceback',' at ']:self.assertNotIn(leak,r.stderr)
 def test_bao_sealed_fails_at_bao_health(self):
  bao=Bao(200,True,['pg'],{'pg':{'current_version':1}})
  try:r=run_mjs('capture',self.payload(bao.port))
  finally:bao.stop()
  self.assertEqual(r.returncode,1)
  m=MASKED.fullmatch(r.stderr);self.assertIsNotNone(m,r.stderr);self.assertEqual(m.group(1),'BAO_HEALTH')
 def test_bao_unreachable_fails_at_bao_health(self):
  r=run_mjs('capture',self.payload(9))
  self.assertEqual(r.returncode,1)
  m=MASKED.fullmatch(r.stderr);self.assertIsNotNone(m,r.stderr);self.assertEqual(m.group(1),'BAO_HEALTH')
 def test_dolt_query_failure_stage(self):
  bao=Bao(200,False,['pg'],{'pg':{'current_version':1}})
  try:r=run_mjs('capture',self.payload(bao.port),dolt_fail='1')
  finally:bao.stop()
  self.assertEqual(r.returncode,1)
  m=MASKED.fullmatch(r.stderr);self.assertIsNotNone(m,r.stderr);self.assertEqual(m.group(1),'DOLT_QUERY')
 def test_dolt_copy_failure_stage(self):
  bao=Bao(200,False,['pg'],{'pg':{'current_version':1}})
  try:r=run_mjs('capture',self.payload(bao.port,running=False),with_dolt_dir=False)
  finally:bao.stop()
  self.assertEqual(r.returncode,1)
  m=MASKED.fullmatch(r.stderr);self.assertIsNotNone(m,r.stderr);self.assertEqual(m.group(1),'DOLT_COPY')
 def test_invalid_mode_stage(self):
  bao=Bao(200,False,['pg'],{'pg':{'current_version':1}})
  try:r=run_mjs('bogus',self.payload(bao.port))
  finally:bao.stop()
  self.assertEqual(r.returncode,1)
  m=MASKED.fullmatch(r.stderr);self.assertIsNotNone(m,r.stderr);self.assertEqual(m.group(1),'MODE')
 def test_hostile_dolt_stderr_never_leaks(self):
  # Canary: a failing dolt CLI writing secret-looking bytes to ITS OWN stderr must not
  # pass them through (execFileSync stdio explicitly piped): masked line only.
  bao=Bao(200,False,['pg'],{'pg':{'current_version':1}})
  try:r=run_mjs('capture',self.payload(bao.port),dolt_fail='CANARY-SECRET-7f3d9a2b')
  finally:bao.stop()
  self.assertEqual(r.returncode,1)
  m=MASKED.fullmatch(r.stderr);self.assertIsNotNone(m,r.stderr);self.assertEqual(m.group(1),'DOLT_QUERY')
  self.assertNotIn('CANARY-SECRET-7f3d9a2b',r.stderr);self.assertNotIn('CANARY-SECRET-7f3d9a2b',r.stdout)
 def test_invalid_json_input_masked_at_input(self):
  r=run_mjs('capture','{"running":true,BROKEN-INPUT-MARKER',raw=True)
  self.assertEqual(r.returncode,1)
  m=MASKED.fullmatch(r.stderr);self.assertIsNotNone(m,r.stderr);self.assertEqual(m.group(1),'INPUT')
  for leak in ['BROKEN-INPUT-MARKER','SyntaxError',' at ']:self.assertNotIn(leak,r.stderr)
 def test_oversized_input_masked_at_input(self):
  r=run_mjs('capture','{"padding":"'+'A'*300000+'"}',raw=True)
  self.assertEqual(r.returncode,1)
  m=MASKED.fullmatch(r.stderr);self.assertIsNotNone(m,r.stderr);self.assertEqual(m.group(1),'INPUT')
  self.assertNotIn('input bound',r.stderr)
if __name__=='__main__':unittest.main()
