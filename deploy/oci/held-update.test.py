import importlib.util, copy, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('queue',Path(__file__).with_name('ordered-queue.py'));q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
S=lambda n:format(n,'040x'); D=lambda n:'sha256:'+format(n,'064x')
def held_state():
 h=[{'sha':S(1),'digest':D(1)},{'sha':S(2),'digest':D(2),'mode':'ui-open-automation-held','automation_held':True}]
 return {'format':3,'history':h,'recovery_fence':S(2),'resume_required':True,'recoveries':[{'target':h[1]}],'opening_audits':[]}
def manifest(state,*nums):
 chain=[];p=S(2)
 for n in nums: chain.append({'sha':S(n),'parent':p,'digest':D(n)});p=S(n)
 return {'format':1,'kind':'reviewed-held-update','state_fingerprint':q.fingerprint(state),'expected_delivered':{'sha':S(2),'digest':D(2)},'authorization_ref':'operator claim','evidence_refs':['e'],'chain':chain,'target':chain[-1]}
class HeldUpdate(unittest.TestCase):
 def setUp(self):self.s=held_state()
 def ok(self,m,**kw):return q.check_held_update(self.s,m,pause_present=kw.get('pause',True))
 def bad(self,m,msg,**kw):
  with self.assertRaisesRegex(ValueError,msg):self.ok(m,**kw)
 def test_one_and_many_commits(self):
  self.assertEqual(len(self.ok(manifest(self.s,3))),1);self.assertEqual(len(self.ok(manifest(self.s,3,4,5))),3)
 def test_check_is_pure(self):
  before=copy.deepcopy(self.s);self.ok(manifest(self.s,3,4));self.assertEqual(before,self.s)
 def test_refusals(self):
  m=manifest(self.s,3,4)
  self.bad(m,'pause',pause=False)
  g=copy.deepcopy(m);g['chain'][1]['parent']=S(9);self.bad(g,'gap')
  g=copy.deepcopy(m);g['chain'][1]['digest']='x';self.bad(g,'gap')
  g=manifest(self.s,3,3);self.bad(g,'gap')
  g=manifest(self.s,1);self.bad(g,'gap')
  g=copy.deepcopy(m);g['target']=g['chain'][0];self.bad(g,'target')
  g=copy.deepcopy(m);g['chain']=[];self.bad(g,'bounded')
  g=copy.deepcopy(m);g['authorization_ref']='';self.bad(g,'approval')
  g=copy.deepcopy(m);g['state_fingerprint']='0'*64;self.bad(g,'stale')
  g=copy.deepcopy(m);g['chain'][0]['extra']=1;self.bad(g,'gap')
 def test_state_refusals(self):
  for key,val,msg in [('resume_required',False,'resume barrier'),('pending',{'sha':S(3)},'resume barrier'),('failed',{'x':1},'resume barrier'),('opening_intent',{'phase':'opening'},'resume barrier'),('recovery_fence',S(1),'fence')]:
   s=held_state();s[key]=val
   if key=='resume_required':s['resumptions']=[{'observed_running':{'sha':S(2)}}]
   with self.assertRaisesRegex(ValueError,msg):q.check_held_update(s,manifest(s,3),pause_present=True)
  s=held_state();s['history'][-1].pop('mode')
  with self.assertRaisesRegex(ValueError,'held UI'):q.check_held_update(s,manifest(s,3),pause_present=True)
 def test_generic_paths_still_refuse_held(self):
  import tempfile
  with tempfile.TemporaryDirectory() as t:
   p=Path(t)/'s.json';q.atomic(p,self.s)
   with self.assertRaisesRegex(ValueError,'unresolved'):q.deploy(p,{'format':1,'base':S(2),'entries':[]},'u')

import json,os,signal,subprocess,sys,tempfile

