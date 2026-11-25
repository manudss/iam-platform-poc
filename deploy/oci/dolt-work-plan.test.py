import importlib.util,json,tempfile,unittest,hashlib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('workplan',Path(__file__).with_name('dolt-work-plan.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_exact_identity_refuses_before_preparation(self):
  calls=[];reader=SimpleNamespace(read_binding=lambda b:(None,json.dumps({'source_inventory_sha256':'wrong'}).encode()),prepare_work_copy=lambda *args:calls.append(args))
  with self.assertRaises(ValueError):m.execute_preparation(reader,None)
  self.assertFalse(calls)
 def test_actual_synthetic_preparation_leaves_input_untouched(self):
  rs=importlib.util.spec_from_file_location('reader',Path(__file__).with_name('dolt-copy-capture.py'));reader=importlib.util.module_from_spec(rs);rs.loader.exec_module(reader)
  ss=importlib.util.spec_from_file_location('stage',Path(__file__).with_name('dolt-source-stage.py'));stager=importlib.util.module_from_spec(ss);ss.loader.exec_module(stager)
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);incoming=root/'incoming';incoming.mkdir();(incoming/'private').write_text('synthetic');rows=stager.inventory(incoming);finger=stager.fingerprint(rows)
   stage={'source_inventory_sha256':finger,'incoming_inventory_sha256':finger,'source_unchanged':True,'source_incoming_bytes_equal':True};raw=json.dumps(stage).encode()
   actual_prepare=reader.prepare_work_copy
   def prepare(source,work):
    # Test-only root/path guard double; production constants never become CLI args.
    with patch.object(reader.re,'fullmatch',return_value=True),patch.object(reader.os,'chown'):
     return actual_prepare(source,work)
   reader.read_binding=lambda b:(None,raw);reader.prepare_work_copy=prepare
   with patch.object(m,'ROOT',root),patch.object(m,'INVENTORY_SHA',finger),patch.object(reader,'digest_tree',return_value=('synthetic-work-hash',9,1)):result=m.execute_preparation(reader,stager)
   self.assertTrue(result['incoming_unchanged']);self.assertFalse(result['docker_executed']);self.assertEqual(stager.inventory(incoming),rows);self.assertEqual((root/'work/private').read_text(),'synthetic');self.assertEqual((root/'work/private').stat().st_mode&0o777,0o600)
if __name__=='__main__':unittest.main()
