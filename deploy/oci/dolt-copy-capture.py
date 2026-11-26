#!/usr/bin/env python3
"""Capture ONLY an operator-staged work copy, never mounted recovery source.
Does not copy source, start a database/app server, migrate, or admit restoration.
The reviewed spec binds all work-tree bytes. Failures preserve private output.
"""
import hashlib,importlib.util,json,os,re,shutil,signal,subprocess,time,threading
from pathlib import Path

class ResourceMonitor:
 """Host-side sampled cgroup peak plus final Docker state, before removal.
 Sampling is observational, not a bound; an early kill can evade peak sampling.
 """
 def __init__(self,name):
  self.name=name;self.done=threading.Event();self.peak=None;self.samples=0;self.thread=None;self.pids_peak=None;self.pids_events_max=None;self.zombies_peak=None
 def start(self):
  self.thread=threading.Thread(target=self.sample,daemon=True);self.thread.start();return self
 def sample(self):
  path=None
  while not self.done.is_set():
   try:
    if path is None:
     r=subprocess.run(['docker','inspect',self.name],capture_output=True,text=True,timeout=3)
     if r.returncode==0:
      pid=json.loads(r.stdout)[0]['State']['Pid']
      if type(pid) is int and pid>0:
       entries=Path('/proc/'+str(pid)+'/cgroup').read_text().splitlines()
       relative=next(row[3:] for row in entries if row.startswith('0::'))
       candidate=Path('/sys/fs/cgroup')/relative.lstrip('/')
       if '..' in candidate.parts:raise ValueError('cgroup path differs')
       path=candidate/'memory.peak'
    if path is not None:
     n=int(path.read_text().strip())
     if n<0:raise ValueError('memory peak differs')
     self.peak=max(self.peak or 0,n);self.samples+=1
     try:self.pids_peak=max(self.pids_peak or 0,int(path.with_name('pids.peak').read_text().strip()))
     except Exception:pass
     try:
      members=path.with_name('cgroup.procs').read_text().split();zombies=0
      for member in members:
       status=Path('/proc')/member/'status'
       if 'State:\tZ' in status.read_text():zombies+=1
      self.zombies_peak=max(self.zombies_peak or 0,zombies)
     except Exception:pass
     try:self.pids_events_max=max(self.pids_events_max or 0,int(dict(row.split() for row in path.with_name('pids.events').read_text().splitlines())['max']))
     except Exception:pass
   except Exception:pass
   self.done.wait(0.05)
 def finish(self):
  self.done.set()
  if self.thread:self.thread.join(timeout=4)
  result={'sampled_memory_peak_bytes':self.peak,'samples':self.samples,'sampled_pids_peak':self.pids_peak,'sampled_zombie_processes_peak':self.zombies_peak,'pids_events_max':self.pids_events_max,'measurement_is_upper_bound':False,'docker_state_available':False}
  try:
   r=subprocess.run(['docker','inspect',self.name],capture_output=True,text=True,timeout=5)
   state=json.loads(r.stdout)[0]['State']
   result.update(docker_state_available=True,oom_killed=state['OOMKilled'],exit_code=state['ExitCode'],running=state['Running'])
  except Exception:pass
  return result

def digest_tree(root):
 if not root.is_dir() or root.is_symlink():raise ValueError('real work directory required')
 rows=[];total=0
 for p in sorted(root.rglob('*')):
  s=p.lstat()
  if p.is_symlink() or not (p.is_dir() or p.is_file()) or s.st_uid or s.st_gid or s.st_mode&0o022:raise ValueError('protected regular work tree only')
  if p.is_file():
   if s.st_nlink!=1:raise ValueError('hardlinks forbidden in work copy')
   total+=s.st_size
   if total>8*1024**3 or len(rows)>=100000:raise ValueError('bounded work copy required')
   h=hashlib.sha256()
   with p.open('rb') as f:
    for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
   rows.append([str(p.relative_to(root)),s.st_size,h.hexdigest()])
 return hashlib.sha256(json.dumps(rows,separators=(',',':')).encode()).hexdigest(),total,len(rows)

