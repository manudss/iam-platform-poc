import copy,importlib.util,json,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('queue',Path(__file__).with_name('ordered-queue.py'));q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
S=lambda n:format(n,'040x');D=lambda n:'sha256:'+format(n,'064x')
class Opening(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'state.json'
  self.gates=[Path(self.tmp.name)/n for n in ['gate','ops']]
  for p in self.gates:p.write_text('retained gate')
  self.s={'format':2,'history':[{'sha':S(1),'digest':D(1)}],'recoveries':[{'target':{'sha':S(1)}}],'recovery_fence':S(1),'resume_required':True,'old_audit':['retained']}
  q.atomic(self.path,self.s);self.calls=[];self.fail=False;self.crash=False
  outer=self
  class Controller:
   def verify(self,*args):return ({'LYAM_FRONT_BARRIER_FILE':str(outer.gates[0]),'LYAM_OPS_BARRIER_FILE':str(outer.gates[1])},{})
   def open_gates(self,*args):
    outer.calls.append('open');s=q.load(outer.path);assert s['opening_intent']['phase']=='opening' and s['format']==3
    outer.gates[0].unlink()
    if outer.crash:raise KeyboardInterrupt()
    if outer.fail:raise ValueError('TLS or hold unknown')
    outer.gates[1].unlink();return {'mode':'ui-open-automation-held','public_status':200,'automation_held':True,'pause_retained':True}
   def close_gates(self,intent):
    outer.calls.append('close')
    for g in intent['gates']:Path(g['path']).write_bytes(bytes.fromhex(g['bytes_hex']))
  self.c=Controller()
 def tearDown(self):self.tmp.cleanup()
 def manifest(self):
  return {'format':1,'kind':'reviewed-ui-held-after-fence','state_fingerprint':q.fingerprint(q.load(self.path)),'expected_delivered':{'sha':S(1),'digest':D(1)},'authorization_ref':'approved exact UI-held operation','evidence_refs':['source evidence'],'target':{'sha':S(2),'digest':D(2)},'chain':[{'sha':S(2),'parent':S(1),'outcome':'ui-open-automation-held'}]}
 def open(self,m=None,verify=None,observe=None):return q.open_reviewed_ui_held(self.path,m or self.manifest(),'repo','fixture',verify=verify or (lambda *a:None),observe=observe or (lambda c,t:{**t,'running':True}),controller=self.c)
 def test_ui_delivery_distinct_keeps_audits_pause_barrier_and_fence(self):
  s=self.open();self.assertTrue(s['resume_required']);self.assertEqual(s['format'],3);self.assertEqual(s['old_audit'],['retained']);self.assertEqual(len(s['recoveries']),2);self.assertEqual(s['history'][-1]['mode'],'ui-open-automation-held');self.assertEqual(s['recovery_fence'],S(2));self.assertNotIn('opening_intent',s)
  with self.assertRaises(ValueError):q.deploy(self.path,{'format':1,'base':S(2),'entries':[]},'never')
  m=self.manifest();m.update(kind='reviewed-resume',expected_delivered={'sha':S(2),'digest':D(2)})
  with self.assertRaisesRegex(ValueError,'generic resume'):q.resume_reviewed(self.path,m,'fixture')
 def test_fail_rearms_access_does_not_advance_cursor_and_blocks_retry(self):
  self.fail=True
  with self.assertRaises(ValueError):self.open()
  s=q.load(self.path);self.assertEqual(s['history'],self.s['history']);self.assertEqual(s['opening_intent']['phase'],'failed-access-rearmed');self.assertTrue(all(p.exists() for p in self.gates))
  with self.assertRaisesRegex(ValueError,'resolved fenced'):self.open()
 def test_interrupt_attempt_also_rearms_and_retains_intent(self):
  self.crash=True
  with self.assertRaises(KeyboardInterrupt):self.open()
  self.assertEqual(self.calls,['open','close']);self.assertIn('opening_intent',q.load(self.path))
 def test_source_and_observation_fail_before_gate_mutation(self):
  def fail(*a):raise ValueError('wrong provenance')
  for kw in [{'verify':fail},{'observe':fail}]:
   with self.assertRaises(ValueError):self.open(**kw)
   self.assertEqual(q.load(self.path),self.s);self.assertEqual(self.calls,[])
 def test_refusals_leave_exact_state(self):
  original=self.manifest()
  for change in [lambda m:m.update(state_fingerprint='stale'),lambda m:m['expected_delivered'].update(digest=D(9)),lambda m:m['target'].update(digest='latest'),lambda m:m['chain'][0].update(parent=S(9)),lambda m:m['chain'][0].update(outcome='delivered'),lambda m:m.update(chain=[]),lambda m:m.update(authorization_ref='')]:
   m=copy.deepcopy(original);change(m)
   with self.assertRaises(ValueError):self.open(m)
   self.assertEqual(q.load(self.path),self.s)
 def test_actual_pending_failed_or_unfenced_not_adopted(self):
  for delta in [{'pending':{'sha':S(2)}},{'failed':{'exit':10}},{'resume_required':False,'resumptions':[{'observed_running':{'sha':S(1)}}]}]:
   s={**self.s,**delta};q.atomic(self.path,s)
   with self.assertRaises(ValueError):self.open()
   self.assertEqual(q.load(self.path),s)
 def test_final_atomic_write_failure_preserves_old_cursor_and_rearms(self):
  from unittest.mock import patch
  real=q.atomic;count=[0]
  def write(path,state):
   count[0]+=1
   if count[0]==2:raise OSError('simulated final disk failure')
   return real(path,state)
  with patch.object(q,'atomic',write),self.assertRaises(OSError):self.open()
  state=q.load(self.path);self.assertEqual(state['history'],self.s['history']);self.assertEqual(len(state['recoveries']),1);self.assertEqual(state['recovery_fence'],S(1));self.assertTrue(all(p.exists() for p in self.gates));self.assertIn('opening_intent',state)
 def test_real_sigkill_between_gate_unlinks_retains_intent_then_rearms(self):
  import os,signal,time
  # Fork isolates actual SIGKILL from this test runner. Double controller only
  # gates the crash point; queue durable serialization is the real implementation.
  pid=os.fork()
  if pid==0:
   def stop_after_one(*args):
    self.gates[0].unlink()
    os.kill(os.getpid(),signal.SIGKILL)
   self.c.open_gates=stop_after_one
   self.open();os._exit(99)
  _,status=os.waitpid(pid,0);self.assertTrue(os.WIFSIGNALED(status));self.assertEqual(os.WTERMSIG(status),signal.SIGKILL)
  state=q.load(self.path);self.assertIn('opening_intent',state);self.assertFalse(self.gates[0].exists());self.assertTrue(self.gates[1].exists());self.assertEqual(state['history'],self.s['history'])
  from unittest.mock import patch
  with patch.object(q,'opening_controller',return_value=self.c):q.rearm_interrupted_opening(self.path)
  self.assertTrue(all(p.exists() for p in self.gates));self.assertEqual(q.load(self.path)['opening_intent']['phase'],'interrupted-access-rearmed');self.assertEqual(q.load(self.path)['history'],self.s['history'])
if __name__=='__main__':unittest.main()
