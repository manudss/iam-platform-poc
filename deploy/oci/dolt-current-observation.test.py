import importlib.util,tempfile,unittest,fcntl,subprocess,sys
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('current',Path(__file__).with_name('dolt-current-observation.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def sample(self,**extra):return dict(memory_max='max',pids_max='max',cpu_max='max 100000',at=10,memory_current=100,memory_peak=200,pids_current=5,memory_events={'max':0,'oom':0,'oom_kill':0},pids_events={'max':0},cpu_usage_usec=100,**extra)
 def test_load_events_cpu_and_missing_measurements(self):
  b=self.sample();limits={'memory_current_max':1000,'pids_current_max':20,'cpu_usec_per_second_max':100000}
  n={**b,'at':12,'cpu_usage_usec':100100};m.check_sample(n,b,b,limits)
  for change in [{'memory_current':1001},{'pids_current':21},{'memory_events':{'max':0,'oom':1,'oom_kill':0}},{'pids_events':{'max':1}},{'cpu_usage_usec':300101},{'at':30}]:
   with self.assertRaises(ValueError):m.check_sample({**n,**change},b,b,limits)
  with self.assertRaises(KeyError):m.check_sample({**n,'pids_events':{}},b,b,limits)
 def test_existing_locks_actual_content_unchanged_and_missing_not_created(self):
  rs=importlib.util.spec_from_file_location('runtime',Path(__file__).with_name('restored-runtime-check.py'));r=importlib.util.module_from_spec(rs);rs.loader.exec_module(r)
  with tempfile.TemporaryDirectory() as d:
   paths={k:Path(d)/k for k in ['journal','updater']}
   for p in paths.values():p.write_bytes(b'unchanged')
   with patch.object(m,'LOCKS',paths):
    # /tmp ancestor is writable, production acquisition must refuse it.
    with self.assertRaisesRegex(ValueError,'ancestry'):
     with m.locked(r):pass
    self.assertEqual([p.read_bytes() for p in paths.values()],[b'unchanged',b'unchanged'])
 def test_guard_fails_closed_and_signals_only_observer(self):
  limits={'memory_current_max':1000,'pids_current_max':20,'cpu_usec_per_second_max':100000}
  g=m.Guard({},limits,lambda:None)
  with patch.object(m,'snapshot',return_value=self.sample()),patch.object(m.os,'kill') as kill:
   g.sample();self.assertEqual(len(g.samples),1)
   with patch.object(g.done,'wait',return_value=False),patch.object(m,'snapshot',side_effect=ValueError('unreadable')):g.loop()
   self.assertTrue(g.failure);kill.assert_called_once_with(m.os.getpid(),m.signal.SIGUSR1)
   self.assertTrue(g.finish()['failed'])
 def test_true_two_locks_reject_unlock_and_replacement(self):
  rs=importlib.util.spec_from_file_location('runtime',Path(__file__).with_name('restored-runtime-check.py'));r=importlib.util.module_from_spec(rs);rs.loader.exec_module(r)
  with tempfile.TemporaryDirectory() as d:
   paths=[Path(d)/x for x in ['journal','updater']]
   for p in paths:p.write_bytes(b'original')
   with paths[0].open('rb') as a,paths[1].open('rb') as b:
    bindings={k:(str(p),f.fileno()) for k,p,f in zip(['journal','updater'],paths,[a,b])}
    fcntl.flock(a,fcntl.LOCK_EX|fcntl.LOCK_NB);fcntl.flock(b,fcntl.LOCK_EX|fcntl.LOCK_NB);r.locks(bindings)
    fcntl.flock(b,fcntl.LOCK_UN)
    with self.assertRaises(ValueError):r.locks(bindings)
    fcntl.flock(b,fcntl.LOCK_EX|fcntl.LOCK_NB)
    paths[0].unlink();paths[0].write_bytes(b'original')
    with self.assertRaises(ValueError):r.locks(bindings)
 def test_unknown_spec_no_read(self):
  with self.assertRaisesRegex(ValueError,'exact observation'):m.execute({},lambda b:self.fail('no reads'),{})
 def test_cli_remains_refusing(self):
  p=subprocess.run([sys.executable,m.__file__],capture_output=True,text=True)
  self.assertEqual(p.returncode,1);self.assertIn('no live authority',p.stderr)
if __name__=='__main__':unittest.main()
