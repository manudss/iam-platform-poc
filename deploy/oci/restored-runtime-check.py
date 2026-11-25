#!/usr/bin/env python3
"""Fixed direct restored held check. No historical receipt, no start/stop or smoke.
New-epoch admission building block only. Local TLS SNI is not public reachability.
"""
import hashlib,http.client,ipaddress,json,os,re,socket,ssl,stat,subprocess
from pathlib import Path
ROOT=Path('/opt/lyam-recovery/active')

def read(binding):
 if not isinstance(binding,dict) or set(binding)!={'path','sha256'} or not re.fullmatch('[a-f0-9]{64}',binding['sha256']):raise ValueError('exact protected file binding required')
 p=Path(binding['path'])
 if not p.is_absolute() or '..' in p.parts:raise ValueError('absolute binding required')
 for a in [p,*p.parents]:
  s=a.lstat()
  if a.is_symlink() or s.st_uid or s.st_gid or s.st_mode&0o022:raise ValueError('protected binding ancestry required')
 if not p.is_file() or p.stat().st_nlink!=1 or p.stat().st_size>64*1024*1024:raise ValueError('bounded unique file required')
 raw=p.read_bytes()
 if hashlib.sha256(raw).hexdigest()!=binding['sha256']:raise ValueError('bound file changed')
 return p,raw

def parse_env(raw):
 env={}
 for line in raw.decode().splitlines():
  if not line or line.startswith('#'):continue
  key,sep,value=line.partition('=')
  if not sep or not re.fullmatch('[A-Za-z_][A-Za-z0-9_]*',key) or key in env:raise ValueError('ambiguous environment')
  env[key]=value
 return env

def locks(bindings):
 import fcntl
 if set(bindings)!={'journal','updater'}:raise ValueError('both real lock bindings required')
 for path,fd in bindings.values():
  p=Path(path);a=os.fstat(fd);b=p.lstat()
  if p.is_symlink() or not stat.S_ISREG(a.st_mode) or (a.st_dev,a.st_ino)!=(b.st_dev,b.st_ino):raise ValueError('exact lock inode required')
  with p.open('a') as other:
   try:fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError:pass
   else:raise ValueError('actual exclusive caller locks required')

def tls_local(origin,address):
 from urllib.parse import urlsplit
 u=urlsplit(origin)
 if u.scheme!='https' or not re.fullmatch('[a-zA-Z0-9.-]+',u.hostname or '') or u.path or u.query or u.fragment or u.username or u.password:raise ValueError('exact HTTPS SNI origin required')
 if ipaddress.ip_address(address) not in (ipaddress.ip_address('127.0.0.1'),ipaddress.ip_address('::1')):raise ValueError('local-only compatibility mapping required')
 class Connection(http.client.HTTPSConnection):
  def connect(self):
   self.sock=socket.create_connection((address,self.port),timeout=self.timeout)
   self.sock=self._context.wrap_socket(self.sock,server_hostname=self.host)
 c=Connection(u.hostname,u.port or 443,timeout=15,context=ssl.create_default_context())
 try:
  c.request('GET','/healthz');r=c.getresponse();r.read(65537)
  if r.status!=503:raise ValueError('local TLS gate not503')
 finally:c.close()
 return {'origin':origin,'connect_address':address,'status':503,'certificate_validation':True,'coverage':'LOCAL_SNI_NOT_PUBLIC_ROUTABILITY'}

