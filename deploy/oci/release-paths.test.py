import importlib.util,unittest
from pathlib import Path
s=importlib.util.spec_from_file_location('paths',Path(__file__).with_name('release-paths.py'));p=importlib.util.module_from_spec(s);s.loader.exec_module(p)
class T(unittest.TestCase):
 def good(self):return p.plan('/opt/lyam-recovery/active','lyam-recovered-held-3','/opt/lyam-recovery/active/backups','/var/lib/lyam-front-gate/MAINTENANCE','/var/lib/lyam-front-gate/OPS-MAINTENANCE')
 def test_recovery_root_has_no_legacy_defaults(self):
  v=self.good();self.assertTrue(p.verify(v,v));self.assertEqual(v['LYAM_QUEUE_STATE'],'/opt/lyam-recovery/active/deploy-queue/state.json');self.assertEqual(v['LYAM_QUALIFICATION_POLICY'],'/opt/lyam-recovery/active/qualification.json')
 def test_missing_or_legacy_binding_refuses(self):
  for k in self.good():
   v=self.good();v.pop(k)
   with self.assertRaises(ValueError):p.verify(v,self.good())
  v=self.good();v['LYAM_QUEUE_STATE']='/opt/lyam/deploy-queue/state.json'
  with self.assertRaises(ValueError):p.verify(v,self.good())
 def test_gate_and_path_ambiguity_refused(self):
  for root in ['relative','/opt/a/../b','/opt/a/','/opt/a b']:
   with self.assertRaises(ValueError):p.plan(root,'app','/opt/a/backups','/var/g/F','/var/g/O')
  with self.assertRaises(ValueError):p.plan('/opt/a','app','/opt/a/backups','/opt/a/F','/opt/a/O')
if __name__=='__main__':unittest.main()