def fake_updater_text(d,lock,rc_expr):
 return """#!/bin/sh
echo "$@" >> %s/args
[ -e /proc/self/fd/8 ] || { echo no-fd8 >&2; exit 21; }
[ "$(stat -L -c %%d:%%i /proc/self/fd/8)" = "$(stat -c %%d:%%i %s)" ] || exit 22
( exec 7>%s; flock -E 75 -n 7 ); [ $? = 75 ] || exit 23
flock -n 8 || exit 24
while [ $# -gt 0 ]; do case "$1" in --closed-receipt) r="$2";; --image) img="$2";; esac; shift; done
ev=%s/ev-$$; mkdir -p $ev; for x in before after smoke; do echo "{\\"$x\\":1}" > $ev/$x.json; done
for x in before after smoke; do printf '%%s %%s %%s\\n' $x $(sha256sum $ev/$x.json | cut -d' ' -f1) $ev/$x.json; done > $r.evidence
echo '{}' > $r.launch
[ -e %s/gates/FRONT ] || echo front-token > %s/gates/FRONT
printf 'state=CLOSED_QUALIFIED\\nheld=true\\npublic_status=503\\nimage=%%s\\ngate_sha256=%%s\\nops_sha256=%%s\\nevidence_index=%%s\\nevidence_index_sha256=%%s\\nlaunch_proof=%%s\\nlaunch_proof_sha256=%%s\\n' "$img" $(sha256sum %s/gates/FRONT 2>/dev/null | cut -d' ' -f1) $(sha256sum %s/gates/OPS | cut -d' ' -f1) $r.evidence $(sha256sum $r.evidence | cut -d' ' -f1) $r.launch $(sha256sum $r.launch | cut -d' ' -f1) > $r
exit %s
"""%(d,lock,lock,d,d,d,d,d,rc_expr)

class Ctl:
 """DOUBLE of reviewed-ui-held.py controller."""
 def __init__(self,fail=None,kill=False):self.calls=[];self.fail=fail;self.kill=kill
 def open_gates(self,m,container,target):
  self.calls.append('open')
  if self.kill:os.kill(os.getpid(),signal.SIGKILL)
  if self.fail:raise RuntimeError(self.fail)
  return {'mode':'ui-open-automation-held','public_status':200,'automation_held':True,'pause_retained':True}
 def close_gates(self,intent):self.calls.append('close')
 def verify_closed_access(self,m):self.calls.append('verify-closed')
 def stop_candidate(self,c):self.calls.append('stop')
class Host:
 """DOUBLE of held-update-host.py Host: records order, no docker/gates."""
 def __init__(self,log,fail_step=None,kill_step=None):self.log=log;self.fail_step=fail_step;self.kill_step=kill_step
 def preflight(self,container=None,base=None):self.log.append('preflight')
 def plan_ops_gate(self,token):return {'path':'/g/OPS','bytes_hex':'00'}
 def create_ops_gate(self,token=None):self.log.append('ops')
 def snapshot_gates(self):return [{'path':'/g/OPS','bytes_hex':'00'}]
 def closed_step(self,entry,adopt,i,fd):
  self.log.append(('step',i,adopt))
  if i==self.kill_step:os.kill(os.getpid(),signal.SIGKILL)
  if i==self.fail_step:raise RuntimeError('closed step rc 4')
  return {'gate_sha256':'%064x'%(i+1)},'/r/%d'%i
 def opening_manifest(self,m,f,p,first=None):self.log.append('opening-manifest');return dict(m)