def prepare_work_copy(incoming,work):
 """Inventory an operator-staged input; create NEW normalized work, input intact.
 Never reads the original recovery mount, follows links, or changes incoming.
 """
 incoming,work=Path(incoming),Path(work)
 if incoming.name!='incoming' or incoming.parent!=work.parent or work.name!='work' or not re.fullmatch(r'/root/dolt-evidence-[a-f0-9]{16}',str(work.parent)) or work.exists():raise ValueError('new sibling work copy required')
 def inventory(root):
  rows=[];total=0
  for p in [root,*sorted(root.rglob('*'))]:
   st=p.lstat()
   if p.is_symlink() or not(p.is_file() or p.is_dir()) or (p.is_file() and st.st_nlink!=1):raise ValueError('unlinked regular staged tree required')
   h=None
   if p.is_file():
    total+=st.st_size
    if total>384*1024**2:raise ValueError('staged tree too large')
    h=hashlib.sha256(p.read_bytes()).hexdigest()
   rows.append({'path':str(p.relative_to(root)),'uid':st.st_uid,'gid':st.st_gid,'mode':st.st_mode&0o7777,'size':st.st_size if p.is_file() else None,'sha256':h})
   if len(rows)>100000:raise ValueError('too many staged entries')
  return rows
 before=inventory(incoming)
 shutil.copytree(incoming,work,symlinks=True)
 for p in [work,*work.rglob('*')]:
  if p.is_symlink():raise ValueError('copy link differs')
  os.chown(p,0,0);p.chmod(0o700 if p.is_dir() else 0o600)
 after=inventory(work)
 content=lambda rows:[(r['path'],r['size'],r['sha256']) for r in rows]
 if before!=inventory(incoming) or content(before)!=content(after):raise ValueError('staged input or copied bytes changed')
 report={'format':1,'kind':'new-work-copy-preparation','incoming_unchanged':True,'content_equal':True,'before':before,'after':after}
 fd=os.open(work.parent/'preparation.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f:json.dump(report,f);f.flush();os.fsync(f.fileno())
 return report

def command(spec,source):
 work=Path(spec['work_dir'])
 if not re.fullmatch(r'/root/dolt-evidence-[a-f0-9]{16}/work',str(work)):raise ValueError('fixed isolated work and scratch paths required')
 if not re.fullmatch(r'sha256:[a-f0-9]{64}',spec['image_id']):raise ValueError('immutable local image ID required')
 if spec['dolt_version']!='2.6.1':raise ValueError('reviewed calibrated Dolt version required')
 if source.get('path')!=str(Path(__file__).with_name('qualification-container.mjs').absolute()):raise ValueError('fixed capture source required')
 return ['docker','run','--init','-i','--name',spec['container'],'--restart','no','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges:true','--read-only','--oom-score-adj','1000','--user','0:0','--memory','1536m','--memory-swap','1536m','--pids-limit','96','--cpus','0.5','--mount','type=bind,src='+str(work)+',dst=/data/dolt,readonly','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=1073741824,mode=0700','--workdir','/tmp','--env','HOME=/tmp','--env','GOMAXPROCS=2','--entrypoint','node',spec['image_id'],'--input-type=module','-e']

def executed_source(raw):
 return ("const {readFileSync:epochRead,statfsSync:epochStat}=await import('node:fs');process.on('exit',()=>{try{const peak=epochRead('/sys/fs/cgroup/memory.peak','utf8').trim();const st=epochStat('/tmp');console.error('DOLT_RESOURCE_V1:'+peak+':'+((st.blocks-st.bfree)*st.bsize))}catch{}});"
  "const {execFileSync:epochExec}=await import('node:child_process');"
  "if(!/\\bdolt version 2\\.6\\.1\\b/.test(epochExec('dolt',['version'],{encoding:'utf8',timeout:10000})))throw Error('version differs');\n"+raw.decode())

def execute(spec,reader):
 if set(spec)!={'format','kind','work_dir','tree_sha256','image_id','dolt_version','source','executed_source_sha256','container','out'} or spec['format']!=1 or spec['kind']!='reviewed-work-copy-dolt-capture':raise ValueError('exact work capture spec required')
 if not re.fullmatch('dolt-copy-[a-f0-9]{16}',spec['container']):raise ValueError('bounded unique container name required')
 args=command(spec,spec['source']);_,raw=reader(spec['source']);work=Path(spec['work_dir']);out=Path(spec['out'])
 if out!=work.parent/'capture.json' or out.exists() or (work.parent/'attempt.json').exists():raise ValueError('fresh capture and scratch required')
 for p in [work,*work.parents]:
  s=p.lstat()
  if p.is_symlink() or s.st_uid or s.st_gid or s.st_mode&0o022:raise ValueError('protected work ancestry required')
 if os.geteuid()!=0:raise ValueError('operator root required')
 if next(int(l.split()[1]) for l in Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))<3*1024*1024:raise ValueError('3GiB MemAvailable required')
 h,total,count=digest_tree(work)
 if h!=spec['tree_sha256'] or not count or total>384*1024**2:raise ValueError('bound nonempty work copy differs')
 if shutil.disk_usage(work.parent).free<2*total+2*1024**3:raise ValueError('scratch disk headroom required')
 # Version is checked inside the SAME named, bounded disposable container;
 # no anonymous version-check container can escape final removal.
 executed=executed_source(raw)
 if hashlib.sha256(executed.encode()).hexdigest()!=spec['executed_source_sha256']:raise ValueError('executed source binding differs')
 existing=subprocess.run(['docker','ps','-a','--format','{{.Names}}'],capture_output=True,text=True,timeout=15)
 if existing.returncode or spec['container'] in existing.stdout.splitlines():raise ValueError('cannot exclude preexisting capture container')
 monitor=ResourceMonitor(spec['container']).start()
 result={'format':1,'kind':'work-copy-dolt-capture-attempt','completed':False,'scratch_tmpfs_max_bytes':1073741824,'source_copy_max_bytes':384*1024**2,'restoration_admissible':False,'source_tree_sha256':h,'source_files':count,'source_bytes':total,'executed_source_sha256':hashlib.sha256(executed.encode()).hexdigest()};failure=None
 try:
  # Python timeout kills docker CLIENT only. Finally forcibly removes this exact
  # disposable container before returning; no auto-remove obscures its outcome.
  r=subprocess.run(args+[executed,'dolt-only'],input='{"running":false}',text=True,capture_output=True,timeout=300)
  metrics=re.findall(r'^DOLT_RESOURCE_V1:([0-9]{1,16}):([0-9]{1,16})$',r.stderr,re.M)
  result['resource_measurement']=dict(zip(('memory_peak_bytes','tmpfs_used_bytes'),map(int,metrics[-1]))) if len(metrics)==1 else None
  if r.returncode:
   result['container_exit_code']=r.returncode
   stages=re.findall(r'^QUALIFICATION_DIAG_V1:(capture-dolt|init)$',r.stderr,re.M)
   result['capture_stage']=stages[-1] if stages else 'unverified'
   result['failure_stdout_bytes']=len(r.stdout.encode())
   for field,pattern in [('reason_code',r'^QUALIFICATION_REASON_V1:(-?[0-9]{1,2})$'),('query_kind_code',r'^DOLT_QUERY_KIND_V1:(-?[0-9]{1,2})$'),('pthread_failure',r'^DOLT_THREAD_FAILURE_V1:([01])$')]:
    found=re.findall(pattern,r.stderr,re.M);result[field]=int(found[-1]) if found else None
   raise ValueError('Dolt copy capture refused')
  envelope=json.loads(r.stdout)
  if not isinstance(envelope,dict) or set(envelope)!={'format','kind','running','dolt'} or envelope['format']!=1 or envelope['kind']!='dolt-only-tables-v3' or envelope['running'] is not False or not envelope['dolt']:raise ValueError('Dolt envelope differs')
  if digest_tree(work)[0]!=h:raise ValueError('read-only work copy changed')
  result.update(completed=True,capture_sha256=hashlib.sha256(r.stdout.encode()).hexdigest())
  fd=os.open(out,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'w') as f:json.dump(envelope,f);f.flush();os.fsync(f.fileno())
 except Exception as e:failure=e
 finally:
  signal.alarm(0)
  for sig in (signal.SIGALRM,signal.SIGTERM,signal.SIGINT):signal.signal(sig,signal.SIG_IGN)
  result['host_resource_measurement']=monitor.finish()
  try:cleanup=subprocess.run(['docker','rm','-f',spec['container']],text=True,capture_output=True,timeout=20)
  except Exception:cleanup=type('Cleanup',(),{'returncode':1})()
  # A failed remove, even if container absent, remains an unverified refusal.
  result['cleanup_confirmed']=cleanup.returncode==0
  fd=os.open(work.parent/'attempt.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'w') as f:json.dump(result,f);f.flush();os.fsync(f.fileno())
 if failure or not result['cleanup_confirmed']:raise ValueError('capture refused or cleanup unverified; inspect private attempt')
 return result

def read_binding(binding):
 if not isinstance(binding,dict) or set(binding)!={'path','sha256'} or not re.fullmatch('[a-f0-9]{64}',binding['sha256']):raise ValueError('exact protected binding required')
 p=Path(binding['path'])
 if not p.is_absolute() or '..' in p.parts:raise ValueError('absolute binding required')
 for x in [p,*p.parents]:
  st=x.lstat()
  if x.is_symlink() or st.st_uid or st.st_gid or st.st_mode&0o022:raise ValueError('protected binding ancestry required')
 if not p.is_file() or p.stat().st_nlink!=1 or p.stat().st_size>64*1024**2:raise ValueError('bounded unique file required')
 raw=p.read_bytes()
 if hashlib.sha256(raw).hexdigest()!=binding['sha256']:raise ValueError('binding changed')
 return p,raw

def bounded_execute(spec):
 def stop(signum,frame):
  signal.alarm(0)
  for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,signal.SIG_IGN)
  raise TimeoutError('copy capture interrupted')
 prior={sig:signal.signal(sig,stop) for sig in (signal.SIGALRM,signal.SIGTERM,signal.SIGINT)}
 signal.alarm(600)
 try:return execute(spec,read_binding)
 finally:
  signal.alarm(0)
  for sig,handler in prior.items():signal.signal(sig,handler)

def main():
 import argparse
 p=argparse.ArgumentParser();p.add_argument('--spec',required=True);p.add_argument('--spec-sha256',required=True);p.add_argument('--controller-sha256',required=True);p.add_argument('--execute-reviewed-work-copy',action='store_true');a=p.parse_args()
 read_binding({'path':str(Path(__file__).absolute()),'sha256':a.controller_sha256})
 _,raw=read_binding({'path':a.spec,'sha256':a.spec_sha256});spec=json.loads(raw)
 if not a.execute_reviewed_work_copy:raise ValueError('reviewed work copy execution flag required')
 result=bounded_execute(spec);print(json.dumps(result,sort_keys=True))
if __name__=='__main__':
 try:main()
 except Exception:
  print('DOLT_COPY_CAPTURE_REFUSED: preserve work copy and inspect private attempt',file=__import__('sys').stderr);raise SystemExit(1)
