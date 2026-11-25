#!/usr/bin/env python3
"""Fail-closed host adapter for one reviewed same-image automation release.
No restore, rollback, retry or queue drain. All effect inputs are protected/hash-bound.
"""
import hashlib, importlib.util, json, os, re, stat, subprocess, time
from pathlib import Path


def read_spec(spec):
 if not isinstance(spec,dict) or set(spec)!={'path','sha256'} or not re.fullmatch('[a-f0-9]{64}',str(spec['sha256'])):raise ValueError('exact protected binding required')
 p=Path(spec['path'])
 if not p.is_absolute() or '..' in p.parts:raise ValueError('absolute binding required')
 for a in [p,*p.parents]:
  s=a.lstat()
  if a.is_symlink() or s.st_uid or s.st_gid or s.st_mode&0o022:raise ValueError('unprotected source ancestry')
 if not p.is_file() or p.stat().st_nlink!=1 or p.stat().st_size>64*1024*1024:raise ValueError('bounded regular protected file required')
 raw=p.read_bytes()
 if hashlib.sha256(raw).hexdigest()!=spec['sha256']:raise ValueError('binding changed')
 return p,raw


def run(args):
 return subprocess.run(args,check=True,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=180).stdout


def imported(path,name):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m


def verify_backlog_pair(initial,current,now=None):
 now=time.time() if now is None else now
 for evidence in (initial,current):
  if evidence.get('format')!=1 or evidence.get('kind')!='live-release-backlog' or evidence.get('inventory_complete') is not True or evidence.get('external_coverage')!='unverified':raise ValueError('bounded local inventory with explicit external gap required')
  ts=evidence.get('captured_at')
  if type(ts) not in (int,float) or not 0<=now-ts<=900:raise ValueError('fresh backlog pair required')
  rows=evidence.get('entries')
  if not isinstance(rows,list) or not rows:raise ValueError('nonempty inventory coverage required')
  for branch in rows:
   for table in branch.get('tables',[]):
    n=table.get('rows')
    if type(n) is not int or not 0<=n<100000:raise ValueError('row bound reached or invalid')
 if initial['entries']!=current['entries'] or initial.get('sha256')!=current.get('sha256'):raise ValueError('backlog changed behind gates; review and recapture required')
 return True


