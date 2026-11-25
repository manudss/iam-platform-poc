#!/usr/bin/env python3
"""Review-only current-held observation. Never starts/stops the held server.
CLI intentionally unavailable pending disposable qualification and final review.
"""
import contextlib,fcntl,hashlib,importlib.util,json,os,re,signal,stat,subprocess,threading,time
from pathlib import Path

ROOT=Path('/opt/lyam-recovery/active')
LOCKS={'journal':ROOT/'deploy-queue/state.json.lock','updater':ROOT/'.update.lock'}

def module(binding,name,reader):
 path,_=reader(binding)
 if path!=Path(__file__).with_name(name).absolute():raise ValueError('fixed sibling required')
 s=importlib.util.spec_from_file_location('observation_'+name.replace('.','_'),path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def private_write(path,value):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f:json.dump(value,f,sort_keys=True);f.flush();os.fsync(f.fileno())

@contextlib.contextmanager
def locked(runtime):
 with contextlib.ExitStack() as stack:
  bindings={}
  for key,path in LOCKS.items():
   for p in [path,*path.parents]:
    s=p.lstat()
    if p.is_symlink() or s.st_uid or s.st_gid or s.st_mode&0o022:raise ValueError('protected existing lock ancestry required')
   fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
   stack.callback(os.close,fd);s=os.fstat(fd)
   if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1:raise ValueError('unique regular lock required')
   fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);bindings[key]=(str(path),fd)
  runtime.locks(bindings)
  yield bindings
  runtime.locks(bindings)

def inspect(container):
 r=subprocess.run(['docker','inspect','--type','container',container],text=True,capture_output=True,timeout=5)
 if r.returncode:raise ValueError('held inspect refused')
 return json.loads(r.stdout)[0]

def counters(path):
 return {k:int(v) for k,v in (row.split() for row in path.read_text().splitlines())}

def snapshot(expected):
 x=inspect(expected['container_id']);s=x['State']
 if x['Id']!=expected['container_id'] or x['Image']!=expected['image_id'] or s['Pid']!=expected['pid'] or s['StartedAt']!=expected['started_at'] or not s['Running'] or s['OOMKilled'] or x['RestartCount']!=0:raise ValueError('held identity changed')
 proc=Path('/proc')/str(s['Pid'])
 if (proc/'ns/net').stat().st_ino!=expected['netns_inode']:raise ValueError('held namespace changed')
 rows=(proc/'cgroup').read_text().splitlines()
 if len(rows)!=1 or not rows[0].startswith('0::/'):raise ValueError('unified cgroup required')
 relative=rows[0][3:]
 if relative!=expected['cgroup'] or '..' in Path(relative).parts or relative=='/':raise ValueError('exact child cgroup required')
 cg=Path('/sys/fs/cgroup')/relative.lstrip('/')
 return {'at':time.monotonic(),'memory_current':int((cg/'memory.current').read_text()),'memory_peak':int((cg/'memory.peak').read_text()),'pids_current':int((cg/'pids.current').read_text()),'memory_events':counters(cg/'memory.events'),'pids_events':counters(cg/'pids.events'),'cpu_usage_usec':counters(cg/'cpu.stat')['usage_usec'],'memory_max':(cg/'memory.max').read_text().strip(),'pids_max':(cg/'pids.max').read_text().strip(),'cpu_max':(cg/'cpu.max').read_text().strip()}

def validate_limits(limits):
 if set(limits)!={'memory_current_max','pids_current_max','cpu_usec_per_second_max'} or any(type(v)is not int or v<=0 for v in limits.values()):raise ValueError('explicit reviewed load limits required')