def verify(spec,lock_bindings,run=subprocess.run):
 required={'format','kind','env','config','helper','launch_proof','policy','gates','local_tls','container','target','expected_container_id'}
 if set(spec)!=required or spec['format']!=1 or spec['kind']!='restored-epoch-direct-held-check':raise ValueError('exact direct held check spec required')
 locks(lock_bindings);env_path,raw=read(spec['env']);env={}
 if env_path!=ROOT/'lyam.env' or stat.S_IMODE(env_path.stat().st_mode)!=0o600:raise ValueError('exact private active environment required')
 env=parse_env(raw)
 if env.get('IAM_AUTOMATION_HOLD')!='1' or env.get('IAM_DEMO_SEED_MODE')!='never' or env.get('LYAM_CONTAINER')!=spec['container']:raise ValueError('held active settings differ')
 config_path,_=read(spec['config']);helper,_=read(spec['helper']);proof_path,proofraw=read(spec['launch_proof']);policy_path,policyraw=read(spec['policy'])
 if config_path!=Path(env['LYAM_CLOSED_CONFIG']) or helper!=ROOT/'bin/closed-recovery-helper.py' or helper!=Path(env['LYAM_CLOSED_IMPLEMENTATION']):raise ValueError('fixed installed closed helper/config required')
 policy=json.loads(policyraw)
 if policy.get('requireAutomationHold') is not True or set(spec['local_tls'])!=set(policy.get('origins',[])) or len(spec['local_tls'])!=3:raise ValueError('all existing three SNI origins required')
 if set(spec['gates'])!={'maintenance','operations'}:raise ValueError('both gate bindings required')
 for key,envkey in [('maintenance','LYAM_FRONT_BARRIER_FILE'),('operations','LYAM_OPS_BARRIER_FILE')]:
  p,_=read(spec['gates'][key])
  if p!=Path(env[envkey]):raise ValueError('exact configured gate required')
 target=spec['target']
 if set(target)!={'sha','digest'} or not re.fullmatch('[a-f0-9]{40}',target['sha']) or not re.fullmatch('sha256:[a-f0-9]{64}',target['digest']):raise ValueError('exact target required')
 image='ghcr.io/manudss/iam-platform-poc@'+target['digest']
 proof=json.loads(proofraw)
 if proof.get('containerID')!=spec['expected_container_id'] or proof.get('image')!=image:raise ValueError('actual launch proof identity differs')
 def command(args):
  r=run(args,text=True,capture_output=True,timeout=180,pass_fds=tuple(fd for path,fd in lock_bindings.values()))
  if r.returncode:raise ValueError('direct installed held check failed')
  return r.stdout
 live=json.loads(command([str(helper),'--mode','postcheck','--proof-file',str(proof_path),'--image',image,'--container',spec['container'],'--env-file',str(env_path),'--data-dir',env['LYAM_DATA_DIR'],'--port',env.get('LYAM_PORT','8080')]))
 if live.get('liveVerified') is not True:raise ValueError('live closed confinement unknown')
 x=json.loads(command(['docker','inspect','--type','container',spec['container']]))[0]
 if x.get('Id')!=spec['expected_container_id'] or x.get('Config',{}).get('Image')!=image or not x.get('State',{}).get('Running') or x.get('RestartCount')!=0:raise ValueError('exact stable held container required')
 image_info=json.loads(command(['docker','image','inspect',image]))[0]
 if image not in image_info.get('RepoDigests',[]) or x.get('Image')!=image_info.get('Id') or image_info.get('Config',{}).get('Labels',{}).get('org.opencontainers.image.revision')!=target['sha']:raise ValueError('held image ID or source differs')
 runtime_env=x.get('Config',{}).get('Env',[]);hc=x.get('HostConfig',{})
 runtime_values={}
 for item in runtime_env:
  key,sep,value=item.partition('=')
  if not sep or key in runtime_values and runtime_values[key]!=value:raise ValueError('contradictory runtime environment')
  runtime_values[key]=value
 if any(runtime_values.get(key)!=value for key,value in env.items()):raise ValueError('runtime environment differs from active env')
 if 'IAM_AUTOMATION_HOLD=1' not in runtime_env or 'IAM_DEMO_SEED_MODE=never' not in runtime_env or hc.get('RestartPolicy',{}).get('Name')!='no' or 'ALL' not in (hc.get('CapDrop') or []) or hc.get('CapAdd') or hc.get('Privileged') or not any(v in ('no-new-privileges','no-new-privileges:true') for v in hc.get('SecurityOpt') or []):raise ValueError('held runtime powers/settings differ')
 tls=[tls_local(origin,address) for origin,address in spec['local_tls'].items()]
 for field in ('env','config','helper','launch_proof','policy'):read(spec[field])
 for value in spec['gates'].values():read(value)
 locks(lock_bindings)
 return {'kind':'direct-current-held-observation','container_id':x['Id'],'target':target,'local_tls':tls,'historical_tls_baseline_missing':True,'restoration_preservation_verified':False,'effect_authority':False}
