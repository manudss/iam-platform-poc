#!/usr/bin/env python3
import copy,importlib.util,json,subprocess,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('runtime',Path(__file__).with_name('systemd-held-runtime.py'));r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
class CleanupNoop(unittest.TestCase):
 def fixture(self):
  engagement='fixture-12345678';unit='lyam-durable-held-'+engagement+'-watchdog.service';ident={'pid':123,'starttime':987,'boot_id':'boot-one'};cg='/system.slice/'+unit
  props={'ActiveState':'inactive','SubState':'dead','MainPID':'0','InvocationID':'','ControlGroup':''}
  return [unit,{'role':'watchdog','engagement':engagement,'identity':ident,'cgroup':cg},props,{'originalMainState':'absent','originalCgroupState':'gone'},{'originalMainState':'absent','originalCgroupState':'empty'},{'returnCode':5,'exactUnitNotLoaded':True,'stdoutEmpty':True},{**props,'LoadState':'not-found'},{**ident,'unit':unit,'controlGroup':cg,'invocationID':'original-invocation'}]
 def test_positive_gone_and_recursive_empty(self):
  args=self.fixture();self.assertTrue(r.watchdog_cleanup_noop(*args))
  args[3]['originalCgroupState']='empty';args[4]['originalCgroupState']='gone';self.assertTrue(r.watchdog_cleanup_noop(*args))
 def test_every_conjunct_fails_closed(self):
  cases=[(0,None,'wrong.service'),(1,'role','worker'),(1,'engagement','other-engagement'),(1,'identity',None),(1,'cgroup','/'),(1,'cgroup','/../'+self.fixture()[0]),(2,'ActiveState','active'),(2,'SubState','running'),(2,'MainPID','77'),(2,'InvocationID','replacement'),(2,'ControlGroup','/replacement'),(3,'originalMainState','alive'),(3,'originalMainState','unknown'),(3,'originalMainState','reused'),(3,'originalCgroupState','populated'),(3,'originalCgroupState','unknown'),(4,'originalMainState','alive'),(4,'originalMainState','unknown'),(4,'originalCgroupState','populated'),(4,'originalCgroupState','unknown'),(5,'returnCode',1),(5,'returnCode',0),(5,'exactUnitNotLoaded',False),(5,'stdoutEmpty',False),(6,'LoadState','loaded'),(6,'ActiveState','active'),(6,'InvocationID','replacement'),(6,'ControlGroup','/replacement'),(7,'pid',124),(7,'starttime',988),(7,'boot_id','otherboot'),(7,'invocationID',''),(7,'unit','other.service'),(7,'controlGroup','/other')]
  for index,key,value in cases:
   with self.subTest(index=index,key=key,value=value):
    a=copy.deepcopy(self.fixture())
    if key is None:a[index]=value
    else:a[index][key]=value
    self.assertFalse(r.watchdog_cleanup_noop(*a))
 def test_independent_stops_scans_and_preserved_rc(self):
  a=self.fixture();unit,old,props,pre,post,stop,final,binding=a
  worker=unit.replace('-watchdog.service','-worker.service');wi={'pid':124,'starttime':988,'boot_id':'boot-one'}
  known={unit:old,worker:{'identity':wi,'cgroup':'/system.slice/'+worker,'role':'worker','engagement':old['engagement']}}
  show={**props,'Result':'success','ExecMainPID':'0','ExecMainCode':'0','ExecMainStatus':'0','RemainAfterExit':'no','ExecMainStartTimestampMonotonic':'0','ExecMainExitTimestampMonotonic':'0'}
  du=SimpleNamespace(unit_properties=lambda u:show,state_of=lambda i:'absent');calls=[]
  def cmd(args,check=True):
   calls.append(args);u=args[-1];return SimpleNamespace(returncode=5 if u==unit else 0,stderr='Failed to stop '+unit+': Unit '+unit+' not loaded.\n' if u==unit else '',stdout='')
  with tempfile.TemporaryDirectory() as tmp:
   folder=Path(tmp);(folder/'unit-bindings.json').write_text(json.dumps({'engagementID':old['engagement'],'watchdog':binding}))
   with patch.object(r,'command',side_effect=cmd),patch.object(r,'independent_cgroup_state',return_value='gone') as probe,patch.object(r,'final_cleanup_manager',return_value=final):
    r.cleanup([worker,unit],known,du,folder)
   data=json.loads((folder/'systemd-cleanup.json').read_text());self.assertTrue(data['passed']);self.assertEqual(data['stopResults'][unit]['returnCode'],5);self.assertEqual(data['stopResults'][unit]['stopOutcome'],'already-unloaded-verified');self.assertEqual(len(calls),2);self.assertEqual(probe.call_count,4)
 def test_timeout_and_permission_never_skip_peer_stop(self):
  a=self.fixture();unit,old,props,*rest=a;worker=unit.replace('-watchdog.service','-worker.service');known={unit:old,worker:{**old,'role':'worker','cgroup':'/system.slice/'+worker}}
  show={**props,'Result':'success','ExecMainPID':'0','ExecMainCode':'0','ExecMainStatus':'0','RemainAfterExit':'no','ExecMainStartTimestampMonotonic':'0','ExecMainExitTimestampMonotonic':'0'}
  du=SimpleNamespace(unit_properties=lambda u:show,state_of=lambda i:'absent')
  for failure in [subprocess.TimeoutExpired('systemctl',45),SimpleNamespace(returncode=5,stderr='permission denied',stdout='')]:
   with self.subTest(failure=type(failure).__name__):
    calls=[]
    def cmd(args,check=True):
     calls.append(args)
     if args[-1]==unit:
      if isinstance(failure,Exception):raise failure
      return failure
     return SimpleNamespace(returncode=0,stderr='',stdout='')
    with patch.object(r,'command',side_effect=cmd),patch.object(r,'independent_cgroup_state',return_value='gone') as probe,patch.object(r,'final_cleanup_manager',return_value={**props,'LoadState':'not-found'}),self.assertRaises(RuntimeError):r.cleanup([unit,worker],known,du)
    self.assertEqual(len(calls),2);self.assertEqual(probe.call_count,4)
 def test_independent_probe_live_child_and_unreadable_are_not_empty(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);base=root/'test';base.mkdir();(base/'cgroup.procs').write_text('');(base/'cgroup.events').write_text('populated 0\n')
   with patch.object(r,'Path',side_effect=lambda p:root if p=='/sys/fs/cgroup' else Path(p)):
    self.assertEqual(r.independent_cgroup_state('/test'),'empty')
    child=base/'child';child.mkdir();(child/'cgroup.procs').write_text('777\n');(child/'cgroup.events').write_text('populated 1\n');self.assertEqual(r.independent_cgroup_state('/test'),'populated')
    (child/'cgroup.procs').unlink()
    with self.assertRaises(FileNotFoundError):r.independent_cgroup_state('/test')
 def test_manager_unknown_or_extra_output_refused(self):
  for value in [SimpleNamespace(returncode=1,stderr='',stdout=''),SimpleNamespace(returncode=0,stderr='permission denied',stdout=''),SimpleNamespace(returncode=0,stderr='',stdout='LoadState=not-found\n')]:
   with patch.object(r,'command',return_value=value),self.assertRaises(RuntimeError):r.final_cleanup_manager(self.fixture()[0])
if __name__=='__main__':unittest.main()
