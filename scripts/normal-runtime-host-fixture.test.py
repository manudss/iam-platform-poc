import argparse,hashlib,importlib.util,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
s=importlib.util.spec_from_file_location('hf',ROOT/'scripts/normal-runtime-host-fixture.py');h=importlib.util.module_from_spec(s);s.loader.exec_module(h)
class Tests(unittest.TestCase):
 def test_preflight_no_pull_no_writes_and_refuses_overlap_memory_or_inventory(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'spec';names=['scripts/normal-runtime-host-fixture.py','scripts/normal-runtime-docker-fixture.py','deploy/oci/normal-runtime.py'];spec={'format':1,'kind':'reviewed-host-pre-fifo-fixture','image':h.IMAGE,'source_sha':h.SOURCE,'files':{n:hashlib.sha256((ROOT/n).read_bytes()).hexdigest() for n in names},'out':'/root/normal-host-proof-0123456789abcdef.json','held_id':'a'*64};p.write_text(json.dumps(spec));p.chmod(0o600);calls=[];overlap=[False]
   def docker(args,**kwargs):
    calls.append(args)
    self.assertNotIn('pull',args)
    if args[1]=='info':return json.dumps({'OSType':'linux','MemoryLimit':True,'PidsLimit':True})
    if args[1:3]==['network','ls']:return 'fixture-network\n'
    if args[1:3]==['network','inspect']:return json.dumps([{'IPAM':{'Config':[{'Subnet':'172.29.0.0/24' if overlap[0] else '172.18.0.0/16'}]}}])
    if args[1:3]==['image','inspect']:return json.dumps([{'RepoDigests':[h.IMAGE],'Config':{'Labels':{'org.opencontainers.image.revision':h.SOURCE}}}])
    raise AssertionError(args)
   real=Path.read_text;real_exists=Path.exists
   def read(path,*a,**kw):return 'MemAvailable: 2097152 kB\n' if str(path)=='/proc/meminfo' else real(path,*a,**kw)
   with patch.object(h,'protected',side_effect=lambda p:Path(p)),patch.object(h.os,'geteuid',return_value=0),patch.object(h.shutil,'disk_usage',return_value=type('Disk',(),{'free':3*1024**3})()),patch.object(h.subprocess,'check_output',side_effect=docker),patch.object(Path,'read_text',read),patch.object(Path,'exists',side_effect=None,autospec=True) as exists:
    exists.side_effect=lambda p:False if str(p).startswith('/root/normal-host-proof-') else real_exists(p)
    self.assertEqual(h.preflight(p)['image'],h.IMAGE)
    overlap[0]=True
    with self.assertRaisesRegex(ValueError,'overlap'):h.preflight(p)
    overlap[0]=False;spec['files']['deploy/oci/normal-runtime.py']='0'*64;p.write_text(json.dumps(spec))
    with self.assertRaisesRegex(ValueError,'code changed'):h.preflight(p)
 def test_postcomparison_refuses_any_nonfixture_change_and_records_memory(self):
  with tempfile.TemporaryDirectory() as d:
   out=Path(d)/'result.json';spec={'out':str(out),'image':h.IMAGE,'source_sha':h.SOURCE,'held_id':'a'*64}
   base={'containers':[{'id':'held'}],'networks':[],'held_namespace':{'rules':'same'},'host_filter_rules':{'iptables':'same'},'memory_available_kib':2000000}
   class Engine:
    def execute(self,*a,**kw):out.write_text(json.dumps({'result':'pre-fifo-network-qualified','app_started':False}))
   with patch.object(h,'snapshot',side_effect=[base,{**base,'containers':[{'id':'held','restart':1}]}]):
    with self.assertRaisesRegex(ValueError,'production or host'):h.execute_reviewed(spec,Engine())
   result=json.loads(out.read_text());self.assertEqual(result['result'],'refused');self.assertFalse(result['production_observation']['comparisons']['containers'])
   with patch.object(h,'memory_available',return_value=500000):
    with self.assertRaisesRegex(ValueError,'pressure'):h.checkpoint()
 def test_timeout_still_runs_postsnapshot_and_returns_refusal(self):
  with tempfile.TemporaryDirectory() as d:
   out=Path(d)/'result.json';spec={'out':str(out),'image':h.IMAGE,'source_sha':h.SOURCE,'held_id':'a'*64};base={'containers':[],'networks':[],'held_namespace':{},'host_filter_rules':{},'memory_available_kib':2000000}
   class Engine:
    def execute(self,*a,**kw):raise TimeoutError('fixture timeout')
   with patch.object(h,'snapshot',return_value=base) as shot,patch.object(h.signal,'alarm'):
    with self.assertRaises(TimeoutError):h.execute_reviewed(spec,Engine())
   self.assertEqual(shot.call_count,2);self.assertEqual(json.loads(out.read_text())['result'],'refused')
 def test_actual_cleanup_finally_ignores_second_signals_and_uses_shared_budget(self):
  import ast,signal
  from types import SimpleNamespace
  source=(ROOT/'scripts/normal-runtime-docker-fixture.py').read_text();tree=ast.parse(source);execute=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='execute');block=next(n for n in execute.body if isinstance(n,ast.Try) and n.finalbody)
  fn=ast.FunctionDef(name='cleanup',args=ast.arguments(posonlyargs=[],args=[],kwonlyargs=[],kw_defaults=[],defaults=[]),body=block.finalbody,decorator_list=[]);module=ast.Module(body=[fn],type_ignores=[]);ast.fix_missing_locations(module)
  with tempfile.TemporaryDirectory() as d:
   root=Path(d)/'owned';root.mkdir();out=Path(d)/'artifact';calls=[];prior={sig:signal.getsignal(sig) for sig in (signal.SIGALRM,signal.SIGTERM,signal.SIGINT)}
   def command(args,**kw):
    calls.append((args,kw['timeout']))
    os.kill(os.getpid(),signal.SIGTERM);os.kill(os.getpid(),signal.SIGINT)
    return SimpleNamespace(returncode=0,stdout='normal-host-prefix-pg\n' if args[:3]==['docker','ps','-a'] and len(calls)==1 else '')
   import subprocess,time,shutil
   scope={'host_fixture':True,'signal':signal,'time':time,'subprocess':subprocess,'shutil':shutil,'root':root,'out':out,'prefix':'normal-host-prefix','networks':['normal-host-prefix-backend'],'result':{'result':'pre-fifo-network-qualified'},'json':json}
   exec(compile(module,'actual-fixture-cleanup','exec'),scope)
   with patch.object(subprocess,'run',side_effect=command):scope['cleanup']()
   self.assertTrue(json.loads(out.read_text())['cleanup_complete']);self.assertFalse(root.exists());self.assertTrue(all(0<t<=15 for args,t in calls))
   self.assertEqual({sig:signal.getsignal(sig) for sig in prior},prior)
 def test_host_resource_flags_are_exact_and_duplicates_refuse(self):
  s=importlib.util.spec_from_file_location('fixture',ROOT/'scripts/normal-runtime-docker-fixture.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
  args=m.host_resource_args(['docker','run','--name','fixture','image'])
  for flag,value in [('--oom-score-adj','1000'),('--memory','256m'),('--memory-swap','256m'),('--pids-limit','128'),('--cpus','0.5')]:self.assertEqual(args[args.index(flag)+1],value)
  for flag in ['--memory','--memory=512m','--cpus','--pids-limit=32','--oom-score-adj=0']:
   with self.assertRaises(ValueError):m.host_resource_args(['docker','run',flag,'image'])
 def test_github_guard_cannot_be_disabled_by_env_on_normal_entry(self):
  s=importlib.util.spec_from_file_location('fixture',ROOT/'scripts/normal-runtime-docker-fixture.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
  with patch.object(m.os,'geteuid',return_value=0),patch.dict(os.environ,{'GITHUB_ACTIONS':'false'}):
   with self.assertRaisesRegex(ValueError,'disposable hosted'):m.execute(argparse.Namespace())
if __name__=='__main__':unittest.main()