def check_sample(now,baseline,previous,limits):
 validate_limits(limits)
 for field,limit in [('memory_max','memory_current_max'),('pids_max','pids_current_max')]:
  if now.get(field)!='max' and limits[limit]>int(now[field]):raise ValueError('threshold exceeds configured cgroup limit')
 if now['memory_current']>limits['memory_current_max'] or now['pids_current']>limits['pids_current_max']:raise ValueError('held load threshold exceeded')
 for family,keys in [('memory_events',('max','oom','oom_kill')),('pids_events',('max',))]:
  if any(now[family][key]!=baseline[family][key] for key in keys):raise ValueError('held cgroup event changed')
 if previous is not None:
  elapsed=now['at']-previous['at'];cpu=now['cpu_usage_usec']-previous['cpu_usage_usec']
  if elapsed<=0 or elapsed>10 or cpu<0 or cpu/elapsed>limits['cpu_usec_per_second_max']:raise ValueError('held CPU threshold or monitor interval exceeded')

class Guard:
 def __init__(self,expected,limits,checks,baseline_events=None):
  self.baseline_events=baseline_events;self.expected=expected;self.limits=limits;self.checks=checks;self.samples=[];self.failure=None;self.done=threading.Event();self.thread=None
 def sample(self):
  self.checks();value=snapshot(self.expected)
  if not self.samples and self.baseline_events is not None and {k:value[k] for k in ['memory_events','pids_events']}!=self.baseline_events:raise ValueError('operator historical events differ')
  check_sample(value,self.samples[0] if self.samples else value,self.samples[-1] if self.samples else None,self.limits)
  self.samples.append(value)
 def start(self):
  self.sample()
  self.thread=threading.Thread(target=self.loop,daemon=True);self.thread.start();return self
 def loop(self):
  while not self.done.wait(2):
   try:self.sample()
   except Exception:
    self.failure=True;os.kill(os.getpid(),signal.SIGUSR1);return
 def finish(self):
  self.done.set()
  if self.thread:self.thread.join(timeout=7)
  if self.thread and self.thread.is_alive():self.failure=True
  if not self.failure:
   try:self.sample()
   except Exception:self.failure=True
  return {'samples':len(self.samples),'failed':bool(self.failure),'memory_current_sampled_max':max((s['memory_current'] for s in self.samples),default=None),'pids_current_sampled_max':max((s['pids_current'] for s in self.samples),default=None),'measurement_is_upper_bound':False,'baseline':self.samples[0] if self.samples else None,'last_sample':self.samples[-1] if self.samples else None}

