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

def cleanup(units,known,du,folder=None):
 errors=[];before={}
 for unit in units:
  try:
   p=du.unit_properties(unit)
   before[unit]={k:p[k] for k in ['ActiveState','MainPID','InvocationID','ControlGroup']}
   if not (known.get(unit) or {}).get('cgroup') and p['ControlGroup']:
    known[unit]={'identity':du.identity(int(p['MainPID'])) if int(p['MainPID'])>0 else None,'cgroup':p['ControlGroup']}
  except Exception:before[unit]={'properties':'unavailable'}
 # Preserve terminal contract state before stopping, including GC. No inference from GC to cleanup success.
 # Every unit gets an independent stop attempt, even if its peer is gone or stopping fails.
 for unit in units:
  try:
   if command(['systemctl','stop',unit],False).returncode:errors.append('stop-refused')
  except Exception:errors.append('stop-exception')
 for unit in units:
  old=known.get(unit) or {};ident=old.get('identity');cg=old.get('cgroup')
  if ident is None:errors.append('identity-not-captured')
  else:
   try:
    if du.state_of(ident)!='absent':errors.append('main-not-confirmed-absent')
   except Exception:errors.append('identity-unverifiable')
  if not cg or not cg.startswith('/') or '..' in cg.split('/') or not cg.endswith('/'+unit):errors.append('cgroup-not-captured');continue
  base=Path('/sys/fs/cgroup')/cg.lstrip('/')
  try:
   try:base.stat();present=True
   except FileNotFoundError:present=False
   if present:
    for procs in base.rglob('cgroup.procs'):
     if procs.read_text().strip():errors.append('cgroup-not-empty')
  except Exception:errors.append('cgroup-unverifiable')
 if folder is not None:(Path(folder)/'systemd-cleanup.json').write_text(json.dumps({'preCleanup':before,'errors':sorted(set(errors)),'passed':not errors}))
 if errors:raise RuntimeError('systemd-cleanup-incomplete:'+','.join(sorted(set(errors))))

def stop(handles):
 units=[h.unit for h in handles.values()]
 known={h.unit:{'identity':h.identity,'cgroup':h.cgroup} for h in handles.values()}
 cleanup(units,known,next(iter(handles.values())).du,Path(next(iter(handles.values())).folder))
