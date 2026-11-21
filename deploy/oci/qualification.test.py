import importlib.util,tempfile,unittest,copy,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('qual',Path(__file__).with_name('qualification.py'));q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
def baseline():return {'dolt':[{'branch':'personal/kept','root':'root'}],'bao':{'all/plugin':'hash'},'credentials':{'credentials.json':'hash'},'postgres':{'rows':{'public.business':{'row1':1},'public.audit':{'row1':1}},'schema':{'columns':[]},'sequenceDefinitions':[],'sequences':{'public.audit_id':{'last_value':1,'is_called':True}}}}
class Preserve(unittest.TestCase):
 def setUp(self):self.p={'appendOnlyTables':['public.audit']};self.before=baseline();self.after=copy.deepcopy(self.before)
 def test_identical(self):self.assertEqual(q.compare(self.before,self.after,self.p),[])
 def test_audit_append_allowed_not_business(self):
  self.after['postgres']['rows']['public.audit']['row2']=1;self.assertEqual(q.compare(self.before,self.after,self.p),[])
  self.after['postgres']['rows']['public.business']['row2']=1;self.assertIn('postgres-rows:public.business',q.compare(self.before,self.after,self.p))
 def test_old_audit_row_must_survive(self):
  self.after['postgres']['rows']['public.audit']={'row2':99};self.assertTrue(q.compare(self.before,self.after,self.p))
 def test_duplicates_cannot_disappear(self):
  self.before['postgres']['rows']['public.audit']['row1']=2;self.assertTrue(q.compare(self.before,self.after,self.p))
 def test_personal_dirty_branch_never_disposable(self):
  self.after['dolt'][0]['root']='lost';self.assertIn('dolt',q.compare(self.before,self.after,self.p))
 def test_missing_secret_metadata_is_loss_not_absence(self):
  self.after['bao']={};self.assertIn('bao',q.compare(self.before,self.after,self.p))
 def test_credential_replacement_detected(self):
  self.after['credentials']['credentials.json']='new';self.assertIn('credentials',q.compare(self.before,self.after,self.p))
 def test_schema_constraint_drift_detected(self):
  self.after['postgres']['schema']['constraint']='changed';self.assertIn('postgres-schema',q.compare(self.before,self.after,self.p))
 def test_table_drop_detected(self):
  del self.after['postgres']['rows']['public.business'];self.assertIn('postgres-tables',q.compare(self.before,self.after,self.p))
 def test_sequence_monotonic_and_called(self):
  self.after['postgres']['sequences']['public.audit_id']['last_value']=2;self.assertEqual(q.compare(self.before,self.after,self.p),[])
  self.after['postgres']['sequences']['public.audit_id']['last_value']=0;self.assertTrue(q.compare(self.before,self.after,self.p))
 def test_policy_required_independent_coverage(self):
  with tempfile.TemporaryDirectory() as d:
   file=Path(d)/'policy.json';file.write_text('{}')
   with self.assertRaises(ValueError):q.policy_load(file)
   example=Path(__file__).with_name('qualification.policy.example.json');self.assertEqual(q.policy_load(example)['format'],1)
 def test_http_only_explicit_isolated_loopback_never_production(self):
  p=json.loads(Path(__file__).with_name('qualification.policy.example.json').read_text());p['origins']=['http://127.0.0.1:19087'];p['isolatedLoopbackTest']=True
  with tempfile.TemporaryDirectory() as d:
   file=Path(d)/'p.json';file.write_text(json.dumps(p))
   with self.assertRaises(ValueError):q.policy_load(file)
   self.assertEqual(q.policy_load(file,True)['origins'],p['origins'])
   p['origins']=['http://example.invalid'];file.write_text(json.dumps(p))
   with self.assertRaises(ValueError):q.policy_load(file,True)
   p['origins']=['http://127.0.0.1.evil.invalid'];file.write_text(json.dumps(p))
   with self.assertRaises(ValueError):q.policy_load(file,True)
 def test_private_evidence_never_overwritten(self):
  with tempfile.TemporaryDirectory() as d:
   file=Path(d)/'private.json';q.private_json(file,{'ok':True});self.assertEqual(file.stat().st_mode&0o777,0o600)
   with self.assertRaises(FileExistsError):q.private_json(file,{})
