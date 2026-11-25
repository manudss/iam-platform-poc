import hashlib,importlib.util,json,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('rq',Path(__file__).with_name('restored-held-qualification.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def fixture(self,d):
  root=Path(d);pol=root/'policy';pol.write_text('{}');before=root/'before.json';before.write_text(json.dumps({'policyHash':hashlib.sha256(pol.read_bytes()).hexdigest()}));env=root/'env';env.write_text('IAM_AUTOMATION_HOLD=1\n');qual=Path(m.__file__).with_name('qualification.py').absolute()
  def binding(p):return {'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
  manifest={'opening':{'qualifier':binding(qual),'before':binding(before),'policy':binding(pol),'env':binding(env)}}
  target={'sha':'a'*40,'digest':'sha256:'+'b'*64};identity={**target,'running':True,'container_id':'container','image_id':'image'}
  class Controller:
   def read_spec(self,spec):
    p=Path(spec['path']);raw=p.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=spec['sha256']:raise ValueError('changed')
    return p,raw
   def verify(self,*a,**k):return {'IAM_AUTOMATION_HOLD':'1','LYAM_FRONT_BARRIER_FILE':'gate'},{}
  class Queue:
   def opening_controller(self,*a):return Controller()
   def observe_running(self,*a):return dict(identity)
  def run(args,**kwargs):
   (root/'after-fresh.json').write_text(json.dumps({'image':'ghcr.io/manudss/iam-platform-poc@'+target['digest'],'policyHash':manifest['opening']['policy']['sha256'],'transportCoverage':'TLS_EXPECTED_ORIGINS','dolt':[{'root':'synthetic'}],'bao':{},'postgres':{},'credentials':{},'migrationLedger':[]}))
   (root/'smoke-fresh.json').write_text(json.dumps({'journal':{},'ledger':[1]}))
   return type('Result',(),{'returncode':0})()
  return root,manifest,target,Queue(),identity,run
 def test_executes_installed_controller_and_computes_fresh_bound_evidence(self):
  with tempfile.TemporaryDirectory() as d:
   root,manifest,target,q,identity,run=self.fixture(d)
   with patch.object(m.subprocess,'run',side_effect=run) as child:r=m.execute(q,manifest,'app',target,(8,9))
   self.assertEqual(r['observed_running'],identity);self.assertEqual(r['kind'],'direct-installed-held-qualification');self.assertLessEqual(r['started_at'],r['completed_at']);self.assertEqual(len(r['store_fingerprint']),64)
   self.assertIn('--require-automation-hold',child.call_args.args[0]);self.assertEqual(Path(child.call_args.args[0][1]).name,'qualification.py')
 def test_fake_receipt_cannot_replace_direct_execution_and_missing_output_refuses(self):
  with tempfile.TemporaryDirectory() as d:
   root,manifest,target,q,identity,run=self.fixture(d);manifest['qualification_receipt']={'result':'qualified'}
   with patch.object(m.subprocess,'run',return_value=type('Result',(),{'returncode':0})()),self.assertRaises(ValueError):m.execute(q,manifest,'app',target,(8,9))
 def test_changed_runtime_or_failed_qualifier_refuses(self):
  for bad in ('runtime','qualifier'):
   with self.subTest(bad=bad),tempfile.TemporaryDirectory() as d:
    root,manifest,target,q,identity,run=self.fixture(d);i=[0]
    def observe(*a):
     i[0]+=1;return {**identity,'container_id':'first' if i[0]==1 else 'second'}
    if bad=='runtime':q.observe_running=observe
    with patch.object(m.subprocess,'run',side_effect=run if bad=='runtime' else lambda *a,**k:type('Result',(),{'returncode':1})()),self.assertRaises(ValueError):m.execute(q,manifest,'app',target,(8,9))
if __name__=='__main__':unittest.main()
