#!/usr/bin/env python3
import importlib.util,json,signal,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('adv',Path(__file__).with_name('systemd-held-adversarial.py'));a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
class Injection(unittest.TestCase):
 def run_case(self,mode='record-loss',drift=None):
  with tempfile.TemporaryDirectory() as tmp:
   folder=Path(tmp);state=folder/'state';state.write_text('queue bytes')
   wid={'pid':123,'boot_id':'boot','starttime':100};kid={'pid':124,'boot_id':'boot','starttime':101};engagement='fixture-12345678'
   wd=SimpleNamespace(pid=123,unit='lyam-durable-held-'+engagement+'-watchdog.service',identity=wid,cgroup='/system.slice/lyam-durable-held-'+engagement+'-watchdog.service');wk=SimpleNamespace(pid=124,unit='lyam-durable-held-'+engagement+'-worker.service',identity=kid,cgroup='/system.slice/lyam-durable-held-'+engagement+'-worker.service',engagement=engagement)
   bindings={'engagementID':engagement,'watchdog':{'unit':wd.unit,'invocationID':'wi'},'worker':{'unit':wk.unit,'invocationID':'ki'}};(folder/'unit-bindings.json').write_text(json.dumps(bindings));(folder/'watchdog-events.jsonl').write_text(json.dumps({'action':'interrupted-rearm-permitted'})+'\n')
   if drift=='first-tick':(folder/'watchdog-events.jsonl').unlink()
   if drift=='late':(folder/'rearm-attempt.json').write_text('already attempted')
   if drift=='cgroup-path':wk.cgroup='/outside-fixture'
   runtime=['infinity'];calls=[]
   def props(unit):
    if unit==wd.unit:return {'InvocationID':'wi' if drift!='watchdog-inv' else 'replacement','MainPID':'123','ControlGroup':wd.cgroup}
    return {'InvocationID':'ki','MainPID':'0','ActiveState':'failed','SubState':'failed','ControlGroup':'','ExecMainPID':'124','RuntimeMaxUSec':runtime[0]}
   def reset(*args):
    calls.append('reset')
    if drift=='setter':raise RuntimeError('reset-refused')
    wk.fixture_reset={'proof':'in-memory'}
    return {'resetRC':0}
   def sig(pid,which):
    if which==signal.SIGSTOP and drift=='stop-refused':raise PermissionError('refused')
    if which==signal.SIGCONT and drift=='continue-refused':raise PermissionError('refused')
    if which==signal.SIGCONT:
     (folder/'watchdog-result.json').write_text(json.dumps({'action':'terminal-gc-observed-report-only' if drift=='wrong-category' else 'identity-unknown-report-only','report_only':True,'needs_operator':True}))
     if drift=='state':state.write_text('changed')
     if drift=='attempt':(folder/'rearm-attempt.json').write_text('unsafe')
   realread=Path.read_text
   def rd(p,*args,**kwargs):
    if str(p)=='/proc/123/stat':return '123 (watchdog) T rest'
    return realread(p,*args,**kwargs)
   du=SimpleNamespace(state_of=lambda i:'alive' if i==wid else 'absent',unit_properties=props)
   with patch.object(a.os,'kill',side_effect=sig),patch.object(a,'load_record_loss',return_value=SimpleNamespace(reset_worker=reset)),patch.object(Path,'read_text',rd),patch.object(a,'origin_status',return_value=503):
    if drift:
     with self.assertRaises((RuntimeError,PermissionError)):a.inject(folder,{'watchdog':wd,'worker':wk},du,mode,state,'https://fixture.invalid')
    else:
     evidence=a.inject(folder,{'watchdog':wd,'worker':wk},du,mode,state,'https://fixture.invalid');self.assertTrue(evidence['watchdogReportOnly']);self.assertTrue((folder/'adversarial-before-cleanup.json').exists());self.assertTrue(json.loads((folder/'adversarial-cleanup.json').read_text())['passed']);self.assertTrue(wk.fixture_reset)
   return calls
 def test_recordloss_positive(self):self.assertEqual(len(self.run_case()),1)
 def test_runtime_fail_closed(self):
  for drift in ['first-tick','late','watchdog-inv','setter','state','attempt','wrong-category','stop-refused','continue-refused']:
   with self.subTest(drift=drift):self.run_case(drift=drift)
 def test_cgroup_refuses_unbound_path_before_mkdir(self):self.assertEqual(self.run_case(mode='orphan-cgroup',drift='cgroup-path'),[])
class CleanupFailures(unittest.TestCase):
 def test_independent_cleanup_even_after_each_failure(self):
  for fail in ['continue','identity','wait','rmdir']:
   with self.subTest(fail=fail),tempfile.TemporaryDirectory() as tmp:
    folder=Path(tmp);a.atomic_proof(folder/'adversarial-before-cleanup.json',{'originStatusDuringInjection':503})
    wd=SimpleNamespace(pid=123);wk=SimpleNamespace(unit='fixture-worker',identity={'pid':124});ident={'pid':125};actions=[];dead=[False];p={'InvocationID':'original','MainPID':'0','RuntimeMaxUSec':'infinity'}
    def exact():
     actions.append('continue-check')
     if fail=='continue':raise RuntimeError('bad')
    def state(i):return 'absent' if i==wk.identity or dead[0] else 'alive'
    def kill(pid,sig):actions.append('kill' if pid==125 else 'continue')
    def wait(timeout):
     actions.append('wait')
     if fail=='wait':raise TimeoutError()
     dead[0]=True
    class CG:
     def __truediv__(self,name):return SimpleNamespace(read_text=lambda:'' if name=='cgroup.procs' else 'populated 0')
     def rmdir(self):
      actions.append('rmdir')
      if fail=='rmdir':raise OSError()
    def props(unit):return {**p,'InvocationID':'replacement'} if fail=='replacement' else p
    def cmd(*args,**kwargs):
     actions.append('restore')
     return SimpleNamespace(returncode=1 if fail=='restore' else 0,stdout='',stderr='')
    du=SimpleNamespace(state_of=state,unit_properties=props)
    with patch.object(a.os,'kill',side_effect=kill),patch.object(a.subprocess,'run',side_effect=cmd),self.assertRaises(RuntimeError):a.cleanup_injection(folder,wd,wk,du,exact,True,SimpleNamespace(wait=wait,pid=125),None if fail=='identity' else ident,[CG(),CG()],True,True,p)
    self.assertEqual(actions.count('rmdir'),2)
    if fail!='identity':self.assertIn('wait',actions)
    self.assertNotIn('restore',actions)
    self.assertTrue((folder/'adversarial-before-cleanup.json').exists());self.assertFalse(json.loads((folder/'adversarial-cleanup.json').read_text())['passed'])
if __name__=='__main__':unittest.main()
