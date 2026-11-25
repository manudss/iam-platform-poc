import copy,hashlib,importlib.util,json,subprocess,tempfile,unittest
from pathlib import Path
HERE=Path(__file__).parent

def mod(name,file):
 s=importlib.util.spec_from_file_location(name,HERE/file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
q=mod('q','ordered-queue.py');r=mod('reconcile','reconcile-restored-held.py');b=mod('boot','release-boot-guard.py')
OLD='a'*40;MID='b'*40;NEW='c'*40;DIG='sha256:'+'d'*64
class Tests(unittest.TestCase):
 def fixture(self,d):
  p=Path(d)/'state';pause=Path(d)/'pause';pause.write_bytes(b'original pause')
  state={'format':3,'history':[{'sha':OLD,'digest':'sha256:'+'e'*64,'mode':'ui-open-automation-held','automation_held':True}],'recovery_fence':OLD,'recoveries':[{'target':{'sha':OLD}}],'resume_required':True};q.atomic(p,state)
  m={'format':1,'kind':'reviewed-restored-held','state_fingerprint':q.fingerprint(state),'expected_delivered':{'sha':OLD,'digest':'sha256:'+'e'*64},'target':{'sha':NEW,'digest':DIG},'chain':[{'sha':MID,'parent':OLD,'outcome':'restored-over-not-delivered'},{'sha':NEW,'parent':MID,'outcome':'restored-automation-held'}],'qualification_receipt':{'fixture':'not a real receipt'},'authorization_ref':'unverified test claim','evidence_refs':['fixture'],'opening':{'closed_receipt':{'fixture':True}}}
  calls=[]
  class Controller:
   def verify(self,m,c,t,public=503):
    calls.append(('closed',public));return {'IAM_AUTOMATION_HOLD':'1','LYAM_PAUSE_FILE':str(pause)},{}
  def verify(repo,base,chain):calls.append(('chain',base,copy.deepcopy(chain)))
  def qualify(proof,target):calls.append(('qualify',target))
  def observe(container,target):calls.append(('observe',container));return {**target,'running':True,'image_id':'same','container_id':'immutable','container':container}
  return p,pause,state,m,calls,{'verify':verify,'qualify':qualify,'observe':observe,'controller':Controller()}
 def test_append_only_explicit_restored_mode_legacy_readers_refuse(self):
  with tempfile.TemporaryDirectory() as d:
   p,pause,old,m,calls,kw=self.fixture(d);s=r.reconcile(q,p,m,'repo','app',pause,**kw)
   self.assertEqual(s['history'][:-1],old['history']);self.assertEqual(s['recoveries'][:-1],old['recoveries']);self.assertEqual(s['format'],5)
   self.assertEqual([e['sha'] for e in s['history']],[OLD,NEW]);self.assertEqual(s['recoveries'][-1]['chain'],m['chain']);self.assertEqual(s['recoveries'][-1]['manifest_claims']['verified_authority'],False)
   self.assertEqual(pause.read_bytes(),b'original pause');self.assertEqual(sum(c[0]=='closed' for c in calls),2)
   self.assertEqual(q.load(p,allow_restored=True),s)
   with self.assertRaises(ValueError):q.load(p)
   with self.assertRaises(ValueError):b.check(p)
   with self.assertRaises(ValueError):q.check_held_update(s,{},pause_present=True)
   with self.assertRaises(ValueError):q.resume_reviewed(p,{},'app')
   legacy=subprocess.check_output(['git','show','276d32:deploy/oci/ordered-queue.py'],cwd=HERE).decode();file=Path(d)/'legacy.py';file.write_text(legacy)
   run=subprocess.run(['python3',str(file),'status','--state',str(p),'--pause-file',str(pause)],capture_output=True);self.assertNotEqual(run.returncode,0)
 def test_missing_qualification_changed_runtime_chain_or_pause_never_write(self):
  for bad in ('qualification','runtime','chain','pause'):
   with self.subTest(bad=bad),tempfile.TemporaryDirectory() as d:
    p,pause,old,m,calls,kw=self.fixture(d);raw=p.read_bytes()
    if bad=='qualification':kw['qualify']=lambda *a:(_ for _ in ()).throw(ValueError('missing real evidence'))
    if bad=='runtime':kw['observe']=lambda *a:{'sha':OLD,'digest':DIG,'running':True}
    if bad=='chain':kw['verify']=lambda *a:(_ for _ in ()).throw(ValueError('not actual first parent'))
    if bad=='pause':pause.unlink()
    with self.assertRaises(ValueError):r.reconcile(q,p,m,'repo','app',pause,**kw)
    self.assertEqual(p.read_bytes(),raw)
 def test_actual_source_chain_rejects_manifest_fiction(self):
  # Real git operations on a disposable repository, not a production source.
  with tempfile.TemporaryDirectory() as d:
   repo=Path(d);subprocess.run(['git','init','-q',str(repo)],check=True)
   def git(*args):return subprocess.check_output(['git','-C',str(repo),*args],text=True).strip()
   git('config','user.email','fixture@example.invalid');git('config','user.name','fixture')
   commits=[]
   for n in range(3):
    (repo/'file').write_text(str(n));git('add','file');git('commit','-qm','fixture');commits.append(git('rev-parse','HEAD'))
   git('update-ref','refs/remotes/origin/main',commits[-1]);chain=[{'sha':commits[i],'parent':commits[i-1]} for i in (1,2)]
   q.verify_source_chain(repo,commits[0],chain)
   with self.assertRaises(ValueError):q.verify_source_chain(repo,commits[0],[chain[-1]])
if __name__=='__main__':unittest.main()
