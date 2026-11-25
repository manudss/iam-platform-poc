#!/usr/bin/env python3
"""Read/hash cold source; stage only after separately reviewed exact plan.
Never executes Dolt, mounts source in Docker, or changes source permissions.
"""
import argparse,hashlib,json,os,re,shutil,stat,subprocess
from pathlib import Path
SOURCE=Path('/mnt/lyam-source/opt/lyam/data/dolt')

def inventory(root):
 rows=[];total=0
 for p in [root,*sorted(root.rglob('*'))]:
  st=p.lstat()
  if not(stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)) or (stat.S_ISREG(st.st_mode) and st.st_nlink!=1):raise ValueError('source links or special files refused')
  h=None;size=None
  if stat.S_ISREG(st.st_mode):
   size=st.st_size;total+=size
   if total>384*1024**2:raise ValueError('source exceeds reviewed cap')
   fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW);digest=hashlib.sha256()
   with os.fdopen(fd,'rb') as f:
    if (os.fstat(f.fileno()).st_ino,os.fstat(f.fileno()).st_dev)!=(st.st_ino,st.st_dev):raise ValueError('source inode changed')
    for chunk in iter(lambda:f.read(1024*1024),b''):digest.update(chunk)
    final=os.fstat(f.fileno())
   if (final.st_size,final.st_mtime_ns,final.st_ctime_ns)!=(st.st_size,st.st_mtime_ns,st.st_ctime_ns):raise ValueError('source changed while reading')
   h=digest.hexdigest()
  rows.append({'path':str(p.relative_to(root)),'size':size,'sha256':h,'uid':st.st_uid,'gid':st.st_gid,'mode':stat.S_IMODE(st.st_mode)})
  if len(rows)>100000:raise ValueError('source entry cap')
 return rows

def fingerprint(rows):return hashlib.sha256(json.dumps(rows,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def content(rows):return [(r['path'],r['size'],r['sha256']) for r in rows]
def private_write(path,value):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f:json.dump(value,f,sort_keys=True);f.flush();os.fsync(f.fileno())
def check_source():
 if os.geteuid()!=0:raise ValueError('operator root required')
 for p in [SOURCE,*SOURCE.parents]:
  if p.is_symlink():raise ValueError('source ancestor link')
 mount=json.loads(subprocess.run(['findmnt','-J','-T',str(SOURCE),'-o','TARGET,SOURCE,OPTIONS'],text=True,capture_output=True,check=True,timeout=10).stdout)['filesystems']
 if len(mount)!=1 or mount[0]['target']!='/mnt/lyam-source' or 'ro' not in mount[0]['options'].split(','):raise ValueError('cold read-only source mount required')
 return mount[0]
def make_plan():
 mount=check_source();rows=inventory(SOURCE)
 if rows!=inventory(SOURCE):raise ValueError('source changed between passes')
 return {'format':1,'kind':'cold-dolt-source-stage-plan','source':str(SOURCE),'mount':mount,'source_inventory_sha256':fingerprint(rows),'source_files':sum(r['size'] is not None for r in rows),'source_directories':sum(r['size'] is None for r in rows),'source_bytes':sum(r['size'] or 0 for r in rows),'inventory':rows,'source_clean_exit_proven':False}
def stage(plan,root):
 root=Path(root)
 if not re.fullmatch(r'/root/dolt-evidence-[a-f0-9]{16}',str(root)) or root.exists():raise ValueError('fresh protected stage root required')
 current=make_plan()
 if current!=plan:raise ValueError('reviewed source plan differs')
 if shutil.disk_usage('/root').free<2*plan['source_bytes']+2*1024**3:raise ValueError('stage disk headroom required')
 root.mkdir(mode=0o700);incoming=root/'incoming'
 # copy2 never creates hardlinks; symlinks preserved then refused, not followed.
 # Immutable ro mount plus before/after byte inventories protects this boundary.
 try:
  shutil.copytree(SOURCE,incoming,symlinks=True,copy_function=shutil.copy2)
  staged=inventory(incoming)
  if inventory(SOURCE)!=plan['inventory'] or content(staged)!=content(plan['inventory']):raise ValueError('source/incoming integrity differs')
  report={'format':1,'kind':'cold-dolt-stage-result','source_inventory_sha256':fingerprint(plan['inventory']),'incoming_inventory_sha256':fingerprint(staged),'source_unchanged':True,'source_incoming_bytes_equal':True,'source_bytes':plan['source_bytes'],'source_files':plan['source_files'],'source_clean_exit_proven':False,'restoration_admissible':False}
  private_write(root/'stage.json',report);return report
 except Exception:
  private_write(root/'stage-refused.json',{'kind':'cold-stage-refused','keep_partial_private':True,'source_not_modified_by_controller':True});raise

def main():
 p=argparse.ArgumentParser();p.add_argument('--controller-sha256',required=True);p.add_argument('--plan-out');p.add_argument('--plan');p.add_argument('--plan-sha256');p.add_argument('--stage-root');p.add_argument('--execute-reviewed-stage',action='store_true');a=p.parse_args()
 self_path=Path(__file__).resolve()
 for parent in [self_path,*self_path.parents]:
  st=parent.lstat()
  if parent.is_symlink() or st.st_uid or st.st_gid or st.st_mode&0o022:raise ValueError('protected controller ancestry required')
 if hashlib.sha256(self_path.read_bytes()).hexdigest()!=a.controller_sha256:raise ValueError('controller hash differs')
 if a.plan_out:
  if a.execute_reviewed_stage or not re.fullmatch(r'/root/dolt-source-plan-[a-f0-9]{16}\.json',a.plan_out):raise ValueError('fresh private plan output required')
  private_write(a.plan_out,make_plan());print(json.dumps({'plan':a.plan_out,'sha256':hashlib.sha256(Path(a.plan_out).read_bytes()).hexdigest(),'staged':False}));return
 if not a.execute_reviewed_stage:raise ValueError('separate reviewed plan and explicit stage required')
 path=Path(a.plan)
 if path.is_symlink() or path.stat().st_uid or path.stat().st_mode&0o077 or hashlib.sha256(path.read_bytes()).hexdigest()!=a.plan_sha256:raise ValueError('protected exact plan required')
 print(json.dumps(stage(json.loads(path.read_text()),a.stage_root)))
if __name__=='__main__':
 try:main()
 except Exception:
  print('DOLT_SOURCE_STAGE_REFUSED: keep source read-only and partial stage private',file=__import__('sys').stderr);raise SystemExit(1)
