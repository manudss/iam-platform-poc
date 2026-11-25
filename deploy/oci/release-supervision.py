#!/usr/bin/env python3
"""Durable supervision of ONE release-held run: a worker (runs the queue CLI as a child) and a separate
read-only watchdog. Adapted from the reviewed one-shot UI-held worker/watchdog: same GO / WATCH_READY /
exclusive-result protocol, but for kind release-held (phases, tri-state identities, 2-tick absence,
one rearm-release-held call, no open/retry/restart/kill). The spec carries hashes only. It grants NO
authority: the operator's GO file is the only start signal, and nothing here opens or lifts anything."""
import argparse,fcntl,hashlib,json,os,re,subprocess,sys,time
from pathlib import Path
HELD=('prepared','closing','env-installing','closed','env-installed','normal-start-committed','effects-released','normal-verified','opening')
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
def check_spec(folder,ancestry=True):
 folder=Path(folder)
 P=(PROTECT or protected) if ancestry else (lambda p:None)   # the child re-checks bindings; ancestry was proven by its parent
 P(folder)
 spec=read(folder/'supervision-spec.json')
 need={'kind','engagement_id','queue','state','pause','lock','repository','container','updater','manifest','python','target_sha','target_digest','fileSHA256','self'}
 if spec.get('kind')!='reviewed-release-held-supervision' or set(spec)!=need:raise ValueError('exact supervision spec required')
 if not re.fullmatch(r'[A-Za-z0-9._-]{8,64}',str(spec['engagement_id'])) or not re.fullmatch(r'sha256:[0-9a-f]{64}',str(spec['target_digest'])):raise ValueError('engagement id and target digest required')
 if read(spec['manifest']).get('engagement_id')!=spec['engagement_id']:raise ValueError('manifest engagement_id must equal the spec engagement_id')
 for p,want in spec['fileSHA256'].items():
  pp=Path(p)
  if not pp.is_absolute() or pp.is_symlink() or not pp.is_file() or pp.resolve()!=pp:raise ValueError('absolute regular non-symlink binding required')
  P(p)
  if sha(p)!=want:raise ValueError('source binding refused')
 for p in [spec['queue'],spec['manifest'],spec['updater'],spec['python'],spec['self']]:
  if p not in spec['fileSHA256']:raise ValueError('missing executable/manifest binding')
 if Path(__file__).resolve()!=Path(spec['self']) or Path(sys.executable).resolve()!=Path(spec['python']):raise ValueError('running supervisor/interpreter are not the bound ones')
 if sha(__file__)!=spec['fileSHA256'][spec['self']]:raise ValueError('supervisor bytes differ from binding')
 return spec
def queue_cmd(spec,sub):
 base=[spec['python'],spec['queue'],sub,'--state',spec['state'],'--pause-file',spec['pause'],'--update-lock',spec['lock']]
 return base+(['--repository',spec['repository'],'--container',spec['container'],'--updater',spec['updater']] if sub=='release-held-reviewed' else [])

def heartbeat_fresh(folder,poll):
 """Advancing watchdog heartbeat (two distinct values, recent) is required before the single GO."""
 hb=lambda:read(folder/'heartbeat.json')
 a=hb();time.sleep(poll*1.2+.2);b=hb()
 return (b['monotone']>a['monotone'] and time.monotonic()-b['monotone']<poll*3 and b.get('alive') is True
  and type(a.get('wall')) is float and type(b.get('wall')) is float and b['wall']>a['wall'] and 0<=time.time()-b['wall']<poll*3)   # wall AND monotonic advance