class Stages(unittest.TestCase):
 def tearDown(self):q._state['stage']='POLICY'
 def test_mark_closed_enum(self):
  q.mark('CAPTURE');self.assertEqual(q.current_stage(),'CAPTURE')
  with self.assertRaises(ValueError):q.mark('BOGUS')
 def test_child_stage_extraction_closed_enum_only(self):
  self.assertEqual(q.child_stage('Qualification UNKNOWN or failed (stage=BAO_WALK). Preserve private evidence and keep maintenance armed.'),'BAO_WALK')
  self.assertIsNone(q.child_stage('anything without marker'))
  self.assertIsNone(q.child_stage('(stage=NOT_A_STAGE)'))
  self.assertIsNone(q.child_stage('(stage=secretvalue)'))
  self.assertIsNone(q.child_stage('(stage=)'))
  self.assertEqual(q.child_stage('(stage=DOLT_QUERY)\n(stage=BAO_WALK)'),'BAO_WALK')
  self.assertIsNone(q.child_stage(None))
 def test_cmd_child_failure_raises_stage_failure(self):
  with self.assertRaises(q.StageFailure) as c:q.cmd(['sh','-c','echo "Qualification UNKNOWN or failed (stage=BAO_WALK). Preserve private evidence and keep maintenance armed." >&2; exit 1'],child=True)
  self.assertEqual(c.exception.stage,'BAO_WALK')
  q.mark('CAPTURE')
  with self.assertRaises(q.StageFailure) as c:q.cmd(['sh','-c','echo "unexpected unclassified child output" >&2; exit 1'],child=True)
  self.assertEqual(c.exception.stage,'CAPTURE')
  with self.assertRaises(ValueError):q.cmd(['sh','-c','exit 1'])
 def test_before_phase_reports_child_stage_without_exception_content(self):
  import subprocess,threading,http.server,os,shutil
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'data').mkdir();(root/'data'/'x.json').write_text('{}')
   (root/'barrier').write_text('armed');(root/'env').write_text('');(root/'bao-token').write_text('fixture')
   (root/'auth.json').write_text('{"username":"u","password":"p"}')
   policy={'format':1,'origins':['http://127.0.0.1:19091'],'issuer':'http://127.0.0.1:8080','tenant':'demo','pgContainer':'pg','pgUser':'u','pgDatabase':'db','network':'none','authFile':str(root/'auth.json'),'baoMetadataRoots':['secret/metadata/iam'],'baoAddress':'http://127.0.0.1:18200','baoTokenFile':str(root/'bao-token'),'credentialFiles':['x.json'],'appendOnlyTables':[],'isolatedLoopbackTest':True}
   (root/'policy.json').write_text(json.dumps(policy))
   handler=type('H',(http.server.BaseHTTPRequestHandler,),{'do_GET':lambda s:(s.send_response(503),s.end_headers()),'log_message':lambda s,*a:None})
   server=http.server.HTTPServer(('127.0.0.1',19091),handler);threading.Thread(target=server.serve_forever,daemon=True).start()
   bin_dir=root/'bin';bin_dir.mkdir()
   docker=bin_dir/'docker';docker.write_text('#!/bin/sh\nif [ "$1" = inspect ]; then echo false; exit 0; fi\nif [ "$1" = run ]; then echo "Qualification UNKNOWN or failed (stage=BAO_WALK). Preserve private evidence and keep maintenance armed." >&2; exit 1; fi\nexit 1\n');docker.chmod(0o755)
   env=dict(os.environ,PATH=str(bin_dir)+':'+os.environ['PATH'])
   args=['python3',str(Path(__file__).with_name('qualification.py')),'--phase','before','--container','api','--image','img','--env-file',str(root/'env'),'--data-dir',str(root/'data'),'--backup-dir',str(root/'data'),'--barrier-file',str(root/'barrier'),'--target-image','img','--evidence-dir',str(root/'evidence'),'--policy',str(root/'policy.json'),'--isolated-loopback-test']
   r=subprocess.run(args,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
   server.shutdown()
   self.assertEqual(r.returncode,1)
   self.assertIn('stage=BAO_WALK',r.stderr)
   self.assertNotIn('Traceback',r.stderr);self.assertNotIn('fixture',r.stderr)
if __name__=='__main__':unittest.main()
