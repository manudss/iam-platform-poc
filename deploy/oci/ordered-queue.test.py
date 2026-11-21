import importlib.util, json, os, subprocess as sp, tempfile, unittest
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
 def runok(self,args,**kw):self.calls.append(args);self.kw=getattr(self,'kw',[])+[kw];return SimpleNamespace(returncode=0)
 def config(self,pins,mode=0o600,pf_mode=0o700,fmt=1,no_transform=None):
  pf=Path(self.tmp.name)/'update-preflight.py';pf.write_text('# reviewed preflight\n');os.chmod(pf,pf_mode)
  cfg=Path(self.tmp.name)/'deploy-preflight.json'
  doc={'format':fmt,'preflight':str(pf),'policy':'/opt/lyam/qualification.json','verifierPins':pins}
  if no_transform is not None: doc['noTransform']=no_transform
  cfg.write_text(json.dumps(doc));os.chmod(cfg,mode)
  return cfg,str(pf)
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
 def test_plan_entry_schema_is_strict_no_extra_keys(self):
  # The SSH guard's stdin contract is exactly {sha,parent,digest}: anything else,
  # including a pin field (present even with a null value), is refused at validation.
  for extra in [{'verifierSha256':format(2,'064x')},{'verifierSha256':None},{'note':'x'}]:
   bad=plan(1,2);bad['entries'][0].update(extra)
   with self.assertRaises(ValueError):q.deploy(self.path,bad,'update',self.runok)
  self.assertEqual(self.calls,[])
 def test_absent_config_is_byte_exact_prior_behavior(self):
  missing=Path(self.tmp.name)/'no-such-config.json'
  q.deploy(self.path,plan(1,2),'update',self.runok,preflight_config=missing)
  self.assertEqual([c[0] for c in self.calls],['update'])
 def test_populated_history_written_by_the_real_queue_resumes_with_absent_config(self):
  # Host-shaped state: the history is built by the queue itself over many cycles (entries carry sha, parent, digest and the
  # 'at' stamp), then resumed by a later overlapping plan, a stale older plan and a new tail, all with NO preflight config.
  missing=Path(self.tmp.name)/'no-such-config.json'
  q.deploy(self.path,plan(1,2,3,4,5,6),'update',self.runok,preflight_config=missing)
  before=q.load(self.path);self.assertEqual(len(before['history']),6);self.assertTrue(all('at' in e for e in before['history'][1:]))
  self.calls.clear()
  q.deploy(self.path,plan(3,4,5,6,7,8),'update',self.runok,preflight_config=missing)       # overlaps four confirmed entries, two new
  self.assertEqual(len(self.calls),2);self.assertEqual([e['sha'] for e in q.load(self.path)['history']],[S(i) for i in range(1,9)])
  self.assertEqual([e['digest'] for e in q.load(self.path)['history'][:6]],[e['digest'] for e in before['history']])  # confirmed digests untouched
  self.calls.clear()
  q.deploy(self.path,plan(2,3,4),'update',self.runok,preflight_config=missing)             # stale older runner: nothing to do
  self.assertEqual(self.calls,[]);self.assertEqual(len(q.load(self.path)['history']),8)
 def test_pinned_entry_preflighted_before_updater_order_preserved(self):
  cfg,pf=self.config({D(2):format(2,'064x')},no_transform=[D(3)])
  q.deploy(self.path,plan(1,2,3),'update',self.runok,preflight_config=cfg)
  self.assertEqual([c[0] for c in self.calls],[pf,'update','update'])
  self.assertEqual(self.calls[0][:2],[pf,'--image']);self.assertIn('--policy',self.calls[0]);self.assertIn(format(2,'064x'),self.calls[0])
 def test_preflight_bounded_timeout_passed(self):
  cfg,pf=self.config({D(2):format(2,'064x')})
  q.deploy(self.path,plan(1,2),'update',self.runok,preflight_config=cfg)
  self.assertEqual(self.kw[0].get('timeout'),120)
 def test_preflight_timeout_fails_closed_before_updater(self):
  cfg,pf=self.config({D(2):format(2,'064x')})
  def hang(args,**kw):
   self.calls.append(args)
   if args[0]==pf:raise sp.TimeoutExpired(cmd=args,timeout=120)
   return SimpleNamespace(returncode=0)
  with self.assertRaises(RuntimeError):q.deploy(self.path,plan(1,2),'update',hang,preflight_config=cfg)
  self.assertEqual([c[0] for c in self.calls],[pf])
  st=q.load(self.path);self.assertEqual(st['failed']['phase'],'preflight');self.assertEqual(st['failed']['exit'],124)
 def test_preflight_refusal_never_touches_updater_and_blocks(self):
  cfg,pf=self.config({D(2):format(2,'064x')})
  def refuse(args,**kw):
   self.calls.append(args);return SimpleNamespace(returncode=1 if args[0]==pf else 0)
  with self.assertRaises(RuntimeError):q.deploy(self.path,plan(1,2),'update',refuse,preflight_config=cfg)
  self.assertEqual([c[0] for c in self.calls],[pf])  # updater never ran: no gate, no state change
  st=q.load(self.path);self.assertEqual(st['failed']['phase'],'preflight');self.assertEqual(len(st['history']),1)
  with self.assertRaises(ValueError):q.deploy(self.path,plan(1,2),'update',self.runok,preflight_config=cfg)
 def test_no_transform_entry_deploys_without_preflight(self):
  cfg,pf=self.config({D(3):format(3,'064x')},no_transform=[D(2)])  # pin only for a later entry
  q.deploy(self.path,plan(1,2,3),'update',self.runok,preflight_config=cfg)
  self.assertEqual([c[0] for c in self.calls],['update',pf,'update'])
 def test_undeclared_digest_refused_before_any_state_write(self):
  cfg,pf=self.config({D(2):format(2,'064x')})  # nothing declared for D(3)
  before=self.path.read_bytes()
  with self.assertRaises(ValueError):q.deploy(self.path,plan(1,2,3),'update',self.runok,preflight_config=cfg)
  self.assertEqual(self.calls,[]);self.assertEqual(self.path.read_bytes(),before)
 def test_digest_cannot_be_both_pinned_and_no_transform(self):
  cfg,pf=self.config({D(2):format(2,'064x')},no_transform=[D(2)])
  with self.assertRaises(ValueError):q.deploy(self.path,plan(1,2),'update',self.runok,preflight_config=cfg)
  self.assertEqual(self.calls,[])
 def test_invalid_no_transform_value_fails_closed(self):
  cfg,pf=self.config({},no_transform=['not-a-digest'])
  with self.assertRaises(ValueError):q.deploy(self.path,plan(1,2),'update',self.runok,preflight_config=cfg)
  self.assertEqual(self.calls,[])
 def test_invalid_config_fails_closed_before_any_state_write(self):
  for kwargs in [{'fmt':2},{'mode':0o644},{'pf_mode':0o755}]:
   cfg,pf=self.config({D(2):format(2,'064x')},**kwargs)
   before=self.path.read_bytes()
   with self.assertRaises(ValueError):q.deploy(self.path,plan(1,2),'update',self.runok,preflight_config=cfg)
   self.assertEqual(self.calls,[]);self.assertEqual(self.path.read_bytes(),before)
   self.calls=[]
 def test_invalid_pin_value_in_config_fails_closed(self):
  cfg,pf=self.config({D(2):'not-a-pin'})
  with self.assertRaises(ValueError):q.deploy(self.path,plan(1,2),'update',self.runok,preflight_config=cfg)
  self.assertEqual(self.calls,[])
 def test_pin_keyed_by_exact_digest_only(self):
  # A pin recorded for a DIFFERENT digest is no disposition for this entry: refused.
  cfg,pf=self.config({'sha256:'+'f'*64:format(2,'064x')})
  with self.assertRaises(ValueError):q.deploy(self.path,plan(1,2),'update',self.runok,preflight_config=cfg)
  self.assertEqual(self.calls,[])
if __name__=='__main__':unittest.main()