class Run(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'s.json';self.s=held_state();q.atomic(self.path,self.s)
 def tearDown(self):self.tmp.cleanup()
 def go(self,*nums,host=None,ctl=None,log=None):
  log=log if log is not None else [];m=manifest(self.s,*nums)
  return q.held_update(self.path,m,'repo','lyam',lambda m:host or Host(log),3,verify=lambda *a:None,observe=lambda c,t:{'sha':t['sha']},controller=ctl or Ctl(),qualify=lambda p,e:None),log
 def test_one_commit_success(self):
  st,log=self.go(3)
  self.assertEqual([h['sha'] for h in st['history']],[S(1),S(2),S(3)]);self.assertEqual(st['history'][-1]['mode'],'ui-open-automation-held')
  self.assertEqual(st['recovery_fence'],S(3));self.assertTrue(st['resume_required']);self.assertNotIn('opening_intent',st);self.assertEqual(log[:2],['preflight','ops'])
 def test_three_commits_sequential_closed_then_one_opening(self):
  ctl=Ctl();st,log=self.go(3,4,5,ctl=ctl)
  steps=[x for x in log if isinstance(x,tuple)];self.assertEqual([x[1] for x in steps],[0,1,2]);self.assertIsNone(steps[0][2]);self.assertEqual(steps[1][2][0]['gate_sha256'],'%064x'%1);self.assertEqual(steps[2][2][0]['gate_sha256'],'%064x'%2)
  self.assertEqual(ctl.calls,['open'],'exactly one opening for the whole chain')
  self.assertEqual([h['mode'] for h in st['history'][2:]],['closed-qualified-held','closed-qualified-held','ui-open-automation-held'])
  self.assertEqual(len(st['recoveries'][-1]['steps']),3);self.assertEqual(st['recovery_fence'],S(5))
 def test_generic_commands_still_refuse_after_success(self):
  self.go(3,4)
  with self.assertRaisesRegex(ValueError,'unresolved'):q.deploy(self.path,{'format':1,'base':S(4),'entries':[]},'u')
  with self.assertRaisesRegex(ValueError,'resume barrier|barrier'):q.check_held_update(q.load(self.path),manifest(q.load(self.path),9),pause_present=False)
 def test_each_commit_needs_its_prior_ci_qualification_before_any_effect(self):
  seen=[];log=[]
  def qualify(p,e):
   seen.append(e['sha'])
   if e['sha']==S(4):raise ValueError('qualification receipt required')
  m=manifest(self.s,3,4,5)
  with self.assertRaisesRegex(ValueError,'qualification receipt'):q.held_update(self.path,m,'r','lyam',lambda m:Host(log),3,verify=lambda *a:None,observe=lambda c,t:{},controller=Ctl(),qualify=qualify)
  self.assertEqual(seen,[S(3),S(4)]);self.assertEqual(log,[],'no host effect');self.assertEqual(q.load(self.path),self.s)
 def test_ops_gate_plan_is_durable_before_creation(self):
  snaps=[]
  class H(Host):
   def create_ops_gate(self,token=None):snaps.append(q.load(self_path)['opening_intent']['gates']);super().create_ops_gate(token)
  self_path=self.path
  self.go(3,host=H([]))
  self.assertEqual(snaps[0][0]['path'],'/g/OPS')
 def test_second_step_failure_retains_intent_and_original_cursor(self):
  ctl=Ctl()
  with self.assertRaisesRegex(RuntimeError,'closed step'):self.go(3,4,5,host=Host([],fail_step=1),ctl=ctl)
  st=q.load(self.path);self.assertEqual(st['history'],self.s['history']);self.assertEqual(st['recovery_fence'],S(2))
  i=st['opening_intent'];self.assertEqual(i['phase'],'failed-access-rearmed');self.assertEqual(len(i['steps']),1,'step 0 really ran and is recorded, not in history')
  self.assertEqual(ctl.calls,['close','verify-closed'])
  with self.assertRaisesRegex(ValueError,'resume barrier'):q.check_held_update(st,manifest(st,3),pause_present=True)
 def test_opening_failure_never_advances_fence_or_history(self):
  with self.assertRaises(RuntimeError):self.go(3,ctl=Ctl(fail='unlink failed'))
  st=q.load(self.path);self.assertEqual(st['history'],self.s['history']);self.assertIn('opening_intent',st)
 def test_incomplete_opening_proof_refused(self):
  class Bad(Ctl):
   def open_gates(self,*a):return {'mode':'ui-open-automation-held','public_status':200,'automation_held':True}
  with self.assertRaisesRegex(ValueError,'proof incomplete'):self.go(3,ctl=Bad())
  self.assertEqual(q.load(self.path)['history'],self.s['history'])
 def test_close_failure_marks_access_unknown_and_stops(self):
  class Bad(Ctl):
   def close_gates(self,i):raise RuntimeError('x')
  ctl=Bad()
  with self.assertRaises(RuntimeError):self.go(3,host=Host([],fail_step=0),ctl=ctl)
  self.assertEqual(q.load(self.path)['opening_intent']['phase'],'failed-access-unknown');self.assertIn('stop',ctl.calls)
 def test_real_sigkill_leaves_intent_no_history_change(self):
  # Real SIGKILL of a separate process at step 1 and at the opening. Disk state only: this does NOT prove gates stay closed.
  for kill_step,kill_open in [(1,False),(None,True)]:
   q.atomic(self.path,self.s)
   code=("import importlib.util,sys,os,signal\nfrom pathlib import Path\nsys.argv=['x']\nns={'__file__':%r,'__name__':'heldmod'}\nexec(open(%r).read(),ns)\n"%(__file__,__file__)+
    "t=ns['Run']('test_one_commit_success');t.setUp();t.path=Path(%r);t.s=ns['held_state']()\n"%str(self.path)+
    "ctl=ns['Ctl'](kill=%r)\nt.go(3,4,5,host=ns['Host']([],kill_step=%r),ctl=ctl)\n"%(kill_open,kill_step))
   r=subprocess.run([sys.executable,'-c',code],capture_output=True,text=True,env={**os.environ})
   self.assertEqual(r.returncode,-signal.SIGKILL,r.stderr[-300:])
   st=q.load(self.path);self.assertEqual(st['history'],self.s['history']);self.assertEqual(st['recovery_fence'],S(2))
   self.assertTrue(st['opening_intent']['phase'].startswith(('closed-step-','opening')),st['opening_intent']['phase'])
   with self.assertRaisesRegex(ValueError,'unresolved'):q.deploy(self.path,{'format':1,'base':S(2),'entries':[]},'u')
   with self.assertRaises(ValueError):q.check_held_update(st,manifest(st,3),pause_present=True)

hs=importlib.util.spec_from_file_location('hostmod',Path(__file__).with_name('held-update-host.py'));hm=importlib.util.module_from_spec(hs);hs.loader.exec_module(hm);hm.PROTECT=lambda p:Path(p)
import hashlib,stat
GOOD={'State':{'Running':True},'Config':{'Image':'ghcr.io/manudss/iam-platform-poc@'+D(2),'Env':['IAM_DEMO_SEED_MODE=never','IAM_AUTOMATION_HOLD=1']},'HostConfig':{'RestartPolicy':{'Name':'no'},'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges']}}
class RealHost(unittest.TestCase):
 """Real held-update-host.py code against a FAKE updater script and temp gate files (no docker)."""
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();d=Path(self.tmp.name);self.d=d
  (d/'gates').mkdir();self.env=d/'lyam.env'
  self.env.write_text('IAM_AUTOMATION_HOLD=1\nLYAM_FRONT_BARRIER_FILE=%s\nLYAM_OPS_BARRIER_FILE=%s\nLYAM_LOCK_FILE=%s\n'%(d/'gates'/'FRONT',d/'gates'/'OPS',d/'lock'))
  (d/'lock').write_text('');(d/'r').mkdir()
 def tearDown(self):self.tmp.cleanup()
 def updater(self,rc,receipt=True):
  u=self.d/'upd.sh';u.write_text(fake_updater_text(self.d,self.d/'lock',str(rc)));u.chmod(0o755);return u
 def host(self,rc=10,receipt=True,plan=False):
  u=self.updater(rc,receipt);h=hm.Host(str(self.env),str(u),str(self.d/'r'),updater_sha256=hashlib.sha256(u.read_bytes()).hexdigest(),inspect=lambda c:GOOD)
  if plan:h.plan_ops_gate('tok');h.create_ops_gate()
  return h
 def test_preflight_requires_absent_gates_and_hold(self):
  h=self.host();h.preflight();(self.d/'gates'/'FRONT').write_text('x')
  with self.assertRaisesRegex(ValueError,'both gates absent'):h.preflight()
  (self.d/'gates'/'FRONT').unlink();self.env.write_text(self.env.read_text().replace('IAM_AUTOMATION_HOLD=1','IAM_AUTOMATION_HOLD=0'))
  with self.assertRaisesRegex(ValueError,'hold'):self.host().preflight()
 def test_ops_gate_mode_is_umask_independent(self):
  old=os.umask(0o077)
  try:
   h=self.host();h.plan_ops_gate('tok');h.create_ops_gate()
  finally:os.umask(old)
  self.assertEqual(stat.S_IMODE((self.d/'gates'/'OPS').stat().st_mode),0o644);h.check_continuity()
 def test_ops_gate_exclusive_and_snapshot(self):
  h=self.host();h.plan_ops_gate('tok');h.create_ops_gate();self.assertEqual((self.d/'gates'/'OPS').read_text(),'tok')
  with self.assertRaises(FileExistsError):h.create_ops_gate()
  self.assertEqual((self.d/'gates'/'OPS').read_text(),'tok');self.assertEqual(len(h.snapshot_gates()),1)
 def test_closed_step_only_rc10_inherits_fd_8_for_source_fd_equal_and_different_and_adopts(self):
  for fixed8 in [False,True]:
   h=self.host(plan=True)
   fd=orig=os.open(self.d/'lock',os.O_RDWR)
   if fixed8:fd=os.dup2(fd,8) if fd!=8 else fd
   self.assertNotEqual(fd,8) if not fixed8 else self.assertEqual(fd,8)
   import fcntl;fcntl.flock(fd,fcntl.LOCK_EX)  # the CALLER holds the lock; the fake updater proves it on fd 8
   f0,p0=h.closed_step({'sha':S(3),'digest':D(3)},None,0,fd)
   f1,p1=h.closed_step({'sha':S(4),'digest':D(4)},(f0,p0),1,fd)
   args=(self.d/'args').read_text().splitlines()[-1];self.assertIn('--closed-recovery',args);self.assertIn('--inherit-lock-fd 8',args);self.assertIn('--adopt-front-gate-receipt '+p0,args);self.assertEqual(f1['state'],'CLOSED_QUALIFIED')
   os.close(fd)
   if orig!=fd:os.close(orig)
   for n in ['OPS','FRONT']:(self.d/'gates'/n).unlink()
   for p in (self.d/'r').iterdir():p.unlink()
  for rc in [0,4,1]:
   fd=os.open(self.d/'lock',os.O_RDWR);import fcntl;fcntl.flock(fd,fcntl.LOCK_EX)
   with self.assertRaisesRegex(RuntimeError,'did not return CLOSED_QUALIFIED'):self.host(rc=rc,plan=True).closed_step({'sha':S(40+rc),'digest':D(40+rc)},None,10+rc,fd)
   os.close(fd)
   for n in ['OPS','FRONT']:
    if (self.d/'gates'/n).exists():(self.d/'gates'/n).unlink()
 def test_ops_replaced_or_front_changed_between_steps_refused_before_updater(self):
  h=self.host(plan=True);fd=os.open(self.d/'lock',os.O_RDWR);import fcntl;fcntl.flock(fd,fcntl.LOCK_EX)
  f0,p0=h.closed_step({'sha':S(3),'digest':D(3)},None,0,fd)
  n=len((self.d/'args').read_text().splitlines())
  (self.d/'gates'/'FRONT').write_text('foreign')
  with self.assertRaisesRegex(ValueError,'front gate changed'):h.closed_step({'sha':S(4),'digest':D(4)},(f0,p0),1,fd)
  (self.d/'gates'/'FRONT').write_text('front-token\n')
  (self.d/'gates'/'OPS').write_text('replaced')
  with self.assertRaisesRegex(ValueError,'OPS barrier changed'):h.closed_step({'sha':S(4),'digest':D(4)},(f0,p0),1,fd)
  self.assertEqual(len((self.d/'args').read_text().splitlines()),n,'updater never launched');os.close(fd)
 def test_updater_hash_binding_and_start_container_checks(self):
  h=self.host();h.updater_sha256='0'*64
  with self.assertRaisesRegex(ValueError,'updater hash'):h.preflight()
  for n in ['OPS','FRONT']:
   if (self.d/'gates'/n).exists():(self.d/'gates'/n).unlink()
  h=self.host();h.preflight('lyam',{'digest':D(2)})
  for mut,msg in [(lambda c:c['Config'].update(Image='ghcr.io/manudss/iam-platform-poc@'+D(9)),'base digest'),(lambda c:c['Config'].update(Env=['IAM_AUTOMATION_HOLD=1']),'seed never'),(lambda c:c['HostConfig'].update(CapDrop=[]),'confinement'),(lambda c:c['HostConfig'].update(RestartPolicy={'Name':'always'}),'restart'),(lambda c:c['State'].update(Running=False),'running')]:
   import copy as _c;g=_c.deepcopy(GOOD);mut(g);hh=self.host();hh.inspect=lambda c,g=g:g
   with self.assertRaisesRegex(ValueError,msg):hh.preflight('lyam',{'digest':D(2)})
  with self.assertRaisesRegex(ValueError,'container/config'):self.host().preflight('other',{'digest':D(2)})
 def test_receipt_parser_is_strict_about_duplicates(self):
  img='ghcr.io/manudss/iam-platform-poc@'+D(3);base='state=CLOSED_QUALIFIED\nheld=true\npublic_status=503\nimage=%s\n'%img
  p=self.d/'rc';p.write_text(base+'gate_sha256=a\ngate_sha256=a\n')
  with self.assertRaisesRegex(ValueError,'duplicate'):hm.parse_receipt(p,img)
  h='b'*64;p.write_text(base+'launcher_sha256=%s\nlauncher_sha256=%s\n'%(h,h))
  with self.assertRaisesRegex(ValueError,'helper set incomplete'):hm.parse_receipt(p,img)
 def test_receipt_must_match_exact_image_and_fields(self):
  p=self.d/'rc';p.write_text('state=CLOSED_QUALIFIED\nheld=true\npublic_status=503\nimage=ghcr.io/manudss/iam-platform-poc@'+D(9)+'\n')
  with self.assertRaisesRegex(ValueError,'exact image'):hm.parse_receipt(p,'ghcr.io/manudss/iam-platform-poc@'+D(3))
  p.write_text('state=CLOSED_QUALIFIED\nheld=true\npublic_status=503\nimage=ghcr.io/manudss/iam-platform-poc@'+D(3)+'\n')
  with self.assertRaisesRegex(ValueError,'lacks'):hm.parse_receipt(p,'ghcr.io/manudss/iam-platform-poc@'+D(3))
 def test_opening_manifest_uses_exact_index_and_detects_tampering(self):
  files={}
  for r in ['before','after','smoke']:
   p=self.d/(r+'.json');p.write_text('{"%s":1}'%r);files[r]=p
  idx=self.d/'idx';idx.write_text(''.join('%s %s %s\n'%(r,hashlib.sha256(p.read_bytes()).hexdigest(),p) for r,p in files.items()))
  lp=self.d/'launch';lp.write_text('{}');rc=self.d/'rcpt';rc.write_text('x')
  fields={'evidence_index':str(idx),'evidence_index_sha256':hashlib.sha256(idx.read_bytes()).hexdigest(),'launch_proof':str(lp),'launch_proof_sha256':hashlib.sha256(lp.read_bytes()).hexdigest()}
  m={'opening_static':{'env':1,'integrity':2,'policy':3,'qualifier':4}}
  o=self.host().opening_manifest(m,fields,str(rc))['opening'];self.assertEqual(o['before']['path'],str(files['before']));self.assertEqual(set(o),{'env','integrity','policy','qualifier','closed_receipt','launch_proof','before','after','smoke'})
  files['after'].write_text('tampered')
  with self.assertRaisesRegex(ValueError,'changed since index'):self.host().opening_manifest(m,fields,str(rc))
  files['after'].write_text('{"after":1}');idx.write_text(idx.read_text()+'before aa bb\n')
  with self.assertRaisesRegex(ValueError,'index changed'):self.host().opening_manifest(m,fields,str(rc))
  with self.assertRaisesRegex(ValueError,'static opening'):self.host().opening_manifest({},fields,str(rc))

