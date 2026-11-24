#!/usr/bin/env python3
"""Disposable runner systemd adapter. Never changes production supervisors or their REQUIRE_UNITS default.
The real launcher argv is prefixed with nsenter only at ExecStart, to enter the fixture mount namespace.
This is a distinct invocation arrangement, not evidence for an unwrapped production launch.
"""
import json,os,subprocess,time
from pathlib import Path

def command(args,check=True):
 r=subprocess.run(args,text=True,capture_output=True,timeout=45)
 if check and r.returncode:raise RuntimeError('systemd-fixture-command-refused')
 return r

class Handle:
 def __init__(self,unit,identity,du,cgroup,folder):self.folder=folder;self.unit=unit;self.pid=identity['pid'];self.identity=identity;self.du=du;self.cgroup=cgroup
 def wait(self,timeout=120):
  end=time.monotonic()+timeout
  while self.du.state_of(self.identity)=='alive':
   if time.monotonic()>end:raise subprocess.TimeoutExpired(self.unit,timeout)
   time.sleep(.1)
  if self.du.state_of(self.identity)!='absent':raise RuntimeError('unit-main-identity-unknown')
  return None
 def kill(self):command(['systemctl','kill','--kill-whom=all','--signal=KILL',self.unit],False)

def start(folder,engagement,py,du_path,du,poll=2):
 if os.geteuid()!=0 or os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_ENVIRONMENT')!='github-hosted' or Path('/proc/1/comm').read_text().strip()!='systemd':raise RuntimeError('real-systemd-pid1-required')
 command(['systemctl','show','--property=Version'])
 if not Path('/sys/fs/cgroup/cgroup.controllers').is_file():raise RuntimeError('real-cgroup-v2-required')
 if Path('/proc/self/ns/mnt').readlink()==Path('/proc/1/ns/mnt').readlink():raise RuntimeError('fixture-private-mount-required')
 if du.REQUIRE_UNITS is not True:raise RuntimeError('real-unit-contract-required')
 owner=du.identity(os.getpid())
 commands=du.launcher_commands(folder,engagement,py,str(du_path),poll)
 units=[next(x.split('=',1)[1] for x in args if x.startswith('--unit=')) for args in commands];known={}
 try:
  for args in commands:
   unit=next(x.split('=',1)[1] for x in args if x.startswith('--unit='))
   if du.state_of(owner)!='alive':raise RuntimeError('mount-owner-not-live-exact')
   known[unit]={'identity':None,'cgroup':None}
   at=args.index('--')
   wrapped=args[:at+1]+['/usr/bin/nsenter','--mount=/proc/%d/ns/mnt'%os.getpid(),'--']+args[at+1:]
   command(wrapped)
   initial=du.unit_properties(unit);pid=int(initial['MainPID'])
   known[unit]={'identity':du.identity(pid),'cgroup':initial['ControlGroup']}
  bindings={'kind':'held-update','engagementID':engagement};evidence={}
  for role,unit in zip(['watchdog','worker'],units):
   props=du.unit_properties(unit);pid=int(props['MainPID']);ident=du.identity(pid)
   if not ident or du.state_of(ident)!='alive':raise RuntimeError('systemd-main-not-alive')
   env=Path('/proc/%d/environ'%pid).read_bytes().split(b'\0')
   if ('INVOCATION_ID='+props['InvocationID']).encode() not in env:raise RuntimeError('postexec-invocation-mismatch')
   cg=Path('/proc/%d/cgroup'%pid).read_text()
   if props['ControlGroup'] not in cg:raise RuntimeError('systemd-cgroup-mismatch')
   fds={}
   for n in [1,2]:
    target=Path('/proc/%d/fd/%d'%(pid,n)).readlink();expected=folder/(role+('.stdout' if n==1 else '.stderr'))
    if str(target)!=str(expected):raise RuntimeError('systemd-output-fd-mismatch')
    fds[str(n)]=True
   if props.get('RemainAfterExit')!=('yes' if role=='worker' else 'no'):raise RuntimeError('systemd-retention-contract-mismatch')
   bindings[role]={'unit':unit,'invocationID':props['InvocationID'],'pid':pid,'starttime':ident['starttime'],'boot_id':ident['boot_id'],'controlGroup':props['ControlGroup']}
   relations=command(['systemctl','show',unit,'-p','PartOf','-p','BindsTo']).stdout
   if any(line.split('=',1)[1] for line in relations.splitlines() if '=' in line):raise RuntimeError('unexpected-unit-coupling')
   merged=command(['systemctl','cat',unit]).stdout
   evidence[role]={'mergedUnitSHA256':__import__('hashlib').sha256(merged.encode()).hexdigest(),'uncoupled':True,'postExecInvocationMatches':True,'properties':props,'cgroupMatches':True,'outputFDsMatch':fds,'mountNamespaceMatches':Path('/proc/%d/ns/mnt'%pid).readlink()==Path('/proc/self/ns/mnt').readlink()}
   if not evidence[role]['mountNamespaceMatches']:raise RuntimeError('systemd-mount-namespace-mismatch')
  (folder/'unit-bindings.json').write_text(json.dumps(bindings));(folder/'unit-bindings.json').chmod(0o600)
  (folder/'UNIT_BINDINGS_READY').write_text('fixture binding ready\n')
  handles={r:Handle(bindings[r]['unit'],{k:bindings[r][k] for k in ['pid','starttime','boot_id']},du,bindings[r]['controlGroup'],folder) for r in ['worker','watchdog']}
  if du.state_of(owner)!='alive':raise RuntimeError('mount-owner-not-live-before-return')
  return handles,evidence
 except BaseException as original:
  try:cleanup(units,known,du,folder)
  except Exception as cleaning:
   (Path(folder)/'systemd-start-failure.json').write_text(json.dumps({'startException':type(original).__name__,'cleanupException':type(cleaning).__name__,'startFailed':True,'cleanupFailed':True}))
   raise cleaning from original
  raise

