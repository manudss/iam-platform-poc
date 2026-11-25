#!/usr/bin/env python3
import copy,importlib.util,unittest,os,fcntl,subprocess,sys,tempfile
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('host',Path(__file__).with_name('release-host.py'));h=importlib.util.module_from_spec(s);s.loader.exec_module(h)
class Tests(unittest.TestCase):
 def fixture(self):
  host=h.Host({});host.env={'LYAM_PORT':'8080','LYAM_DATA_DIR':'/data-root'};host.image_config={'Env':['PATH=/bin'],'Cmd':['run'],'User':'1000'}
  c={'Config':{'Env':['PATH=/bin','IAM_DEMO_SEED_MODE=never'],'Cmd':['run'],'User':'1000'},'HostConfig':{'NetworkMode':'bridge','RestartPolicy':{'Name':'no','MaximumRetryCount':0},'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true'],'PortBindings':{'8080/tcp':[{'HostIp':'127.0.0.1','HostPort':'8080'}]},'Binds':['/data-root:/data']},'Mounts':[{'Type':'bind','Source':'/data-root','Destination':'/data','RW':True,'Propagation':'rprivate'}],'NetworkSettings':{'Networks':{'bridge':{}}}}
  return host,c
 def test_exact_profile(self):
  host,c=self.fixture();host.verify_config(c,b'')
 def test_runtime_options_and_environment_fail_closed(self):
  changes=[('Config','Cmd',['different']),('Config','User','0'),('Config','Env',['PATH=/bin','IAM_DEMO_SEED_MODE=never','IAM_AUTOMATION_HOLD=1']),('HostConfig','ReadonlyRootfs',True),('HostConfig','SecurityOpt',[]),('HostConfig','Dns',['1.1.1.1']),('HostConfig','Ulimits',[{'Name':'nofile'}]),('HostConfig','Devices',[{}]),('HostConfig','Binds',['/wrong:/data']),('HostConfig','NetworkMode','host'),('HostConfig','RestartPolicy',{'Name':'always'}),('HostConfig','PortBindings',{}),('NetworkSettings','Networks',{'bridge':{},'other':{}})]
  for section,key,value in changes:
   with self.subTest(section=section,key=key):
    host,c=self.fixture();c[section][key]=value
    with self.assertRaises(ValueError):host.verify_config(c,b'')
 def test_extra_mount_is_refused(self):
  host,c=self.fixture();c['Mounts'].append(dict(c['Mounts'][0]))
  with self.assertRaises(ValueError):host.verify_config(c,b'')
 def test_persist_failure_keeps_real_child_and_inherited_lock(self):
  qspec=importlib.util.spec_from_file_location('queue',Path(__file__).with_name('ordered-queue.py'));q=importlib.util.module_from_spec(qspec);qspec.loader.exec_module(q)
  with tempfile.TemporaryDirectory() as d:
   lock=open(Path(d)/'lock','a');fcntl.flock(lock,fcntl.LOCK_EX)
   host=h.Host({},lock.fileno());host.q=q
   host.bind_intent({'child':None},lambda:(_ for _ in ()).throw(RuntimeError('injected persistence failure')))
   try:
    with self.assertRaises(RuntimeError):host.run([sys.executable,'-c','import time;time.sleep(30)'])
    child=host.intent['child']['identity'];self.assertEqual(q.queue_state(child),'alive');lock.close()
    other=open(Path(d)/'lock','a')
    with self.assertRaises(BlockingIOError):fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
    with self.assertRaises(ValueError):host.run(['true'])
    with self.assertRaises(ValueError):host.close_access(host.intent)
   finally:
    if getattr(host,'active_child',None):host.active_child.kill();host.active_child.communicate()
    if 'other' in locals():other.close()
    if not lock.closed:lock.close()
 def test_backlog_pair_has_external_gap_and_refuses_changed_roots_or_ceiling(self):
  initial={'format':1,'kind':'live-release-backlog','inventory_complete':True,'external_coverage':'unverified','captured_at':10,'sha256':'a'*64,'entries':[{'root':'root','tables':[{'rows':0}]}]}
  self.assertTrue(h.verify_backlog_pair(initial,copy.deepcopy(initial),now=11))
  for change in ('root','rows','external','stale'):
   current=copy.deepcopy(initial)
   if change=='root':current['entries'][0]['root']='changed'
   if change=='rows':current['entries'][0]['tables'][0]['rows']=100000
   if change=='external':current['external_coverage']='safe'
   if change=='stale':current['captured_at']=-1000
   with self.assertRaises(ValueError):h.verify_backlog_pair(initial,current,now=11)
 def test_no_hold_removal_without_commit(self):
  host=h.Host({})
  with self.assertRaisesRegex(ValueError,'commit'):host.start_normal({})
 def test_postgate_recapture_is_before_stop_and_preservation(self):
  calls=[];host=h.Host({'env':{'path':'env'}});host.container='held-app'
  host.recapture_backlog=lambda:calls.append('recapture')
  host.run=lambda args:calls.append(args[0])
  host.qualify_args=lambda *a:['qualification']
  host.install_operational_policy=lambda:calls.append('policy')
  host.install_normal_env({})
  self.assertEqual(calls,['recapture','docker','qualification','policy'])
 def test_postgate_change_prevents_stop_and_hold_removal(self):
  host=h.Host({});host.recapture_backlog=lambda:(_ for _ in ()).throw(ValueError('changed'))
  host.run=lambda *a:(_ for _ in ()).throw(AssertionError('must not stop'))
  with self.assertRaisesRegex(ValueError,'changed'):host.install_normal_env({})
 def test_held_observation_rejects_duplicate_hold_or_changed_image(self):
  target={'sha':'a'*40,'digest':'sha256:'+'b'*64};ref='ghcr.io/manudss/iam-platform-poc@'+target['digest']
  q=type('Observer',(),{'observe_running':staticmethod(lambda *a:{**target,'image_id':'image','running':True})})
  c={'Id':'container','Image':'image','State':{'Running':True},'Config':{'Image':ref,'Env':['IAM_AUTOMATION_HOLD=1']}}
  with patch.object(h,'imported',return_value=q),patch.object(h,'run',side_effect=lambda *a:h.json.dumps([c])):
   self.assertTrue(h.Host({}).observe_held('held',target)['held'])
   c['Config']['Env'].append('IAM_AUTOMATION_HOLD=1')
   with self.assertRaises(ValueError):h.Host({}).observe_held('held',target)
   c['Config']['Env']=['IAM_AUTOMATION_HOLD=1'];c['Image']='other'
   with self.assertRaises(ValueError):h.Host({}).observe_held('held',target)
 def test_no_import_before_binding(self):
  old=h.imported
  try:
   h.imported=lambda *a:(_ for _ in ()).throw(AssertionError('early import'))
   host=h.Host({})
   with self.assertRaises(ValueError):host.preflight({}, {},'lyam',{'digest':'sha256:'+'a'*64})
  finally:h.imported=old
if __name__=='__main__':unittest.main()
