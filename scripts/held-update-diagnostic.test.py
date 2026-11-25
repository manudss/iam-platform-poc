import importlib.util,json,unittest
from pathlib import Path
s=importlib.util.spec_from_file_location('d',Path(__file__).with_name('held-update-diagnostic.py'));d=importlib.util.module_from_spec(s);s.loader.exec_module(d)
class D(unittest.TestCase):
 def test_fixed_categories_and_code(self):
  for rc in [1,4,10,124,-9]:
   log='PRIVATE secret /root/path\npre-opening qualification failed\nclosed step did not return CLOSED_QUALIFIED (rc %s); no retry, no rollback'%rc
   v=d.project(log);self.assertEqual(v,{'updaterExit':rc,'categories':['qualification-before-open-refused']});self.assertNotIn('PRIVATE',json.dumps(v))
 def test_unknown_never_leaks(self):
  self.assertEqual(d.project('password=SECRET arbitrary refusal'),{'updaterExit':None,'categories':['unclassified']})
  self.assertIsNone(d.project('closed step did not return CLOSED_QUALIFIED (rc 999); no retry, no rollback')['updaterExit'])
 def test_nested_diagnostics_are_strict(self):
  good={'exceptionType':'RuntimeError','sourceLines':[12,20]}
  bad=[{'exceptionType':'secret','sourceLines':[1]},dict(good,private='SECRET'),{'exceptionType':'RuntimeError','sourceLines':[True]}, {'exceptionType':'RuntimeError','sourceLines':['SECRET']}]
  log='\n'.join('QUALIFICATION_DIAG_V1 '+json.dumps(v) for v in [good,*bad])
  self.assertEqual(d.project(log)['qualificationDiagnostics'],[good]);self.assertNotIn('SECRET',json.dumps(d.project(log)))
 def test_integration_projects_private_log_only_on_failure(self):
  text=Path(__file__).with_name('held-update-scenario.py').read_text()
  self.assertIn("rec['updaterDiagnostic']=load_module(source/'scripts/held-update-diagnostic.py','held_diagnostic').project(log)",text)
if __name__=='__main__':unittest.main()
