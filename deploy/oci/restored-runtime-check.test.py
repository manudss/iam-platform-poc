import importlib.util,tempfile,unittest,fcntl
from pathlib import Path
s=importlib.util.spec_from_file_location('runtime',Path(__file__).with_name('restored-runtime-check.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_two_actual_locks_and_no_arbitrary_source(self):
  with tempfile.TemporaryDirectory() as d:
   a=Path(d)/'journal';b=Path(d)/'update';a.touch();b.touch()
   with a.open('a') as j,b.open('a') as u:
    bindings={'journal':(str(a),j.fileno()),'updater':(str(b),u.fileno())}
    with self.assertRaises(ValueError):m.locks(bindings)
    fcntl.flock(j,fcntl.LOCK_EX);fcntl.flock(u,fcntl.LOCK_EX);m.locks(bindings)
    with self.assertRaises(ValueError):m.verify({'format':1},bindings)
 def test_tls_only_loopback_and_valid_origin_no_network_on_bad_input(self):
  for origin,address in [('http://example.com','127.0.0.1'),('https://example.com','1.1.1.1'),('https://example.com/path','127.0.0.1')]:
   with self.assertRaises(ValueError):m.tls_local(origin,address)
if __name__=='__main__':unittest.main()
