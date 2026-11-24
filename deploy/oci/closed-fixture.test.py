#!/usr/bin/python3
import unittest,importlib.util
s=importlib.util.spec_from_file_location('f',str(__import__('pathlib').Path(__file__).parents[2]/'scripts/closed-helper-docker-fixture.py'));f=importlib.util.module_from_spec(s);s.loader.exec_module(f)
class PostApp(unittest.TestCase):
 def test_postapp(self):
  launch={'policy4Exact':'four','policy6Exact':'six'};summary={'pid1Status':['CapEff: 0000000000000000','CapBnd: 0000000000000000','NoNewPrivs: 1']};f.assert_postapp('four','six',launch,summary)
  for a,b in [('changed','six'),('four','changed')]:self.assertRaises(ValueError,f.assert_postapp,a,b,launch,summary)
  for field in ['CapEff','CapBnd','NoNewPrivs']:
   bad={'pid1Status':[x.replace('0000000000000000','0000000000000001') if x.startswith(field) else x for x in summary['pid1Status']]}
   if field=='NoNewPrivs':bad={'pid1Status':[x.replace('NoNewPrivs: 1','NoNewPrivs: 0') for x in summary['pid1Status']]}
   self.assertRaises(ValueError,f.assert_postapp,'four','six',launch,bad)
if __name__=='__main__':unittest.main()