# ---- real systemd unit bindings (production). Tests set REQUIRE_UNITS=False explicitly for pure-process tests.
REQUIRE_UNITS=True
SYSTEMCTL='/usr/bin/systemctl'
UNIT_RE=re.compile(r'lyam-durable-release-[A-Za-z0-9._-]{8,64}-(worker|watchdog)\.service')
SHOW=['InvocationID','MainPID','ControlGroup','ActiveState','User','UMask','Restart','KillMode','RuntimeMaxUSec','TimeoutStartUSec','TimeoutStopUSec','StandardOutput','StandardError','RemainAfterExit','SubState','Result','ExecMainPID','ExecMainCode','ExecMainStatus','ExecMainStartTimestampMonotonic','ExecMainExitTimestampMonotonic']
CGROOT='/sys/fs/cgroup'
CG_RE=re.compile(r'/[A-Za-z0-9._@:/-]{1,300}')
FAILED_TUPLES={'exit-code':('1',255),'signal':('2',64),'core-dump':('3',64)}   # Result -> (ExecMainCode CLD_EXITED/KILLED/DUMPED, max status or signal number)
class UnitRecordLost(ValueError):
 """The manager no longer has the bound invocation (empty InvocationID/ControlGroup on an inactive unit): terminal-GC-observed, REPORT-ONLY, never permission to rearm."""
def cgroup_state(path):
 """'empty' only if the bound cgroup AND every descendant cgroup have no process (recursive; cgroup.events populated 0 where present);
 'gone' only if the directory certainly does not exist. Any unreadable entry or walk error raises: unknown is never ended."""
 if not CG_RE.fullmatch(path or '') or '..' in path.split('/'):raise ValueError('bound control group path invalid')
 d=Path(CGROOT)/path.lstrip('/')
 if not d.exists():return 'gone'
 def bad(e):raise ValueError('control group walk failed')
 for cur,dirs,files in os.walk(d,onerror=bad,followlinks=False):
  try:
   if (Path(cur)/'cgroup.procs').read_text().split():return 'populated'
   ev=Path(cur)/'cgroup.events'
   if ev.exists() and 'populated 1' in ev.read_text().split('\n'):return 'populated'
  except OSError:raise ValueError('control group unreadable')
 return 'empty'
def unit_properties(unit):
 if not UNIT_RE.fullmatch(unit or ''):raise ValueError('bounded release-held unit name required')
 out=subprocess.run([SYSTEMCTL,'show','--no-pager',unit,'-p',','.join(SHOW)],capture_output=True,text=True,timeout=30,stdin=subprocess.DEVNULL)
 if out.returncode:raise ValueError('systemctl show failed')
 props=dict(l.split('=',1) for l in out.stdout.splitlines() if '=' in l)
 if set(props)<set(SHOW):raise ValueError('incomplete unit properties')
 return props
def worker_record(value,e,engagement):
 return {'start':int(value),'engagementID':engagement,'unit':e['unit'],'invocationID':e['invocationID'],'pid':e['pid'],'starttime':e['starttime'],'boot_id':e['boot_id'],'controlGroup':e['controlGroup']}
def worker_start_stamp(folder,value,e,engagement):
 """Temporal binding, one durable record bound to the full worker identity. The first sighting of the running worker publishes it ATOMICALLY and
 exclusively: complete bytes into a private temp file, fsync, hard link to the final name (fails if it exists), fsync of the directory. A concurrent
 loser never sees a partial file: the final name only ever exists complete. Every later sighting must equal the whole record."""
 if not value.isdigit() or int(value)<=0:raise ValueError('worker start timestamp invalid')
 folder=Path(folder);f=folder/'worker-unit-start.json';want=worker_record(value,e,engagement)
 if not f.exists():
  tmp=folder/('worker-unit-start.json.tmp-%d-%d'%(os.getpid(),time.monotonic_ns()))
  fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  try:
   with os.fdopen(fd,'w') as h:json.dump(want,h,sort_keys=True);h.flush();os.fsync(h.fileno())
   try:os.link(tmp,f)
   except FileExistsError:pass
  finally:os.unlink(tmp)
  dfd=os.open(folder,os.O_RDONLY)
  try:os.fsync(dfd)
  finally:os.close(dfd)
 if read(f)!=want:raise ValueError('worker start record differs from the observed worker')
 return want['start']
def temporal_ok(folder,p,e,engagement):
 """The retained end belongs to the run seen starting: same recorded start stamp, a real exit stamp not before it. No record = unknown, never ended."""
 f=Path(folder)/'worker-unit-start.json'
 if not f.exists():return False
 rec=read(f);st,ex=p['ExecMainStartTimestampMonotonic'],p['ExecMainExitTimestampMonotonic']
 return st.isdigit() and ex.isdigit() and int(st)>0 and rec==worker_record(st,e,engagement) and int(ex)>=int(st)   # the whole record (engagement, unit, invocation, pid, starttime, boot, cgroup) must match, not only the number
