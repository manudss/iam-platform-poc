#!/usr/bin/env python3
"""Durable supervision of ONE held-update run: a worker (runs the queue CLI as a child) and a separate
read-only watchdog. Adapted from the reviewed one-shot UI-held worker/watchdog: same GO / WATCH_READY /
exclusive-result protocol, but for kind held-update (phases, tri-state identities, 2-tick absence,
one rearm-held-update call, no open/retry/restart/kill). The spec carries hashes only. It grants NO
authority: the operator's GO file is the only start signal, and nothing here opens or lifts anything."""
import argparse,fcntl,hashlib,json,os,subprocess,sys,time
from pathlib import Path
HELD=('held-update-prepared','ops-gate-planned','ops-gate-created','closed-step-','opening')
PROTECT=None  # tests replace; production requires root-owned, non-writable ancestry

def atomic(path,value):
 path=Path(path)
 if path.exists():raise ValueError('exclusive output already exists')
 tmp=path.with_name(path.name+'.tmp-'+str(os.getpid()))
 fd=os.open(tmp,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
 with os.fdopen(fd,'w') as f:json.dump(value,f,sort_keys=True);f.write('\n');f.flush();os.fsync(f.fileno())
 os.link(tmp,path);tmp.unlink()
 fd=os.open(path.parent,os.O_RDONLY)
 try:os.fsync(fd)
 finally:os.close(fd)

def identity(pid):
 """Same schema as ordered-queue.queue_identity (pid/starttime/boot_id) plus systemd invocation when present."""
 try:
  raw=Path('/proc/%d/stat'%pid).read_text();fields=raw[raw.rfind(')')+2:].split()
  return {'pid':pid,'starttime':fields[19],'boot_id':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'state':fields[0],'invocation':os.environ.get('INVOCATION_ID','') if pid==os.getpid() else ''}
 except FileNotFoundError:return None
def state_of(expected):
 """alive | absent | unknown. Reused pid, other boot with same pid is judged by boot id first."""
 try:
  if not isinstance(expected,dict) or type(expected.get('pid')) is not int or not str(expected.get('starttime','')).isdigit() or not expected.get('boot_id'):return 'unknown'
  if Path('/proc/sys/kernel/random/boot_id').read_text().strip()!=expected['boot_id']:return 'unknown'   # different boot = different identity, never inferred dead
  o=identity(expected['pid'])
 except OSError:return 'unknown'
 if o is None:return 'absent'
 if o['starttime']!=expected['starttime']:return 'unknown'
 return 'absent' if o['state'] in ('Z','X') else 'alive'
def read(p):return json.loads(Path(p).read_text())
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()

def protected(p):
 p=Path(p)
 for q in [p]+list(p.parents):
  st=q.lstat()
  if q.is_symlink() or st.st_uid or st.st_gid or st.st_mode&0o022:raise ValueError('protected ancestry required')
def check_spec(folder):
 folder=Path(folder);(PROTECT or protected)(folder)
 spec=read(folder/'supervision-spec.json')
 need={'kind','queue','state','pause','lock','repository','container','updater','manifest','python','target_sha','fileSHA256','self'}
 if spec.get('kind')!='reviewed-held-update-supervision' or set(spec)!=need:raise ValueError('exact supervision spec required')
 for p,want in spec['fileSHA256'].items():
  (PROTECT or protected)(p)
  if Path(p).is_symlink() or sha(p)!=want:raise ValueError('source binding refused')
 for p in [spec['queue'],spec['manifest'],spec['updater'],spec['python'],spec['self']]:
  if p not in spec['fileSHA256']:raise ValueError('missing executable/manifest binding')
 if sha(__file__)!=spec['fileSHA256'][spec['self']]:raise ValueError('supervisor bytes differ from binding')
 return spec
def queue_cmd(spec,sub):
 base=[spec['python'],spec['queue'],sub,'--state',spec['state'],'--pause-file',spec['pause'],'--update-lock',spec['lock']]
 return base+(['--repository',spec['repository'],'--container',spec['container'],'--updater',spec['updater']] if sub=='held-update-reviewed' else [])

def heartbeat_fresh(folder,poll):
 """Advancing watchdog heartbeat (two distinct values, recent) is required before the single GO."""
 hb=lambda:read(folder/'heartbeat.json')
 a=hb();time.sleep(poll*1.2+.2);b=hb()
 return b['monotone']>a['monotone'] and time.monotonic()-b['monotone']<poll*3 and b.get('alive') is True

def worker(folder,spec,poll=5):
 folder=Path(folder);atomic(folder/'worker-identity.json',identity(os.getpid()))
 while not (folder/'GO').exists():time.sleep(.1)
 if not (folder/'WATCH_READY').exists() or not heartbeat_fresh(folder,poll):raise ValueError('watchdog not ready')
 atomic(folder/'STARTED',{'at':time.time()})
 with open(folder/'worker.log','xb') as log:
  os.chmod(log.name,0o600)
  child=subprocess.Popen([spec['python'],spec['self'],'child','--folder',str(folder),'--manifest',spec['manifest'],'--']+queue_cmd(spec,'held-update-reviewed'),stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  ident=identity(child.pid)
  if ident is None:raise ValueError('child exited before identity')
  atomic(folder/'queue-identity.json',ident);atomic(folder/'CHILD_GO',{'at':time.time()})
  rc=child.wait()
 atomic(folder/'worker-result.json',{'exit':rc,'at':time.time()});return rc
def child(folder,manifest,argv):
 folder=Path(folder)
 while not (folder/'CHILD_GO').exists():time.sleep(.05)
 fd=os.open(manifest,os.O_RDONLY);os.dup2(fd,0);os.close(fd);os.execvp(argv[0],argv)

def decision(folder,spec,state):
 """Distinct categories; first match wins. Only interrupted-rearm-permitted can lead to the single rearm call."""
 folder=Path(folder)
 if not (folder/'STARTED').exists():return 'pre-go-await'          # no completed/exit before this engagement started
 i=state.get('opening_intent');phase=str((i or {}).get('phase',''))
 if (folder/'worker-result.json').exists():
  rc=read(folder/'worker-result.json')['exit']
  if rc==0:
   ok=i is None and state.get('recovery_fence')==spec['target_sha'] and state.get('resume_required') is True and Path(spec['pause']).is_file()
   return 'completed' if ok else 'completed-audit-mismatch-report-only'
  if i is None:return 'failed-before-intent-report-only'
 if not i:return 'await-intent'
 if phase.startswith('failed-access-'):return 'caught-failure-report-only'
 if phase.startswith('interrupted-access-rearmed'):return 'recovery-done'
 if not phase.startswith(HELD):return 'identity-unknown-report-only'
 if not (folder/'queue-identity.json').exists():return 'child-unknown-report-only'
 w=state_of(read(folder/'worker-identity.json'));q=state_of(read(folder/'queue-identity.json'));qs=state_of(i.get('queue'))
 if 'unknown' in (w,q,qs):return 'identity-unknown-report-only'
 if q=='alive' or qs=='alive':return 'observe-live-queue' if w=='alive' else 'orphan-queue-alive-observe'
 if w=='alive' and not (folder/'worker-result.json').exists():return 'observe-live-queue'
 return 'interrupted-rearm-permitted'

def recovery(folder,spec):
 """No lock is held here: the queue CLI takes the updater lock and the state lock itself and re-checks identity and phase
 (a precheck here would only be an illusion of authorization). One durable attempt, exclusive, even across watchdog relaunch."""
 atomic(Path(folder)/'rearm-attempt.json',{'at':time.time(),'monotonic':time.monotonic()})
 with open(Path(folder)/'recovery.log','xb') as log:
  os.chmod(log.name,0o600);rc=subprocess.run(queue_cmd(spec,'rearm-held-update'),stdout=log,stderr=subprocess.STDOUT,stdin=subprocess.DEVNULL).returncode
 return {'kind':'rearm-held-update-attempted','exit':rc,'outcome':'measured-closed' if rc==0 else 'refused-collision-or-unknown-report-only'}

def watchdog(folder,spec,recover=recovery,poll=5):
 folder=Path(folder);atomic(folder/'watchdog-identity.json',identity(os.getpid()));ready=False
 while True:
  if (folder/'STOP_WATCHDOG').exists():return
  try:action=decision(folder,spec,read(spec['state']))
  except Exception:action='state-unreadable'
  with open(folder/'heartbeat.json.tmp','w') as f:
   os.chmod(f.name,0o600);json.dump({'alive':True,'monotone':time.monotonic(),'category':action},f);f.flush();os.fsync(f.fileno())
  os.replace(folder/'heartbeat.json.tmp',folder/'heartbeat.json')
  if not ready:atomic(folder/'WATCH_READY',{'at':time.time()});ready=True   # only after the first heartbeat exists
  with open(folder/'watchdog-events.jsonl','a') as f:os.chmod(f.name,0o600);f.write(json.dumps({'monotone':time.monotonic(),'action':action})+'\n');f.flush();os.fsync(f.fileno())
  if action=='interrupted-rearm-permitted':
   time.sleep(poll)
   try:confirmed=decision(folder,spec,read(spec['state']))
   except Exception:continue
   if confirmed!=action:continue
   atomic(folder/'watchdog-result.json',{'action':action,'recovery':recover(folder,spec)});return
  if action not in ['observe-live-queue','pre-go-await','await-intent','orphan-queue-alive-observe','state-unreadable']:
   atomic(folder/'watchdog-result.json',{'action':action});return
  time.sleep(poll)

def main(argv=None):
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['worker','watchdog','child']);p.add_argument('--folder',required=True);p.add_argument('--manifest');p.add_argument('--poll',type=float,default=5)
 a,rest=p.parse_known_args(argv)
 if a.poll<1 or a.poll>60:raise ValueError('poll must be within 1..60 seconds')
 if a.mode=='child':return child(a.folder,a.manifest,rest[1:] if rest[:1]==['--'] else rest)
 spec=check_spec(a.folder)
 return worker(a.folder,spec,a.poll) if a.mode=='worker' else watchdog(a.folder,spec,poll=a.poll)
if __name__=='__main__':sys.exit(main())
