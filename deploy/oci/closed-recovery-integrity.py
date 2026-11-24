#!/usr/bin/env python3
"""Verify reviewed closed-recovery code before executing any helper."""
import hashlib,json,os,pathlib,stat,sys

def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def secure(path,private=False):
 p=pathlib.Path(path)
 if p.is_symlink() or not p.is_absolute() or not p.is_file():raise ValueError('absolute regular non-symlink required')
 for q in [p]+list(p.parents):
  s=q.stat()
  if s.st_uid!=0 or s.st_gid!=0 or s.st_mode&0o022:raise ValueError('root-owned protected code ancestry required')
 if private and p.stat().st_mode&0o077:raise ValueError('private configuration required')
 return p

def root_hashes(c):
 out={}
 base=pathlib.Path(__file__).absolute().parent
 for filename in ['update.sh','closed-recovery-integrity.py','closed-recovery-call.py']:
  p=secure(str(base/filename));actual=digest(p)
  if actual!=c['controllerSHA256'][filename]:raise ValueError('controller hash differs from review')
  out['controller_'+filename.replace('.','_').replace('-','_')]=actual
 return out

def verify(envpath):
 env={}
 for line in secure(envpath,True).read_text().splitlines():
  if not line or line.startswith('#'):continue
  k,sep,v=line.partition('=')
  if not sep or k in env:raise ValueError('malformed/duplicate environment')
  env[k]=v
 c=json.loads(secure(env['LYAM_CLOSED_CONFIG'],True).read_text())
 out=root_hashes(c)
 out['config_sha256']=digest(secure(env['LYAM_CLOSED_CONFIG'],True))
 for path,expected in c['qualificationSHA256'].items():
  actual=digest(secure(path))
  if actual!=expected:raise ValueError('qualification hash differs from review')
 out['qualification_inventory_sha256']=hashlib.sha256(json.dumps(c['qualificationSHA256'],sort_keys=True).encode()).hexdigest()
 if env['LYAM_POST_UPDATE_CHECK'] not in c['qualificationSHA256']:raise ValueError('qualification entrypoint not reviewed')
 qualifier=pathlib.Path(env['LYAM_POST_UPDATE_CHECK'])
 if str(qualifier.with_name('qualification-container.mjs')) not in c['qualificationSHA256'] or '/opt/lyam/qualification.json' not in c['qualificationSHA256']:raise ValueError('qualification source and default policy must both be reviewed')

 for field,key in [('launcher_sha256','LYAM_CLOSED_LAUNCHER'),('preflight_sha256','LYAM_CLOSED_PREFLIGHT')]:
  actual=digest(secure(env[key]))
  if actual!=c['helperSHA256'][key]:raise ValueError('helper hash differs from review')
  out[field]=actual
 impl=secure(env['LYAM_CLOSED_IMPLEMENTATION'])
 out['implementation_sha256']=digest(impl)
 if out['implementation_sha256']!=c['implementationSHA256']:raise ValueError('implementation hash differs from review')
 return out
if __name__=='__main__':
 try:
  for k,v in verify(sys.argv[1]).items():print(k+'='+v)
 except Exception:print('closed integrity verification failed',file=sys.stderr);sys.exit(1)
