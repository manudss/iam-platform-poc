#!/usr/bin/env python3
"""Fixed current-baseline adapter draft. No CLI, no arbitrary command in spec.
Cold backup may be prepared only through the separately coordinated transaction.
No production execution is ready until isolated qualification/start/gates complete.
"""
import fcntl,hashlib,json,os,shutil,stat,subprocess,time,re,types,tarfile
from pathlib import Path
ROOT=Path('/opt/lyam-recovery/active')
GATE_ROOT=Path('/opt/lyam-recovery/front-prepared')

def protected(p,private=False):
 p=Path(p)
 if not p.is_absolute() or '..' in p.parts:raise ValueError('canonical absolute path required')
 for a in [p,*p.parents]:
  s=a.lstat()
  if a.is_symlink() or s.st_uid or s.st_gid or s.st_mode&0o022:raise ValueError('protected root-owned path required')
 if private and stat.S_IMODE(p.stat().st_mode)!=0o600:raise ValueError('private file required')
 return p

def run(args,fds=()):
 p=subprocess.run(args,capture_output=True,text=True,timeout=180,pass_fds=fds)
 if p.returncode:raise ValueError('fixed baseline command refused; retain gates and private evidence')
 return p.stdout.strip()

def inventory(source):
 source=Path(source);out={}
 for p in [source,*sorted(source.rglob('*'))]:
  st=p.lstat()
  if p.is_symlink() or not (p.is_file() or p.is_dir()) or (p.is_file() and st.st_nlink!=1):raise ValueError('cold source special file/link refused')
  name=str(p.relative_to(source.parent))
  out[name]={'size':st.st_size if p.is_file() else 0,'uid':st.st_uid,'gid':st.st_gid,'mode':stat.S_IMODE(st.st_mode),'sha256':hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None}
 return out

def verify_archive(path,expected):
 actual={}
 with tarfile.open(path,'r:gz') as t:
  for item in t:
   if not (item.isfile() or item.isdir()) or item.name in actual:raise ValueError('cold archive member refused')
   stream=t.extractfile(item) if item.isfile() else None
   actual[item.name]={'size':item.size if item.isfile() else 0,'uid':item.uid,'gid':item.gid,'mode':item.mode,'sha256':hashlib.sha256(stream.read()).hexdigest() if stream else None}
 if actual!=expected:raise ValueError('cold archive does not equal stopped source inventory')