def execute(spec,reader,bindings):
 required={'format','kind','runtime_controller','host_controller','helper','client','resources','source','runtime','expected','limits','executed_source_sha256','reference_after','root','journal','pause','baseline_events'}
 if set(spec)!=required or spec['format']!=1 or spec['kind']!='reviewed-current-held-observation':raise ValueError('exact observation spec required')
 validate_limits(spec['limits'])
 expected=spec['expected']
 if set(expected)!={'container_id','image_id','pid','started_at','netns_inode','cgroup'} or expected['container_id']!=spec['runtime']['expected_container_id']:raise ValueError('exact current identity binding required')
 if not re.fullmatch('[a-f0-9]{64}',expected['container_id']) or not re.fullmatch('sha256:[a-f0-9]{64}',expected['image_id']) or type(expected['pid'])is not int or expected['pid']<=0 or type(expected['netns_inode'])is not int or expected['netns_inode']<=0 or not isinstance(expected['started_at'],str) or not expected['started_at']:raise ValueError('resolved current identity required')
 runtime=module(spec['runtime_controller'],'restored-runtime-check.py',reader)
 host=module(spec['host_controller'],'dolt-current-host.py',reader)
 helper=module(spec['helper'],'dolt-held-capture.py',reader)
 client=module(spec['client'],'dolt-current-client.py',reader)
 resources=module(spec['resources'],'dolt-copy-capture.py',reader)
 source_path,source=reader(spec['source'])
 if source_path!=Path(__file__).with_name('qualification-container.mjs').absolute():raise ValueError('fixed SQL source required')
 executed=helper.executed_source(source)
 if hashlib.sha256(executed.encode()).hexdigest()!=spec['executed_source_sha256']:raise ValueError('SQL source differs')
 _,raw=reader(spec['reference_after']);reference=json.loads(raw)
 if reference.get('kind')!='dolt-only-tables-v3' or reference.get('running')is not True:raise ValueError('actual replay after required')
 root=Path(spec['root'])
 if not re.fullmatch(r'/root/dolt-current-[a-f0-9]{16}',str(root)) or root.exists():raise ValueError('fresh private output required')
 for p in root.parents:
  s=p.lstat()
  if p.is_symlink() or s.st_uid or s.st_gid or s.st_mode&0o022:raise ValueError('protected output ancestry required')
 if int(next(row.split()[1] for row in Path('/proc/meminfo').read_text().splitlines() if row.startswith('MemAvailable:')))<3*1024**2:raise ValueError('3GiB host headroom required')
 def checks():
  runtime.locks(bindings)
  for key in ['env','pause','journal']:reader(spec['runtime'][key])
  for gate in spec['runtime']['gates'].values():reader(gate)
 root.mkdir(mode=0o700)
 result={'kind':'current-held-observation-result','completed':False,'restoration_admissible':False,'effect_authority':False,'stage':'runtime-before','operator_baseline_events':spec['baseline_events']};guard=None;failed=False;metrics=[]
 previous_monitor=client.resource_monitor
 def stop(sig,frame):raise TimeoutError('current observation refused or deadline')
 signals={s:signal.signal(s,stop) for s in (signal.SIGALRM,signal.SIGTERM,signal.SIGINT,signal.SIGUSR1)};signal.alarm(900)
 try:
  checks();before=host.verify(spec['runtime'],expected,reader);snapshot(expected)
  guard=Guard(expected,spec['limits'],checks,spec['baseline_events']).start()
  client.resource_monitor=lambda name:resources.ResourceMonitor(name)
  captures=[]
  for n in range(2):
   result['stage']='capture-'+str(n+1)
   value=client.capture_once(expected['container_id'],expected['image_id'],executed,bindings,metrics)
   private_write(root/('capture-'+str(n+1)+'.json'),value);captures.append(value)
   if guard.failure:raise ValueError('guard refused')
   metric=metrics[-1]
   if not metric.get('docker_state_available') or metric.get('oom_killed')is not False or metric.get('exit_code')!=0 or metric.get('running')is not False or not metric.get('samples') or metric.get('pids_events_max')!=0:raise ValueError('client outcome unverified')
  if captures[0]!=captures[1]:raise ValueError('current held moving')
  result['stage']='runtime-after'
  if host.verify(spec['runtime'],expected,reader)!=before:raise ValueError('runtime observation changed')
  checks();snapshot(expected)
  result['equal_replay_after']=captures[0]['dolt']==reference['dolt']
  result['stable_double_capture']=True
  result['two_client_cleanups_confirmed']=True
  if not result['equal_replay_after']:raise ValueError('current held differs from replay after')
  for key in ['runtime_controller','host_controller','helper','client','resources','source','reference_after']:reader(spec[key])
  result.update(completed=True,stage='completed')
 except Exception:failed=True
 finally:
  for sig in signals:signal.signal(sig,signal.SIG_IGN)
  signal.alarm(0);client.resource_monitor=previous_monitor
  if guard:
   result['server_guard']=guard.finish()
   if result['server_guard']['failed']:failed=True;result['completed']=False;result['stage']='server-guard-refused'
  result['client_measurements']=metrics
  private_write(root/'result.json',result)
  for sig,handler in signals.items():signal.signal(sig,handler)
 if failed:raise ValueError('current observation refused; preserve private captures/result')
 return result

def main():
 raise ValueError('review-only; no executable CLI before disposable qualification and review')
if __name__=='__main__':
 try:main()
 except Exception:
  print('CURRENT_HELD_OBSERVATION_REFUSED: no live authority',file=__import__('sys').stderr);raise SystemExit(1)
