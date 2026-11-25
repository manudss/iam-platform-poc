#!/usr/bin/env python3
"""Capture ONLY an operator-staged work copy, never mounted recovery source.
Does not copy source, start a database/app server, migrate, or admit restoration.
The reviewed spec binds all work-tree bytes. Failures preserve private output.
"""
import hashlib,importlib.util,json,os,re,shutil,signal,subprocess,time
from pathlib import Path

def digest_tree(root):
 if not root.is_dir() or root.is_symlink():raise ValueError('real work directory required')
 rows=[];total=0
 for p in sorted(root.rglob('*')):
  s=p.lstat()
  if p.is_symlink() or not (p.is_dir() or p.is_file()) or s.st_uid or s.st_gid or s.st_mode&0o022:raise ValueError('protected regular work tree only')
  if p.is_file():
   if s.st_nlink!=1:raise ValueError('hardlinks forbidden in work copy')
   total+=s.st_size
   if total>8*1024**3 or len(rows)>=100000:raise ValueError('bounded work copy required')
   h=hashlib.sha256()
   with p.open('rb') as f:
    for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
   rows.append([str(p.relative_to(root)),s.st_size,h.hexdigest()])
 return hashlib.sha256(json.dumps(rows,separators=(',',':')).encode()).hexdigest(),total,len(rows)

def command(spec,source):
 work=Path(spec['work_dir']);scratch=Path(spec['scratch_dir'])
 if not re.fullmatch(r'/root/dolt-evidence-[a-f0-9]{16}/work',str(work)) or scratch!=work.parent/'scratch':raise ValueError('fixed isolated work and scratch paths required')
 if not re.fullmatch(r'sha256:[a-f0-9]{64}',spec['image_id']):raise ValueError('immutable local image ID required')
 if spec['dolt_version']!='2.6.1':raise ValueError('reviewed calibrated Dolt version required')
 if source.get('path')!=str(Path(__file__).with_name('qualification-container.mjs').absolute()):raise ValueError('fixed capture source required')
 return ['docker','run','--name',spec['container'],'--restart','no','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges:true','--read-only','--oom-score-adj','1000','--memory','768m','--memory-swap','768m','--pids-limit','96','--cpus','0.5','--mount','type=bind,src='+str(work)+',dst=/data/dolt,readonly','--mount','type=bind,src='+str(scratch)+',dst=/tmp','--workdir','/tmp','--entrypoint','node',spec['image_id'],'--input-type=module','-e']

def execute(spec,reader):
 if set(spec)!={'format','kind','work_dir','scratch_dir','tree_sha256','image_id','dolt_version','source','container','out'} or spec['format']!=1 or spec['kind']!='reviewed-work-copy-dolt-capture':raise ValueError('exact work capture spec required')
 if not re.fullmatch('dolt-copy-[a-f0-9]{16}',spec['container']):raise ValueError('bounded unique container name required')
 args=command(spec,spec['source']);_,raw=reader(spec['source']);work=Path(spec['work_dir']);scratch=Path(spec['scratch_dir']);out=Path(spec['out'])
 if out!=work.parent/'capture.json' or out.exists() or scratch.exists():raise ValueError('fresh capture and scratch required')
 for p in [work,*work.parents]:
  s=p.lstat()
  if p.is_symlink() or s.st_uid or s.st_gid or s.st_mode&0o022:raise ValueError('protected work ancestry required')
 if os.geteuid()!=0:raise ValueError('operator root required')
 if next(int(l.split()[1]) for l in Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))<2*1024*1024:raise ValueError('2GiB MemAvailable required')
 h,total,count=digest_tree(work)
 if h!=spec['tree_sha256'] or not count:raise ValueError('bound nonempty work copy differs')
 if shutil.disk_usage(work.parent).free<2*total+2*1024**3:raise ValueError('scratch disk headroom required')
 # Verify local immutable image and exact CLI version without mounting any data.
 version=subprocess.run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','128m','--pids-limit','32','--entrypoint','dolt',spec['image_id'],'version'],capture_output=True,text=True,timeout=30)
 if version.returncode or not re.search(r'\bdolt version 2\.6\.1\b',version.stdout):raise ValueError('actual Dolt version differs')
 scratch.mkdir(mode=0o700);result={'format':1,'kind':'work-copy-dolt-capture-attempt','completed':False,'restoration_admissible':False,'source_tree_sha256':h,'source_files':count,'source_bytes':total};failure=None
 try:
  # Python timeout kills docker CLIENT only. Finally forcibly removes this exact
  # disposable container before returning; no auto-remove obscures its outcome.
  r=subprocess.run(args+[raw.decode(),'dolt-only'],input='{"running":false}',text=True,capture_output=True,timeout=300)
  if r.returncode:raise ValueError('Dolt copy capture refused')
  envelope=json.loads(r.stdout)
  if not isinstance(envelope,dict) or set(envelope)!={'format','kind','running','dolt'} or envelope['format']!=1 or envelope['kind']!='dolt-only-tables-v3' or envelope['running'] is not False or not envelope['dolt']:raise ValueError('Dolt envelope differs')
  if digest_tree(work)[0]!=h:raise ValueError('read-only work copy changed')
  result.update(completed=True,capture_sha256=hashlib.sha256(r.stdout.encode()).hexdigest())
  fd=os.open(out,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'w') as f:json.dump(envelope,f);f.flush();os.fsync(f.fileno())
 except Exception as e:failure=e
 finally:
  cleanup=subprocess.run(['docker','rm','-f',spec['container']],text=True,capture_output=True,timeout=20)
  # A failed remove, even if container absent, remains an unverified refusal.
  result['cleanup_confirmed']=cleanup.returncode==0
  fd=os.open(work.parent/'attempt.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'w') as f:json.dump(result,f);f.flush();os.fsync(f.fileno())
 if failure or not result['cleanup_confirmed']:raise ValueError('capture refused or cleanup unverified; inspect private attempt')
 return result

def main():
 import argparse
 p=argparse.ArgumentParser();p.add_argument('--spec',required=True);p.add_argument('--spec-sha256',required=True);p.add_argument('--controller-sha256',required=True);p.add_argument('--execute-reviewed-work-copy',action='store_true');a=p.parse_args()
 path=Path(__file__).with_name('dolt-migration-evidence.py').absolute()
 # This bootstrap is not a data action. Before host use its hash must join the
 # installed inventory in the exact reviewed bundle, not merely this import.
 raise ValueError('work-copy runner remains review-only: bootstrap binding, signals and scratch quota integration pending')
if __name__=='__main__':
 try:main()
 except Exception:
  print('DOLT_COPY_CAPTURE_REFUSED: preserve work copy and inspect reviewed plan',file=__import__('sys').stderr);raise SystemExit(1)