def independent_cgroup_state(cg):
 base=Path('/sys/fs/cgroup')/cg.lstrip('/')
 try:base.stat()
 except FileNotFoundError:return 'gone'
 def bad(error):raise error
 populated=False
 for folder,dirs,files in os.walk(base,onerror=bad,followlinks=False):
  here=Path(folder)
  if here.is_symlink() or any((here/d).is_symlink() for d in dirs):raise RuntimeError('cgroup-symlink-refused')
  if (here/'cgroup.procs').read_text().strip():populated=True
  events=dict(line.split() for line in (here/'cgroup.events').read_text().splitlines())
  if events.get('populated') not in ('0','1'):raise RuntimeError('cgroup-events-unknown')
  if events['populated']=='1':populated=True
 return 'populated' if populated else 'empty'

def cleanup(units,known,du,folder=None):
 errors=[];before={};stops={};proof={};preproof={}
 for unit in units:
  try:
   p=du.unit_properties(unit)
   before[unit]={k:p[k] for k in ['ActiveState','SubState','MainPID','InvocationID','ControlGroup','Result','ExecMainPID','ExecMainCode','ExecMainStatus','RemainAfterExit','ExecMainStartTimestampMonotonic','ExecMainExitTimestampMonotonic']}
   if not (known.get(unit) or {}).get('cgroup') and p['ControlGroup']:
    known[unit]={'identity':du.identity(int(p['MainPID'])) if int(p['MainPID'])>0 else None,'cgroup':p['ControlGroup']}
  except Exception:before[unit]={'properties':'unavailable'}
 for unit in units:
  old=known.get(unit) or {};preproof[unit]={}
  try:preproof[unit]['originalMainState']=du.state_of(old['identity'])
  except Exception:preproof[unit]['originalMainState']='unknown'
  try:
   cg=old['cgroup']
   if not cg or not cg.startswith('/') or '..' in cg.split('/') or not cg.endswith('/'+unit):raise RuntimeError('cgroup-not-bound')
   preproof[unit]['originalCgroupState']=independent_cgroup_state(cg)
  except Exception:preproof[unit]['originalCgroupState']='unknown'
 # Preserve terminal contract state before stopping, including GC. No inference from GC to cleanup success.
 # Every unit gets an independent stop attempt, even if its peer is gone or stopping fails.
 for unit in units:
  try:
   result=command(['systemctl','stop',unit],False)
   expected='Failed to stop '+unit+': Unit '+unit+' not loaded.'
   stops[unit]={'returnCode':result.returncode,'exactUnitNotLoaded':result.stderr.strip()==expected}
   if result.returncode:errors.append('stop-refused')
  except Exception:errors.append('stop-exception')
 for unit in units:
  old=known.get(unit) or {};ident=old.get('identity');cg=old.get('cgroup')
  if ident is None:errors.append('identity-not-captured')
  else:
   try:
    state=du.state_of(ident);proof.setdefault(unit,{})['originalMainState']=state
    if state!='absent':errors.append('main-not-confirmed-absent')
   except Exception:errors.append('identity-unverifiable')
  if not cg or not cg.startswith('/') or '..' in cg.split('/') or not cg.endswith('/'+unit):errors.append('cgroup-not-captured');continue
  try:
   cstate=independent_cgroup_state(cg)
   proof.setdefault(unit,{})['originalCgroupState']=cstate
   if cstate not in ('empty','gone'):errors.append('cgroup-not-empty')
  except Exception:errors.append('cgroup-unverifiable')
 if folder is not None:
  try:
   bindings=json.loads((Path(folder)/'unit-bindings.json').read_text());record=json.loads((Path(folder)/'worker-unit-start.json').read_text());e=bindings['worker']
   expected={k:e[k] for k in ['unit','invocationID','pid','starttime','boot_id','controlGroup']};expected['engagementID']=bindings['engagementID'];expected['start']=record['start']
   proof['workerStartRecordMatchesBinding']=record==expected and type(record['start']) is int and record['start']>0
   proof['workerStartMatchesPreCleanupManager']=str(record['start'])==before[e['unit']]['ExecMainStartTimestampMonotonic']
  except Exception:proof['workerStartRecordMatchesBinding']=False;proof['workerStartMatchesPreCleanupManager']=False
 if folder is not None:(Path(folder)/'systemd-cleanup.json').write_text(json.dumps({'preCleanup':before,'preCleanupBoundProcessAndCgroupProof':preproof,'cgroupProbe':'independent-harness-procs-and-events-recursive','stopResults':stops,'boundProcessAndCgroupProof':proof,'errors':sorted(set(errors)),'passed':not errors}))
 if errors:raise RuntimeError('systemd-cleanup-incomplete:'+','.join(sorted(set(errors))))

def stop(handles):
 units=[h.unit for h in handles.values()]
 known={h.unit:{'identity':h.identity,'cgroup':h.cgroup} for h in handles.values()}
 cleanup(units,known,next(iter(handles.values())).du,Path(next(iter(handles.values())).folder))
