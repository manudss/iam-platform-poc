#!/usr/bin/env python3
"""Reviewed held-UI opening only. Never clear deployment pause or automation hold.
Run through ordered-queue open-reviewed-ui-held, under both locks.
"""
import hashlib,json,os,stat,subprocess,sys,urllib.request,urllib.error
from pathlib import Path

def protected(path):
 p=Path(path)
 if not p.is_absolute() or p.is_symlink() or not p.is_file():raise ValueError('absolute protected regular file required')
 for q in [p]+list(p.parents):
  s=q.lstat()
  if stat.S_ISLNK(s.st_mode) or s.st_uid or s.st_gid or s.st_mode&0o022:raise ValueError('unprotected evidence/config ancestry')
 return p

def protected_parent(path):
 for p in [path.parent]+list(path.parent.parents):
  st=p.lstat()
  if p.is_symlink() or st.st_uid or st.st_gid or st.st_mode&0o022:raise ValueError('unprotected gate ancestry')

def read_spec(spec):
 if not isinstance(spec,dict) or set(spec)!={'path','sha256'}:raise ValueError('exact evidence path/hash required')
 p=protected(spec['path']);raw=p.read_bytes()
 if len(raw)>64*1024*1024 or hashlib.sha256(raw).hexdigest()!=spec['sha256']:raise ValueError('evidence bytes mismatch')
 return p,raw

def run(args):
 return subprocess.run(args,check=True,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=180).stdout

def status(origin,expected):
 # No redirects: each reviewed TLS host must answer itself.
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args,**kwargs):return None
 try:r=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect).open(origin+'/healthz',timeout=15);s=r.status
 except urllib.error.HTTPError as e:s=e.code
 if s!=expected:raise ValueError('public TLS health status mismatch')

def ui_document(origin):
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args,**kwargs):return None
 r=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect).open(origin+'/login',timeout=15)
 raw=r.read(2*1024*1024+1)
 if r.status!=200 or len(raw)>2*1024*1024 or 'text/html' not in r.headers.get('Content-Type','') or b'<app-root' not in raw or b'<title>Sign in</title>' not in raw:raise ValueError('expected UI login document absent')

def check_origins(origins,expected):
 for origin in origins:status(origin,expected)

def settings(manifest):
 _,raw=read_spec(manifest['opening']['env']);env={}
 for line in raw.decode().splitlines():
  if '=' in line and not line.startswith('#'):
   k,v=line.split('=',1)
   if k in env:raise ValueError('duplicate environment setting')
   env[k]=v
 if env.get('IAM_AUTOMATION_HOLD')!='1':raise ValueError('persistent hold required')
 return env

