import hashlib,importlib.util,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('epoch',Path(__file__).with_name('restored-epoch-qualifier.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_fixed_module_name_and_binding_before_execution(self):
  with tempfile.TemporaryDirectory() as d:
   path=Path(d)/'qualification.py';path.write_text('raise AssertionError("external code must not execute")')
   with self.assertRaisesRegex(ValueError,'fixed installed'):m.load_fixed({'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()},'qualification.py',lambda b:(path,path.read_bytes()))
 def test_unknown_epoch_spec_cannot_call_capture_or_smoke(self):
  p=Path(m.__file__).with_name('restored-runtime-check.py').absolute()
  actual=Path.lstat
  def ls(path):
   st=actual(path);return type('Stat',(),{'st_uid':0,'st_gid':0,'st_mode':st.st_mode&~0o022})()
  spec={'runtime_controller':{'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()},'kind':'unknown'}
  with patch.object(Path,'lstat',ls),self.assertRaisesRegex(ValueError,'exact current epoch'):m.execute(spec,{})
if __name__=='__main__':unittest.main()
