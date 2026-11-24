import importlib.util,pathlib,tempfile,json,hashlib,unittest,types
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('integrity',pathlib.Path(__file__).with_name('closed-recovery-integrity.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Integrity(unittest.TestCase):
 def test_reviewed_hashes_before_helpers(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);files={}
   for role in ['LAUNCHER','PREFLIGHT','IMPLEMENTATION']:
    p=root/role;p.write_text('reviewed '+role);files['LYAM_CLOSED_'+role]=str(p)
   files['LYAM_POST_UPDATE_CHECK']=str(root/'LAUNCHER')
   c={'qualificationSHA256':{str(root/'LAUNCHER'):m.digest(root/'LAUNCHER')},'controllerSHA256':{name:m.digest(pathlib.Path(m.__file__).parent/name) for name in ['update.sh','closed-recovery-integrity.py','closed-recovery-call.py']},'helperSHA256':{k:m.digest(pathlib.Path(v)) for k,v in files.items() if not k.endswith('IMPLEMENTATION')},'implementationSHA256':m.digest(root/'IMPLEMENTATION')}
   source=root/'qualification-container.mjs';source.write_text('source');c['qualificationSHA256'][str(source)]=m.digest(source);policy=root/'policy';policy.write_text('policy');c['qualificationSHA256']['/opt/lyam/qualification.json']=m.digest(policy)
   config=root/'config';config.write_text(json.dumps(c));files['LYAM_CLOSED_CONFIG']=str(config)
   env=root/'env';env.write_text('\n'.join(k+'='+v for k,v in files.items()))
   with patch.object(m,'secure',side_effect=lambda p,private=False:policy if p=='/opt/lyam/qualification.json' else pathlib.Path(p)):
    self.assertEqual(len(m.verify(str(env))),8)
    for role in ['LAUNCHER','PREFLIGHT','IMPLEMENTATION']:
     p=root/role;original=p.read_text();p.write_text('mutant')
     with self.assertRaisesRegex(ValueError,'hash differs'):m.verify(str(env))
     p.write_text(original)
 def test_controller_hashes_are_checked(self):
  base=pathlib.Path(m.__file__).parent
  c={'controllerSHA256':{name:m.digest(base/name) for name in ['update.sh','closed-recovery-integrity.py','closed-recovery-call.py']}}
  with patch.object(m,'secure',side_effect=lambda p,private=False:pathlib.Path(p)):
   self.assertEqual(len(m.root_hashes(c)),3)
   for name in c['controllerSHA256']:
    bad=json.loads(json.dumps(c));bad['controllerSHA256'][name]='0'*64
    with self.assertRaisesRegex(ValueError,'controller hash'):m.root_hashes(bad)
 def test_permissions_and_ancestor_rejected(self):
  p=pathlib.Path(__file__).absolute()
  with patch.object(pathlib.Path,'stat',return_value=types.SimpleNamespace(st_uid=1000,st_gid=0,st_mode=0o100755)):
   with self.assertRaisesRegex(ValueError,'root-owned'):m.secure(str(p))
  with patch.object(pathlib.Path,'stat',return_value=types.SimpleNamespace(st_uid=0,st_gid=0,st_mode=0o100777)):
   with self.assertRaisesRegex(ValueError,'root-owned'):m.secure(str(p))
if __name__=='__main__':unittest.main()
