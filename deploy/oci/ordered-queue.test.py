import importlib.util, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('queue',Path(__file__).with_name('ordered-queue.py'));q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
S=lambda n:format(n,'040x'); D=lambda n:'sha256:'+format(n,'064x')
def plan(base,*nums):
 entries=[];parent=S(base)
 for n in nums: entries.append({'sha':S(n),'parent':parent,'digest':D(n)});parent=S(n)
 return {'format':1,'base':S(base),'entries':entries}
class Queue(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'state.json';q.atomic(self.path,{'format':1,'history':[{'sha':S(1),'digest':D(1)}]});self.calls=[]
 def tearDown(self):self.tmp.cleanup()
 def runok(self,args,**kw):self.calls.append(args);return SimpleNamespace(returncode=0)
 def test_order_multicommit(self):
  q.deploy(self.path,plan(1,2,3,4),'update',self.runok);self.assertEqual([e['sha'] for e in q.load(self.path)['history']],[S(i) for i in range(1,5)])
 def test_overlap_newer_runner_then_stale(self):
  q.deploy(self.path,plan(1,2,3),'update',self.runok);q.deploy(self.path,plan(1,2),'update',self.runok);self.assertEqual(len(self.calls),2)
 def test_overlap_older_then_newer(self):
  q.deploy(self.path,plan(1,2),'update',self.runok);q.deploy(self.path,plan(1,2,3),'update',self.runok);self.assertEqual(len(self.calls),2)
 def test_rebuilt_overlap_never_replaces_deployed_digest(self):
  q.deploy(self.path,plan(1,2),'update',self.runok);bad=plan(1,2,3);bad['entries'][0]['digest']=D(999)
  q.deploy(self.path,bad,'update',self.runok);self.assertEqual(q.load(self.path)['history'][1]['digest'],D(2));self.assertEqual(len(self.calls),2)
 def test_fail_blocks_followers_and_retry(self):
  with self.assertRaises(RuntimeError):q.deploy(self.path,plan(1,2,3),'update',lambda *a,**k:SimpleNamespace(returncode=3))
  self.assertEqual(len(q.load(self.path)['history']),1)
  with self.assertRaises(ValueError):q.deploy(self.path,plan(1,2,3),'update',self.runok)
 def test_crash_pending_blocks(self):
  def crash(*a,**kw):raise RuntimeError('crash after update could have succeeded')
  with self.assertRaises(RuntimeError):q.deploy(self.path,plan(1,2),'update',crash)
  with self.assertRaises(ValueError):q.deploy(self.path,plan(1,2),'update',self.runok)
 def test_gap_unknown_baseline_duplicate_invalid_digest(self):
  for bad in [plan(5,6),{'format':1,'base':S(1),'entries':[{'sha':S(3),'parent':S(2),'digest':D(3)}]},plan(1,2,2),{'format':1,'base':S(1),'entries':[{'sha':S(2),'parent':S(1),'digest':'latest'}]}]:
   with self.assertRaises(ValueError):q.deploy(self.path,bad,'update',self.runok)
if __name__=='__main__':unittest.main()
