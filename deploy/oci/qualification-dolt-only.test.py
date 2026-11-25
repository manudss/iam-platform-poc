"""Real Node dispatch, mocked capture function. No Docker, host or real Dolt."""
import json,subprocess,unittest
from pathlib import Path
SOURCE=Path(__file__).with_name('qualification-container.mjs').read_text()
class Tests(unittest.TestCase):
 def invoke(self,p,rows):
  # Retain real input/dispatch/error handling, replace only storage functions.
  start=SOURCE.index('function dolt(){');end=SOURCE.index('async function workflowHashes()',start)
  source=SOURCE[:start]+'function dolt(){return '+json.dumps(rows)+';}\n'+SOURCE[end:]
  start=source.index('async function bao(){');end=source.index('function dolt(){',start)
  source=source[:start]+"async function bao(){throw Error('Bao MUST NOT run');}\n"+source[end:]
  return subprocess.run(['node','--input-type=module','-e',source,'dolt-only'],input=json.dumps(p),text=True,capture_output=True,timeout=5)
 def test_dispatch_both_explicit_modes_no_bao_or_smoke(self):
  rows=[{'evidence':'dolt-tables-v3','database':'iam','branch':'main'}]
  for running in (True,False):
   result=self.invoke({'running':running},rows);self.assertEqual(result.returncode,0,result.stderr)
   self.assertEqual(json.loads(result.stdout),{'format':1,'kind':'dolt-only-tables-v3','running':running,'dolt':rows})
 def test_unknown_mode_or_empty_inventory_refuses(self):
  for p,rows in [({},[{}]),({'running':'false'},[{}]),({'running':False},[])]:
   result=self.invoke(p,rows);self.assertNotEqual(result.returncode,0);self.assertFalse(result.stdout);self.assertIn('QUALIFICATION_DIAG_V1:capture-dolt',result.stderr)
if __name__=='__main__':unittest.main()
