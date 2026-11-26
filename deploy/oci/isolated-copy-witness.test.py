import importlib.util,unittest
from unittest.mock import patch
from pathlib import Path
s=importlib.util.spec_from_file_location('w',Path(__file__).with_name('isolated-copy-witness.py'));w=importlib.util.module_from_spec(s);s.loader.exec_module(w)
class Tests(unittest.TestCase):
 def test_changed_rule_or_attempt_refuses(self):
  a={'rules_sha256':'a','reject_packets':4};self.assertEqual(w.verify_quiet(a,a)['new_rejected_packets'],0)
  for b in [{'rules_sha256':'b','reject_packets':4},{'rules_sha256':'a','reject_packets':5}]:
   with self.assertRaises(ValueError):w.verify_quiet(a,b)
class PartialTests(unittest.TestCase):
 def test_partial_cleanup_absence_and_exact_invariants(self):
  label='LQ0123456789ab';before='-P INPUT ACCEPT\n-A INPUT -j EXISTING'
  state=[before,'-N '+label,'-A '+label+' -j REJECT','-A INPUT -s 10.0.0.2/32 -m comment --comment '+label+' -j REJECT']
  def call(a):
   if a==['iptables','-S']:return '\n'.join(state)
   if a==['ip6tables','-S']:return '-P INPUT ACCEPT'
   if a[1]=='-D':state.remove('-A '+' '.join(a[2:]));return ''
   if a[1]=='-F':state[:]=[l for l in state if not l.startswith('-A '+label+' ')];return ''
   if a[1]=='-X':state.remove('-N '+label);return ''
   raise AssertionError(a)
  binding={'label':label,'hooks':[['INPUT','-s','10.0.0.2/32','-m','comment','--comment',label,'-j','REJECT']],'own':[['-j','REJECT']],'ips':['10.0.0.2'],'pre_v4':before,'pre_v6':'-P INPUT ACCEPT'}
  with patch.object(w,'call',side_effect=call):w.cleanup(binding);w.cleanup(binding)
  self.assertEqual(state,[before])
 def test_foreign_change_refuses(self):
  with patch.object(w,'call',return_value='foreign change'):
   with self.assertRaises(ValueError):w.cleanup({'label':'LQ0123456789ab','pre_v4':'prior','pre_v6':'prior'})
class OwnershipTest(unittest.TestCase):
 def test_foreign_hook_not_deleted(self):
  label='LQ0123456789ab';foreign='-A INPUT -j '+label
  trace=[]
  def call(args):
   trace.append(args)
   if args==['iptables','-S']:return '-N '+label+'\n'+foreign
   if args==['ip6tables','-S']:return ''
   raise AssertionError(args)
  with patch.object(w,'call',side_effect=call):
   with self.assertRaises(ValueError):w.cleanup({'label':label,'hooks':[],'own':[],'pre_v4':'','pre_v6':''})
  self.assertFalse(any(a[1] in ('-D','-F','-X') for a in trace))
 def test_probe_requires_each_host_and_forward_counter(self):
  binding={'ips':['10.0.0.2'],'backend':'10.0.0.0/24'}
  a={'reject_packets':0,'host_input_reject_packets':0};b={'reject_packets':1,'host_input_reject_packets':0}
  with patch.object(w,'call',return_value=''),patch.object(w,'snapshot',side_effect=[a,b]):
   with self.assertRaises(ValueError):w.probe(binding,123,'10.0.0.2')
  b['host_input_reject_packets']=1
  with patch.object(w,'call',return_value=''),patch.object(w,'snapshot',side_effect=[a,b]):self.assertTrue(w.probe(binding,123,'10.0.0.2')['host_and_forward_counters_advanced'])
if __name__=='__main__':unittest.main()