class Host:
 def __init__(self,manifest,lock_fd=None):
  self.lock_fd=lock_fd;self.intent=None;self.persist=None
  self.m=manifest;self.gates=[]
 def bind_intent(self,intent,persist):self.intent=intent;self.persist=persist
 def run(self,args,input_text=None):
  if self.intent is None:return run(args)
  prior=self.intent.get('child')
  if prior is not None and self.q.queue_state(prior.get('identity'))!='absent':raise ValueError('prior child alive or unknown; no additional subprocess')
  if type(self.lock_fd) is not int or self.lock_fd<3:raise ValueError('inherited updater lock required')
  # Every external child inherits the actual open lock description. A dead queue
  # cannot permit a second mutator while its Docker/qualification child survives.
  child=subprocess.Popen(args,text=True,stdin=subprocess.PIPE if input_text is not None else None,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=[self.lock_fd])
  self.active_child=child
  try:
   self.intent['child']={'identity':self.q.queue_identity(child.pid),'argv_kind':Path(args[0]).name};self.persist()
   out,err=child.communicate(input=input_text,timeout=600)
  except BaseException:
   # Never kill or retry a child of an uncertain release. Keep identity and lock.
   raise
  self.active_child=None;self.intent['child']=None;self.persist()
  if child.returncode:raise subprocess.CalledProcessError(child.returncode,args)
  return out
 def observe_held(self,container,target):
  q=imported(Path(__file__).with_name('ordered-queue.py'),'release_readonly_observer')
  result=q.observe_running(container,target)
  c=json.loads(run(['docker','inspect','--type','container',container]))[0]
  # Separate observations must refer to exactly the same immutable container/image.
  if c.get('Image')!=result['image_id'] or not c.get('State',{}).get('Running') or c.get('Config',{}).get('Image')!='ghcr.io/manudss/iam-platform-poc@'+target['digest']:raise ValueError('live runtime changed during observation')
  settings=[v for v in c.get('Config',{}).get('Env',[]) if v.split('=',1)[0]=='IAM_AUTOMATION_HOLD']
  if settings!=['IAM_AUTOMATION_HOLD=1']:raise ValueError('exact live HOLD1 required')
  return {**result,'held':True,'container_id':c['Id']}
 def preflight(self,state,manifest,container,target):
  if type(self.lock_fd) is not int or self.lock_fd<3:raise ValueError('actual updater lock fd required')
  # Deliberate WIP safety stop: evidence-shaped JSON is not qualification.
  # Remove only with an implemented/reviewed real backlog producer, coherent
  # post-gate recapture comparison, and isolated-copy execution verifier.
  raise ValueError('release implementation incomplete: real backlog/isolated-copy verification not implemented')
  self.target=target;self.container=container;self.image='ghcr.io/manudss/iam-platform-poc@'+target['digest']
  # Bind the complete installed controller set, including host boot and systemd
  # supervision, BEFORE upgrading the journal. An old format3 controller refuses4.
  expected={'ordered-queue.py','release-held.py','release-host.py','release-boot-guard.py','host-boot.sh','qualification.py','qualification-container.mjs','release-supervision.py','held-update-durable.py','reviewed-ui-held.py','release-paths.py','release-backlog.mjs','reconcile-restored-held.py','restored-held-qualification.py','normal-runtime.py'}
  bindings=manifest.get('installed')
  if not isinstance(bindings,list) or {Path(x.get('path','')).name for x in bindings}!=expected:raise ValueError('complete installed release toolchain required')
  if not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}',container):raise ValueError('bounded container name required')
  for b in bindings:
   p,_=read_spec(b)
   if p!=Path(__file__).parent/p.name:raise ValueError('fixed installed controller path required')
  self.opening=imported(Path(__file__).with_name('reviewed-ui-held.py'),'release_opening')
  self.env_path,envraw=read_spec(manifest['env']);st=self.env_path.stat()
  if stat.S_IMODE(st.st_mode)!=0o600:raise ValueError('environment mode must already be 0600')
  release=imported(Path(__file__).with_name('release-held.py'),'release_bytes')
  self.normal_raw=release.release_env_bytes(envraw)
  self.env={}
  for line in envraw.decode().splitlines():
   if line and not line.startswith('#'):
    k,v=line.split('=',1);self.env[k]=v
  paths=imported(Path(__file__).with_name('release-paths.py'),'release_operational_paths')
  paths.verify_operational(self.env,str(self.env_path),manifest['state_path'])
  normal_path,normal_raw=read_spec(manifest['normal_runtime']);self.normal_config=json.loads(normal_raw)
  normal=imported(Path(__file__).with_name('normal-runtime.py'),'release_normal_contract')
  normal.validate(self.normal_config)
  if self.normal_config['image']!=self.image or self.normal_config['source_sha']!=target['sha'] or self.normal_config['container']!=container or self.normal_config['data_dir']!=self.env['LYAM_DATA_DIR']:raise ValueError('normal runtime binding differs')
  if self.normal_config['env']!={'path':str(self.env_path),'sha256':hashlib.sha256(self.normal_raw).hexdigest()}:raise ValueError('normal env output binding differs')
  if self.env.get('LYAM_LOCK_FILE','/opt/lyam/.update.lock')!=manifest.get('update_lock_path'):raise ValueError('configured updater lock binding required')
  if self.env.get('LYAM_CONTAINER','lyam')!=container or self.env.get('IAM_DEMO_SEED_MODE')!='never':raise ValueError('container/seed setting differs')
  self.pause=Path(self.env.get('LYAM_PAUSE_FILE','/opt/lyam/UPDATE_PAUSED'))
  self.pause_path,pause_raw=read_spec(manifest['pause'])
  if self.pause_path!=self.pause:raise ValueError('pause binding mismatch')
  self.pause_raw=pause_raw
  self.policy_source,policyraw=read_spec(manifest['normal_policy']);self.policy=json.loads(policyraw)
  self.policy_path,self.prior_policy_raw=read_spec(manifest['operational_policy_before'])
  if self.env.get('LYAM_QUALIFICATION_POLICY')!=str(self.policy_path) or self.policy_source==self.policy_path:raise ValueError('explicit operational policy migration binding required')
  self.normal_policy_raw=policyraw
  if self.env.get('LYAM_POST_UPDATE_CHECK')!=str(Path(__file__).with_name('qualification.py')):raise ValueError('future updates must use exact installed qualifier')
  if self.env.get('LYAM_QUEUE_STATE')!=manifest.get('state_path'):raise ValueError('boot/queue state path must be identical')
  if self.policy.get('requireAutomationHold') is not False:raise ValueError('explicit normal qualification policy required')
  self.qualifier=imported(Path(__file__).with_name('qualification.py'),'release_qualification');self.qualifier.policy_load(self.policy_source)
  self.evidence=Path(manifest['evidence_dir'])
  for p in [self.evidence.parent,*self.evidence.parent.parents]:
   st=p.lstat()
   if p.is_symlink() or not p.is_dir() or st.st_uid or st.st_gid or st.st_mode&0o022:raise ValueError('protected evidence directory required')
  if os.path.lexists(self.evidence):raise ValueError('release preservation directory must not exist')
  # Receipt is a result of an isolated coherent copy, not an authority grant.
  _,raw=read_spec(manifest['isolated_qualification']);receipt=json.loads(raw)
  _,raw=read_spec(manifest['backlog']);backlog=json.loads(raw)
  self.backlog=backlog
  self.backlog_producer,self.backlog_source=read_spec(manifest['backlog_producer'])
  if self.backlog_producer!=Path(__file__).with_name('release-backlog.mjs'):raise ValueError('fixed installed backlog producer required')
  if backlog.get('inventory_complete') is not True or type(backlog.get('captured_at')) not in (int,float) or not 0<=time.time()-backlog['captured_at']<=900:raise ValueError('fresh real inventory required; external reconciliation remains unverified')
  required={'result':'qualified-normal-release','image':self.image,'state_fingerprint':manifest['state_fingerprint'],'env_before_sha256':manifest['env']['sha256'],'env_after_sha256':hashlib.sha256(self.normal_raw).hexdigest(),'backlog_sha256':manifest['backlog']['sha256'],'policy_sha256':manifest['normal_policy']['sha256'],'normal_runtime_sha256':manifest['normal_runtime']['sha256'],'production_credentials_used':False,'production_upstreams_used':False}
  if any(receipt.get(k)!=v for k,v in required.items()):raise ValueError('isolated copy qualification binding incomplete')
  # Coherent preservation backup captured by the operator, immutable and fresh.
  _,raw=read_spec(manifest['backup_receipt']);backup=json.loads(raw)
  if backup.get('result')!='coherent-backup' or backup.get('image')!=self.image or backup.get('state_fingerprint')!=manifest['state_fingerprint'] or not backup.get('files'):raise ValueError('coherent backup receipt required')
  if type(backup.get('captured_at')) not in (int,float) or not 0<=time.time()-backup['captured_at']<=900:raise ValueError('fresh backup capture required')
  for b in backup['files']:read_spec(b)
  for receipt in [backup,receipt]:
   if not isinstance(receipt.get('capture_evidence'),list) or not receipt['capture_evidence']:raise ValueError('bound actual capture evidence required, receipt flags insufficient')
   for b in receipt['capture_evidence']:read_spec(b)
  # Qualification effect verifier is fixed installed code, never an argv string.
  # Existing qualifier requires digest-specific verification for expected changes.
  for value in self.policy.get('transformationVerifiers',{}).values():
   path=value if isinstance(value,str) else value.get('path')
   match=[b for b in manifest.get('effect_verifiers',[]) if b.get('path')==path]
   if len(match)!=1:raise ValueError('effect verifier not bound')
   read_spec(match[0])
  self.q=imported(Path(__file__).with_name('ordered-queue.py'),'release_queue_observer');self.q.observe_running(container,target)
  c=json.loads(self.run(['docker','inspect',container]))[0]
  if c.get('HostConfig',{}).get('RestartPolicy',{}).get('Name')!='no' or c['RestartCount']!=0:raise ValueError('held container must not restart autonomously')
  if 'IAM_AUTOMATION_HOLD=1' not in c.get('Config',{}).get('Env',[]):raise ValueError('live held environment required')
  self.image_config=json.loads(self.run(['docker','image','inspect',self.image]))[0]['Config']
  self.verify_config(c,envraw,held=True)
  self.original_container={'id':c['Id'],'image':c['Image'],'created':c['Created'],'name':c['Name']}
  # Normal launch arguments are constructed, not taken from free-form manifest.
  self.front=Path(self.env.get('LYAM_FRONT_BARRIER_FILE','/var/lib/lyam-front-gate/MAINTENANCE'))
  self.ops=Path(self.env.get('LYAM_OPS_BARRIER_FILE','/var/lib/lyam-front-gate/OPS-MAINTENANCE'))
  if self.front==self.ops:raise ValueError('distinct public gates required')
  self.initial_gates=[]
  restored=state.get('format')==5
  if restored:
   for p in [self.front,self.ops]:
    spec=next((x for x in manifest.get('closed_gates',[]) if x.get('path')==str(p)),None)
    checked,raw=read_spec(spec);st=checked.stat()
    self.initial_gates.append({'path':str(p),'bytes_hex':raw.hex(),'mode':stat.S_IMODE(st.st_mode),'uid':st.st_uid,'gid':st.st_gid})
   if len(manifest.get('closed_gates',[]))!=2:raise ValueError('exact closed gate bindings required')
  elif any(os.path.lexists(p) for p in [self.front,self.ops]):raise ValueError('UI-open state requires initially absent gates')
  for p in [self.front,self.ops]:self.opening.protected_parent(p)
  self.opening.check_origins(self.policy['origins'],503 if restored else 200)
  # Runtime invocation/cgroup proof is supplied by the installed durable
  # supervisor and independently verified, never a mere manifest boolean.
  supervision=manifest.get('supervision')
  if not isinstance(supervision,dict) or set(supervision)!={'path'}:raise ValueError('supervision path required; spec binds this manifest, avoiding circular hashes')
  self.supervision=Path(supervision['path'])
  sm=imported(Path(__file__).with_name('release-supervision.py'),'release_supervisor')
  sm.verify_live(self.supervision,manifest['engagement_id'])
 def before_commit(self,intent):
  if not hasattr(self,'backlog_recapture'):raise ValueError('postgate recapture missing')
  verify_backlog_pair(self.backlog,self.backlog_recapture)
  for key in ['env','pause','normal_runtime','normal_policy','isolated_qualification','backlog','backup_receipt','backlog_producer']:
   binding=self.m[key]
   _,raw=read_spec(binding)
   if key in ('backlog','backup_receipt'):
    x=json.loads(raw)
    if not 0<=time.time()-x['captured_at']<=900:raise ValueError('capture became stale before effect commit')
  read_spec({'path':str(self.policy_path),'sha256':self.m['normal_policy']['sha256']})
  for binding in self.m['installed']+self.m.get('effect_verifiers',[]):read_spec(binding)
  sm=imported(Path(__file__).with_name('release-supervision.py'),'release_supervisor_commit');sm.verify_live(self.supervision,self.m['engagement_id'])
  c=json.loads(self.run(['docker','inspect',self.container]))[0]
  if c['Id']!=self.original_container['id'] or c['State']['Running']:raise ValueError('original held container changed before commit')
 def verify_config(self,c,envraw,held=False):
  cfg=c['Config'];hc=c['HostConfig'];image=self.image_config
  for k in ['Entrypoint','Cmd','User','WorkingDir','Healthcheck','StopSignal','Shell','Labels','ExposedPorts','Volumes','OnBuild']:
   if cfg.get(k)!=image.get(k):raise ValueError('nonstandard image config: '+k)
  expected={}
  for line in image.get('Env') or []:
   k,v=line.split('=',1);expected[k]=v
  for line in envraw.decode().splitlines():
   if line and not line.startswith('#'):
    k,v=line.split('=',1);expected[k]=v
  expected['IAM_DEMO_SEED_MODE']='never'
  observed={}
  for line in cfg.get('Env') or []:
   k,v=line.split('=',1)
   if k in observed:raise ValueError('duplicate runtime env')
   observed[k]=v
  if observed!=expected:raise ValueError('runtime environment differs')
  net=self.env.get('LYAM_DOCKER_NETWORK') or 'bridge'
  required={'NetworkMode':net,'RestartPolicy':{'Name':'no','MaximumRetryCount':0},'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true'],'PortBindings':{'8080/tcp':[{'HostIp':'127.0.0.1','HostPort':self.env.get('LYAM_PORT','8080')}]},'Binds':[self.env.get('LYAM_DATA_DIR','/opt/lyam/data')+':/data']}
  for k,v in required.items():
   if hc.get(k)!=v:raise ValueError('runtime host config differs: '+k)
  for k in ['Privileged','ReadonlyRootfs','PublishAllPorts','AutoRemove','Init','OomKillDisable']:
   if hc.get(k) not in (None,False):raise ValueError('unsupported host flag: '+k)
  for k in ['CapAdd','Dns','DnsOptions','DnsSearch','ExtraHosts','Tmpfs','Devices','DeviceRequests','Ulimits','VolumesFrom','Links','Sysctls','GroupAdd','Mounts','StorageOpt','LogConfig']:
   value=hc.get(k)
   if k=='LogConfig':
    if value not in (None,{'Type':'json-file','Config':{}}):raise ValueError('unsupported logging config')
   elif value:raise ValueError('unsupported host option: '+k)
  mounts=c.get('Mounts',[])
  if len(mounts)!=1 or any(mounts[0].get(k)!=v for k,v in {'Type':'bind','Source':self.env.get('LYAM_DATA_DIR','/opt/lyam/data'),'Destination':'/data','RW':True,'Propagation':'rprivate'}.items()):raise ValueError('exact data mount required')
  if set(c.get('NetworkSettings',{}).get('Networks',{}))!={net}:raise ValueError('exact single network required')
 def expected_state(self):return {'env_path':str(self.env_path),'env_before_sha256':self.m['env']['sha256'],'env_after_sha256':hashlib.sha256(self.normal_raw).hexdigest(),'container':self.original_container,'normal_runtime':self.m['normal_runtime'],'operational_policy_before':self.m['operational_policy_before'],'operational_policy_after_sha256':self.m['normal_policy']['sha256']}
 def plan_gates(self):
  if getattr(self,'initial_gates',[]):return self.initial_gates
  token=('lyam-reviewed-release:'+self.m['engagement_id']+':'+os.urandom(16).hex()).encode()
  self.gates=[{'path':str(p),'bytes_hex':token.hex(),'mode':0o644,'uid':0,'gid':0} for p in [self.front,self.ops]]
  return self.gates
 def close_access(self,intent):
  child=intent.get('child')
  if child is not None and (not hasattr(self,'q') or self.q.queue_state(child.get('identity'))!='absent'):raise ValueError('release child alive or unknown; access state unknown, no concurrent repair')
  self.opening.close_gates(intent)
  self.opening.check_origins(self.policy['origins'],503)
 def install_normal_env(self,intent):
  # Stop before initial preservation capture; the held app cannot run backlog.
  self.recapture_backlog()
  self.run(['docker','stop',self.container])
  args=self.qualify_args('before',self.m['env']['path']);self.run(args)
  self.install_operational_policy()
 def recapture_backlog(self):
  # Called after both access gates are proven closed, while the original app is
  # still running held. Input is the exact protected installed producer bytes.
  read_spec(self.m['backlog_producer'])
  raw=self.run(['docker','exec','-i',self.container,'node','--input-type=module'],input_text=self.backlog_source.decode()+"\nawait main();\n")
  current=json.loads(raw)
  verify_backlog_pair(self.backlog,current)
  self.backlog_recapture=current
  if self.intent is None or self.persist is None:raise ValueError('durable release intent required for recapture')
  self.intent['postgate_backlog']={'captured_at':current['captured_at'],'sha256':current['sha256'],'external_coverage':'unverified'};self.persist()
 def install_operational_policy(self):
  p,raw=read_spec(self.m['operational_policy_before'])
  if raw!=self.prior_policy_raw:raise ValueError('operational policy changed')
  st=p.stat();tmp=p.with_name('.normal-policy-'+os.urandom(8).hex())
  fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,stat.S_IMODE(st.st_mode))
  try:
   with os.fdopen(fd,'wb') as f:os.fchown(f.fileno(),st.st_uid,st.st_gid);f.write(self.normal_policy_raw);f.flush();os.fsync(f.fileno())
   read_spec(self.m['operational_policy_before']);os.replace(tmp,p);d=os.open(p.parent,os.O_RDONLY)
   try:os.fsync(d)
   finally:os.close(d)
  finally:
   if tmp.exists():tmp.unlink()
 def qualify_args(self,phase,env):
  return [str(Path(__file__).with_name('qualification.py')),'--phase',phase,'--container',self.container,'--image',self.image,'--env-file',env,'--data-dir',self.env.get('LYAM_DATA_DIR','/opt/lyam/data'),'--backup-dir',self.env.get('LYAM_BACKUP_DIR','/opt/lyam/backups'),'--barrier-file',str(self.front),'--target-image',self.image,'--evidence-dir',str(self.evidence),'--policy',str(self.policy_source)]
 def start_normal(self,intent):
  if intent.get('normal_start_committed') is not True:raise ValueError('durable effects commit required before HOLD removal')
  mod=imported(Path(__file__).with_name('release-held.py'),'release_env_install')
  intent['env_proof']=mod.install_env(self.env_path,self.m['env']['sha256']);self.persist()
  if self.env_path.read_bytes()!=self.normal_raw:raise ValueError('normal environment changed')
  c=json.loads(self.run(['docker','inspect',self.container]))[0]
  if c['Id']!=self.original_container['id'] or c['State']['Running'] or c['Config']['Image']!=self.image:raise ValueError('stopped exact held container required')
  # Preserve the stopped held container throughout every repeated prepare/probe.
  runtime_path,raw=read_spec(self.m['normal_runtime'])
  cfg=json.loads(raw)
  if cfg['image']!=self.image or cfg['container']!=self.container or cfg['env']!={'path':str(self.env_path),'sha256':hashlib.sha256(self.normal_raw).hexdigest()}:raise ValueError('exact normal launcher binding differs')
  normal=imported(Path(__file__).with_name('normal-runtime.py'),'release_normal_runtime')
  normal.LOCK_FDS=(self.lock_fd,);normal.LOCK_PATHS=(self.m['update_lock_path'],)
  normal.prepare(cfg)
  preserved=self.container+'-held-'+self.original_container['id'][:12]
  if len(preserved)>128:raise ValueError('preserved held name too long')
  intent['preserved_held']={'id':self.original_container['id'],'name':preserved};self.persist()
  self.run(['docker','rename',self.container,preserved])
  # Never restart or remove this held runtime automatically, including failure.
  def effects(proof):
   intent['effects_released']=True;intent['phase']='effects-released';intent['normal_launch']=proof
   intent['events'].append({'phase':'effects-released','at':time.time()});self.persist()
  self.normal_launch=normal.launch(cfg,effects)
  intent['normal_launch']=self.normal_launch;self.persist()
 def verify_normal_namespace(self,intent):
  normal=imported(Path(__file__).with_name('normal-runtime.py'),'release_normal_postcheck')
  normal.LOCK_FDS=(self.lock_fd,);normal.LOCK_PATHS=(self.m['update_lock_path'],)
  cfg=json.loads(read_spec(self.m['normal_runtime'])[1])
  return normal.postcheck(cfg,intent['normal_launch'])
 def verify_normal(self,intent):
  deadline=time.monotonic()+420
  code="const fs=require('fs');const lines=fs.readFileSync('/data/api.log','utf8').split('\\n').filter(l=>l.includes('automation hold: '));const m=/automation hold: (\\{[^\\n]+\\})/.exec(lines.at(-1)||'');const x=m&&JSON.parse(m[1]);if('IAM_AUTOMATION_HOLD' in process.env||!x||x.held!==false||x.settingPresent!==false)process.exit(1);Promise.all([fetch('http://127.0.0.1:3000/health'),fetch('http://127.0.0.1:8081/health')]).then(rs=>process.exit(rs.every(r=>r.ok)?0:1)).catch(()=>process.exit(1))"
  while True:
   try:self.run(['docker','exec',self.container,'node','-e',code]);break
   except subprocess.CalledProcessError:
    if time.monotonic()>=deadline:raise ValueError('normal runtime not healthy')
    time.sleep(2)
  c=json.loads(self.run(['docker','inspect',self.container]))[0]
  if c['HostConfig']['RestartPolicy']['Name']!='no' or c['RestartCount']!=0 or c['HostConfig'].get('Privileged') or c['HostConfig'].get('CapAdd') or set(c['HostConfig'].get('CapDrop') or [])!={'ALL'}:raise ValueError('normal runtime security differs')
  self.verify_normal_namespace(intent)
  observation=self.q.observe_running(self.container,self.target)
  self.run(self.qualify_args('after',str(self.env_path)))
  return {**observation,'held':False,'settingPresent':False}
 def open_access(self,intent):
  self.verify_normal_namespace(intent)
  self.opening.check_origins(self.policy['origins'],503)
  for g in intent['gates']:
   p=Path(g['path']);st=p.lstat()
   if p.is_symlink() or p.read_bytes()!=bytes.fromhex(g['bytes_hex']) or stat.S_IMODE(st.st_mode)!=g['mode'] or (st.st_uid,st.st_gid)!=(g['uid'],g['gid']):raise ValueError('gate ownership changed')
  for g in intent['gates']:
   p=Path(g['path']);p.unlink();fd=os.open(p.parent,os.O_RDONLY)
   try:os.fsync(fd)
   finally:os.close(fd)
  self.opening.check_origins(self.policy['origins'],200)
  for origin in self.policy['origins']:self.opening.ui_document(origin)
 def finish_pause(self,intent):
  if self.pause.is_symlink() or self.pause.read_bytes()!=self.pause_raw:raise ValueError('pause ownership changed')
  self.pause.unlink();fd=os.open(self.pause.parent,os.O_RDONLY)
  try:os.fsync(fd)
  finally:os.close(fd)


