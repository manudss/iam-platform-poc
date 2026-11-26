#!/usr/bin/env python3
import copy, hashlib, importlib.util, json, os, subprocess, tempfile, unittest
from pathlib import Path
HERE=Path(__file__).parent

def module(name,file):
 s=importlib.util.spec_from_file_location(name,HERE/file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
q=module('queue','ordered-queue.py');r=module('release','release-held.py');boot=module('boot','release-boot-guard.py')
SHA='a'*40;DIG='sha256:'+'b'*64

def state():
 return {'format':3,'history':[{'sha':SHA,'digest':DIG,'mode':'ui-open-automation-held','automation_held':True}], 'recovery_fence':SHA,'recoveries':[{'target':{'sha':SHA}}],'resume_required':True}
def manifest(s):
 return {'format':1,'kind':'reviewed-release-held','state_fingerprint':q.fingerprint(s),'expected_delivered':{'sha':SHA,'digest':DIG},'target':{'sha':SHA,'digest':DIG},'authorization_ref':'test decision reference only','evidence_refs':['test fixture evidence'],'engagement_id':'test-release-0001'}

class Host:
 def __init__(self,pause):self.calls=[];self.pause=pause
 def observe_held(self,container,target):return {**target,'running':True,'held':True}
 def preflight(self,*a):self.calls.append('preflight')
 def plan_gates(self):return []
 def close_access(self,*a):self.calls.append('close')
 def install_normal_env(self,*a):self.calls.append('env')
 def start_normal(self,*a):self.calls.append('start')
 def verify_normal(self,*a):return {'held':False,'settingPresent':False,'sha':SHA,'digest':DIG}
 def open_access(self,*a):self.calls.append('open')
 def finish_pause(self,*a):self.calls.append('pause');self.pause.unlink()

class Tests(unittest.TestCase):
 def setup_case(self,d):
  p=Path(d)/'state.json';pause=Path(d)/'PAUSE';pause.touch();s=state();q.atomic(p,s);return p,pause,manifest(s),Host(pause)
 def test_success_unique_history_and_readable_audit(self):
  with tempfile.TemporaryDirectory() as d:
   p,pause,m,h=self.setup_case(d);s=r.release(q,p,m,'lyam',h,pause)
   self.assertEqual(s,q.load(p));self.assertEqual(len(s['history']),1);self.assertFalse(pause.exists());boot.check(p)
   self.assertEqual(h.calls,['preflight','close','env','start','open','pause']);self.assertEqual(s['resumptions'][-1]['observed_running']['sha'],SHA)
   with self.assertRaises(ValueError):r.release(q,p,m,'lyam',h,pause)
 def test_live_mismatch_unknown_or_nonheld_refuses_before_preflight_and_writes(self):
  for observation in [{},{'sha':SHA,'digest':DIG,'held':False,'running':True},{'sha':'c'*40,'digest':DIG,'held':True,'running':True}]:
   with self.subTest(observation=observation),tempfile.TemporaryDirectory() as d:
    p,pause,m,h=self.setup_case(d);raw=p.read_bytes();h.observe_held=lambda *a:observation
    with self.assertRaisesRegex(ValueError,'runtime/journal'):r.release(q,p,m,'lyam',h,pause)
    self.assertEqual(p.read_bytes(),raw);self.assertEqual(h.calls,[]);self.assertTrue(pause.exists())
 def test_manifest_refs_are_not_recorded_as_verified_authority(self):
  with tempfile.TemporaryDirectory() as d:
   p,pause,m,h=self.setup_case(d);s=r.release(q,p,m,'lyam',h,pause)
   a=s['resumptions'][-1];self.assertNotIn('authorization_ref',a);self.assertIs(a['manifest_claims']['verified_authority'],False)
 def test_refusals_never_change_state(self):
  for field,value in [('pending',{'sha':SHA}),('failed',{}),('opening_intent',{'x':1}),('resume_required',False),('recovery_fence','c'*40)]:
   with self.subTest(field=field),tempfile.TemporaryDirectory() as d:
    p,pause,m,h=self.setup_case(d);s=state();s[field]=value
    if field=='failed':s[field]={'failure':True}
    q.atomic(p,s);raw=p.read_bytes()
    with self.assertRaises(ValueError):r.release(q,p,m,'lyam',h,pause)
    self.assertEqual(raw,p.read_bytes());self.assertEqual(h.calls,[])
 def test_stale_manifest_and_missing_pause(self):
  for what in ('stale','pause'):
   with tempfile.TemporaryDirectory() as d:
    p,pause,m,h=self.setup_case(d)
    if what=='stale':m['state_fingerprint']='f'*64
    else:pause.unlink()
    raw=p.read_bytes()
    with self.assertRaises(ValueError):r.release(q,p,m,'lyam',h,pause)
    self.assertEqual(raw,p.read_bytes());self.assertEqual(h.calls,[])
 def test_interruptions_keep_intent_block_all_generic_mutants_and_boot(self):
  for phase in ('prepared','closing','closed','env-installing','env-installed','normal-start-committed','normal-verified','opening'):
   with self.subTest(phase=phase),tempfile.TemporaryDirectory() as d:
    p,pause,m,h=self.setup_case(d)
    def hook(x):
     if x==phase:raise KeyboardInterrupt()
    with self.assertRaises(KeyboardInterrupt):r.release(q,p,m,'lyam',h,pause,hook)
    s=q.load(p,allow_release=True);self.assertIn('release_intent',s);self.assertTrue(pause.exists())
    self.assertEqual(len(s['history']),1)
    with self.assertRaises(ValueError):q.load(p)
    with self.assertRaises(ValueError):boot.check(p)
    for cmd in ['status','drain','resume-reviewed','record-reviewed-recovery','record-reviewed-in-place','open-reviewed-ui-held','held-update-reviewed','rearm-held-update','rearm-interrupted-opening']:
     lock=Path(d)/'update.lock';lock.touch()
     call=subprocess.run(['python3',str(HERE/'ordered-queue.py'),cmd,'--state',str(p),'--pause-file',str(pause),'--update-lock',str(lock)],input='{}',text=True,capture_output=True)
     self.assertNotEqual(call.returncode,0,cmd)
 def test_commit_before_pause_failure_is_not_rewritten(self):
  with tempfile.TemporaryDirectory() as d:
   p,pause,m,h=self.setup_case(d)
   def hook(x):
    if x=='journal-committed':raise KeyboardInterrupt()
   with self.assertRaises(KeyboardInterrupt):r.release(q,p,m,'lyam',h,pause,hook)
   s=q.load(p);self.assertNotIn('release_intent',s);self.assertTrue(pause.exists());self.assertEqual(s['delivery_mode'],'normal');self.assertEqual(len(s['releases']),1)
 def test_finalize_after_journal_commit_never_restarts(self):
  for already_removed in (False,True):
   with tempfile.TemporaryDirectory() as d:
    p,pause,m,h=self.setup_case(d)
    def hook(x):
     if x=='journal-committed':raise KeyboardInterrupt()
    with self.assertRaises(KeyboardInterrupt):r.release(q,p,m,'lyam',h,pause,hook)
    if already_removed:pause.unlink()
    calls=[]
    class Final:
     def __init__(self,m):pass
     def verify_finalization(self,a,p):calls.append('verify')
     def finish_finalization(self,a):
      calls.append('finish')
      if pause.exists():pause.unlink()
    with self.assertRaises(ValueError):boot.check(p)
    r.finalize(q,p,pause,Final);self.assertEqual(calls,['verify','finish']);self.assertFalse(pause.exists());self.assertFalse(q.load(p)['release_finalize_required']);boot.check(p)
    with self.assertRaises(ValueError):r.finalize(q,p,pause,Final)
 def test_boot_guard_format4_inconsistent_audit(self):
  for mutate in [lambda s:s.update(delivery_mode='held'),lambda s:s.update(resume_required=True),lambda s:s.update(releases=[]),lambda s:s['releases'][-1]['observed_running'].update(sha='c'*40),lambda s:s.update(release_finalize_required=True)]:
   with tempfile.TemporaryDirectory() as d:
    p,pause,m,h=self.setup_case(d);s=r.release(q,p,m,'lyam',h,pause);mutate(s);q.atomic(p,s)
    with self.assertRaises(ValueError):boot.check(p)
 def test_legacy_controller_refuses_format4(self):
  with tempfile.TemporaryDirectory() as d:
   p,pause,m,h=self.setup_case(d);r.release(q,p,m,'lyam',h,pause)
   legacy=subprocess.check_output(['git','show','2f8499cf6d9187c7835f4ad3bb7e84ec55bfc6bd:deploy/oci/ordered-queue.py'],cwd=HERE).decode()
   old=Path(d)/'old.py';old.write_text(legacy)
   c=subprocess.run(['python3',str(old),'status','--state',str(p),'--pause-file',str(pause)],capture_output=True)
   self.assertNotEqual(c.returncode,0)
 def test_env_byte_exact_preservation_and_refusals(self):
  original=b'# comment\r\nA=x\r\nIAM_AUTOMATION_HOLD=1\r\nSECRET=unchanged\n'
  self.assertEqual(r.release_env_bytes(original),b'# comment\r\nA=x\r\nSECRET=unchanged\n')
  for raw in [b'A=1\n',b'IAM_AUTOMATION_HOLD=0\n',b'IAM_AUTOMATION_HOLD=1\nIAM_AUTOMATION_HOLD=1\n',b'A=1\nA=2\nIAM_AUTOMATION_HOLD=1\n']:
   with self.assertRaises(ValueError):r.release_env_bytes(raw)
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'env';p.write_bytes(original);p.chmod(0o600)
   before=p.stat();r.install_env(p,hashlib.sha256(original).hexdigest(),os.getuid(),os.getgid(),check_ancestry=False);after=p.stat()
   self.assertEqual((before.st_uid,before.st_gid,before.st_mode),(after.st_uid,after.st_gid,after.st_mode));self.assertEqual(p.read_bytes(),r.release_env_bytes(original))
 def test_failed_from_and_commit_marker_survive_failure(self):
  for effect,phase,committed in [('install_normal_env','env-installing',False),('start_normal','normal-start-committed',True),('verify_normal','normal-start-committed',True),('open_access','opening',True)]:
   with tempfile.TemporaryDirectory() as d:
    p,pause,m,h=self.setup_case(d)
    def bad(*a):raise RuntimeError('injected')
    setattr(h,effect,bad)
    with self.assertRaises(RuntimeError):r.release(q,p,m,'lyam',h,pause)
    i=q.load(p,allow_release=True)['release_intent'];self.assertEqual(i['failed_from'],phase);self.assertEqual(i['normal_start_committed'],committed)
 def test_old_recovery_never_downgrades_completed_format4(self):
  with tempfile.TemporaryDirectory() as d:
   p,pause,m,h=self.setup_case(d);r.release(q,p,m,'lyam',h,pause);raw=p.read_bytes()
   for f in (q.record_reviewed_recovery,q.open_reviewed_ui_held):
    with self.assertRaises(ValueError):f(p,{},'repo','lyam')
    self.assertEqual(raw,p.read_bytes())
 def test_following_normal_deployment_preserves_release_fence_audit(self):
  from types import SimpleNamespace
  with tempfile.TemporaryDirectory() as d:
   p,pause,m,h=self.setup_case(d);r.release(q,p,m,'lyam',h,pause)
   plan={'format':1,'base':SHA,'entries':[{'sha':'c'*40,'parent':SHA,'digest':'sha256:'+'d'*64}]}
   q.deploy(p,plan,'unused',lambda *a,**kw:SimpleNamespace(returncode=0))
   s=q.load(p);self.assertEqual(len(s['history']),2);boot.check(p)
 def test_rearm_never_restarts_or_replays_and_refuses_alive_unknown_child(self):
  for identity in ('alive','unknown','absent'):
   with tempfile.TemporaryDirectory() as d:
    p,pause,m,h=self.setup_case(d)
    def hook(x):
     if x=='closed':raise KeyboardInterrupt()
    with self.assertRaises(KeyboardInterrupt):r.release(q,p,m,'lyam',h,pause,hook)
    calls=[]
    class ReArm:
     def close_access(self,*a):calls.append('access-only')
    if identity!='absent':
     with self.assertRaises(ValueError):q.rearm_release_held(p,lambda x:identity,lambda m:ReArm())
     self.assertEqual(calls,[])
    else:
     q.rearm_release_held(p,lambda x:'absent',lambda m:ReArm());self.assertEqual(calls,['access-only']);self.assertTrue(pause.exists());self.assertTrue(q.load(p,allow_release=True)['release_intent']['access_rearmed'])
 def test_corrupt_format4_blocks_boot(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'state.json'
   for s in [{'format':4},{'format':4,'delivery_mode':'normal','resume_required':False,'releases':[]},{'format':99}]:
    p.write_text(json.dumps(s))
    with self.assertRaises(ValueError):boot.check(p)

if __name__=='__main__':unittest.main()