def verify(manifest,container,target,public=503):
 opening=manifest['opening'];env=settings(manifest)
 if env.get('LYAM_CONTAINER','lyam')!=container:raise ValueError('container/config mismatch')
 receipt_path,raw=read_spec(opening['closed_receipt']);fields={}
 for line in raw.decode().splitlines():
  k,v=line.split('=',1)
  if k in fields:raise ValueError('duplicate closed receipt field')
  fields[k]=v
 image='ghcr.io/manudss/iam-platform-poc@'+target['digest']
 if any(fields.get(k)!=v for k,v in {'state':'CLOSED_QUALIFIED','held':'true','public_status':'503','image':image}.items()):raise ValueError('closed receipt target/state mismatch')
 # Verify installed controller/helper bindings, then exact live confinement again.
 root=protected(opening['integrity']['path']);read_spec(opening['integrity'])
 integrity=dict(line.split('=',1) for line in run(['python3',str(root),opening['env']['path']]).splitlines())
 if any(fields.get(k)!=v for k,v in integrity.items()):raise ValueError('closed integrity binding changed')
 launch,launchraw=read_spec(opening['launch_proof'])
 if str(launch)!=fields.get('launch_proof') or opening['launch_proof']['sha256']!=fields.get('launch_proof_sha256'):raise ValueError('closed launch proof mismatch')
 config=json.loads(protected(env['LYAM_CLOSED_CONFIG']).read_text())
 if config.get('image')!=image:raise ValueError('reviewed config targets another image')
 helper=protected(env['LYAM_CLOSED_IMPLEMENTATION'])
 if hashlib.sha256(helper.read_bytes()).hexdigest()!=fields.get('implementation_sha256'):raise ValueError('helper changed')
 proof=json.loads(run([str(helper),'--mode','postcheck','--proof-file',str(launch),'--image',image,'--container',container,'--env-file',opening['env']['path'],'--data-dir',env.get('LYAM_DATA_DIR','/opt/lyam/data'),'--port',env.get('LYAM_PORT','8080')]))
 if proof.get('liveVerified') is not True:raise ValueError('live confinement unknown')
 policy_path,policyraw=read_spec(opening['policy']);policy=json.loads(policyraw)
 if policy.get('requireAutomationHold') is not True:raise ValueError('held policy required')
 import importlib.util
 qualifier_path,_=read_spec(opening['qualifier'])
 if str(qualifier_path)!=env.get('LYAM_POST_UPDATE_CHECK') or str(policy_path)!='/opt/lyam/qualification.json':raise ValueError('qualification entrypoint/policy mismatch')
 inventory=config['qualificationSHA256']
 for path in [qualifier_path,qualifier_path.with_name('qualification-container.mjs'),policy_path]:
  if hashlib.sha256(protected(path).read_bytes()).hexdigest()!=inventory.get(str(path)):raise ValueError('qualification must match reviewed config inventory')
 spec=importlib.util.spec_from_file_location('held_qualifier',qualifier_path);q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
 q.policy_load(str(policy_path))
 before=json.loads(read_spec(opening['before'])[1]);after=json.loads(read_spec(opening['after'])[1]);smoke=json.loads(read_spec(opening['smoke'])[1])
 policyhash=hashlib.sha256(policyraw).hexdigest()
 if str(qualifier_path)!=env.get('LYAM_POST_UPDATE_CHECK') or str(policy_path)!='/opt/lyam/qualification.json':raise ValueError('qualification entrypoint/policy mismatch')
 if any(v.get('policyHash')!=policyhash or v.get('transportCoverage')!='TLS_EXPECTED_ORIGINS' for v in [before,after]) or after.get('image')!=image:raise ValueError('qualified policy/transport/image mismatch')
 q.exact_held_activations(before,after)
 if q.compare(before,after,policy):raise ValueError('preservation evidence changed; no automatic transform acceptance')
 if not isinstance(smoke.get('journal'),dict) or not smoke.get('ledger'):raise ValueError('smoke evidence incomplete')
 inspect=json.loads(run(['docker','inspect',container]))[0];q.closed_runtime(inspect)
 if inspect['Config']['Image']!=image or not inspect['State']['Running']:raise ValueError('held runtime mismatch')
 code="const fs=require('fs');const m=/automation hold: (\\{[^\\n]+\\})/.exec(fs.readFileSync('/data/api.log','utf8'));if(process.env.IAM_AUTOMATION_HOLD!=='1'||!m||JSON.parse(m[1]).held!==true)process.exit(1);fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
 run(['docker','exec',container,'node','-e',code])
 pause=protected(env.get('LYAM_PAUSE_FILE','/opt/lyam/UPDATE_PAUSED'))
 if public==503:
  for key,field in [('LYAM_FRONT_BARRIER_FILE','gate_sha256'),('LYAM_OPS_BARRIER_FILE','ops_sha256')]:
   p=protected(env[key])
   if hashlib.sha256(p.read_bytes()).hexdigest()!=fields.get(field):raise ValueError('gate ownership changed')
 check_origins(policy['origins'],public)
 if public==200:
  for origin in policy['origins']:ui_document(origin)
 return env,fields

