#!/usr/bin/env python3
import copy,hashlib,importlib.util,json,os,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('rl',Path(__file__).with_name('systemd-held-record-loss.py'));r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
spec=importlib.util.spec_from_file_location('adv',Path(__file__).with_name('systemd-held-adversarial.py'));a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
class ResetProof(unittest.TestCase):
 def fixture(self,folder):
  eng='fixture-12345678';roles={}
  for role,pid in [('worker',124),('watchdog',123)]:
   unit='lyam-durable-held-'+eng+'-'+role+'.service';ident={'pid':pid,'starttime':100+pid,'boot_id':'boot-one'}
   roles[role]=SimpleNamespace(unit=unit,pid=pid,identity=ident,cgroup='/system.slice/'+unit,engagement=eng)
  b={'kind':'held-update','engagementID':eng,**{role:{**h.identity,'unit':h.unit,'invocationID':role+'-inv','controlGroup':h.cgroup} for role,h in roles.items()}}
  props={'InvocationID':'worker-inv','MainPID':'0','ControlGroup':'','ExecMainPID':'124','ActiveState':'failed','SubState':'failed','Result':'signal','ExecMainCode':'2','ExecMainStatus':'9','ExecMainStartTimestampMonotonic':'987','ExecMainExitTimestampMonotonic':'999'}
  rec={**b['worker'],'engagementID':eng,'start':987};(folder/'worker-unit-start.json').write_text(json.dumps(rec));(folder/'unit-bindings.json').write_text(json.dumps(b))
  before={k:props[k] for k in ['InvocationID','MainPID','ControlGroup','ActiveState','SubState']};before['LoadState']='loaded'
  after={'LoadState':'not-found','ActiveState':'inactive','SubState':'dead','MainPID':'0','InvocationID':'','ControlGroup':''}
  du=SimpleNamespace(state_of=lambda i:'alive' if i==roles['watchdog'].identity else 'absent',unit_properties=lambda u:props if u==roles['worker'].unit else {'InvocationID':'watchdog-inv','MainPID':'123','ControlGroup':roles['watchdog'].cgroup},FAILED_TUPLES={'signal':('2',64)},temporal_ok=lambda *args:True,worker_record=lambda *args:rec)
  rt=SimpleNamespace(independent_cgroup_state=lambda cg:'gone',final_cleanup_manager=lambda u:before)
  return roles,b,props,du,rt,before,after
 def reset(self,folder,drift=None):
  roles,b,p,du,rt,before,after=self.fixture(folder);calls=[]
  if drift=='binding':b['worker']['pid']=999
  if drift=='tuple':p['Result']='timeout'
  if drift=='stamp':du.temporal_ok=lambda *args:False
  if drift=='alive':du.state_of=lambda i:'alive'
  if drift=='cgroup':rt.independent_cgroup_state=lambda cg:'empty'
  baseprops=du.unit_properties
  if drift=='watchdog-inv':du.unit_properties=lambda u:{**baseprops(u),'InvocationID':'replacement'} if u==roles['watchdog'].unit else baseprops(u)
  if drift=='lastcheck':du.unit_properties=lambda u:{**baseprops(u),'Result':'timeout'} if u==roles['worker'].unit else baseprops(u)
  if drift=='late':(folder/'rearm-attempt.json').write_text('late')
  def cmd(args,**kwargs):
   calls.append(args);rt.final_cleanup_manager=lambda u:after
   return SimpleNamespace(returncode=1 if drift=='reset-refused' else 0,stdout='',stderr='')
  realread=Path.read_text
  def rd(p,*args,**kwargs):
   if str(p)=='/proc/123/stat':return '123 (watchdog) S rest' if drift=='watchdog-not-stopped' else '123 (watchdog) T rest'
   return realread(p,*args,**kwargs)
  with patch.object(r.subprocess,'run',side_effect=cmd),patch.object(Path,'read_text',rd):
   if drift:
    with self.assertRaises(RuntimeError):r.reset_worker(folder,roles['worker'],roles['watchdog'],du,b,p,rt,a.atomic_proof,b'queue bytes')
   else:r.reset_worker(folder,roles['worker'],roles['watchdog'],du,b,p,rt,a.atomic_proof,b'queue bytes')
  return roles,b,p,du,rt,before,after,calls
 def test_reset_exact_and_durable(self):
  with tempfile.TemporaryDirectory() as t:
   folder=Path(t)/('sup-'+r.SCENARIO);folder.mkdir();roles,b,p,du,rt,before,after,calls=self.reset(folder)
   self.assertEqual(calls,[['systemctl','reset-failed',roles['worker'].unit]])
   self.assertEqual(os.stat(folder/'record-loss-reset-proof.json').st_mode&0o777,0o600)
   self.assertEqual(roles['worker'].fixture_reset['proof']['after'],after)
 def test_preconditions_and_reset_failure(self):
  for drift in ['binding','tuple','stamp','alive','cgroup','reset-refused','watchdog-not-stopped','watchdog-inv','lastcheck','late']:
   with self.subTest(drift=drift),tempfile.TemporaryDirectory() as t:
    folder=Path(t)/('sup-'+r.SCENARIO);folder.mkdir();*_,calls=self.reset(folder,drift)
    self.assertEqual(len(calls),1 if drift=='reset-refused' else 0)
 def args(self,folder):
  roles,b,p,du,rt,before,after,calls=self.reset(folder);h=roles['worker'];old={'identity':h.identity,'role':'worker','engagement':h.engagement,'cgroup':h.cgroup};no={'originalMainState':'absent','originalCgroupState':'gone'}
  return [h.unit,old,{k:v for k,v in after.items() if k!='LoadState'},no.copy(),no.copy(),{'returnCode':5,'exactUnitNotLoaded':True,'stdoutEmpty':True},after,b['worker'],h.fixture_reset,folder]
 def test_cleanup_requires_caller_and_every_identity(self):
  cases=[(1,'role','watchdog'),(1,'engagement','other-engagement'),(1,'identity',None),(2,'InvocationID','changed'),(3,'originalCgroupState','empty'),(3,'originalMainState','alive'),(4,'originalCgroupState','populated'),(4,'originalMainState','unknown'),(5,'returnCode',1),(5,'stdoutEmpty',False),(5,'exactUnitNotLoaded',False),(6,'LoadState','loaded'),(7,'pid',125),(7,'starttime',9),(7,'boot_id','other'),(7,'invocationID','other'),(7,'controlGroup','/other'),(8,'scenario','other'),(8,'sha256','bad')]
  for index,key,value in cases:
   with self.subTest(index=index,key=key),tempfile.TemporaryDirectory() as t:
    folder=Path(t)/('sup-'+r.SCENARIO);folder.mkdir();args=self.args(folder);self.assertTrue(r.cleanup_reset_noop(*args));args[index]=copy.deepcopy(args[index]);args[index][key]=value;self.assertFalse(r.cleanup_reset_noop(*args))
  with tempfile.TemporaryDirectory() as t:
   folder=Path(t)/('sup-'+r.SCENARIO);folder.mkdir();args=self.args(folder);args[8]=None;self.assertFalse(r.cleanup_reset_noop(*args))
 def test_real_cleanup_collector_thirteen_fields_and_failure_after_reset(self):
  spec=importlib.util.spec_from_file_location('runtime_real',Path(__file__).with_name('systemd-held-runtime.py'));rt=importlib.util.module_from_spec(spec);spec.loader.exec_module(rt)
  with tempfile.TemporaryDirectory() as t:
   folder=Path(t)/('sup-'+r.SCENARIO);folder.mkdir();args=self.args(folder);unit,old,before,pre,post,stop,final,binding,token,_=args
   props={**before,'Result':'success','ExecMainPID':'0','ExecMainCode':'0','ExecMainStatus':'0','RemainAfterExit':'no','ExecMainStartTimestampMonotonic':'0','ExecMainExitTimestampMonotonic':'0'}
   self.assertEqual(len(props),12)
   du=SimpleNamespace(unit_properties=lambda u:props,state_of=lambda i:'absent')
   known={unit:{**old,'fixtureReset':token}}
   cmd=SimpleNamespace(returncode=5,stdout='',stderr='Failed to stop '+unit+': Unit '+unit+' not loaded.\n')
   with patch.object(rt,'command',return_value=cmd),patch.object(rt,'independent_cgroup_state',return_value='gone'),patch.object(rt,'final_cleanup_manager',return_value=final):rt.cleanup([unit],known,du,folder)
   data=json.loads((folder/'systemd-cleanup.json').read_text());self.assertTrue(data['passed']);self.assertEqual(data['stopResults'][unit]['stopOutcome'],'already-unloaded-after-verified-test-reset')
   # A later scenario assertion failure has no role in the cleanup capability and remains a failure.
   with self.assertRaises(RuntimeError):
    try:raise RuntimeError('scenario-assertion-failed')
    finally:
     with patch.object(rt,'command',return_value=cmd),patch.object(rt,'independent_cgroup_state',return_value='gone'),patch.object(rt,'final_cleanup_manager',return_value=final):rt.cleanup([unit],known,du,folder)
 def test_file_tamper_and_permissions_refused(self):
  for drift in ['content','permission','bindings']:
   with self.subTest(drift=drift),tempfile.TemporaryDirectory() as t:
    folder=Path(t)/('sup-'+r.SCENARIO);folder.mkdir();args=self.args(folder)
    if drift=='content':(folder/'record-loss-reset-proof.json').write_text('{}')
    elif drift=='permission':(folder/'record-loss-reset-proof.json').chmod(0o644)
    else:(folder/'unit-bindings.json').write_text('{}')
    self.assertFalse(r.cleanup_reset_noop(*args))
if __name__=='__main__':unittest.main()
