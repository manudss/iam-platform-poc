#!/usr/bin/env python3
"""Host adapter for ordered-queue held-update-reviewed. Loaded only through a hash-bound,
root-protected path. Never lifts the update pause or the automation hold and never opens a gate
by itself: the final opening is done by reviewed-ui-held.py from the queue."""
import hashlib,json,os,re,stat,subprocess
from pathlib import Path
import importlib.util

def _protected(path):
 p=Path(path)
 if not p.is_absolute() or p.is_symlink():raise ValueError('absolute protected path required')
 for q in [p]+list(p.parents):
  s=q.lstat()
  if stat.S_ISLNK(s.st_mode) or s.st_uid or s.st_gid or s.st_mode&0o022:raise ValueError('unprotected path ancestry')
 return p

STRICT=True  # production: real root owner and root-owned non-writable ancestry (no sticky/current-uid allowance); tests set False explicitly
PROTECT=_protected  # tests replace this; production keeps the root-ownership check

def env_settings(env_path):
 env={}
 for line in PROTECT(env_path).read_text().splitlines():
  if '=' in line and not line.startswith('#'):
   k,v=line.split('=',1)
   if k in env:raise ValueError('duplicate environment setting')
   env[k]=v
 return env

KNOWN_DUP={'launcher_sha256','preflight_sha256','implementation_sha256'}
def parse_receipt(path,image):
 # Same strictness as reviewed-ui-held.receipt_fields: only the three historical helper hashes may appear,
 # exactly twice, with identical valid values. Anything else duplicated is refused.
 raw=PROTECT(path).read_bytes()
 if len(raw)>1024*1024:raise ValueError('receipt too large')
 fields={};counts={}
 for line in raw.decode().splitlines():
  k,v=line.split('=',1);counts[k]=counts.get(k,0)+1
  if k in fields:
   if k not in KNOWN_DUP or counts[k]!=2 or fields[k]!=v or not re.fullmatch(r'[0-9a-f]{64}',v):raise ValueError('duplicate closed receipt field')
  else:fields[k]=v
 if any(c>1 for c in counts.values()) and any(counts.get(k)!=2 for k in KNOWN_DUP):raise ValueError('duplicate closed receipt helper set incomplete')
 if any(fields.get(k)!=v for k,v in {'state':'CLOSED_QUALIFIED','held':'true','public_status':'503','image':image}.items()):
  raise ValueError('closed receipt is not CLOSED_QUALIFIED for the exact image')
 for k in ['gate_sha256','ops_sha256','evidence_index','evidence_index_sha256','launch_proof','launch_proof_sha256']:
  if not fields.get(k):raise ValueError('closed receipt lacks '+k)
 return fields

def fsync_path(p):
 p=Path(p);fd=os.open(p,os.O_RDONLY)
 try:os.fsync(fd)
 finally:os.close(fd)
 d=os.open(p.parent,os.O_RDONLY)
 try:os.fsync(d)
 finally:os.close(d)

def _owner_ok(uid):return uid==0 if STRICT else uid in (0,os.geteuid())
def _ancestor_ok(anc):
 a=Path(anc).lstat()
 if stat.S_ISLNK(a.st_mode) or not _owner_ok(a.st_uid):raise ValueError('gate ancestor not root-owned')
 if a.st_mode&0o022 and (STRICT or not a.st_mode&0o1000):raise ValueError('gate ancestor writable by others')
def gate_record(p):
 p=Path(p);st=p.lstat()
 if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):raise ValueError('gate must be a regular non-symlink file')
 if st.st_nlink!=1:raise ValueError('gate must have a single link')
 if not _owner_ok(st.st_uid):raise ValueError('gate owner must be root')
 for anc in [p.parent,*p.parent.parents]:_ancestor_ok(anc)
 return {'path':str(p),'bytes_hex':p.read_bytes().hex(),'mode':st.st_mode&0o777,'uid':st.st_uid,'gid':st.st_gid}

