import importlib.util,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('dispatch',Path(__file__).with_name('ci-dispatch.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_only_two_exact_commands(self):
  for cmd in ('','status','lyam-status;id','lyam-drain --state /tmp/x',' lyam-status','lyam-drain\n'):
   with self.assertRaises(ValueError):m.plan(cmd)
 def test_all_operational_paths_and_env_propagate(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'bin').mkdir();(root/'deploy-queue').mkdir()
   paths=Path(__file__).with_name('release-paths.py');(root/'bin/release-paths.py').write_bytes(paths.read_bytes())
   ps=importlib.util.spec_from_file_location('paths',paths);p=importlib.util.module_from_spec(ps);ps.loader.exec_module(p)
   env=p.plan(str(root),'app',str(root/'backups'),'/var/lib/fixture/MAINT','/var/lib/fixture/OPS')
   (root/'lyam.env').write_text(''.join(k+'='+v+'\n' for k,v in env.items()));(root/'lyam.env').chmod(0o600)
   for path in ('bin/ordered-queue.py','bin/update.sh','deploy-queue/state.json','.update.lock'):(root/path).touch()
   with patch.object(m,'protected',side_effect=lambda p:p):
    for command in ('lyam-status','lyam-drain'):
     args=m.plan(command,root);self.assertIn(str(root/'lyam.env'),args);self.assertIn(str(root/'bin/update.sh'),args);self.assertIn(str(root/'deploy-queue/state.json'),args)
    (root/'lyam.env').write_text((root/'lyam.env').read_text()+'LYAM_CONTAINER=duplicate\n')
    with self.assertRaises(ValueError):m.plan('lyam-drain',root)
if __name__=='__main__':unittest.main()
