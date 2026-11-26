#!/usr/bin/env python3
import hashlib,importlib.util,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('bootstrap',Path(__file__).with_name('release-bootstrap.py'));b=importlib.util.module_from_spec(s);s.loader.exec_module(b)
class Tests(unittest.TestCase):
 def fixture(self,d):
  d=Path(d);root=d/'bin';root.mkdir();stage=d/'stage';stage.mkdir();state=d/'state';state.write_text(json.dumps({'format':3,'resume_required':True,'history':[{'mode':'ui-open-automation-held'}]}));Path(str(state)+'.lock').touch();pause=d/'pause';pause.touch();env=d/'env';env.write_text('IAM_AUTOMATION_HOLD=1\n');env.chmod(0o600);lock=d/'lock';lock.touch();files=[]
  for n in b.NAMES:
   p=stage/n;p.write_text('# staged fixture '+n);files.append({'source':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
  return {'install_dir':str(root),'state':str(state),'pause':str(pause),'env':str(env),'update_lock':str(lock),'files':files,'container':'fixture'}
 def command(self,args,**kw):
  if args[0]=='docker':return json.dumps([{'HostConfig':{'RestartPolicy':{'Name':'no'}},'State':{'Running':True},'Config':{'Env':['IAM_AUTOMATION_HOLD=1']}}])
  return 'LoadState=masked\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlPID=0\n'
 def test_dry_run_and_install_preserve_journal_hold_pause(self):
  with tempfile.TemporaryDirectory() as d,patch.object(b,'protected',lambda p:Path(p)),patch.object(b.subprocess,'check_output',self.command):
   spec=self.fixture(d);raw=Path(spec['state']).read_bytes();self.assertFalse(b.install(spec)['installed']);self.assertEqual(list(Path(spec['install_dir']).iterdir()),[])
   self.assertTrue(b.install(spec,True)['installed']);self.assertEqual({p.name for p in Path(spec['install_dir']).iterdir()},b.NAMES);self.assertEqual(Path(spec['state']).read_bytes(),raw);self.assertTrue(Path(spec['pause']).exists());self.assertIn('IAM_AUTOMATION_HOLD=1',Path(spec['env']).read_text())
 def test_unmasked_or_active_service_refused_without_install(self):
  for bad in ['LoadState=loaded','ActiveState=active','MainPID=123']:
   with self.subTest(bad=bad),tempfile.TemporaryDirectory() as d,patch.object(b,'protected',lambda p:Path(p)):
    spec=self.fixture(d)
    def command(args,**kw):
     out=self.command(args,**kw)
     if args[0]!='docker':
      key=bad.split('=')[0];out='\n'.join(bad if line.startswith(key+'=') else line for line in out.splitlines())
     return out
    with patch.object(b.subprocess,'check_output',command),self.assertRaises(ValueError):b.install(spec,True)
    self.assertEqual(list(Path(spec['install_dir']).iterdir()),[])
 def test_changed_staged_binding_refused(self):
  with tempfile.TemporaryDirectory() as d,patch.object(b,'protected',lambda p:Path(p)),patch.object(b.subprocess,'check_output',self.command):
   spec=self.fixture(d);Path(spec['files'][0]['source']).write_text('changed')
   with self.assertRaises(ValueError):b.install(spec,True)
if __name__=='__main__':unittest.main()