class Host:
 """env: updater env file. updater: path of the installed update.sh. receipt_dir: protected root dir."""
 def __init__(self,env_file,updater,receipt_dir,lock_file=None,run=subprocess.run,updater_sha256=None,inspect=None,step_configs=None):
  self.env_file=env_file;self.updater=updater;self.receipt_dir=Path(receipt_dir);self.run=run;self.updater_sha256=updater_sha256;self.inspect=inspect or self._docker_inspect;self.ops_record=None;self.step_gates=[];self.step_configs=step_configs;self.installed_configs=[]
  self.env=env_settings(env_file)
  self.front=Path(self.env.get('LYAM_FRONT_BARRIER_FILE','/var/lib/lyam-front-gate/MAINTENANCE'))
  self.ops=Path(self.env.get('LYAM_OPS_BARRIER_FILE',str(self.front.parent/'OPS-MAINTENANCE')))
  self.lock_file=Path(lock_file or self.env.get('LYAM_LOCK_FILE','/opt/lyam/.update.lock'))
 @staticmethod
 def _docker_inspect(container):
  out=subprocess.run(['docker','inspect','--type','container',container],check=True,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30).stdout
  items=json.loads(out)
  if len(items)!=1:raise ValueError('ambiguous container')
  return items[0]
 def check_updater(self):
  # Bind the updater BEFORE any effect: protected regular file whose bytes match the reviewed hash.
  p=PROTECT(self.updater)
  if not self.updater_sha256 or hashlib.sha256(p.read_bytes()).hexdigest()!=self.updater_sha256:raise ValueError('reviewed updater hash mismatch')
 def preflight(self,container=None,base=None):
  self.check_updater()
  if container is not None:
   if self.env.get('LYAM_CONTAINER','lyam')!=container:raise ValueError('container/config mismatch')
   c=self.inspect(container);cfg=c.get('Config',{});host=c.get('HostConfig',{})
   envs=dict(e.split('=',1) for e in cfg.get('Env',[]) if '=' in e)
   if base is not None and cfg.get('Image')!='ghcr.io/manudss/iam-platform-poc@'+base['digest']:raise ValueError('running image is not the journal base digest')
   if c.get('State',{}).get('Running') is not True:raise ValueError('start container not running')
   if host.get('RestartPolicy',{}).get('Name') not in ('no',''):raise ValueError('restart policy must be no')
   if envs.get('IAM_DEMO_SEED_MODE')!='never' or envs.get('IAM_AUTOMATION_HOLD')!='1':raise ValueError('start container must have seed never and hold 1')
   if host.get('CapDrop')!=['ALL'] or 'no-new-privileges' not in ' '.join(host.get('SecurityOpt') or []):raise ValueError('start container confinement missing')
  if self.env.get('IAM_AUTOMATION_HOLD')!='1':raise ValueError('persistent hold required')
  if self.front.exists() or self.ops.exists():raise ValueError('held state must start with both gates absent')
  if self.front==self.ops:raise ValueError('gates must be distinct')
 def plan_ops_gate(self,token):
  # Durable plan BEFORE creation: exact bytes/mode/owner. The caller persists it in the intent first.
  self.ops_token=token
  self.ops_record={'path':str(self.ops),'bytes_hex':token.encode().hex(),'mode':0o644,'uid':os.geteuid(),'gid':os.getegid()}
  return dict(self.ops_record)
 def create_ops_gate(self,token=None):
  token=self.ops_token if token is None else token
  fd=os.open(self.ops,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)
  with os.fdopen(fd,'wb') as f:
   # Independent of the process umask: the plan says 0644 and Caddy must read it.
   os.fchmod(f.fileno(),0o644);os.fchown(f.fileno(),self.ops_record['uid'],self.ops_record['gid'])
   f.write(token.encode());f.flush();os.fsync(f.fileno())
  st=os.lstat(self.ops)
  if stat.S_IMODE(st.st_mode)!=0o644 or st.st_uid!=self.ops_record['uid']:raise ValueError('OPS gate mode/owner differs from plan')
  for anc in [self.ops.parent,*self.ops.parent.parents]:
   _ancestor_ok(anc)
  d=os.open(self.ops.parent,os.O_RDONLY)
  try:os.fsync(d)
  finally:os.close(d)
 def snapshot_gates(self):
  gates=[]
  for p in [self.front,self.ops]:
   if p.is_symlink() or p.exists():gates.append(gate_record(p))
  if self.ops_record and not any(g['path']==str(self.ops) for g in gates):gates.append(dict(self.ops_record))
  return gates
 def check_continuity(self,previous=None):
  # OPS is the one global outer barrier: unchanged bytes/owner/mode through the whole chain, never re-derived.
  if self.ops_record is None:raise ValueError('OPS gate was not planned')
  cur=gate_record(self.ops)
  if any(cur[k]!=self.ops_record[k] for k in ['bytes_hex','mode','uid','gid']):raise ValueError('OPS barrier changed during the chain')
  if previous is not None:
   if previous['ops_sha256']!=hashlib.sha256(bytes.fromhex(self.ops_record['bytes_hex'])).hexdigest():raise ValueError('receipt OPS hash is not the chain OPS')
   cf=gate_record(self.front)
   if hashlib.sha256(bytes.fromhex(cf['bytes_hex'])).hexdigest()!=previous['gate_sha256']:raise ValueError('front gate changed since previous receipt')
   if self.step_gates and any(cf[k]!=self.step_gates[-1][k] for k in ['mode','uid','gid']):raise ValueError('front gate owner/mode changed between steps')
 CONFIG_VARIABLE={'image','imageID','ledgerSHA256','controllerSHA256','qualificationSHA256','implementationSHA256','manifestSHA256','offlineFileSHA256'}
 def install_step_config(self,entry,index,chain_len):
  """Per-step helper configuration, hash-bound by the reviewed manifest. The helper config frozen at the baseline names the baseline image,
  while the controller requires the exact step candidate. The manifest therefore lists, for EVERY step, a protected prebuilt config file with
  its sha256 and the expected imageID; the host verifies it, requires that ONLY the variable keys differ from the config currently installed
  (image, imageID and the SHA bindings), that image equals this step's exact digest ref, and replaces the single reviewed install path atomically.
  No free mutation: absent list means no change (legacy callers keep their old behaviour); a wrong length, path, hash or content refuses."""
  sc=self.step_configs
  if sc is None:return None
  if not isinstance(sc,dict) or set(sc)!={'install_to','steps'} or not isinstance(sc['steps'],list) or len(sc['steps'])!=chain_len:raise ValueError('step_configs must list every chain step')
  st=sc['steps'][index]
  if not isinstance(st,dict) or set(st)!={'path','sha256','imageID','manifestSHA256','offlineFileSHA256'} or not re.fullmatch(r'[0-9a-f]{64}',str(st['sha256'])) or not re.fullmatch(r'sha256:[0-9a-f]{64}',str(st['imageID'])) or not re.fullmatch(r'[0-9a-f]{64}',str(st['manifestSHA256'])) or not isinstance(st['offlineFileSHA256'],dict) or not st['offlineFileSHA256'] or not all(isinstance(k,str) and k.startswith('/') and re.fullmatch(r'[0-9a-f]{64}',str(v)) for k,v in st['offlineFileSHA256'].items()):raise ValueError('invalid step config entry')
  consumed=self.env.get('LYAM_CLOSED_CONFIG')
  if not consumed or str(Path(sc['install_to']))!=consumed:raise ValueError('install_to must be the LYAM_CLOSED_CONFIG path consumed by the helper')
  if os.environ.get('LYAM_CLOSED_CONFIG') not in (None,consumed):raise ValueError('ambient LYAM_CLOSED_CONFIG would override the reviewed config path')
  dst=PROTECT(sc['install_to']);src=PROTECT(st['path'])
  if src==dst or not src.is_file() or not dst.is_file():raise ValueError('distinct regular step config and installed config required')
  raw=src.read_bytes()
  if hashlib.sha256(raw).hexdigest()!=st['sha256']:raise ValueError('step config hash mismatch')
  new=json.loads(raw);cur=json.loads(dst.read_bytes())
  ref='ghcr.io/manudss/iam-platform-poc@'+entry['digest']
  if new.get('image')!=ref or new.get('imageID')!=st['imageID']:raise ValueError('step config does not name this exact step image')
  if new.get('manifestSHA256')!=st['manifestSHA256'] or new.get('offlineFileSHA256')!=st['offlineFileSHA256']:raise ValueError('step config manifest/offline hashes differ from the reviewed candidate bindings')
  if set(new)!=set(cur) or any(new[k]!=cur[k] for k in cur if k not in self.CONFIG_VARIABLE):raise ValueError('step config may change only image and binding keys')
  mode=stat.S_IMODE(dst.stat().st_mode);tmp=dst.with_name(dst.name+'.step-%d.tmp'%index)
  fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  try:
   with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
   os.chmod(tmp,mode)
   if os.geteuid()==0:os.chown(tmp,dst.stat().st_uid,dst.stat().st_gid)
   os.replace(tmp,dst);fsync_path(dst.parent)
  except BaseException:
   try:tmp.unlink()
   except OSError:pass
   raise
  if hashlib.sha256(dst.read_bytes()).hexdigest()!=st['sha256']:raise ValueError('installed step config differs after replace')
  rec={'step':index,'sha256':st['sha256'],'installed_to':str(dst),'image':ref};self.installed_configs.append(rec);return rec
 def closed_step(self,entry,adopt,index,lock_fd,chain_len=None):
  """adopt: (previous_fields, previous_receipt_path) or None."""
  image='ghcr.io/manudss/iam-platform-poc@'+entry['digest']
  self.check_updater();self.check_continuity(adopt[0] if adopt else None)
  if self.step_configs is not None:self.install_step_config(entry,index,chain_len)   # before the helper reads its config, after the gates/updater checks
  receipt=self.receipt_dir/('held-step-%d-%s.receipt'%(index,entry['sha']))
  if receipt.exists():raise ValueError('receipt must be fresh')
  args=['sh',self.updater,'--image',image,'--env-file',self.env_file,'--closed-recovery','--closed-receipt',str(receipt),'--inherit-lock-fd','8']
  if adopt:args+=['--adopt-front-gate-receipt',adopt[1]]
  if not isinstance(lock_fd,int) or lock_fd<3:raise ValueError('explicit caller lock fd (>=3) required')
  # The shell dup()s the caller's lock fd onto 8 (same open file description) before exec'ing the updater;
  # subprocess closes every fd not in pass_fds AFTER preexec_fn, so dup2-in-preexec cannot be used.
  r=self.run(['sh','-c','exec "$@" 8>&%d'%lock_fd,'held-step']+args,check=False,pass_fds=[lock_fd])
  if r.returncode!=10:raise RuntimeError('closed step did not return CLOSED_QUALIFIED (rc %s); no retry, no rollback'%r.returncode)
  fields=parse_receipt(receipt,image)
  for p in [receipt,fields['evidence_index'],fields['launch_proof']]:PROTECT(p);fsync_path(p)
  self.check_continuity(fields)
  self.step_gates.append(gate_record(self.front))
  return fields,str(receipt)
 @staticmethod
 def index_rows(fields):
  idx=PROTECT(fields['evidence_index'])
  raw=idx.read_bytes()
  if hashlib.sha256(raw).hexdigest()!=fields.get('evidence_index_sha256'):raise ValueError('evidence index changed since receipt')
  rows={}
  for line in raw.decode().splitlines():
   role,digest,p=line.split(' ',2)
   if role in rows or role not in {'before','after','smoke','backup-readback','bao-config','bao-policy'} or not re.fullmatch(r'[0-9a-f]{64}',digest):raise ValueError('invalid evidence index')
   rows[role]={'path':p,'sha256':digest}
  if not {'before','after','smoke','backup-readback'}<=set(rows):raise ValueError('evidence index incomplete')
  for spec in rows.values():
   ev=PROTECT(spec['path'])
   if ev.stat().st_size>64*1024*1024 or hashlib.sha256(ev.read_bytes()).hexdigest()!=spec['sha256']:raise ValueError('evidence file changed since index')
  return rows
 def opening_manifest(self,manifest,fields,receipt_path,first_fields=None):
  static=manifest.get('opening_static')
  if not isinstance(static,dict) or set(static)!={'env','integrity','policy','qualifier'}:raise ValueError('static opening bindings required')
  rows=self.index_rows(fields)
  # Preservation is judged from the state BEFORE THE FIRST STEP to the final state, not just the last step.
  rows['before']=self.index_rows(first_fields or fields)['before']
  def spec(p):return {'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
  opening=dict(static)
  opening.update(closed_receipt=spec(Path(receipt_path)),launch_proof=spec(Path(fields['launch_proof'])),before=rows['before'],after=rows['after'],smoke=rows['smoke'])
  if opening['launch_proof']['sha256']!=fields['launch_proof_sha256']:raise ValueError('launch proof changed since receipt')
  m=dict(manifest);m['opening']=opening;return m
