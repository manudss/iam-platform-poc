import importlib.util,tempfile,unittest,os
from pathlib import Path
s=importlib.util.spec_from_file_location('copycapture',Path(__file__).with_name('dolt-copy-capture.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_plan_never_mounts_source_and_has_no_network_app_or_write_mount(self):
  spec={'work_dir':'/root/dolt-evidence-'+'a'*16+'/work','scratch_dir':'/root/dolt-evidence-'+'a'*16+'/scratch','image_id':'sha256:'+'b'*64,'dolt_version':'2.6.1','container':'dolt-copy-'+'c'*16}
  cmd=m.command(spec,{'path':str(Path(m.__file__).with_name('qualification-container.mjs').absolute())})
  self.assertEqual(cmd[cmd.index('--network')+1],'none');self.assertIn('--read-only',cmd);self.assertIn('dst=/data/dolt,readonly',' '.join(cmd));self.assertNotIn('/mnt/', ' '.join(cmd));self.assertEqual(cmd[cmd.index('--entrypoint')+1],'node')
  spec['work_dir']='/mnt/lyam-source/opt/lyam/data/dolt'
  with self.assertRaises(ValueError):m.command(spec,{})
 def test_tree_refuses_symlink_and_hardlink(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);(p/'x').write_text('private');(p/'y').symlink_to(p/'x')
   with self.assertRaises(ValueError):m.digest_tree(p)
   (p/'y').unlink();os.link(p/'x',p/'y')
   with self.assertRaises(ValueError):m.digest_tree(p)
if __name__=='__main__':unittest.main()