def r_checked_again(unit,before):
 """True when the manager's record changed since it was read (and the cgroup scanned): a terminal claim must survive a fresh re-read."""
 return unit_properties(unit)!=before
def verify_units(folder,role,spec,self_check=True):
 """Differentiated check. The calling role's own unit must be active/running and exact. The watchdog always requires itself exact.
 The worker unit is launched with RemainAfterExit=yes so the manager keeps its record (InvocationID, ControlGroup, Result, ExecMain*) after the
 process ends. Seen from the watchdog it may be: 'active' (running, exact main pid alive), 'exited' (retained: active/exited, Result=success,
 ExecMainCode=1, same InvocationID and ControlGroup as bound, MainPID 0, ExecMainPID=bound pid, pid/starttime/boot absent, cgroup empty or gone),
 or 'failed' (retained failed unit, same conditions, coherent tuple: exit-code/CLD_EXITED/status 1..255, signal/CLD_KILLED or core-dump/CLD_DUMPED with signal 1..64; other Results are refused). A record the manager already forgot (empty InvocationID/ControlGroup)
 raises UnitRecordLost; a reused pid, other boot, other invocation or any ambiguity raises ValueError. Neither is ever permission to rearm.
 Returns the bindings plus _worker_status and _worker_exit (int exit status of the retained worker, else None)."""
 folder=Path(folder);b=read(folder/'unit-bindings.json')
 if b.get('kind')!='release-held' or b.get('engagementID')!=spec['engagement_id'] or set(b)!={'kind','engagementID','worker','watchdog'}:raise ValueError('release-held unit binding required')
 status={};exit_status=None
 for r in ('worker','watchdog'):
  e=b[r];p=unit_properties(e['unit'])
  if r=='worker':worker_props=p
  if r=='worker' and role=='watchdog' and p['InvocationID']=='' and p['ControlGroup']=='' and p['ActiveState'] in ('inactive','failed') and p['MainPID']=='0':raise UnitRecordLost('unit record no longer held by the manager')
  # A retained TERMINAL worker may have lost its manager-side ControlGroup (cgroup removed after exit) while the invocation record is retained.
  # That is accepted only for the worker seen from the watchdog in an exited/failed state with MainPID 0; running units must match the bound cgroup exactly.
  cg_retired=(r=='worker' and role=='watchdog' and p['ControlGroup']=='' and p['MainPID']=='0' and (p['ActiveState'],p['SubState']) in (('active','exited'),('failed','failed')))
  if not e['unit'].endswith('-'+r+'.service') or not e['invocationID'] or p['InvocationID']!=e['invocationID'] or (p['ControlGroup']!=e['controlGroup'] and not cg_retired):raise ValueError('unit identity differs from binding')
  if p['User'] not in ('root','') or p['Restart']!='no' or p['KillMode']!='control-group' or any(p[k]!='infinity' for k in ('RuntimeMaxUSec','TimeoutStartUSec','TimeoutStopUSec')) or p['UMask']!='0077':raise ValueError('unit properties differ from the reviewed contract')
  if p['RemainAfterExit']!=('yes' if r=='worker' else 'no'):raise ValueError('unit retention differs from the reviewed contract')
  if not p['StandardOutput'].startswith('append') or not p['StandardError'].startswith('append'):raise ValueError('unit output not append-only')
  o=state_of({'pid':e['pid'],'starttime':e['starttime'],'boot_id':e['boot_id']})
  if p['ActiveState']=='active' and p['SubState']=='running':
   if str(e['pid'])!=p['MainPID'] or int(p['MainPID'])<=0 or o!='alive':raise ValueError('unit main process identity not alive/exact')
   status[r]='active'
   if r=='worker':worker_start_stamp(folder,p['ExecMainStartTimestampMonotonic'],e,spec['engagement_id'])
  elif r=='worker' and role=='watchdog' and p['MainPID']=='0' and p['ExecMainPID']==str(e['pid']) and o=='absent' and cgroup_state(e['controlGroup'])!='populated' and p['ExecMainStatus'].isdigit() and temporal_ok(folder,p,e,spec['engagement_id']):
   if p['ActiveState']=='active' and p['SubState']=='exited' and p['Result']=='success' and p['ExecMainCode']=='1':status[r]='exited';exit_status=int(p['ExecMainStatus'])
   elif p['ActiveState']=='failed' and p['SubState']=='failed' and FAILED_TUPLES.get(p['Result']) and p['ExecMainCode']==FAILED_TUPLES[p['Result']][0] and 1<=int(p['ExecMainStatus'])<=FAILED_TUPLES[p['Result']][1]:status[r]='failed'   # coherent terminal tuple only; timeout/watchdog/resources are not proof of end
   else:raise ValueError('unit state not acceptable for '+r)
  else:raise ValueError('unit state not acceptable for '+r)
 if status['worker']!='active' and r_checked_again(b['worker']['unit'],worker_props):raise ValueError('unit record drifted between the cgroup scan and the manager re-read')
 if status['watchdog']!='active':raise ValueError('watchdog unit must be active')
 me=b[role]
 if self_check and (os.environ.get('INVOCATION_ID')!=me['invocationID'] or os.getpid()!=me['pid']):raise ValueError('this process is not the bound unit main process')
 b['_worker_status']=status['worker'];b['_worker_exit']=exit_status
 return b