def open_gates(manifest,container,target):
 env,fields=verify(manifest,container,target)
 opening=manifest['opening']; evidence=Path(opening['before']['path']).parent
 if Path(opening['before']['path']).name!='before.json':raise ValueError('exact original preservation baseline required')
 existing=set(evidence.iterdir())
 image='ghcr.io/manudss/iam-platform-poc@'+target['digest']
 run([opening['qualifier']['path'],'--phase','after','--container',container,'--image',image,'--env-file',opening['env']['path'],'--data-dir',env.get('LYAM_DATA_DIR','/opt/lyam/data'),'--backup-dir',env.get('LYAM_BACKUP_DIR','/opt/lyam/backups'),'--barrier-file',env['LYAM_FRONT_BARRIER_FILE'],'--target-image',image,'--evidence-dir',str(evidence),'--policy',opening['policy']['path'],'--require-automation-hold'])
 new=set(evidence.iterdir())-existing
 after=[p for p in new if p.name.startswith('after-')];smoke=[p for p in new if p.name.startswith('smoke-')]
 if len(after)!=1 or len(smoke)!=1:raise ValueError('fresh qualification files ambiguous')
 fresh={'before_sha256':opening['before']['sha256'],'after_sha256':hashlib.sha256(after[0].read_bytes()).hexdigest(),'smoke_sha256':hashlib.sha256(smoke[0].read_bytes()).hexdigest(),'after_path':str(after[0]),'smoke_path':str(smoke[0]),'policyHash':opening['policy']['sha256'],'image':image,'result':'qualified-held-before-opening','transportCoverage':'TLS_EXPECTED_ORIGINS'}
 verify(manifest,container,target)
 paths=[Path(env[k]) for k in ['LYAM_FRONT_BARRIER_FILE','LYAM_OPS_BARRIER_FILE']]
 if paths[0]==paths[1]:raise ValueError('gates must be distinct')
 # Retain exact bytes in crash-persistent intent before either unlink. Queue supplies it.
 for p in paths:
  p.unlink();fd=os.open(p.parent,os.O_RDONLY)
  try:os.fsync(fd)
  finally:os.close(fd)
 verify(manifest,container,target,public=200)
 return {'mode':'ui-open-automation-held','public_status':200,'automation_held':True,'pause_retained':True,'zero_writes':False,'fresh_qualification':fresh}

def verify_closed_access(manifest):
 env=settings(manifest);protected(env.get('LYAM_PAUSE_FILE','/opt/lyam/UPDATE_PAUSED'))
 _,raw=read_spec(manifest['opening']['policy']);policy=json.loads(raw)
 check_origins(policy['origins'],503)

def stop_candidate(container):
 try:run(['docker','stop',container])
 except Exception:pass

def close_gates(intent):
 # Re-arming access is not undoing visitor writes. Never restore data or boot old image.
 for entry in intent['gates']:
  p=Path(entry['path']);protected_parent(p)
  if p.is_symlink():raise ValueError('symlink gate forbidden')
  if p.exists():
   if p.read_bytes().hex()!=entry['bytes_hex']:raise ValueError('foreign gate during compensation')
   st=p.stat()
   if any(st_value!=entry.get(key,st_value) for key,st_value in [('mode',st.st_mode&0o777),('uid',st.st_uid),('gid',st.st_gid)]):raise ValueError('gate ownership/mode changed during compensation')
   continue
  fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)
  os.fchmod(fd,entry.get('mode',0o644));os.fchown(fd,entry.get('uid',os.geteuid()),entry.get('gid',os.getegid()))
  with os.fdopen(fd,'wb') as f:f.write(bytes.fromhex(entry['bytes_hex']));f.flush();os.fsync(f.fileno())
  directory=os.open(p.parent,os.O_RDONLY)
  try:os.fsync(directory)
  finally:os.close(directory)
