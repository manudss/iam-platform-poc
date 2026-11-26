import importlib.util,json,hashlib,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('j',Path(__file__).with_name('source-rw-journal.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_actual_exclusive_chain_fsync_and_reread(self):
  with tempfile.TemporaryDirectory() as d,patch.object(m.Path,'lstat') as st:
   real=type('S',(),{'st_uid':0,'st_gid':0,'st_mode':0o700})
   st.return_value=real
   with patch.object(m.Path,'is_symlink',return_value=False):
    j=m.Journal(Path(d)/'events');j.create({'prepared':True});j.append({'committed':True})
   a=(j.path/'000000.json').read_bytes();b=json.loads((j.path/'000001.json').read_text())
   self.assertEqual(b['previous_sha256'],hashlib.sha256(a).hexdigest())
   with self.assertRaises(FileExistsError):m.Journal(j.path).create({})
 def test_failed_fsync_never_advances_sequence(self):
  with tempfile.TemporaryDirectory() as d:
   j=m.Journal(d)
   with patch.object(m.os,'fsync',side_effect=OSError('failed')):
    with self.assertRaises(OSError):j.append({'commit':True})
   self.assertEqual(j.next,0);self.assertIsNone(j.previous)
   with self.assertRaises(FileExistsError):j.append({'commit':True})
if __name__=='__main__':unittest.main()