def await_units(folder,role,spec,timeout=600):
 folder=Path(folder);e=time.time()+timeout
 while not (folder/'UNIT_BINDINGS_READY').exists():
  if time.time()>e:raise ValueError('unit bindings not ready')
  time.sleep(.2)
 return verify_units(folder,role,spec)
def launcher_commands(folder,engagement,python,selfpath,poll=5):
 """The two exact systemd-run argv lists. Compiling them authorizes nothing: an isolated launcher runs them after review."""
 out=[]
 for role in ('watchdog','worker'):
  unit='lyam-durable-release-%s-%s.service'%(engagement,role)
  out.append(['systemd-run','--unit='+unit,'--service-type=exec']+(['-p','RemainAfterExit=yes'] if role=='worker' else [])+['-p','User=root','-p','UMask=0077','-p','Restart=no','-p','KillMode=control-group','-p','RuntimeMaxSec=infinity','-p','TimeoutStartSec=infinity','-p','TimeoutStopSec=infinity','-p','StandardOutput=append:%s/%s.stdout'%(folder,role),'-p','StandardError=append:%s/%s.stderr'%(folder,role),'--',python,selfpath,role,'--folder',str(folder),'--poll',str(poll)])
 return out

def worker(folder,spec,poll=5):
 folder=Path(folder)
 if REQUIRE_UNITS:await_units(folder,'worker',spec)   # before identity/heartbeat use/GO
 atomic(folder/'worker-identity.json',identity(os.getpid()))
 while not (folder/'GO').exists():time.sleep(.1)
 if not (folder/'WATCH_READY').exists() or not heartbeat_fresh(folder,poll):raise ValueError('watchdog not ready')
 if REQUIRE_UNITS:verify_units(folder,'worker',spec)
 atomic(folder/'STARTED',{'at':time.time(),'engagement_id':spec['engagement_id']})
 with open(folder/'worker.log','xb') as log:
  os.chmod(log.name,0o600)
  child=subprocess.Popen([spec['python'],spec['self'],'child','--folder',str(folder),'--manifest',spec['manifest'],'--']+queue_cmd(spec,'release-held-reviewed'),stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  ident=identity(child.pid)
  if ident is None:raise ValueError('child exited before identity')
  atomic(folder/'queue-identity.json',ident);atomic(folder/'CHILD_GO',{'at':time.time()})
  rc=child.wait()
 atomic(folder/'worker-result.json',{'exit':rc,'at':time.time()});return rc
def child(folder,manifest,argv):
 folder=Path(folder);check_spec(folder,ancestry=False)
 while not (folder/'CHILD_GO').exists():time.sleep(.05)
 fd=os.open(manifest,os.O_RDONLY);os.dup2(fd,0);os.close(fd);os.execvp(argv[0],argv)

def final_audit_ok(folder,spec,state):
 try:
  man=read(spec['manifest']);aud=state['releases'][-1];target={'sha':spec['target_sha'],'digest':spec['target_digest']}
  return (read(Path(folder)/'STARTED').get('engagement_id')==spec['engagement_id'] and aud.get('manifest')==man
   and state.get('format')==4 and not state.get('release_intent') and state.get('delivery_mode')=='normal'
   and state.get('resume_required') is False and not state.get('release_finalize_required') and not Path(spec['pause']).exists() and aud.get('target')==target
   and aud.get('observed_running',{}).get('held') is False and aud.get('observed_running',{}).get('settingPresent') is False)
 except Exception:return False

def decision(folder,spec,state):
 """Distinct categories; first match wins. Only interrupted-rearm-permitted can lead to the single rearm call."""
 folder=Path(folder)
 if not (folder/'STARTED').exists():return 'pre-go-await'          # no completed/exit before this engagement started
 i=state.get('release_intent');phase=str((i or {}).get('phase',''))
 if (folder/'worker-result.json').exists():
  rc=read(folder/'worker-result.json')['exit']
  if rc==0:
   return 'completed' if final_audit_ok(folder,spec,state) else 'completed-audit-mismatch-report-only'
  if i is None:return 'failed-before-intent-report-only'
  if rc>0 and str(phase).startswith(HELD):return 'caught-nonzero-without-failed-phase-report-only'   # handler did not finish: ambiguous, never rearmed by extension
 if not i:return 'await-intent'
 if i.get('access_rearmed') is True:return 'recovery-done'
 if phase.startswith('failed-'):return 'caught-failure-report-only'
 if not phase.startswith(HELD):return 'identity-unknown-report-only'
 if not (folder/'queue-identity.json').exists():return 'child-unknown-report-only'
 w=state_of(read(folder/'worker-identity.json'));q=state_of(read(folder/'queue-identity.json'));qs=state_of(i.get('queue'))
 uc=i.get('child');ucs='absent' if uc is None else state_of(uc.get('identity') if isinstance(uc,dict) else None)
 if 'unknown' in (w,q,qs,ucs):return 'identity-unknown-report-only'
 if ucs=='alive' and q!='alive' and qs!='alive':return 'orphan-updater-alive-observe'   # a live updater child holds the lock: never rearm, never kill
 if q=='alive' or qs=='alive':return 'observe-live-queue' if w=='alive' else 'orphan-queue-alive-observe'
 if w=='alive' and not (folder/'worker-result.json').exists():return 'observe-live-queue'
 return 'interrupted-rearm-permitted'

def recovery(folder,spec):
 """No lock is held here: the queue CLI takes the updater lock and the state lock itself and re-checks identity and phase
 (a precheck here would only be an illusion of authorization). One durable attempt, exclusive, even across watchdog relaunch."""
 atomic(Path(folder)/'rearm-attempt.json',{'at':time.time(),'monotonic':time.monotonic()})
 with open(Path(folder)/'recovery.log','xb') as log:
  os.chmod(log.name,0o600);rc=subprocess.run(queue_cmd(spec,'rearm-release-held'),stdout=log,stderr=subprocess.STDOUT,stdin=subprocess.DEVNULL).returncode
 return {'kind':'rearm-release-held-attempted','exit':rc,'outcome':'measured-closed' if rc==0 else 'refused-collision-or-unknown-report-only'}

END_WAIT=120.0   # seconds the watchdog waits for a worker that already wrote its result to reach a RETAINED end; beyond it: report-only
def watchdog(folder,spec,recover=recovery,poll=5):
 folder=Path(folder);ready=False;await_since=None
 if REQUIRE_UNITS:await_units(folder,'watchdog',spec)
 atomic(folder/'watchdog-identity.json',identity(os.getpid()))
 while True:
  if (folder/'STOP_WATCHDOG').exists():return
  units=None
  try:
   if REQUIRE_UNITS:units=verify_units(folder,'watchdog',spec)
  except UnitRecordLost:action='terminal-gc-observed-report-only'   # the manager forgot the invocation: never proof of end, never rearm
  except Exception:action='identity-unknown-report-only'   # unit ambiguity is never permission to rearm
  else:
   try:action=decision(folder,spec,read(spec['state']))
   except Exception:action='state-unreadable'
   if units is not None:
    ws=units['_worker_status']
    if action=='completed' and ws=='active':action='completed-awaiting-worker-end'   # nominal race: worker-result is written BEFORE the process exits; wait, bounded
    elif action=='completed' and not (ws=='exited' and units['_worker_exit']==0):action='completed-unit-result-mismatch-report-only'
    if action=='interrupted-rearm-permitted' and ws not in ('exited','failed'):action='identity-unknown-report-only'   # rearm only after the retained manager record shows the worker ended
  if action=='completed-awaiting-worker-end':
   if await_since is None:await_since=time.monotonic()
   if time.monotonic()-await_since>END_WAIT:action='completed-worker-end-timeout-report-only'
  else:await_since=None
  with open(folder/'heartbeat.json.tmp','w') as f:
   os.chmod(f.name,0o600);json.dump({'alive':True,'monotone':time.monotonic(),'wall':time.time(),'category':action},f);f.flush();os.fsync(f.fileno())
  os.replace(folder/'heartbeat.json.tmp',folder/'heartbeat.json')
  if not ready:atomic(folder/'WATCH_READY',{'at':time.time()});ready=True   # only after the first heartbeat exists
  with open(folder/'watchdog-events.jsonl','a') as f:os.chmod(f.name,0o600);f.write(json.dumps({'monotone':time.monotonic(),'wall':time.time(),'action':action})+'\n');f.flush();os.fsync(f.fileno())
  if action=='interrupted-rearm-permitted':
   time.sleep(poll)
   try:confirmed=decision(folder,spec,read(spec['state']))
   except Exception:continue
   if confirmed!=action:continue
   try:
    if REQUIRE_UNITS and verify_units(folder,'watchdog',spec)['_worker_status'] not in ('exited','failed'):raise ValueError('worker end not retained at the second tick')   # systemd identity must still hold at the second tick, immediately before the single attempt
   except Exception:
    atomic(folder/'watchdog-result.json',{'action':'identity-unknown-report-only','wall':time.time(),'report_only':True,'needs_operator':True});return
   rec=recover(folder,spec);atomic(folder/'watchdog-result.json',{'action':action,'wall':time.time(),'recovery':rec,'needs_operator':True});return
  if action not in ['observe-live-queue','pre-go-await','await-intent','orphan-queue-alive-observe','orphan-updater-alive-observe','state-unreadable','completed-awaiting-worker-end']:
   atomic(folder/'watchdog-result.json',{'action':action,'wall':time.time(),'report_only':action.endswith('report-only') or action=='completed-audit-mismatch-report-only','needs_operator':action not in ('completed','recovery-done')});return
  time.sleep(poll)

def main(argv=None):
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['worker','watchdog','child']);p.add_argument('--folder',required=True);p.add_argument('--manifest');p.add_argument('--poll',type=float,default=5)
 a,rest=p.parse_known_args(argv)
 if a.poll<1 or a.poll>60:raise ValueError('poll must be within 1..60 seconds')
 if a.mode=='child':return child(a.folder,a.manifest,rest[1:] if rest[:1]==['--'] else rest)
 spec=check_spec(a.folder)
 return worker(a.folder,spec,a.poll) if a.mode=='worker' else watchdog(a.folder,spec,poll=a.poll)
if __name__=='__main__':sys.exit(main())


def verify_live(spec_path,engagement):
 folder=Path(spec_path).parent
 spec=check_spec(folder)
 if spec_path!=folder/'supervision-spec.json' or spec['engagement_id']!=engagement:raise ValueError('supervision engagement differs')
 units=verify_units(folder,'worker',spec,self_check=False)
 if units['_worker_status']!='active':raise ValueError('release worker not active')
 child_id=read(folder/'queue-identity.json')
 if child_id.get('pid')!=os.getpid() or state_of(child_id)!='alive':raise ValueError('this is not the supervised queue child')
 if not (folder/'GO').is_file() or not (folder/'WATCH_READY').is_file() or not heartbeat_fresh(folder,5):raise ValueError('release GO and advancing watchdog required')
 return spec