RUNNER=r"""
import importlib.util,sys,functools,os
from pathlib import Path
spec=importlib.util.spec_from_file_location('qq',sys.argv[1]);q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
q.PROTECTED=lambda st:True
orig=q.bound_module
def bm(*a):
 m=orig(*a);m.PROTECT=lambda p:Path(p)
 m.Host._docker_inspect=staticmethod(lambda c:{'State':{'Running':True},'Config':{'Image':'ghcr.io/manudss/iam-platform-poc@sha256:'+'0'*63+'2','Env':['IAM_DEMO_SEED_MODE=never','IAM_AUTOMATION_HOLD=1']},'HostConfig':{'RestartPolicy':{'Name':'no'},'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges']}})
 return m
q.bound_module=bm
class C:
 def settings(self,m):return {'LYAM_LOCK_FILE':os.environ['FAKE_LOCK'],'LYAM_PAUSE_FILE':os.environ['FAKE_PAUSE']}
 def open_gates(self,m,c,t):return {'mode':'ui-open-automation-held','public_status':200,'automation_held':True,'pause_retained':True}
 def close_gates(self,i):pass
 def verify_closed_access(self,m):pass
q.opening_controller=lambda m:C()
q.held_update=functools.partial(q.held_update,qualify=lambda p,e:None,verify=lambda *a:None,observe=lambda c,t:{'sha':t['sha']})
sys.argv=['ordered-queue.py']+sys.argv[2:]
q.main()
"""
class RealController(unittest.TestCase):
 """REAL reviewed-ui-held.py settings/verify_closed_access on the STATIC view used by the held-update CLI
 (no manifest.opening exists before the steps). Only the root-ownership check is replaced."""
 def test_static_view_is_accepted_and_dynamic_view_is_not_needed(self):
  spec=importlib.util.spec_from_file_location('rc',Path(__file__).parent/'reviewed-ui-held.py');rc=importlib.util.module_from_spec(spec);spec.loader.exec_module(rc)
  rc.protected=lambda p:Path(p)
  with tempfile.TemporaryDirectory() as d:
   env=Path(d)/'e';env.write_text('IAM_AUTOMATION_HOLD=1\nLYAM_LOCK_FILE=/x\n');pol=Path(d)/'p';pol.write_text(json.dumps({'origins':[]}))
   sp=lambda p:{'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
   view={'opening':{'env':sp(env),'policy':sp(pol),'integrity':{},'qualifier':{}}}
   self.assertEqual(rc.settings(view)['LYAM_LOCK_FILE'],'/x');rc.verify_closed_access(view)
   with self.assertRaises(KeyError):rc.settings({'opening_static':view['opening']})
class RealCli(unittest.TestCase):
 """Real ordered-queue CLI process -> real Host class -> real child process inheriting the caller lock onto fd 8.
 Updater and controller are FAKES (no docker, no gates, no root)."""
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();d=Path(self.tmp.name);self.d=d
  (d/'q').mkdir();(d/'r').mkdir();(d/'gates').mkdir(exist_ok=True);self.pause=d/'PAUSE';self.pause.write_text('p');self.lock=d/'lock';self.lock.write_text('')
  self.env=d/'lyam.env';self.env.write_text('IAM_AUTOMATION_HOLD=1\nLYAM_FRONT_BARRIER_FILE=%s\nLYAM_OPS_BARRIER_FILE=%s\nLYAM_LOCK_FILE=%s\n'%(d/'gates'/'FRONT',d/'gates'/'OPS',self.lock));(d/'g').mkdir()
  self.s=held_state();self.state=d/'q'/'state.json';q.atomic(self.state,self.s)
  # copy the real modules next to each other so bound_module resolves held-update-host.py by its fixed sibling path
  self.inst=d/'inst';self.inst.mkdir()
  for n in ['ordered-queue.py','held-update-host.py']:(self.inst/n).write_bytes((Path(__file__).parent/n).read_bytes())
  (self.d/'upd.sh').write_text(fake_updater_text(d,self.lock,'${FAKE_RC:-10}'))
  (self.d/'upd.sh').chmod(0o755)
 def tearDown(self):self.tmp.cleanup()
 def cli(self,*nums,rc=10):
  m=manifest(self.s,*nums);m.update({'_lock':str(self.lock),'_pause':str(self.pause),'receipt_dir':str(self.d/'r'),'opening_controller':{'path':'x','sha256':'0'},
   'opening_static':{'env':{'path':str(self.env),'sha256':'0'},'integrity':{},'policy':{},'qualifier':{}},
   'updater':{'path':str(self.d/'upd.sh'),'sha256':hashlib.sha256((self.d/'upd.sh').read_bytes()).hexdigest()},
   'held_host':{'path':str(self.inst/'held-update-host.py'),'sha256':hashlib.sha256((self.inst/'held-update-host.py').read_bytes()).hexdigest()}})
  return subprocess.run([sys.executable,'-c',RUNNER,str(self.inst/'ordered-queue.py'),'held-update-reviewed','--state',str(self.state),'--pause-file',str(self.pause),'--update-lock',str(self.lock),'--repository','repo','--container','lyam','--updater',str(self.d/'upd.sh')],input=json.dumps(m),capture_output=True,text=True,env={**os.environ,'FAKE_RC':str(rc),'FAKE_LOCK':str(self.lock),'FAKE_PAUSE':str(self.pause)})
 def test_cli_one_and_three_commits_with_real_inherited_lock(self):
  r=self.cli(3);self.assertEqual(r.returncode,0,r.stderr);self.assertEqual(q.load(self.state)['recovery_fence'],S(3))
  self.assertEqual((self.d/'args').read_text().count('--inherit-lock-fd 8'),1)
  [p.unlink() for p in (self.d/'r').iterdir()];(self.d/'args').unlink();(self.d/'gates'/'OPS').unlink();(self.d/'gates'/'FRONT').unlink();q.atomic(self.state,self.s);r=self.cli(3,4,5);self.assertEqual(r.returncode,0,r.stderr)
  st=q.load(self.state);self.assertEqual(st['recovery_fence'],S(5));self.assertEqual([h['mode'] for h in st['history'][-3:]][-1],'ui-open-automation-held')
  args=(self.d/'args').read_text().splitlines();self.assertEqual(len(args),3);self.assertNotIn('--adopt-front-gate-receipt',args[0]);self.assertIn('held-step-0-',args[1]);self.assertIn('--adopt-front-gate-receipt',args[1]);self.assertIn('--adopt-front-gate-receipt',args[2])
 def test_cli_updater_failure_retains_intent_and_original_cursor(self):
  r=self.cli(3,rc=4);self.assertNotEqual(r.returncode,0);st=q.load(self.state);self.assertEqual(st['history'],self.s['history']);self.assertIn('opening_intent',st);self.assertIn('queue',st['opening_intent'])
 def test_cli_refuses_when_updater_lock_already_held_by_third_party(self):
  fd=os.open(self.lock,os.O_RDWR);fcntl_flock=__import__('fcntl').flock;fcntl_flock(fd,__import__('fcntl').LOCK_EX)
  try:
   r=self.cli(3);self.assertNotEqual(r.returncode,0);self.assertEqual(q.load(self.state)['history'],self.s['history']);self.assertFalse((self.d/'args').exists())
  finally:os.close(fd)
 def test_rearm_refuses_live_or_unknown_queue_identity_and_accepts_dead_one(self):
  st=q.load(self.state);me=q.queue_identity()
  st['opening_intent']={'phase':'closed-step-0-running','queue':me,'gates':[],'container':'lyam','manifest':{'opening_static':{}}};q.atomic(self.state,st)
  class C:
   calls=[]
   def close_gates(self,i):self.calls.append('close')
   def verify_closed_access(self,m):self.calls.append('verify')
  c=C()
  with self.assertRaisesRegex(ValueError,'alive or not certainly absent'):q.rearm_held_update(self.state,controller=c)
  st['opening_intent'].pop('queue');q.atomic(self.state,st)
  with self.assertRaisesRegex(ValueError,'not certainly absent'):q.rearm_held_update(self.state,controller=c)
  self.assertEqual(c.calls,[])
  p=subprocess.Popen(['sleep','0.1']);dead=q.queue_identity(p.pid);p.wait()
  self.assertFalse(q.queue_alive(dead));self.assertTrue(q.queue_alive(me))
  st['opening_intent']['queue']=dead;q.atomic(self.state,st);q.rearm_held_update(self.state,controller=c)
  self.assertEqual(c.calls,['close','verify']);self.assertEqual(q.load(self.state)['opening_intent']['phase'],'interrupted-access-rearmed')
 def test_queue_state_tristate(self):
  me=q.queue_identity()
  self.assertEqual(q.queue_state(me),'alive')
  self.assertEqual(q.queue_state({**me,'boot_id':'other-boot'}),'absent')
  self.assertEqual(q.queue_state({**me,'starttime':str(int(me['starttime'])+1)}),'unknown','reused pid / other process is NOT dead')
  for bad in [None,{},{'pid':1},{**me,'extra':1},{**me,'pid':'x'},{**me,'starttime':'abc'},{**me,'boot_id':''}]:self.assertEqual(q.queue_state(bad),'unknown')
  p=subprocess.Popen(['sleep','0.1']);dead=q.queue_identity(p.pid);p.wait();self.assertEqual(q.queue_state(dead),'absent')
 def test_rearm_reused_pid_is_unknown_and_refused(self):
  st=q.load(self.state);me=q.queue_identity();st['opening_intent']={'phase':'opening','queue':{**me,'starttime':str(int(me['starttime'])+1)},'gates':[],'container':'lyam','manifest':{'opening_static':{}}};q.atomic(self.state,st)
  class C:
   calls=[]
   def close_gates(self,i):self.calls.append('close')
  with self.assertRaisesRegex(ValueError,'not certainly absent'):q.rearm_held_update(self.state,controller=C())
  self.assertEqual(C.calls,[])
 def test_rearm_close_error_is_durable_unknown(self):
  st=q.load(self.state);st['opening_intent']={'phase':'opening','queue':{'pid':999999,'starttime':'1','boot_id':'other'},'gates':[],'container':'lyam','manifest':{'opening_static':{}}};q.atomic(self.state,st)
  class C:
   def close_gates(self,i):raise OSError('boom')
   def stop_candidate(self,c):raise RuntimeError('stop failed')
  with self.assertRaises(OSError):q.rearm_held_update(self.state,controller=C())
  i=q.load(self.state)['opening_intent'];self.assertEqual(i['phase'],'failed-access-unknown');self.assertTrue(i['rearm_stop_failed'])
 def test_rearm_unmeasured_closure_marks_unknown_and_stops(self):
  st=q.load(self.state);p=subprocess.Popen(['true']);dead=q.queue_identity(p.pid) if False else {'pid':999999,'starttime':'1','boot_id':'x'};p.wait()
  st['opening_intent']={'phase':'opening','queue':dead,'gates':[],'container':'lyam','manifest':{'opening_static':{}}};q.atomic(self.state,st)
  class C:
   calls=[]
   def close_gates(self,i):pass
   def verify_closed_access(self,m):raise ValueError('200 observed')
   def stop_candidate(self,c):self.calls.append('stop')
  c=C()
  with self.assertRaisesRegex(ValueError,'200 observed'):q.rearm_held_update(self.state,controller=c)
  self.assertEqual(c.calls,['stop']);self.assertEqual(q.load(self.state)['opening_intent']['phase'],'failed-access-unknown')
if __name__=='__main__':unittest.main()
