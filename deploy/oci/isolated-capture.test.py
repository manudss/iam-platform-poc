import importlib.util,json,unittest
from pathlib import Path
s=importlib.util.spec_from_file_location('c',Path(__file__).with_name('isolated-capture.py'));c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
class Tests(unittest.TestCase):
 def test_exact_capture_fifo_fence_order_and_cleanup(self):
  trace=[]
  def cmd(args,input=None):
   trace.append(args)
   if args[:3]==['docker','network','inspect']:return json.dumps([{'Internal':True,'EnableIPv6':False,'IPAM':{'Config':[{'Gateway':'172.27.0.1'}]},'Containers':{'p':{'Name':'pg-copy','IPv4Address':'172.27.0.10/24'},'b':{'Name':'bao-copy','IPv4Address':'172.27.0.11/24'}}}])
   if args[:2]==['docker','run']:
    self.assertIn('--read-only',args);self.assertIn('--cap-drop',args);self.assertIn('--memory-swap',args);self.assertNotIn('capture',args[-1:]);return 'cid'
   if args[:2]==['docker','inspect']:return json.dumps([{'State':{'Pid':123}}])
   if args[:3]==['docker','exec','-i']:
    self.assertTrue(any('DROP' in a and 'raw' in a for a in trace));self.assertEqual(json.loads(input)['baoToken'],'fictional');return '{}'
   if '-nvx' in args:return '1 1 '+('DROP' if 'raw' in args else 'REJECT')+' all'
   return ''
  out=c.capture(cmd,'image','/env','/opt/lyam-qualification/copies/test/data','network','SOURCE',json.dumps({'isolatedCopy':True,'pgContainer':'pg-copy','baoContainer':'bao-copy','baoToken':'fictional'}));self.assertEqual(out,'{}');self.assertIn(['docker','rm','-f','cid'],trace)
 def test_unmarked_policy_refuses_before_network(self):
  with self.assertRaises(ValueError):c.capture(lambda *a:(_ for _ in ()).throw(AssertionError()),'i','e','d','n','s','{}')
 def test_run_ambiguous_failure_recovers_only_label_bound_id(self):
  trace=[]
  def cmd(a,inp=None):
   trace.append(a)
   if a[:3]==['docker','network','inspect']:return json.dumps([{'Internal':True,'EnableIPv6':False}])
   if a[:2]==['docker','run']:raise ValueError('ambiguous')
   if a[:3]==['docker','ps','-aq']:
    if a[-1].startswith('label='):return 'exactid'
    return ''
   if a[:2]==['docker','inspect']:
    name=next(v.split('=',2)[2] for v in trace[-2] if v.startswith('label='))
    return json.dumps([{'Id':'exactid','Name':'/'+name,'Config':{'Labels':{'lyam-copy-capture':name}}}])
   return ''
  with self.assertRaises(ValueError):c.capture(cmd,'i','e','/opt/lyam-qualification/copies/test/data','n','s','{"isolatedCopy":true}')
  self.assertIn(['docker','rm','-f','exactid'],trace)
if __name__=='__main__':unittest.main()
