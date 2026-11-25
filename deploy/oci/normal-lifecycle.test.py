import importlib.util,json,tempfile,unittest
from pathlib import Path
s=importlib.util.spec_from_file_location('lifecycle',Path(__file__).with_name('normal-lifecycle.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_marker_durable_before_fifo_refusal_never_overwrites(self):
  with tempfile.TemporaryDirectory() as d:
   path=Path(d)/'attempt'
   class N:
    def launch(self,c,callback):
     self_outer.assertTrue(path.is_file());self_outer.assertFalse(Path(str(path)+'.effects').exists());callback({'namespace':42});self_outer.assertTrue(Path(str(path)+'.effects').is_file());raise ValueError('refuse after marker')
   self_outer=self
   # Test directory is temporary and not root-owned protected in normal runs.
   import os
   from unittest.mock import patch
   actual=Path.lstat
   def ls(p):
    r=actual(p)
    return type('Stat',(),{'st_uid':0,'st_gid':0,'st_mode':r.st_mode&~0o022})()
   with patch.object(Path,'lstat',ls):
    with self.assertRaisesRegex(ValueError,'after marker'):m.launch({'image':'exact'},path,N())
    raw=path.read_bytes()
    with self.assertRaises(ValueError):m.launch({'image':'other'},path,N())
    self.assertEqual(path.read_bytes(),raw)
 def test_atomic_evidence_no_overwrite(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'proof';m.atomic_new(p,{'x':1})
   with self.assertRaises(FileExistsError):m.atomic_new(p,{'x':2})
   self.assertEqual(json.loads(p.read_text()),{'x':1})
if __name__=='__main__':unittest.main()
