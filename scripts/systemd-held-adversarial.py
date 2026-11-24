#!/usr/bin/env python3
"""Disposable-runner injections against real, already-terminal worker records.
Not a natural crash, escaped updater, production control, or unwrapped-launch proof.
"""
import hashlib,json,os,re,signal,subprocess,sys,time,urllib.request,urllib.error
from pathlib import Path

def atomic_proof(path,data):
 path=Path(path);temp=path.with_suffix('.tmp');fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f:json.dump(data,f,sort_keys=True);f.flush();os.fsync(f.fileno())
 os.replace(temp,path)
 fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)

def origin_status(origin):
 try:return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(origin+'/healthz',timeout=3).status
 except urllib.error.HTTPError as e:return e.code

def load_record_loss():
 import importlib.util
 spec=importlib.util.spec_from_file_location('record_loss',Path(__file__).with_name('systemd-held-record-loss.py'));rl=importlib.util.module_from_spec(spec);spec.loader.exec_module(rl)
 return rl

def inject(folder,handles,du,mode,state_path,origin):
 folder=Path(folder);bindings=json.loads((folder/'unit-bindings.json').read_text());wd=handles['watchdog'];wk=handles['worker'];child=None;child_ident=None;created=[];changed=False;stopped=False;setterSucceeded=False
 if mode not in ('record-loss','orphan-cgroup'):raise RuntimeError('unknown-systemd-injection')
 if not re.fullmatch(r'[A-Za-z0-9._-]{8,64}',wk.engagement) or bindings.get('engagementID')!=wk.engagement or wk.unit!='lyam-durable-held-'+wk.engagement+'-worker.service' or wk.cgroup!='/system.slice/'+wk.unit:raise RuntimeError('injection-worker-bound-path-required')
 if wd.unit!='lyam-durable-held-'+wk.engagement+'-watchdog.service' or wd.cgroup!='/system.slice/'+wd.unit:raise RuntimeError('injection-watchdog-bound-path-required')
 def no_attempt():
  if (folder/'rearm-attempt.json').exists() or (folder/'watchdog-result.json').exists():raise RuntimeError('injection-window-missed')
 def exact_watchdog():
  if du.state_of(wd.identity)!='alive':raise RuntimeError('injection-watchdog-not-exact-alive')
  props=du.unit_properties(wd.unit);b=bindings['watchdog']
  if b['unit']!=wd.unit or props['InvocationID']!=b['invocationID'] or props['MainPID']!=str(wd.pid) or props['ControlGroup']!=wd.cgroup:raise RuntimeError('injection-watchdog-manager-drift')
 events=folder/'watchdog-events.jsonl'
 if not events.exists() or not any(json.loads(line).get('action')=='interrupted-rearm-permitted' for line in events.read_text().splitlines()):raise RuntimeError('injection-first-tick-not-persisted')
 no_attempt();exact_watchdog();os.kill(wd.pid,signal.SIGSTOP);stopped=True
 try:
  end=time.monotonic()+3
  while time.monotonic()<end:
   exact_watchdog()
   if Path('/proc/%d/stat'%wd.pid).read_text().split(') ',1)[1].split()[0] in ('T','t'):break
   time.sleep(.02)
  else:raise RuntimeError('injection-watchdog-not-stopped')
  no_attempt()
  p=du.unit_properties(wk.unit)
  b=bindings['worker']
  if b['unit']!=wk.unit or b['invocationID']!=p['InvocationID'] or p['MainPID']!='0' or (p['ActiveState'],p['SubState'])!=('failed','failed') or p['ControlGroup']!='' or p['ExecMainPID']!=str(wk.pid) or du.state_of(wk.identity)!='absent':raise RuntimeError('injection-worker-not-retained-failed')
  runtime=__import__('importlib.util',fromlist=['util']);spec=runtime.spec_from_file_location('independent_runtime',Path(__file__).with_name('systemd-held-runtime.py'));rt=runtime.module_from_spec(spec);spec.loader.exec_module(rt)
  if rt.independent_cgroup_state(wk.cgroup) not in ('empty','gone'):raise RuntimeError('injection-original-cgroup-not-empty')
  state=Path(state_path).read_bytes();evidence={'mode':mode,'watchdogStoppedExact':True,'workerAlreadyFailedExact':True,'firstTickBeforeInjection':True}
  if mode=='record-loss':
   proof=load_record_loss().reset_worker(folder,wk,wd,du,bindings,p,rt,atomic_proof,state)
   evidence.update({'resetCommandSucceeded':True,'managerRecordLostMeasured':True,'originalPIDAbsent':True,'originalCgroupGone':True,'injection':'reset-failed-exact-retained-worker'})
  else:
   cg=wk.cgroup
   if bindings['engagementID']!=wk.engagement or wk.unit!='lyam-durable-held-'+wk.engagement+'-worker.service' or cg!='/system.slice/'+wk.unit:raise RuntimeError('injection-cgroup-not-bound')
   base=Path('/sys/fs/cgroup')/cg.lstrip('/')
   if base.parent.is_symlink() or base.parent.resolve()!=base.parent:raise RuntimeError('injection-cgroup-parent-unsafe')
   if base.exists():raise RuntimeError('injection-original-cgroup-not-gone')
   base.mkdir();created.append(base);branch=base/'fixture-descendants';branch.mkdir();created.append(branch);leaf=branch/'fixture-orphan';leaf.mkdir();created.append(leaf)
   child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(90)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   child_ident=du.identity(child.pid)
   if not child_ident or du.state_of(child_ident)!='alive':raise RuntimeError('injection-child-not-alive')
   (leaf/'cgroup.procs').write_text(str(child.pid))
   if (base/'cgroup.procs').read_text().strip() or (branch/'cgroup.procs').read_text().strip():raise RuntimeError('injection-root-not-empty')
   if Path('/proc/%d/cgroup'%child.pid).read_text().strip()!='0::'+cg+'/fixture-descendants/fixture-orphan':raise RuntimeError('injection-child-proc-membership-differs')
   if du.state_of(child_ident)!='alive' or str(child.pid) not in (leaf/'cgroup.procs').read_text().split() or 'populated 1' not in (base/'cgroup.events').read_text().splitlines():raise RuntimeError('injection-descendant-not-measured')
   evidence.update({'injection':'recreated-original-bound-cgroup-with-live-synthetic-descendant','childIdentityCaptured':True,'childMembershipExact':True,'originalBoundCgroupPopulated':True,'rootAndIntermediateProcsEmpty':True,'childProcCgroupExact':True})
  no_attempt();exact_watchdog();os.kill(wd.pid,signal.SIGCONT);stopped=False
  end=time.monotonic()+15
  while not (folder/'watchdog-result.json').exists() and time.monotonic()<end:time.sleep(.05)
  if not (folder/'watchdog-result.json').exists():raise RuntimeError('injection-report-timeout')
  result=json.loads((folder/'watchdog-result.json').read_text())
  expected_action='identity-unknown-report-only'  # frozen after first persisted tick, next check is the pre-rearm check
  if result.get('action')!=expected_action or result.get('report_only') is not True or result.get('needs_operator') is not True:raise RuntimeError('injection-not-report-only')
  if (folder/'rearm-attempt.json').exists() or Path(state_path).read_bytes()!=state:raise RuntimeError('injection-rearm-or-state-mutation')
  if child_ident and du.state_of(child_ident)!='alive':raise RuntimeError('injection-child-not-live-through-refusal')
  if origin_status(origin)!=503:raise RuntimeError('injection-active-origin-not-503')
  if child_ident and du.state_of(child_ident)!='alive':raise RuntimeError('injection-child-ended-before-503-proof')
  evidence['originStatusDuringInjection']=503
  evidence.update({'watchdogReportOnly':True,'rearmAttemptAbsent':True,'stateUnchanged':True,'stateSHA256Before':hashlib.sha256(state).hexdigest(),'stateSHA256After':hashlib.sha256(Path(state_path).read_bytes()).hexdigest()})
  atomic_proof(folder/'adversarial-before-cleanup.json',evidence)
  return evidence
 finally:
  cleanup_injection(folder,wd,wk,du,exact_watchdog,stopped,child,child_ident,created,changed,setterSucceeded,locals().get('p'))

