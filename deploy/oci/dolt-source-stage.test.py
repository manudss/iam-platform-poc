import importlib.util,tempfile,unittest,os
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('stage',Path(__file__).with_name('dolt-source-stage.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_content_inventory_and_link_refusal(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'a').write_bytes(b'synthetic');a=m.inventory(root)
   self.assertEqual(sum(r['size'] or 0 for r in a),9)
   (root/'link').symlink_to(root/'a')
   with self.assertRaises(ValueError):m.inventory(root)
   (root/'link').unlink();os.link(root/'a',root/'hard')
   with self.assertRaises(ValueError):m.inventory(root)
 def test_stage_mismatch_refuses_before_destination_creation(self):
  root=Path('/root/dolt-evidence-'+'f'*16)
  with patch.object(Path,'exists',return_value=False),patch.object(m,'make_plan',return_value={'source_inventory_sha256':'one'}),patch.object(Path,'mkdir') as mkdir:
   with self.assertRaisesRegex(ValueError,'differs'):m.stage({'source_inventory_sha256':'two'},root)
   mkdir.assert_not_called()
 def test_content_keeps_hash_paths_sizes_but_not_modes(self):
  a=[{'path':'a','size':1,'sha256':'fixed','mode':511}];b=[{**a[0],'mode':384}]
  self.assertEqual(m.content(a),m.content(b));self.assertNotEqual(m.fingerprint(a),m.fingerprint(b))
if __name__=='__main__':unittest.main()
