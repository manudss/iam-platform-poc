#!/usr/bin/python3
import unittest,importlib.util
from unittest.mock import patch
from types import SimpleNamespace
s=importlib.util.spec_from_file_location('f',str(__import__('pathlib').Path(__file__).parents[2]/'scripts/closed-helper-docker-fixture.py'));f=importlib.util.module_from_spec(s);s.loader.exec_module(f)
class PostApp(unittest.TestCase):
 def test_companion_readiness_explicit_http(self):
  for pgcode,baocode,expected in [(0,0,True),(1,0,False),(0,1,False),(1,1,False)]:
   with patch.object(f,'call',side_effect=[SimpleNamespace(returncode=pgcode),SimpleNamespace(returncode=baocode)]) as call:
    diagnostics={}
    self.assertEqual(f.companions_ready('fixture-pg','fixture-bao',diagnostics),expected)
    self.assertEqual(diagnostics,{'pgIsReadyRC':pgcode,'baoStatusRC':baocode})
    self.assertEqual(call.call_args_list[1].args,(['docker','exec','-e','BAO_ADDR=http://127.0.0.1:8200','fixture-bao','bao','status'],False))
 def test_failure_code_allowlist(self):
  with patch.object(f,'HELPER_ERRORS',{'ValueError: ledger changed from reviewed source'}):
   self.assertEqual(f.failure_code('trace\nValueError: ledger changed from reviewed source\n'),'ValueError: ledger changed from reviewed source')
   self.assertEqual(f.failure_code('ValueError: private arbitrary content'),'unclassified-subprocess-failure')
 def test_fixture_ancestry(self):
  root=__import__('pathlib').Path('/root/fixture')
  for uid,mode,ok in [(0,0o700,True),(0,0o755,True),(1001,0o755,False),(0,0o775,False),(0,0o777,False)]:
   with patch('pathlib.Path.stat',return_value=SimpleNamespace(st_uid=uid,st_mode=mode)):
    if ok:f.assert_fixture_ancestry(root)
    else:self.assertRaises(ValueError,f.assert_fixture_ancestry,root)
 def test_postapp(self):
  launch={'policy4Exact':'four','policy6Exact':'six'};summary={'pid1Status':['CapEff: 0000000000000000','CapBnd: 0000000000000000','NoNewPrivs: 1']};f.assert_postapp('four','six',launch,summary)
  for a,b in [('changed','six'),('four','changed')]:self.assertRaises(ValueError,f.assert_postapp,a,b,launch,summary)
  for field in ['CapEff','CapBnd','NoNewPrivs']:
   bad={'pid1Status':[x.replace('0000000000000000','0000000000000001') if x.startswith(field) else x for x in summary['pid1Status']]}
   if field=='NoNewPrivs':bad={'pid1Status':[x.replace('NoNewPrivs: 1','NoNewPrivs: 0') for x in summary['pid1Status']]}
   self.assertRaises(ValueError,f.assert_postapp,'four','six',launch,bad)
if __name__=='__main__':unittest.main()
