#!/usr/bin/env python3
"""Exercise the actual host-fixture entry on a disposable hosted runner only.
A synthetic idle HOLD container stands in for production observation, no app.
"""
import hashlib,json,os,shutil,subprocess,tempfile
from pathlib import Path

def run(args):return subprocess.check_output(args,text=True,stderr=subprocess.PIPE,timeout=600).strip()
def main():
 if os.geteuid()!=0 or os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_ENVIRONMENT')!='github-hosted' or Path('/opt/lyam-recovery').exists() or Path('/opt/lyam').exists():raise ValueError('hosted disposable root runner only')
 root=Path(tempfile.mkdtemp(prefix='host-path-code-',dir='/root'));prefix='host-path-held-'+os.urandom(8).hex();held=None
 source=Path(__file__).resolve().parents[1]
 names=['scripts/normal-runtime-host-fixture.py','scripts/normal-runtime-docker-fixture.py','deploy/oci/normal-runtime.py']
 image='ghcr.io/manudss/iam-platform-poc@sha256:81aeb18f91f8413d44508866ef7e06becbe4816aa2478869fbff0d33bdef0904'
 out=Path('/root/normal-host-proof-'+os.urandom(8).hex()+'.json');destination=Path('/tmp/normal-runtime-host-path-proof.json')
 try:
  for rel in names:
   p=root/rel;p.parent.mkdir(mode=0o700,parents=True,exist_ok=True);shutil.copyfile(source/rel,p);p.chmod(0o700)
  held=run(['docker','run','-d','--name',prefix,'--restart','no','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','64m','--memory-swap','64m','--pids-limit','32','--oom-score-adj','1000','-e','IAM_AUTOMATION_HOLD=1','--entrypoint','sh',image,'-c','sleep 900'])
  spec={'format':1,'kind':'reviewed-host-pre-fifo-fixture','image':image,'source_sha':'276d32d3162c940d7744eca9432e8b914976539f','files':{rel:hashlib.sha256((root/rel).read_bytes()).hexdigest() for rel in names},'out':str(out),'held_id':held}
  file=root/'spec.json';file.write_text(json.dumps(spec));file.chmod(0o600)
  run(['python3',str(root/'scripts/normal-runtime-host-fixture.py'),'--spec',str(file)])
  run(['python3',str(root/'scripts/normal-runtime-host-fixture.py'),'--spec',str(file),'--execute-reviewed-host-fixture'])
 finally:
  if out.exists():shutil.copyfile(out,destination);destination.chmod(0o644);out.unlink()
  if held:
   subprocess.run(['docker','rm','-f',held],check=False,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
  shutil.rmtree(root)
if __name__=='__main__':main()
