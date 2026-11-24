#!/usr/bin/python3
import importlib.util,unittest,types
from unittest.mock import patch
s=importlib.util.spec_from_file_location('h',str(__import__('pathlib').Path(__file__).with_name('closed-recovery-helper.py')));h=importlib.util.module_from_spec(s);s.loader.exec_module(h)
class Live(unittest.TestCase):
 def go(self,change=None):
  state={'interfaces':[{'name':'eth0','disabled':'1'}],'addresses':'addr lo','routes':'route lo'}
  proof={'containerID':'cid','namespaceInode':11,'policy4Exact':'four','policy6Exact':'six','ipv6State':state,'ipv6DisabledProved':True}
  x={'Id':'cid','Image':'imageid','State':{'Running':True,'Pid':123}}
  if change=='identity':x['Image']='bad'
  def call(args):
   if args[0]=='nsenter':return ('BAD' if change=='rules' else 'four') if args[-2]=='iptables' else 'six'
   import json
   return json.dumps({**state,'interfaces':[{'name':'eth0','disabled':'0'}]} if change=='ipv6' else state)
  status='CapEff: 0000000000000000\nCapBnd: 0000000000000000\nNoNewPrivs: '+('0' if change=='caps' else '1')
  with patch.object(h,'inspect',return_value=x),patch.object(h.os,'stat',return_value=types.SimpleNamespace(st_ino=11)),patch.object(h,'call',side_effect=call),patch.object(h.pathlib.Path,'read_text',return_value=status):return h.verify_live(proof,{'imageID':'imageid'},types.SimpleNamespace(container='name'))
 def test_stabilization_waits_for_tentative(self):
  from unittest.mock import Mock
  base={'interfaces':[{'name':'eth0','disabled':'0'}],'addresses':'fe80 02 40 20 80 eth0','routes':'route stable'}
  pending={**base,'addresses':'fe80 02 40 20 c0 eth0'}
  read=Mock(side_effect=[pending,base,base,base]);self.assertEqual(h.stable_ipv6(read,lambda _:None),base)
  self.assertEqual(read.call_count,4)
  self.assertRaises(ValueError,h.stable_ipv6,lambda:pending,lambda _:None)
  self.assertRaises(ValueError,h.stable_ipv6,lambda:{**base,'addresses':'fe80 02 40 20 88 eth0'},lambda _:None)
 def test_live(self):self.assertTrue(self.go()['liveVerified'])
 def test_identity_changed(self):self.assertRaises(ValueError,self.go,'identity')
 def test_rules_changed(self):self.assertRaises(ValueError,self.go,'rules')
 def test_caps_changed(self):self.assertRaises(ValueError,self.go,'caps')
 def test_ipv6_changed(self):self.assertRaises(ValueError,self.go,'ipv6')
if __name__=='__main__':unittest.main()
