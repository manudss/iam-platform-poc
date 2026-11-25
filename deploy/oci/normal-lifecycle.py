#!/usr/bin/env python3
"""Shared normal launcher adapter, updater caller only. No rollback or gate opening.
Durable pre-effects record precedes FIFO. Updater draft only, boot still refused.
"""
import argparse,hashlib,importlib.util,json,os,re,sys,time,stat
from pathlib import Path

def checked_source(path,expected):
 p=Path(path)
 if not re.fullmatch('[a-f0-9]{64}',expected):raise ValueError('exact code digest required')
 for a in [p,*p.parents]:
  s=a.lstat()
  if a.is_symlink() or s.st_uid or s.st_gid or s.st_mode&0o022:raise ValueError('protected lifecycle code required')
 raw=p.read_bytes()
 if not p.is_file() or p.stat().st_nlink!=1 or hashlib.sha256(raw).hexdigest()!=expected:raise ValueError('lifecycle code binding differs')
 return p

def module():
 p=Path(__file__).with_name('normal-runtime.py');s=importlib.util.spec_from_file_location('normal_lifecycle_runtime',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def atomic_new(path,value):
 p=Path(path);raw=json.dumps(value,sort_keys=True).encode();fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
 d=os.open(p.parent,os.O_RDONLY)
 try:os.fsync(d)
 finally:os.close(d)

def config(runtime,env_path,image,container,data,port,n):
 _,raw=n.protected(runtime);c=json.loads(raw);n.validate(c)
 if c['container']!=container or c['data_dir']!=data or c['port']!=port or c['env']['path']!=env_path:raise ValueError('exact operational normal profile differs')
 if not re.fullmatch('ghcr.io/manudss/iam-platform-poc@sha256:[a-f0-9]{64}',image):raise ValueError('normal lifecycle exact digest required')
 observed=json.loads(n.call(['docker','image','inspect',image]))[0]
 if image not in observed.get('RepoDigests',[]):raise ValueError('normal target digest absent')
 sha=observed.get('Config',{}).get('Labels',{}).get('org.opencontainers.image.revision')
 if not re.fullmatch('[a-f0-9]{40}',sha or ''):raise ValueError('normal target revision required')
 # Template pins topology/security, while target image and exact current env are
 # per-update facts bound into the new attempt record before any FIFO release.
 n.protected({'path':env_path,'sha256':hashlib.sha256(Path(env_path).read_bytes()).hexdigest()})
 c.update(image=image,image_id=observed['Id'],source_sha=sha,env={'path':env_path,'sha256':hashlib.sha256(Path(env_path).read_bytes()).hexdigest()})
 n.prepare(c);return c

def pending_attempts(directory):
 for p in Path(directory).glob('normal-attempt-*.json'):
  if p.is_symlink():raise ValueError('unsafe prior attempt')
  if not Path(str(p)+'.completed').is_file():raise ValueError('prior normal attempt unresolved; operator review required')

def postcheck(c,evidence,n):
 p=Path(evidence);raw=p.read_bytes();attempt=json.loads(n.protected({'path':str(p),'sha256':hashlib.sha256(raw).hexdigest()})[1])
 effects=json.loads(n.protected({'path':str(p)+'.effects','sha256':hashlib.sha256(Path(str(p)+'.effects').read_bytes()).hexdigest()})[1])
 launched=json.loads(n.protected({'path':str(p)+'.launched','sha256':hashlib.sha256(Path(str(p)+'.launched').read_bytes()).hexdigest()})[1])
 if attempt['config']!=c or effects.get('kind')!='normal-lifecycle-effects-committed' or effects.get('attempt_sha256')!=hashlib.sha256(raw).hexdigest() or effects.get('proof')!=launched.get('proof'):raise ValueError('attempt/effects/launched binding differs')
 return n.postcheck(c,launched['proof'])

def launch(c,evidence,n):
 p=Path(evidence)
 if not p.is_absolute() or '..' in p.parts or p.exists() or p.is_symlink():raise ValueError('fresh absolute attempt evidence required')
 for parent in [p.parent,*p.parent.parents]:
  st=parent.lstat()
  if parent.is_symlink() or not parent.is_dir() or st.st_uid or st.st_gid or st.st_mode&0o022:raise ValueError('protected attempt evidence ancestry required')
 pending_attempts(p.parent)
 attempt={'format':1,'kind':'normal-lifecycle-attempt','phase':'prepared','at':time.time(),'config':c,'effects_released':False}
 atomic_new(p,attempt)
 # Separate exclusive new marker, never overwrite/retry an ambiguous attempt.
 effect_path=Path(str(p)+'.effects')
 def effects(proof):atomic_new(effect_path,{'kind':'normal-lifecycle-effects-committed','at':time.time(),'attempt_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'proof':proof})
 proof=n.launch(c,effects)
 n.postcheck(c,proof)
 atomic_new(Path(str(p)+'.launched'),{'kind':'normal-lifecycle-launched','at':time.time(),'proof':proof})
 return proof

def main():
 p=argparse.ArgumentParser();p.add_argument('command',choices=['prepare','launch','postcheck','complete']);p.add_argument('--controller-sha256',required=True);p.add_argument('--launcher-sha256',required=True);p.add_argument('--runtime',required=True);p.add_argument('--runtime-sha256',required=True);p.add_argument('--env-file',required=True);p.add_argument('--image',required=True);p.add_argument('--container',required=True);p.add_argument('--data-dir',required=True);p.add_argument('--port',type=int,required=True);p.add_argument('--update-lock',required=True);p.add_argument('--lock-fd',type=int,required=True);p.add_argument('--evidence');a=p.parse_args()
 if os.geteuid()!=0:raise ValueError('fixed installed root caller required')
 checked_source(Path(__file__).absolute(),a.controller_sha256);checked_source(Path(__file__).with_name('normal-runtime.py').absolute(),a.launcher_sha256)
 n=module();n.LOCK_FDS=(a.lock_fd,);n.LOCK_PATHS=(a.update_lock,)
 c=config({'path':a.runtime,'sha256':a.runtime_sha256},a.env_file,a.image,a.container,a.data_dir,a.port,n)
 if a.command=='prepare' and a.evidence:pending_attempts(Path(a.evidence).parent)
 if a.command in ('postcheck','complete'):
  if not a.evidence:raise ValueError('existing attempt evidence required')
  postcheck(c,a.evidence,n)
  if a.command=='complete':atomic_new(Path(a.evidence+'.completed'),{'kind':'normal-lifecycle-completed','attempt_sha256':hashlib.sha256(Path(a.evidence).read_bytes()).hexdigest(),'at':time.time()})
 if a.command=='launch':
  if not a.evidence:raise ValueError('fresh durable attempt evidence required')
  launch(c,a.evidence,n)
 print('Normal lifecycle '+a.command+' completed, no release or opening implied')
if __name__=='__main__':
 try:main()
 except Exception:
  print('Normal lifecycle refused; retain gates and attempts, no automatic restore or retry',file=sys.stderr);sys.exit(1)
