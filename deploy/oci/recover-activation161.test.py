import unittest,importlib.util,json,copy,hashlib
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

def mod(n,f):
 s=importlib.util.spec_from_file_location(n,Path(__file__).with_name(f));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
r=mod('opening','recover-activation161.py');fixtures=mod('fixtures','activation161-exception.test.py')
class OpeningTests(unittest.TestCase):
 def setUp(self):
  self.f=fixtures.ExceptionMode();self.f.setUp();f=self.f;self.d=f.d
  for name in ['STATE','UPDATE_LOCK','PAUSE']:setattr(r.ex,name,getattr(fixtures.ex,name))
  state=json.loads(f.incident.read_text());state['format']=1;state['history'][0]['digest']='sha256:'+'d'*64;f.incident.write_text(json.dumps(state));f.m['original_incident']=state;f.m['incident_sha256']=r.ex.sha(f.incident.read_bytes())
  f.policy['origins']=['https://fixture.test'];f.policyfile.write_text(json.dumps(f.policy));ph=r.ex.sha(f.policyfile.read_bytes());f.b.update(policyHash=ph,transportCoverage='TLS_EXPECTED_ORIGINS');f.a.update(policyHash=ph,transportCoverage='TLS_EXPECTED_ORIGINS');f.before.write_text(json.dumps(f.b));f.m.update(before_sha256=r.ex.sha(f.before.read_bytes()),policy_sha256=ph);f.manifest.write_text(json.dumps(f.m))
  closed=f.runobj();closed.capture_value=f.c;closed.save(fixtures.q.private_json,f.b,f.a,{'journal':{'count':3},'ledger':'valid'},fixtures.q.compare);closed.close()
  self.barrier=self.d/'MAINTENANCE';self.token='lyam-update:999999:20261123T200000Z';self.barrier.write_text(self.token+'\n');r.BARRIER=self.barrier
  pin=lambda p:{'path':str(p),'sha256':r.ex.sha(p.read_bytes())}
  target={'sha':'a'*40,'digest':r.ex.IMAGE.split('@')[1]}
  self.m={'format':1,'kind':r.KIND,'authorization_ref':'explicit separate opening approval','evidence_refs':['reviewed evidence'],'closed_manifest':pin(f.manifest),'before':pin(f.before),'closed_result':pin(self.d/'result/closed-exception-result.json'),'code_sha256':{n:r.ex.sha((r.HERE/n).read_bytes())for n in r.CODE},'one_shot_claim':str(self.d/'opening-claim'),'output':str(self.d/'opening-output'),'barrier_file':str(self.barrier),'barrier_token':self.token,'former_pid':999999,'origins':f.policy['origins'],'container':'fixture','data_dir':str(self.d),'repository':'fixture','queue_manifest':{'format':1,'kind':r.KIND,'state_fingerprint':r.queue.fingerprint(state),'expected_delivered':state['history'][-1],'authorization_ref':'opening','evidence_refs':['evidence'],'target':target,'chain':[{'sha':target['sha'],'parent':'b'*40,'outcome':'delivered'}],'original_unresolved':{k:state[k]for k in ['pending','failed']}}}
  self.path=self.d/'opening.json';self.sync();self.attempts=[]
 def sync(self):self.path.write_text(json.dumps(self.m))
 def attempt(self):
  a=r.Opening(self.path,r.ex.sha(self.path.read_bytes()));self.attempts.append(a);return a
 def tearDown(self):
  for a in self.attempts:a.close()
  self.f.tearDown()
 def capture(self,m,v):v.capture_value=copy.deepcopy(self.f.c);return copy.deepcopy(self.f.a)
 def runit(self,a=None,**kw):
  args={'capture':self.capture,'observe':lambda *x:{'sha':'a'*40},'verify':lambda *x:None,'front':lambda o:503 if self.barrier.exists()else 200,'is_dead':lambda p:True,'identify':lambda c:{'Id':'fixture','Image':'fixture','RestartCount':0,'StartedAt':'fixed'}};args.update(kw);return(a or self.attempt()).run(**args)
 def test_success_records_exception_fence_pause_and_explicit_resume(self):
  result=self.runit();state=r.queue.load(self.f.incident);self.assertTrue(result['opened']);self.assertFalse(self.barrier.exists());self.assertTrue(r.ex.PAUSE.exists());self.assertTrue(state['resume_required']);self.assertEqual(state['format'],2);self.assertNotIn('pending',state);audit=state['recoveries'][-1];self.assertEqual(audit['kind'],r.KIND);self.assertIn('failed',audit['original_unresolved']);self.assertEqual(audit['closed_result'],self.m['closed_result'])
  with self.assertRaises(ValueError):r.queue.checked_manifest(state,self.m['queue_manifest'],'reviewed-in-place')
  with self.assertRaises(ValueError):r.queue.deploy(self.f.incident,{'format':1,'base':'b'*40,'entries':[]},'not-executed')
 def test_separate_claim_consumed_after_failure_no_fresh_output_retry(self):
  a=self.attempt()
  with self.assertRaises(ValueError):self.runit(a,is_dead=lambda p:False)
  a.close();self.m['output']=str(self.d/'another-output');self.sync()
  with self.assertRaises(FileExistsError):self.attempt()
 def test_normal_or_altered_receipt_and_wrong_manifest_refuse(self):
  for key,value in [('format',1),('type','normal'),('result','qualified'),('image','other')]:
   raw=json.loads((self.d/'result/closed-exception-result.json').read_text());changed={**raw,key:value};p=self.d/'altered-result.json';p.write_text(json.dumps(changed));m=copy.deepcopy(self.m);m['closed_result']={'path':str(p),'sha256':r.ex.sha(p.read_bytes())}
   with self.subTest(key=key),self.assertRaises(ValueError):r.verify_closed(m)
  self.m['kind']='reviewed-in-place-opening';self.sync()
  with self.assertRaises(ValueError):self.attempt()
 def test_live_pid_foreign_gate_early200_or_missing_pause_refuse(self):
  a=self.attempt()
  for change in ['pid','foreign','200','pause']:
   a.started=False # isolated failure-path subcase, production CLI never resets this
   self.barrier.write_text(self.token+'\n');r.ex.PAUSE.touch();kw={}
   if change=='pid':kw['is_dead']=lambda p:False
   if change=='foreign':self.barrier.write_text('foreign')
   if change=='200':kw['front']=lambda o:200
   if change=='pause':r.ex.PAUSE.unlink()
   with self.subTest(change=change),self.assertRaises(ValueError):self.runit(a,**kw)
 def test_final_capture_added_activation_or_non_target_drift_refuse(self):
  a=self.attempt()
  for change in ['activation','bao','credentials']:
   a.started=False # isolated test subcase
   def bad(m,v):
    out=self.capture(m,v)
    if change=='activation':v.capture_value['projection']['pairs'][0]['legacy']='f'*64
    else:out[change]={}
    return out
   with self.subTest(change=change),self.assertRaises(ValueError):self.runit(a,capture=bad)
   self.assertTrue(self.barrier.exists())
 def test_missing_capture_or_registry_change_or_identity_change_refuse(self):
  a=self.attempt()
  with self.assertRaises(ValueError):self.runit(a,capture=lambda m,v:dict(self.f.a,postgres={}))
  a.started=False
  def changed(m,v):
   state=json.loads(self.f.incident.read_text());state['failed']['exit']=7;self.f.incident.write_text(json.dumps(state));return self.capture(m,v)
  with self.assertRaises(ValueError):self.runit(a,capture=changed)
  self.assertTrue(self.barrier.exists())
 def test_container_restart_or_stale_capture_refuse(self):
  a=self.attempt();counter=[0]
  def identify(c):counter[0]+=1;return{'restart':counter[0]}
  with self.assertRaises(ValueError):self.runit(a,identify=identify)
  a.started=False
  with patch.object(r.time,'monotonic',side_effect=[0,61]):
   with self.assertRaisesRegex(ValueError,'stale'):self.runit(a)
  self.assertTrue(self.barrier.exists())
 def test_tls503_after_unlink_rearms_without_record(self):
  with self.assertRaises(ValueError):self.runit(front=lambda o:503)
  self.assertEqual(self.barrier.read_text().strip(),self.token);self.assertIn('pending',r.queue.load(self.f.incident))
 def test_recorder_failure_and_postwrite_uncertainty_preserve_audit(self):
  def write(path,value):r.queue.atomic(path,value);raise OSError('fixture fsync uncertainty')
  with self.assertRaisesRegex(RuntimeError,'queue write attempted'):self.runit(write=write)
  self.assertTrue(self.barrier.exists());self.assertTrue(r.queue.load(self.f.incident)['resume_required']);self.assertTrue(r.ex.PAUSE.exists())
 def test_recorder_failure_before_write_rearms_without_ad_hoc_queue_edit(self):
  with self.assertRaisesRegex(RuntimeError,'queue write attempted'):self.runit(write=lambda *a:(_ for _ in[]).throw(OSError('fixture failure')))
  self.assertTrue(self.barrier.exists());self.assertIn('pending',r.queue.load(self.f.incident))
 def test_interrupt_immediately_after_unlink_rearms_and_foreign_marker_preserved(self):
  a=self.attempt();original=Path.unlink
  def interrupt(p,*args,**kw):
   value=original(p,*args,**kw)
   if p==self.barrier:raise KeyboardInterrupt('fixture signal')
   return value
  with patch.object(Path,'unlink',interrupt),self.assertRaises(KeyboardInterrupt):self.runit(a)
  self.assertEqual(self.barrier.read_text().strip(),self.token)
  self.tearDown();self.setUp();a=self.attempt()
  def foreign(p,*args,**kw):
   value=original(p,*args,**kw)
   if p==self.barrier:p.write_text('foreign');raise KeyboardInterrupt('fixture foreign')
   return value
  with patch.object(Path,'unlink',foreign),self.assertRaises(KeyboardInterrupt):self.runit(a)
  self.assertEqual(self.barrier.read_text(),'foreign')
 def test_closed_claim_and_other_incident_refuse(self):
  a=self.attempt();Path(self.f.m['one_shot_claim']).write_text('wrong\n')
  with self.assertRaisesRegex(ValueError,'claim'):self.runit(a)
 def test_normal_queue_verifier_never_accepts_opening_or_closed_type(self):
  with self.assertRaises(ValueError):r.queue.verify_qualification_receipt(self.m,self.m['queue_manifest']['target'])
  with self.assertRaises(ValueError):r.queue.checked_manifest(r.queue.load(self.f.incident),self.m['queue_manifest'],'reviewed-in-place')
 def test_reentry_and_opening_claim_mutation_refuse(self):
  a=self.attempt()
  with self.assertRaises(ValueError):self.runit(a,is_dead=lambda p:False)
  with self.assertRaisesRegex(ValueError,'consumed'):self.runit(a)
  a.started=False;Path(self.m['one_shot_claim']).write_text('other')
  with self.assertRaisesRegex(ValueError,'claim changed'):self.runit(a)
 def test_absent_fresh_capture_cannot_reuse_closed_capture(self):
  a=self.attempt()
  with self.assertRaisesRegex(ValueError,'capture/after'):self.runit(a,capture=lambda m,v:copy.deepcopy(self.f.a))
  self.assertTrue(self.barrier.exists())
 def test_wrong_digest_chain_fingerprint_or_origins_never_open(self):
  for change in ['digest','chain','fingerprint','origins']:
   self.tearDown();self.setUp()
   if change=='digest':self.m['queue_manifest']['target']['digest']='sha256:'+'e'*64
   if change=='chain':self.m['queue_manifest']['chain'][0]['parent']='e'*40
   if change=='fingerprint':self.m['queue_manifest']['state_fingerprint']='e'*64
   if change=='origins':self.m['origins']=['https://other.test']
   self.sync()
   with self.subTest(change=change),self.assertRaises(ValueError):self.runit()
   self.assertTrue(self.barrier.exists())
 def test_git_or_image_validation_failure_never_opens(self):
  a=self.attempt()
  with self.assertRaises(ValueError):self.runit(a,verify=lambda *a:(_ for _ in[]).throw(ValueError('chain mismatch')))
  a.started=False
  with self.assertRaises(ValueError):self.runit(a,observe=lambda *a:(_ for _ in[]).throw(ValueError('wrong OCI')))
  self.assertTrue(self.barrier.exists())
 def test_manifest_and_code_mutation_after_capture_refuse(self):
  a=self.attempt()
  def changed(m,v):
   result=self.capture(m,v);self.path.write_text('{}');return result
  with self.assertRaises(ValueError):self.runit(a,capture=changed)
  self.assertTrue(self.barrier.exists())
 def test_old_plan_refused_even_if_resume_flag_later_explicitly_cleared(self):
  self.runit();state=r.queue.load(self.f.incident);state['resume_required']=False;state['resumptions']=[{'observed_running':{'sha':'a'*40}}];r.queue.atomic(self.f.incident,state)
  with self.assertRaisesRegex(ValueError,'predates'):r.queue.deploy(self.f.incident,{'format':1,'base':'b'*40,'entries':[]},'never-run')
if __name__=='__main__':unittest.main()
