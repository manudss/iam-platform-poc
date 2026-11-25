import importlib.util,json,os,signal,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
s=importlib.util.spec_from_file_location('client',Path(__file__).with_name('dolt-current-client.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_real_usr1_during_finish_and_exact_remove_is_deferred(self):
  events=[];names=[];signals=[]
  def refusal(s,f):raise TimeoutError('real guard refusal')
  old=signal.signal(signal.SIGUSR1,refusal)
  try:
   def finish():
    events.append('finish');os.kill(os.getpid(),signal.SIGUSR1);return {'samples':1}
   def run(args,**kw):
    if args[:2]==['docker','run']:
     names.append(args[args.index('--name')+1]);return SimpleNamespace(returncode=0,stdout=json.dumps({'format':1,'kind':'dolt-only-tables-v3','running':True,'dolt':[{'root':'test'}]}))
    if args[:2]==['docker','ps']:
     self.assertIn('name=^/'+names[0]+'$',args);events.append('absence');return SimpleNamespace(returncode=0,stdout='')
    self.assertEqual(args,['docker','rm','-f',names[0]]);events.append('rm');os.kill(os.getpid(),signal.SIGUSR1);return SimpleNamespace(returncode=0)
   with patch.object(m,'resource_monitor',return_value=SimpleNamespace(start=lambda:SimpleNamespace(finish=finish))),patch.object(m.subprocess,'run',side_effect=run):
    m.capture_once('a'*64,'sha256:'+'b'*64,'source',{},[])
   self.assertEqual(events,['finish','rm','absence']);self.assertEqual(signals,[])
   with self.assertRaises(TimeoutError):os.kill(os.getpid(),signal.SIGUSR1)
  finally:signal.signal(signal.SIGUSR1,old)
if __name__=='__main__':unittest.main()
