#!/usr/bin/env python3
"""Operator-only, fixed direct runtime + two real locks, no smoke or service start.
Captures Dolt twice on existing held server; does not change a gate or journal.
"""
import contextlib,fcntl,hashlib,importlib.util,json,os,re,signal,subprocess,secrets
from pathlib import Path

def load_fixed(binding,name,reader):
 path,raw=reader(binding)
 if path!=Path(__file__).with_name(name).absolute():raise ValueError('fixed reviewed module required')
 s=importlib.util.spec_from_file_location('held_'+name.replace('.','_'),path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def execute(spec,bindings,reader):
 if set(spec)!={'format','kind','runtime_controller','runtime','source','out','executed_source_sha256'} or spec['format']!=1 or spec['kind']!='reviewed-held-dolt-only-capture':raise ValueError('exact held capture spec required')
 runtime=load_fixed(spec['runtime_controller'],'restored-runtime-check.py',reader)
 source_path,source=reader(spec['source'])
 if source_path!=Path(__file__).with_name('qualification-container.mjs').absolute():raise ValueError('fixed Dolt source required')
 out=Path(spec['out'])
 if not re.fullmatch(r'/root/dolt-held-evidence-[a-f0-9]{16}\.json',str(out)) or out.exists():raise ValueError('fresh private bounded held output required')
 runtime.locks(bindings);before=runtime.verify(spec['runtime'],bindings)
 executed_source=("const {spawn:epochSpawn}=await import('node:child_process');const epochWatch=epochSpawn(process.execPath,['-e',\"setTimeout(()=>{try{process.kill(Number(process.argv[1]),'SIGKILL')}catch{}},150000)\",String(process.pid)],{stdio:'ignore'});epochWatch.unref();process.on('exit',()=>{try{epochWatch.kill('SIGKILL')}catch{}});\n"+source.decode())
 if hashlib.sha256(executed_source.encode()).hexdigest()!=spec['executed_source_sha256']:raise ValueError('held executed source binding differs')
 # SQL clients run in a NEW bounded cgroup, not in the app's cgroup. Only the
 # existing held network namespace is shared. No production filesystem mount.
 observed=subprocess.run(['docker','inspect',spec['runtime']['container']],text=True,capture_output=True,timeout=15)
 if observed.returncode:raise ValueError('held resource metadata unavailable')
 identity=json.loads(observed.stdout)[0];image_id=identity['Image']
 if next(int(l.split()[1]) for l in Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))<3*1024*1024:raise ValueError('held read requires 3GiB host headroom')
 rows=[]
 for _ in range(2):
  name='dolt-held-reader-'+secrets.token_hex(8)
  args=['docker','run','--name',name,'--restart','no','--user','0:0','--network','container:'+spec['runtime']['expected_container_id'],'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--oom-score-adj','1000','--memory','768m','--memory-swap','768m','--pids-limit','96','--cpus','0.5','--tmpfs','/data/dolt:rw,nosuid,nodev,noexec,size=16777216','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=67108864','--env','HOME=/tmp','--entrypoint','node',image_id,'--input-type=module','-e',executed_source,'dolt-only']
  try:
   value=subprocess.run(args,input='{"running":true}',text=True,capture_output=True,timeout=180,pass_fds=tuple(fd for _,fd in bindings.values()))
   if value.returncode:raise ValueError('held isolated Dolt read refused')
   envelope=json.loads(value.stdout)
   if set(envelope)!={'format','kind','running','dolt'} or envelope['format']!=1 or envelope['kind']!='dolt-only-tables-v3' or envelope['running'] is not True or not envelope['dolt']:raise ValueError('held Dolt envelope differs')
   rows.append(envelope)
  finally:
   cleanup=subprocess.run(['docker','rm','-f',name],text=True,capture_output=True,timeout=20)
   if cleanup.returncode:raise ValueError('held reader cleanup unverified')
 if rows[0]!=rows[1]:raise ValueError('held Dolt moving between captures')
 if runtime.verify(spec['runtime'],bindings)!=before:raise ValueError('held identity/gates changed')
 runtime.locks(bindings);reader(spec['source']);reader(spec['runtime_controller'])
 fd=os.open(out,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f:json.dump(rows[0],f,sort_keys=True);f.flush();os.fsync(f.fileno())
 return {'format':1,'kind':'held-dolt-only-capture-result','sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'source_sha256':spec['source']['sha256'],'executed_source_sha256':hashlib.sha256(executed_source.encode()).hexdigest(),'restoration_admissible':False,'effect_authority':False,'stable_double_capture':True}

def main():
 import argparse
 # Copy runner's small protected read primitive is itself hash bound before import.
 p=argparse.ArgumentParser();p.add_argument('--spec',required=True);p.add_argument('--spec-sha256',required=True);p.add_argument('--controller-sha256',required=True);p.add_argument('--reader-sha256',required=True);p.add_argument('--execute-reviewed-held-read',action='store_true');a=p.parse_args()
 path=Path(__file__).with_name('dolt-copy-capture.py').absolute()
 for pth in [path,*path.parents]:
  st=pth.lstat()
  if pth.is_symlink() or st.st_uid or st.st_gid or st.st_mode&0o022:raise ValueError('protected fixed bootstrap required')
 if hashlib.sha256(path.read_bytes()).hexdigest()!=a.reader_sha256:raise ValueError('reader binding changed')
 s=importlib.util.spec_from_file_location('capture_reader',path);r=importlib.util.module_from_spec(s);s.loader.exec_module(r)
 r.read_binding({'path':str(Path(__file__).absolute()),'sha256':a.controller_sha256});_,raw=r.read_binding({'path':a.spec,'sha256':a.spec_sha256});spec=json.loads(raw)
 if not a.execute_reviewed_held_read:raise ValueError('explicit reviewed held read required')
 raise ValueError('isolated held reader remains review-only pending real server fixture')
 def stop(signum,frame):raise TimeoutError('held read global deadline')
 prior={sig:signal.signal(sig,stop) for sig in (signal.SIGALRM,signal.SIGTERM,signal.SIGINT)};signal.alarm(600)
 try:
  with contextlib.ExitStack() as stack:
   bindings={}
   for key,path in [('journal',Path('/opt/lyam-recovery/active/deploy-queue/state.json.lock')),('updater',Path('/opt/lyam-recovery/active/.update.lock'))]:
    st=path.lstat()
    if path.is_symlink() or not path.is_file() or st.st_uid or st.st_gid or st.st_mode&0o022:raise ValueError('existing protected lock required')
    file=stack.enter_context(path.open('a'));fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB);bindings[key]=(str(path),file.fileno())
   print(json.dumps(execute(spec,bindings,r.read_binding),sort_keys=True))
 finally:
  signal.alarm(0)
  for sig,handler in prior.items():signal.signal(sig,handler)
if __name__=='__main__':
 try:main()
 except Exception:
  print('HELD_DOLT_CAPTURE_REFUSED: preserve held state, no admission',file=__import__('sys').stderr);raise SystemExit(1)