def rearm_host(manifest):
 # Access only. Do not run original preflight, which would reject the partially
 # changed environment; the durable gate records carry exact owned bytes.
 h=Host(manifest)
 h.policy_path,raw=read_spec(manifest['normal_policy']);h.policy=json.loads(raw)
 return h


class Finalizer:
 # Explicit operator continuation after atomic normal journal commit only.
 # No Docker start/exec, qualification mutation, environment write or gate edit.
 def __init__(self,manifest):self.m=manifest
 def verify_finalization(self,audit,pause):
  for binding in self.m['installed']:read_spec(binding)
  expected=audit['expected']
  p,raw=read_spec({'path':self.m['env']['path'],'sha256':expected['env_after_sha256']})
  if stat.S_IMODE(p.stat().st_mode)!=0o600:raise ValueError('normal environment metadata changed')
  self.pause=Path(pause)
  if str(self.pause)!=self.m['pause']['path']:raise ValueError('pause path changed')
  if os.path.lexists(self.pause):read_spec(self.m['pause'])
  for gate in audit['gates']:
   if os.path.lexists(gate['path']):raise ValueError('access gate present; explicit access review required')
  q=imported(Path(__file__).with_name('ordered-queue.py'),'release_final_observer');q.observe_running(json.loads(read_spec(self.m['normal_runtime'])[1])['container'],audit['target'])
  _,raw=read_spec(self.m['normal_policy']);policy=json.loads(raw)
  read_spec({'path':self.m['operational_policy_before']['path'],'sha256':self.m['normal_policy']['sha256']})
  opening=imported(Path(__file__).with_name('reviewed-ui-held.py'),'release_final_origins');opening.check_origins(policy['origins'],200)
  for origin in policy['origins']:opening.ui_document(origin)
 def finish_finalization(self,audit):
  if not os.path.lexists(self.pause):return
  read_spec(self.m['pause']);self.pause.unlink();d=os.open(self.pause.parent,os.O_RDONLY)
  try:os.fsync(d)
  finally:os.close(d)