def cleanup_injection(folder,wd,wk,du,exact_watchdog,stopped,child,child_ident,created,changed,setterSucceeded,p):
 errors=[]
 if stopped:
  try:exact_watchdog();os.kill(wd.pid,signal.SIGCONT)
  except Exception:errors.append('watchdog-continue-unproved')
 if child:
  try:
   if child_ident is None:raise RuntimeError('child-identity-unavailable')
   if du.state_of(child_ident)=='alive':os.kill(child.pid,signal.SIGKILL)
   child.wait(timeout=10)
   if du.state_of(child_ident)!='absent':raise RuntimeError('child-end-unproved')
  except Exception:errors.append('child-cleanup-unproved')
 for path in reversed(created):
  try:
   if (path/'cgroup.procs').read_text().strip() or 'populated 1' in (path/'cgroup.events').read_text().splitlines():raise RuntimeError('cgroup-not-empty')
   path.rmdir()
  except Exception:errors.append('cgroup-cleanup-unproved')
 atomic_proof(folder/'adversarial-cleanup.json',{'passed':not errors,'errors':sorted(set(errors)),'childWasCreated':child is not None,'createdCgroupCount':len(created),'runtimeSetterAttempted':changed,'runtimeSetterSucceeded':setterSucceeded})
 if errors:raise RuntimeError('injection-cleanup-incomplete')
