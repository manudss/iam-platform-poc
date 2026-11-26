import importlib.util,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('b',Path(__file__).with_name('variant-b-capture.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_restart_always_refused_before_process_loader_or_signal(self):
  calls=[]
  def docker(*args):calls.append(args);return json.dumps([{'HostConfig':{'RestartPolicy':{'Name':'always'}}}])
  def forbidden(*args):raise AssertionError('no process probe may load')
  with patch.object(m.os,'geteuid',return_value=0),patch.dict(os.environ,{'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted'}),patch.object(m.Path,'exists',return_value=False):
   with self.assertRaisesRegex(ValueError,'restart policy'):
    m.quiesce_archive({},Path('/code'),Path('/root'),Path('/source'),Path('/archive'),'test-eng','pg','bao','app','sha','digest','image','pgimage','baoimage',{},forbidden,forbidden,forbidden,docker,forbidden)
  self.assertEqual(calls,[('inspect','app')])
 def test_non_dev_refused_before_effect(self):
  with patch.object(m.os,'geteuid',return_value=1000):
   with self.assertRaisesRegex(ValueError,'DEV runner'):
    m.quiesce_archive({},None,None,None,None,None,None,None,None,None,None,None,None,None,None,None,None,None,None,None)
if __name__=='__main__':unittest.main()
