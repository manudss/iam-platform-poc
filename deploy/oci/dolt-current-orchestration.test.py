import importlib.util,json,tempfile,unittest,hashlib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
s=importlib.util.spec_from_file_location('current',Path(__file__).with_name('dolt-current-observation.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def exercise(self,mode):
  source=b'synthetic';envelope={'format':1,'kind':'dolt-only-tables-v3','running':True,'dolt':[{'root':'first'}]};records={};events=[]
  runtime=SimpleNamespace(locks=lambda b:None,verify=lambda s,b:({'identity':'changed'} if mode=='runtime' and events.count('capture')==2 else {'identity':'same'}),parse_env=lambda raw:{'LYAM_LOCK_FILE':str(m.LOCKS['updater']),'LYAM_QUEUE_STATE':str(m.ROOT/'deploy-queue/state.json'),'LYAM_PAUSE_FILE':str(m.ROOT/'UPDATE_PAUSED')})
  def capture(*args):
   events.append('capture')
   if mode=='client-failure':raise ValueError('client refused')
   args[-1].append({'docker_state_available':True,'oom_killed':False,'exit_code':0,'running':False,'samples':10,'pids_events_max':1 if mode=='events' else 0})
   return {**envelope,'dolt':[{'root':'changed'}]} if mode=='moving' and len(events)==2 else envelope
  host=SimpleNamespace(verify=lambda s,e,r:({'identity':'changed'} if mode=='runtime' and events.count('capture')==2 else {'identity':'same'}))
  helper=SimpleNamespace(executed_source=lambda raw:'executed',capture_once=capture,resource_monitor=lambda n:None)
  resources=SimpleNamespace(ResourceMonitor=lambda n:None)
  def mod(binding,name,reader):return {'restored-runtime-check.py':runtime,'dolt-current-host.py':host,'dolt-held-capture.py':helper,'dolt-current-client.py':helper,'dolt-copy-capture.py':resources}[name]
  def reader(binding):
   key=binding['key'];paths={'source':Path(m.__file__).with_name('qualification-container.mjs').absolute(),'journal':m.ROOT/'deploy-queue/state.json','pause':m.ROOT/'UPDATE_PAUSED'}
   data=json.dumps({**envelope,'dolt':[{'root':'other'}]} if mode=='reference' else envelope).encode() if key=='reference_after' else source
   return paths.get(key,Path('/root')/key),data
  bind=lambda k:{'key':k}
  spec={'format':1,'kind':'reviewed-current-held-observation','baseline_events':{},'runtime_controller':bind('runtime_controller'),'host_controller':bind('host_controller'),'helper':bind('helper'),'client':bind('client'),'resources':bind('resources'),'source':bind('source'),'reference_after':bind('reference_after'),'journal':bind('journal'),'pause':bind('pause'),'runtime':{**{k:bind(k) for k in ['env','config','helper','launch_proof','policy']},'pause':bind('pause'),'journal':bind('journal'),'gates':{'maintenance':bind('gate1'),'operations':bind('gate2')},'expected_container_id':'a'*64},'expected':{'container_id':'a'*64,'image_id':'sha256:'+'b'*64,'pid':123,'started_at':'now','netns_inode':456,'cgroup':'/docker/test'},'limits':{'memory_current_max':1000,'pids_current_max':100,'cpu_usec_per_second_max':100000},'executed_source_sha256':hashlib.sha256(b'executed').hexdigest(),'root':'/root/dolt-current-'+'a'*16}
  guard=SimpleNamespace(start=lambda:guard,finish=lambda:{'failed':mode=='guard','samples':5},failure=False)
  with patch.object(m,'module',side_effect=mod),patch.object(m,'Guard',return_value=guard),patch.object(m,'snapshot',return_value={}),patch.object(Path,'exists',return_value=False),patch.object(Path,'lstat',return_value=SimpleNamespace(st_uid=0,st_gid=0,st_mode=0o40700)),patch.object(Path,'is_symlink',return_value=False),patch.object(Path,'mkdir'),patch.object(Path,'read_text',return_value='MemAvailable: 5000000 kB\n'),patch.object(m,'private_write',side_effect=lambda p,v:records.update({p.name:json.loads(json.dumps(v))})):
   if mode=='ok':self.assertTrue(m.execute(spec,reader,{})['completed'])
   else:
    with self.assertRaisesRegex(ValueError,'preserve private'):m.execute(spec,reader,{})
  result=records['result.json'];self.assertEqual(result['completed'],mode=='ok');self.assertFalse(result['restoration_admissible'])
  if mode!='client-failure':self.assertIn('capture-1.json',records)
  if mode in ['moving','reference','runtime','ok','guard']:self.assertIn('capture-2.json',records)
  if mode=='reference':self.assertFalse(result['equal_replay_after'])
 def test_stable(self):self.exercise('ok')
 def test_moving_preserves_both(self):self.exercise('moving')
 def test_reference_difference_preserved(self):self.exercise('reference')
 def test_runtime_change(self):self.exercise('runtime')
 def test_client_failure_result(self):self.exercise('client-failure')
 def test_client_events(self):self.exercise('events')
 def test_guard_failure(self):self.exercise('guard')
if __name__=='__main__':unittest.main()
