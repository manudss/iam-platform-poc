import importlib.util,tempfile,unittest,json,hashlib
from pathlib import Path
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('recovery',Path(__file__).with_name('recover-in-place.py'));r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
class Recovery(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.d=Path(self.tmp.name);self.barrier=self.d/'MAINTENANCE';self.token='lyam-update:361992:20261123T200000Z';self.barrier.write_text(self.token+'\n');self.pause=self.d/'PAUSED';self.pause.touch();self.state=self.d/'state.json';sha='a'*40;digest='sha256:'+'b'*64;last={'sha':'c'*40,'digest':'sha256:'+'d'*64};pending={'sha':sha,'digest':digest,'parent':last['sha']};state={'format':1,'history':[last],'pending':pending,'failed':{'sha':sha,'exit':4}};r.queue.atomic(self.state,state);self.image='ghcr.io/manudss/iam-platform-poc@'+digest
  self.before=self.d/'before.json';self.before.write_text(json.dumps({'image':'old','policyHash':'p'}));self.calls=[]
  for name in ['qualification.py','qualification-container.mjs']:(self.d/name).write_text('fictional pinned script')
  def pin(p):return {'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
  self.pin=pin
  self.m={'format':1,'kind':'reviewed-in-place-opening','authorization_ref':'reviewed user approval reference','evidence_refs':['private incident'],'state':str(self.state),'pause_file':str(self.pause),'original_before':pin(self.before),'qualification_script':pin(self.d/'qualification.py'),'qualification_helper':pin(self.d/'qualification-container.mjs'),'barrier_token':self.token,'former_pid':361992,'barrier_file':str(self.barrier),'origins':['https://example.test'],'container':'fictional','repository':'reviewed-repository','queue_manifest':{'format':1,'kind':'reviewed-in-place','state_fingerprint':r.queue.fingerprint(state),'expected_delivered':last,'authorization_ref':'approval','evidence_refs':['evidence'],'original_unresolved':{k:state[k] for k in ['pending','failed']},'chain':[{**pending,'outcome':'delivered'}],'target':{'sha':sha,'digest':digest},'qualification':{'sha':sha,'digest':digest,'evidence_refs':['qualification']}},'qualification_args':{'container':'fictional','env-file':'private-env','data-dir':'private-data','backup-dir':'backup','target-image':self.image,'evidence-dir':str(self.d),'policy':'private-policy','receipt-file':str(self.d/'success.json')}}
 def tearDown(self):self.tmp.cleanup()
 def qualify(self,args,**kw):
  self.calls.append(args);after=self.d/'after.json';smoke=self.d/'smoke.json';after.write_text(json.dumps({'image':self.image,'policyHash':'p'}));smoke.write_text(json.dumps({'journal':{'count':1},'ledger':'valid'}));receipt={'format':1,'result':'qualified','transportCoverage':'TLS_EXPECTED_ORIGINS','image':self.image,'policyHash':'p'}
  for k,p in [('before',self.before),('after',after),('smoke',smoke)]:receipt[k+'_path']=str(p);receipt[k+'_sha256']=self.pin(p)['sha256']
  (self.d/'success.json').write_text(json.dumps(receipt));return SimpleNamespace(returncode=0)
 def recover(self,**kw):return r.recover(self.m,run=kw.get('run',self.qualify),is_dead=kw.get('dead',lambda p:True),front=kw.get('front',lambda o:503 if self.barrier.exists() else 200),observe=lambda *a:None,verify=lambda *a:None,record=kw.get('record',lambda *a:self.calls.append('record')))
 def test_success_qualifies_before_opening_retains_pause_and_requests_separate_resume(self):
  out=self.recover();self.assertTrue(out['opened']);self.assertTrue(out['queue_resume_required']);self.assertTrue(self.pause.exists());self.assertFalse(self.barrier.exists());self.assertEqual(self.calls[-1],'record')
 def test_qualification_exit_nonzero_never_opens(self):
  with self.assertRaisesRegex(ValueError,'qualification failed'):self.recover(run=lambda *a,**k:SimpleNamespace(returncode=1))
  self.assertEqual(self.barrier.read_text().strip(),self.token)
 def test_live_owner_foreign_marker_missing_pause_or_changed_before_refuse(self):
  with self.assertRaises(ValueError):self.recover(dead=lambda p:False)
  self.barrier.write_text('foreign')
  with self.assertRaises(ValueError):self.recover()
  self.barrier.write_text(self.token);self.pause.unlink()
  with self.assertRaises(ValueError):self.recover()
 def test_failed_public_probe_rearms_exact_owner_and_never_records(self):
  with self.assertRaisesRegex(ValueError,'TLS opening'):self.recover(front=lambda o:503 if self.barrier.exists() else 502)
  self.assertEqual(self.barrier.read_text().strip(),self.token);self.assertNotIn('record',self.calls)
 def test_queue_record_error_rearms_and_retains_pause(self):
  def fail(*a):raise ValueError('queue record failed')
  with self.assertRaises(ValueError):self.recover(record=fail)
  self.assertEqual(self.barrier.read_text().strip(),self.token);self.assertTrue(self.pause.exists())
 def test_changed_before_and_missing_receipt_never_open(self):
  self.before.write_text('{}')
  with self.assertRaisesRegex(ValueError,'pinned'):self.recover()
  self.assertTrue(self.barrier.exists());self.assertEqual(self.calls,[])
 def test_interruption_after_open_rearms(self):
  def interrupt(*a):raise KeyboardInterrupt('fixture interrupt')
  with self.assertRaises(KeyboardInterrupt):self.recover(record=interrupt)
  self.assertTrue(self.barrier.exists());self.assertTrue(self.pause.exists())
 def test_wrong_pending_target_stops_before_qualification_or_open(self):
  self.m['queue_manifest']['target']['digest']='sha256:'+'f'*64
  with self.assertRaisesRegex(ValueError,'exact failed'):self.recover()
  self.assertTrue(self.barrier.exists());self.assertEqual(self.calls,[])
 def test_interrupt_after_unlink_before_next_statement_rearms(self):
  from unittest.mock import patch
  original=Path.unlink;barrier=self.barrier
  def interrupted(path,*args,**kw):
   out=original(path,*args,**kw)
   if path==barrier:raise KeyboardInterrupt('signal immediately after unlink syscall')
   return out
  with patch.object(Path,'unlink',interrupted):
   with self.assertRaises(KeyboardInterrupt):self.recover()
  self.assertEqual(self.barrier.read_text().strip(),self.token);self.assertNotIn('record',self.calls)
 def test_foreign_marker_appearing_after_unlink_is_not_overwritten(self):
  from unittest.mock import patch
  original=Path.unlink;barrier=self.barrier
  def interrupted(path,*args,**kw):
   out=original(path,*args,**kw)
   if path==barrier:path.write_text('foreign-owner');raise KeyboardInterrupt('foreign gate appeared')
   return out
  with patch.object(Path,'unlink',interrupted):
   with self.assertRaises(KeyboardInterrupt):self.recover()
  self.assertEqual(self.barrier.read_text(),'foreign-owner')
if __name__=='__main__':unittest.main()
