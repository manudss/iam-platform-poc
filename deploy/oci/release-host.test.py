#!/usr/bin/env python3
import copy,importlib.util,unittest,os,fcntl,subprocess,sys,tempfile
from pathlib import Path
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
 def test_no_import_before_binding(self):
  old=h.imported
  try:
   h.imported=lambda *a:(_ for _ in ()).throw(AssertionError('early import'))
   host=h.Host({})
   with self.assertRaises(ValueError):host.preflight({}, {},'lyam',{'digest':'sha256:'+'a'*64})
  finally:h.imported=old
if __name__=='__main__':unittest.main()
