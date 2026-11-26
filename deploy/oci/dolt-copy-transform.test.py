import importlib.util,unittest
from pathlib import Path
s=importlib.util.spec_from_file_location('replay',Path(__file__).with_name('dolt-copy-transform.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_bootstrap_source_bounded(self):
  self.assertIn('cpSync',m.server_source());self.assertNotIn('start.sh',m.server_source())
 def test_unknown_spec_refuses_before_any_read(self):
  with self.assertRaisesRegex(ValueError,'exact replay spec'):m.execute({'format':1},lambda x:self.fail('no reads expected'))
 def test_module_requires_fixed_sibling(self):
  with self.assertRaisesRegex(ValueError,'fixed bound'):m.module({},'dolt-copy-capture.py',lambda b:(Path('/tmp/wrong.py'),b''))
if __name__=='__main__':unittest.main()
