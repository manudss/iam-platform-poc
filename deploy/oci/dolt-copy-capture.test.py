import importlib.util,tempfile,unittest,os
from pathlib import Path
s=importlib.util.spec_from_file_location('copycapture',Path(__file__).with_name('dolt-copy-capture.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_plan_never_mounts_source_and_has_no_network_app_or_write_mount(self):
  spec={'work_dir':'/root/dolt-evidence-'+'a'*16+'/work','image_id':'sha256:'+'b'*64,'dolt_version':'2.6.1','container':'dolt-copy-'+'c'*16}
  cmd=m.command(spec,{'path':str(Path(m.__file__).with_name('qualification-container.mjs').absolute())})
  self.assertEqual(cmd[cmd.index('--network')+1],'none');self.assertIn('--read-only',cmd);self.assertEqual(cmd[cmd.index('--user')+1],'0:0');self.assertIn('size=1073741824',cmd[cmd.index('--tmpfs')+1]);self.assertIn('dst=/data/dolt,readonly',' '.join(cmd));self.assertNotIn('/mnt/', ' '.join(cmd));self.assertEqual(cmd[cmd.index('--entrypoint')+1],'node')
  spec['work_dir']='/mnt/lyam-source/opt/lyam/data/dolt'
  with self.assertRaises(ValueError):m.command(spec,{})
 def test_bounded_executor_restores_handlers_on_refusal(self):
  import signal
  from unittest.mock import patch
  prior={sig:signal.getsignal(sig) for sig in (signal.SIGALRM,signal.SIGTERM,signal.SIGINT)}
  with patch.object(m,'execute',side_effect=TimeoutError('synthetic refusal')):
   with self.assertRaises(TimeoutError):m.bounded_execute({})
  self.assertEqual({sig:signal.getsignal(sig) for sig in prior},prior)
 def test_actual_execute_failure_still_removes_only_own_container_and_writes_attempt(self):
  import json
  from types import SimpleNamespace
  from unittest.mock import patch
  with tempfile.TemporaryDirectory() as d:
   base=Path(d);work=base/'work';work.mkdir();(work/'file').write_text('fixture');spec={'format':1,'kind':'reviewed-work-copy-dolt-capture','work_dir':str(work),'tree_sha256':'a'*64,'image_id':'sha256:'+'b'*64,'dolt_version':'2.6.1','source':{},'container':'dolt-copy-'+'c'*16,'out':str(base/'capture.json')};calls=[]
   def run(args,**kw):
    calls.append(args)
    if args[:3]==['docker','ps','-a']:return SimpleNamespace(returncode=0,stdout='')
    if args[:2]==['docker','rm']:return SimpleNamespace(returncode=0,stdout='')
    raise TimeoutError('synthetic container deadline')
   # Root ancestry is a deployment property; this test exercises real finally
   # and persisted attempt using local temporary files with ownership doubled.
   actual=Path.lstat
   def ls(p):
    st=actual(p);return SimpleNamespace(st_uid=0,st_gid=0,st_mode=st.st_mode&~0o022)
   read_text=Path.read_text
   def read(p,*a,**kw):return 'MemAvailable: 5000000 kB\n' if str(p)=='/proc/meminfo' else read_text(p,*a,**kw)
   prior={sig:__import__('signal').getsignal(sig) for sig in (__import__('signal').SIGALRM,__import__('signal').SIGTERM,__import__('signal').SIGINT)}
   try:
    with patch.object(Path,'read_text',read),patch.object(m,'command',return_value=['docker','run']),patch.object(m,'digest_tree',return_value=('a'*64,7,1)),patch.object(m.os,'geteuid',return_value=0),patch.object(Path,'lstat',ls),patch.object(m.shutil,'disk_usage',return_value=SimpleNamespace(free=10*1024**3)),patch.object(m.subprocess,'run',side_effect=run):
     with self.assertRaisesRegex(ValueError,'cleanup unverified'):m.execute(spec,lambda b:(Path('source'),b'fixed'))
    result=json.loads((base/'attempt.json').read_text());self.assertFalse(result['completed']);self.assertTrue(result['cleanup_confirmed']);self.assertEqual(calls[-1],['docker','rm','-f',spec['container']])
   finally:
    for sig,handler in prior.items():__import__('signal').signal(sig,handler)
 def test_tree_refuses_symlink_and_hardlink(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);(p/'x').write_text('private');(p/'y').symlink_to(p/'x')
   with self.assertRaises(ValueError):m.digest_tree(p)
   (p/'y').unlink();os.link(p/'x',p/'y')
   with self.assertRaises(ValueError):m.digest_tree(p)
if __name__=='__main__':unittest.main()