class Host:
 def __init__(self,spec,locks):self.spec=spec;self.lock_bindings=locks
 def locks(self):
  if set(self.lock_bindings)!={'journal','updater'}:raise ValueError('two actual exclusive locks required')
  for p,fd in self.lock_bindings.values():
   a=os.fstat(fd);b=protected(p).stat()
   if (a.st_dev,a.st_ino)!=(b.st_dev,b.st_ino):raise ValueError('lock inode differs')
   with open(p,'a') as other:
    try:fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:pass
    else:raise ValueError('lock not held')
   fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 def command(self,args):return run(args,tuple(fd for p,fd in self.lock_bindings.values()))
 def inspect(self,name):return json.loads(self.command(['docker','inspect','--type','container',name]))[0]
 def read_binding(self,b,private=True):
  if set(b)!={'path','sha256'}:raise ValueError('exact file binding required')
  p=protected(b['path'],private);raw=p.read_bytes()
  if hashlib.sha256(raw).hexdigest()!=b['sha256']:raise ValueError('file changed')
  return p,raw
 def preflight(self,spec,old_raw):
  self.locks()
  if spec!=self.spec or spec['state_path']!=str(ROOT/'deploy-queue/state.json'):raise ValueError('fixed active state required')
  if spec['container']!='lyam-recovered-held-next':raise ValueError('exact current held name required')
  if hashlib.sha256(old_raw).hexdigest()!=spec['prior_journal_sha256']:raise ValueError('current journal binding differs')
  self.env_path,self.env_raw=self.read_binding(spec['env'])
  if self.env_path!=ROOT/'lyam.env':raise ValueError('fixed active env required')
  self.policy_path,self.policy_raw=self.read_binding(spec['normal_policy']);self.policy=json.loads(self.policy_raw)
  if self.policy.get('requireAutomationHold') is not False:raise ValueError('explicit normal policy required')
  self.backup=protected(ROOT/'backups')
  if stat.S_IMODE(self.backup.stat().st_mode)!=0o700:raise ValueError('private backup root required')
  for role in ['app','pg','bao']:
   expected=spec['identities'][role];observed=self.inspect(expected['name'])
   if observed['Id']!=expected['id'] or not observed['State']['Running'] or observed['RestartCount']!=expected['restart_count']:raise ValueError('current store identity moved')
   if observed['Image']!=expected['image_id']:raise ValueError('current store image moved')
  app=self.inspect(spec['container'])
  if app['Config']['Image']!='ghcr.io/manudss/iam-platform-poc@'+spec['target']['digest'] or 'IAM_AUTOMATION_HOLD=1' not in app['Config']['Env']:raise ValueError('exact held immutable image required')
  # Explicit protected source files and ownership-bound store directories.
  for b in spec['files']:self.read_binding(b,b['path'].endswith(('.env','.json','UPDATE_PAUSED','MAINTENANCE')))
  for role in ['dolt','pg','bao']:
   d=spec['stores'][role];p=Path(d['path']);st=p.lstat()
   if p.resolve(strict=True)!=p:raise ValueError('canonical source store required')
   protected(p.parent)
   if p.is_symlink() or not p.is_dir() or (st.st_uid,st.st_gid)!=(d['uid'],d['gid']) or st.st_mode&0o077:raise ValueError('private current store ownership differs')
   if ROOT not in p.parents:raise ValueError('current store outside active root')
  self.assert_initial_gates();self.verify_closed_tls()
  # Startup implementation is deliberately unavailable until isolated replay
  # validates exact backup/config, not a JSON attestation.
  raise ValueError('fixed isolated replay adapter not yet implemented; no host execution')
 def assert_initial_gates(self):
  for role in ('maintenance','operations'):
   p,raw=self.read_binding(self.spec['gates'][role])
   if not raw:raise ValueError('nonempty exact initial gates required')
 def verify_closed_tls(self):
  value=self.command(['curl','--silent','--show-error','--noproxy','*','--connect-timeout','5','--max-time','15','--resolve','lyam.dss.name:443:127.0.0.1','--output','/dev/null','--write-out','%{http_code} %{ssl_verify_result}','https://lyam.dss.name/healthz'])
  if value!='503 0':raise ValueError('closed local TLS503 not verified')
 def close_access(self):
  # Independent of the initial gate hashes and safe after partial opening.
  # Fixed paths, no spec-selected destination. No app/data compensation.
  gates=[GATE_ROOT/name for name in ('MAINTENANCE','OPS-MAINTENANCE')]
  for gate in gates:
   protected(gate.parent)
   if gate.is_symlink():raise ValueError('gate symlink refused')
   temporary=gate.with_name(gate.name+'.closing-'+str(os.getpid())+'-'+str(time.time_ns()))
   fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
   try:
    os.fchown(fd,0,0);os.fchmod(fd,0o600)
    with os.fdopen(fd,'wb') as f:f.write(b'closed-current-baseline\n');f.flush();os.fsync(f.fileno())
    os.replace(temporary,gate)
    directory=os.open(gate.parent,os.O_RDONLY)
    try:os.fsync(directory)
    finally:os.close(directory)
    protected(gate,True)
   finally:
    if temporary.exists():temporary.unlink()
  self.verify_closed_tls()
 def capture_current_baseline(self,spec):
  self.locks();self.close_access()
  if not re.fullmatch('[a-z0-9-]{1,32}',spec['engagement_id']):raise ValueError('bounded engagement id required')
  self.assert_single_writer_sources(spec,allowed_ids=[spec['identities'][r]['id'] for r in ('app','pg','bao')],require_stopped=False)
  # Conservative uncompressed budget checked before stopping any writer.
  source_bytes=sum(p.stat().st_size for r in ('dolt','pg','bao') for p in Path(spec['stores'][r]['path']).rglob('*') if p.is_file())
  if shutil.disk_usage(self.backup).free<source_bytes*3+1024**3:raise ValueError('insufficient backup/copy space before stop')
  folder=self.backup/('current-baseline-'+spec['engagement_id'])
  folder.mkdir(mode=0o700)
  checkpoints=folder/'checkpoints';checkpoints.mkdir(mode=0o700)
  for role in ['app','pg','bao']:
   expected=spec['identities'][role];observed=self.inspect(expected['id'])
   if observed['Id']!=expected['id'] or observed['Image']!=expected['image_id']:raise ValueError('writer moved before stop')
   def checkpoint(kind):
    p=checkpoints/(role+'-'+kind+'.json');fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as f:f.write(json.dumps({'role':role,'container_id':expected['id'],'phase':kind,'at':time.time()}).encode());f.flush();os.fsync(f.fileno())
    d=os.open(checkpoints,os.O_RDONLY)
    try:os.fsync(d)
    finally:os.close(d)
   checkpoint('stop-intent');self.command(['docker','stop','--time','30',expected['id']])
   state=self.inspect(expected['id'])['State']
   if state['Running'] or state.get('OOMKilled') is not False or state.get('ExitCode')!=0:raise ValueError('writer did not stop cleanly with exit0/noOOM')
   checkpoint('stopped')
  for role in ['app','pg','bao']:
   expected=spec['identities'][role];x=self.inspect(expected['id'])
   if x['Id']!=expected['id'] or x['State']['Running']:raise ValueError('all three stores must be cold')
  return self.archive_stopped_sources(spec,folder,checkpoints)

 def archive_stopped_sources(self,spec,folder,checkpoints):
  # Internal archive stage only. Caller owns physical quiescence and boot lock.
  self.locks();self.close_access()
  self.assert_single_writer_sources(spec)
  inventories={role:inventory(spec['stores'][role]['path']) for role in ('dolt','pg','bao')}
  required=sum(v['size'] for values in inventories.values() for v in values.values())*3+1024**3
  if shutil.disk_usage(self.backup).free<required:raise ValueError('insufficient backup/copy space')
  archives={}
  # Archive all store bytes while ALL writers are stopped. Do not restart app.
  for role in ['dolt','pg','bao']:
   self.assert_single_writer_sources(spec)
   source=Path(spec['stores'][role]['path']);out=folder/(role+'.tar.gz')
   self.command(['tar','-C',str(source.parent),'-czf',str(out),source.name]);out.chmod(0o600)
   self.command(['gzip','-t',str(out)]);self.command(['tar','-tzf',str(out)])
   verify_archive(out,inventories[role])
   if inventory(source)!=inventories[role]:raise ValueError('cold source changed during archive')
   with out.open('rb') as archive_file:os.fsync(archive_file.fileno())
   self.assert_single_writer_sources(spec)
   archives[role]={'path':str(out),'sha256':hashlib.sha256(out.read_bytes()).hexdigest()}
  for b in spec['files']:
   p,raw=self.read_binding(b,b['path'].endswith(('.env','.json','UPDATE_PAUSED','MAINTENANCE')));out=folder/('file-'+hashlib.sha256(str(p).encode()).hexdigest())
   fd=os.open(out,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
   with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
  self.assert_single_writer_sources(spec)
  final=folder/'capture-complete.json'
  fd=os.open(final,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'wb') as f:
   f.write(json.dumps({'kind':'cold-capture-complete','archives':archives,'stores_stopped':True,'at':time.time()},sort_keys=True).encode());f.flush();os.fsync(f.fileno())
  for directory in (checkpoints,folder,self.backup):
   fd=os.open(directory,os.O_RDONLY)
   try:os.fsync(fd)
   finally:os.close(fd)
  # Real companion readiness/unseal is part of the not-yet-implemented replay
  # adapter. Do not restart sealed Bao blindly or call arbitrary shell strings.
  return {'target':spec['target'],'coherent_three_store_backup':True,'archives':archives,'at':time.time(),'stores_stopped':True,'historical_preservation_claimed':False}
 def qualify_isolated(self,spec,baseline):
  # Caller supplies only pinned adjacent modules in installed root-owned tree.
  # Preflight is still unconditionally disabled until complete host review.
  self.locks();self.close_access()
  import importlib.util
  def load(name):
   binding=spec['code_bindings'][name];p,raw=self.read_binding(binding,False)
   if p!=Path(__file__).with_name(name):raise ValueError('fixed adjacent adapter source required')
   m=types.ModuleType(name.replace('.','_'));m.__file__=str(p);exec(compile(raw,str(p),'exec'),m.__dict__);return m
  iso=load('cold-three-store-copy.py');runtime=load('normal-runtime.py');lifecycle=load('normal-lifecycle.py');witness=load('isolated-copy-witness.py')
  runtime.LOCK_FDS=tuple(fd for p,fd in self.lock_bindings.values());runtime.LOCK_PATHS=tuple(p for p,fd in self.lock_bindings.values());runtime.lock_proof()
  copy=spec['copy'];env_binding=copy['env'];self.read_binding(env_binding)
  paths=copy['qualification_paths'];q=spec['code_bindings']['qualification.py'];self.read_binding(q,False)
  # qualification.py owns its fixed adjacent helper and JS capture.
  for name in ('isolated-capture.py','qualification-container.mjs'):self.read_binding(spec['code_bindings'][name],False)
  def command(args,raw=None):
   proc=subprocess.run(args,input=raw,capture_output=True,text=isinstance(raw,str) or raw is None,timeout=900,pass_fds=runtime.LOCK_FDS)
   if proc.returncode:raise ValueError('isolated fixed command refused; retain private evidence')
   return (proc.stdout if isinstance(proc.stdout,str) else proc.stdout.decode()).strip()
  probes=iso.Qualification(command,q['path'],q['sha256'],copy['policy_binding']['path'],env_binding['path'],paths['barrier'],paths['backup'],paths['evidence'],spec['identities']['app']['image'])
  events=Path(paths['effects_events']);events.mkdir(mode=0o700)
  def marker(event):
   self.locks();self.close_access()
   lifecycle.atomic_new(events/(str(time.time_ns())+'.json'),event)
  return iso.Isolated(command,witness,runtime,None).qualify(baseline,spec,env_binding,probes,marker,lifecycle,paths['attempt'])

 def assert_single_writer_sources(self,spec,allowed_ids=(),require_stopped=True):
  # Canonical overlap catches bind mounts of an ancestor or descendant too.
  sources=[Path(spec['stores'][r]['path']).resolve(strict=True) for r in ('dolt','pg','bao')]
  old_ids={spec['identities'][r]['id'] for r in ('app','pg','bao')}
  allowed=set(allowed_ids)
  if require_stopped and allowed & old_ids:raise ValueError('old source writers cannot be allowed')
  for role in ('app','pg','bao'):
   old=self.inspect(spec['identities'][role]['id'])
   if old['Id']!=spec['identities'][role]['id'] or old['HostConfig']['RestartPolicy']['Name']!='no' or (require_stopped and old['State']['Running']):raise ValueError('old writer state/restart differs')
  for cid in self.command(['docker','ps','-q','--no-trunc']).splitlines():
   x=self.inspect(cid)
   if x['Id']!=cid:raise ValueError('full running writer identity differs')
   for mount in x.get('Mounts',[]):
    if not mount.get('RW'):continue
    source=Path(mount['Source']).resolve(strict=True)
    overlaps=any(source==p or source in p.parents or p in source.parents for p in sources)
    if overlaps and cid not in allowed:raise ValueError('unexpected overlapping RW source writer')
  # This proves Docker exclusion only. Fixed host process/controller exclusion
  # remains a separate preflight requirement before this draft can be enabled.

 def start_normal(self,*a):raise ValueError('normal source-RW companion/app FIFO transaction not yet Docker-qualified')
 def verify_normal(self,*a):raise ValueError('normal qualification adapter not implemented')
 def open_access(self):raise ValueError('gate opening adapter not implemented')
 def finish_pause(self,*a):raise ValueError('exact pause finalization not implemented')
