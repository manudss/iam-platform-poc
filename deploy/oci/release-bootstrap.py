#!/usr/bin/env python3
"""Stage/bootstrap the reviewed release toolchain, while format3 + HOLD remain.
No application start, pause removal or journal migration. Operator-only install.
"""
import argparse, fcntl, hashlib, json, os, stat, subprocess
from pathlib import Path

NAMES={'ordered-queue.py','release-held.py','release-host.py','release-supervision.py','release-boot-guard.py','host-boot.sh','qualification.py','qualification-container.mjs','held-update-durable.py','reviewed-ui-held.py','release-paths.py','release-backlog.mjs'}

def protected(p):
 p=Path(p)
 if not p.is_absolute() or '..' in p.parts:raise ValueError('absolute protected path required')
 for a in [p,*p.parents]:
  s=a.lstat()
  if a.is_symlink() or s.st_uid or s.st_gid or s.st_mode&0o022:raise ValueError('protected root ownership required')
 return p

def install(spec,commit=False):
 root=protected(spec['install_dir']);state=protected(spec['state']);pause=protected(spec['pause']);env=protected(spec['env'])
 raw=state.read_bytes();s=json.loads(raw)
 if s.get('format')!=3 or s.get('resume_required') is not True or s.get('opening_intent') or s.get('pending') or s.get('failed') or s['history'][-1].get('mode')!='ui-open-automation-held':raise ValueError('resolved held format3 state required')
 if stat.S_IMODE(env.stat().st_mode)!=0o600:raise ValueError('environment must already be private')
 if sum(x==b'IAM_AUTOMATION_HOLD=1' for x in env.read_bytes().splitlines())!=1:raise ValueError('persistent HOLD1 required')
 c=json.loads(subprocess.check_output(['docker','inspect',spec['container']],text=True))[0]
 if c['HostConfig']['RestartPolicy']['Name']!='no' or not c['State']['Running'] or 'IAM_AUTOMATION_HOLD=1' not in c['Config']['Env']:raise ValueError('live held nonrestarting container required')
 files=spec['files']
 if {Path(x['source']).name for x in files}!=NAMES or len(files)!=len(NAMES):raise ValueError('complete unique toolchain required')
 values={}
 for x in files:
  p=protected(x['source']);v=p.read_bytes()
  if hashlib.sha256(v).hexdigest()!=x['sha256']:raise ValueError('staged source changed')
  dst=root/p.name
  if dst.exists():protected(dst)
  values[p.name]=v
 # A stopped/disabled boot unit cannot race a partly installed toolchain. The
 # operator restarts/enables boot supervision only after bootstrap verification.
 def idle():
  props=dict(line.split('=',1) for line in subprocess.check_output(['systemctl','show','lyam-boot.service','--property=LoadState,ActiveState,SubState,MainPID,ControlPID'],text=True).splitlines() if '=' in line)
  if props!={'LoadState':'masked','ActiveState':'inactive','SubState':'dead','MainPID':'0','ControlPID':'0'}:raise ValueError('boot service must be masked, inactive and process-free')
  forbidden={str(root/n) for n in ['host-boot.sh','ordered-queue.py','update.sh','held-update-durable.py','release-supervision.py']}
  for proc in Path('/proc').iterdir():
   if not proc.name.isdigit() or int(proc.name)==os.getpid():continue
   try:args=set(x.decode(errors='replace') for x in (proc/'cmdline').read_bytes().split(b'\0') if x)
   except FileNotFoundError:continue
   except PermissionError:raise ValueError('cannot exclude existing controller process')
   if args & forbidden:raise ValueError('old controller still alive')
 idle()
 # Both locks are held through every rename. No deployment can slip between old
 # and new binaries. State stays3, so partial bootstrap is safely rerunnable.
 protected(str(state)+'.lock')
 with open(str(state)+'.lock','a') as queue_lock,open(protected(spec['update_lock']),'a') as update_lock:
  fcntl.flock(queue_lock,fcntl.LOCK_EX|fcntl.LOCK_NB);fcntl.flock(update_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  if state.read_bytes()!=raw:raise ValueError('state changed before bootstrap lock')
  idle()
  if not commit:return {'verified':True,'installed':False,'files':sorted(values)}
  # Install guard first, queue last. No format4 writer can appear before guard.
  order=['release-boot-guard.py','host-boot.sh']+[n for n in sorted(values) if n not in ['release-boot-guard.py','host-boot.sh','ordered-queue.py']]+['ordered-queue.py']
  for name in order:
   dst=root/name;tmp=root/('.bootstrap-'+name+'-'+os.urandom(8).hex())
   fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o700)
   try:
    with os.fdopen(fd,'wb') as f:f.write(values[name]);f.flush();os.fsync(f.fileno());os.fchmod(f.fileno(),0o700)
    os.replace(tmp,dst);d=os.open(root,os.O_RDONLY)
    try:os.fsync(d)
    finally:os.close(d)
   finally:
    if tmp.exists():tmp.unlink()
  for name,v in values.items():
   if (root/name).read_bytes()!=v:raise ValueError('installed bytes differ')
  if state.read_bytes()!=raw:raise ValueError('bootstrap unexpectedly changed state')
  return {'verified':True,'installed':True,'files':sorted(values)}

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--spec',required=True);p.add_argument('--install',action='store_true');a=p.parse_args()
 spec=json.loads(protected(a.spec).read_text());print(json.dumps(install(spec,a.install)))
