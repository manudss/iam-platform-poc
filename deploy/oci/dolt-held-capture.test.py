import importlib.util,json,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
s=importlib.util.spec_from_file_location('heldcapture',Path(__file__).with_name('dolt-held-capture.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def run_capture(self,moving=False):
  envelope={'format':1,'kind':'dolt-only-tables-v3','running':True,'dolt':[{'root':'one'}]};out=Path('/root/dolt-held-evidence-'+'a'*16+'.json');spec={'format':1,'kind':'reviewed-held-dolt-only-capture','runtime_controller':{},'runtime':{'container':'held','expected_container_id':'a'*64},'source':{'sha256':'a'*64},'executed_source_sha256':'b'*64,'out':str(out)};events=[];writes=[]
  runtime=SimpleNamespace(locks=lambda b:events.append('locks'),verify=lambda s,b:(events.append('verify') or {'id':'held'}))
  def reader(b):return Path(m.__file__).with_name('qualification-container.mjs').absolute(),b'fixed source'
  calls=[SimpleNamespace(returncode=0,stdout=json.dumps(envelope)),SimpleNamespace(returncode=0,stdout=json.dumps({**envelope,'dolt':[{'root':'changed'}]} if moving else envelope))]
  with tempfile.TemporaryDirectory() as d:
   actual=Path(d)/'out';real_open=m.os.open
   def opened(path,*args):writes.append(path);return real_open(actual,*args)
   with patch.object(m,'resource_monitor',return_value=SimpleNamespace(start=lambda:SimpleNamespace(finish=lambda:{}))),patch.object(m.hashlib,'sha256',return_value=SimpleNamespace(hexdigest=lambda:'b'*64)),patch.object(Path,'read_text',return_value='MemAvailable: 5000000 kB\n'),patch.object(m,'load_fixed',return_value=runtime),patch.object(Path,'exists',return_value=False),patch.object(m.subprocess,'run',side_effect=[SimpleNamespace(returncode=0,stdout=json.dumps([{'Image':'sha256:'+'c'*64}])),calls[0],SimpleNamespace(returncode=0),calls[1],SimpleNamespace(returncode=0)]) as run,patch.object(m.os,'open',side_effect=opened),patch.object(Path,'read_bytes',return_value=b'output'):
    if moving:
     with self.assertRaisesRegex(ValueError,'moving'):m.execute(spec,{'journal':('j',8),'updater':('u',9)},reader)
     self.assertFalse(writes);return
    result=m.execute(spec,{'journal':('j',8),'updater':('u',9)},reader)
    self.assertTrue(result['stable_double_capture']);self.assertFalse(result['restoration_admissible']);self.assertEqual(run.call_count,5);self.assertEqual(events,['locks','verify','verify','locks']);self.assertTrue(all(c.kwargs.get('pass_fds')==(8,9) for c in run.call_args_list if c.args[0][:2]==['docker','run']));
    with actual.open() as f:self.assertEqual(json.load(f),envelope)
 def test_stable_double_read_and_locks(self):self.run_capture()
 def test_movement_never_writes(self):self.run_capture(True)
if __name__=='__main__':unittest.main()
