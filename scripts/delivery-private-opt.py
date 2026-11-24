#!/usr/bin/env python3
"""Disposable runner mount-namespace isolation, never repairs a shared ancestor."""
import os,sys,subprocess,tempfile,stat,json
from pathlib import Path

def mount(*args):subprocess.run(['mount',*args],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
def main():
 if os.geteuid()!=0 or os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_ENVIRONMENT')!='github-hosted':raise RuntimeError('disposable root runner required')
 # Refuse to modify mount topology unless this is already a distinct mount namespace.
 if Path('/proc/self/ns/mnt').readlink()==Path('/proc/1/ns/mnt').readlink():raise RuntimeError('private mount namespace required')
 if Path('/opt/lyam').exists() or len(sys.argv)<3 or sys.argv[1]!='--':raise RuntimeError('fixture-only command required')
 old=Path(tempfile.mkdtemp(prefix='ui-held-original-opt-',dir='/root'));mount('--bind','/opt',str(old))
 original=old.stat();mount('-t','tmpfs','-o','mode=0755,uid=0,gid=0','ui-held-private-opt','/opt')
 # Preserve installed runner tools without changing the old /opt or its children.
 for entry in old.iterdir():
  target=Path('/opt')/entry.name
  if entry.is_symlink():target.symlink_to(os.readlink(entry));continue
  if entry.is_dir():target.mkdir()
  elif entry.is_file():target.touch()
  else:raise RuntimeError('unsupported original opt entry')
  mount('--bind',str(entry),str(target))
  mount('-o','remount,bind,ro',str(target))
 st=Path('/opt').stat()
 if st.st_uid or st.st_gid or stat.S_IMODE(st.st_mode)!=0o755:raise RuntimeError('private opt mode incorrect')
 again=old.stat()
 if (again.st_uid,again.st_gid,again.st_mode)!=(original.st_uid,original.st_gid,original.st_mode):raise RuntimeError('shared original opt metadata changed')
 # Fixed numeric metadata only, no original paths, environment or contents.
 def shape(value):return {'uid':value.st_uid,'gid':value.st_gid,'mode':oct(stat.S_IMODE(value.st_mode))}
 evidence={'separateMountNamespace':True,'originalBefore':shape(original),'originalPreFixture':shape(again),'privateOpt':shape(st),'runnerToolBindsReadOnly':True,'realLyamAbsentBefore':True}
 if '--out' not in sys.argv:raise RuntimeError('explicit fixture artifact directory required')
 out=Path(sys.argv[sys.argv.index('--out')+1]);out.mkdir(parents=True,exist_ok=True)
 (out/'private-mount-isolation.json').write_text(json.dumps(evidence,indent=2))
 os.execvp(sys.argv[2],sys.argv[2:])
if __name__=='__main__':main()
