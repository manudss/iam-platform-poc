#!/usr/bin/env python3
"""Fixed SSH forced-command route. Install by operator only; never accepts paths.
Authorized key command should invoke this file through a narrowly allowed sudo rule.
The CI SSH key may request only lyam-status or lyam-drain.
"""
import importlib.util,os,stat,subprocess,sys
from pathlib import Path
ROOT=Path('/opt/lyam-recovery/active')

def protected(path):
 for p in [path,*path.parents]:
  s=p.lstat()
  if p.is_symlink() or s.st_uid or s.st_gid or s.st_mode&0o022:raise ValueError('unprotected deployment route')
 if not path.is_file() or path.stat().st_nlink!=1:raise ValueError('unique route file required')
 return path

def plan(command,root=ROOT):
 if command not in ('lyam-status','lyam-drain'):raise ValueError('SSH command not allowed')
 envfile=protected(root/'lyam.env');env={}
 if stat.S_IMODE(envfile.stat().st_mode)!=0o600:raise ValueError('private environment required')
 for line in envfile.read_text().splitlines():
  if not line or line.startswith('#'):continue
  k,sep,v=line.partition('=')
  if not sep or k in env:raise ValueError('ambiguous environment')
  env[k]=v
 paths=protected(root/'bin/release-paths.py')
 spec=importlib.util.spec_from_file_location('ci_paths',paths);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 expected=module.verify_operational(env,str(envfile),str(root/'deploy-queue/state.json'))
 queue=protected(Path(expected['LYAM_ORDERED_QUEUE']));updater=protected(Path(expected['LYAM_UPDATE_SCRIPT']))
 protected(root/'deploy-queue/state.json');protected(root/'.update.lock')
 return [sys.executable,str(queue),'status' if command=='lyam-status' else 'drain','--state',expected['LYAM_QUEUE_STATE'],'--pause-file',expected['LYAM_PAUSE_FILE'],'--update-lock',expected['LYAM_LOCK_FILE'],'--updater',str(updater),'--env-file',str(envfile)]

def main():
 if os.geteuid()!=0:raise ValueError('operator installed root route required')
 args=plan(os.environ.get('SSH_ORIGINAL_COMMAND',''))
 clean={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root','LANG':'C.UTF-8'}
 return subprocess.run(args,env=clean,check=False).returncode
if __name__=='__main__':
 try:sys.exit(main())
 except Exception:
  print('Deployment SSH route refused',file=sys.stderr);sys.exit(1)
