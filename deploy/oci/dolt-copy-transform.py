#!/usr/bin/env python3
"""Replay ONLY reviewed0003DDL on NEW isolated disk copy, never app/live held.
Review-only CLI. Exact function exercised by synthetic fixture before E5 review.
"""
import hashlib,importlib.util,json,os,re,shutil,signal,subprocess,time
from pathlib import Path

def module(binding,expected,reader):
 path,raw=reader(binding)
 if path!=Path(__file__).with_name(expected).absolute():raise ValueError('fixed bound replay module required')
 spec=importlib.util.spec_from_file_location('replay_'+expected.replace('.','_'),path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

def server_source():
 # Entire mutable database is in size-limited tmpfs charged to bounded cgroup.
 return "const f=require('fs'),{spawn}=require('child_process');f.cpSync('/input','/data/dolt',{recursive:true});const child=spawn('dolt',['sql-server','--host','127.0.0.1','--port','3307','--data-dir','/data/dolt'],{cwd:'/data/dolt',stdio:'inherit'});for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>child.kill(s));child.on('exit',code=>process.exit(code??1));"

def execute(spec,reader):
 required={'format','kind','work','work_tree_sha256','root','image_id','before','before_refs','after_refs','source','copy_reader','held_reader','adapter','verifier','ddl','ddl_sha256','server_source_sha256'}
 if set(spec)!=required or spec['format']!=1 or spec['kind']!='reviewed-disposable-copy0003-replay':raise ValueError('exact replay spec required')
 if hashlib.sha256(server_source().encode()).hexdigest()!=spec['server_source_sha256']:raise ValueError('exact replay server source required')
 copy=module(spec['copy_reader'],'dolt-copy-capture.py',reader);helper=module(spec['held_reader'],'dolt-held-capture.py',reader);adapter=module(spec['adapter'],'dolt-migration-evidence.py',reader);verifier=module(spec['verifier'],'qualification-dolt-piece-storage-verifier.py',reader)
 work=Path(spec['work']);root=Path(spec['root'])
 if not re.fullmatch(r'/root/dolt-evidence-[a-f0-9]{16}/work',str(work)) or not re.fullmatch(r'/root/dolt-replay-[a-f0-9]{16}',str(root)) or root.exists():raise ValueError('new isolated replay paths required')
 for p in [work,*work.parents,root.parent]:
  st=p.lstat()
  if p.is_symlink() or st.st_uid or st.st_gid or st.st_mode&0o022:raise ValueError('protected replay ancestry required')
 h,total,count=copy.digest_tree(work)
 if h!=spec['work_tree_sha256'] or total>384*1024**2:raise ValueError('work input differs')
 if next(int(l.split()[1]) for l in Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))<4*1024*1024 or shutil.disk_usage('/root').free<2*total+2*1024**3:raise ValueError('replay headroom required')
 _,raw=reader(spec['before']);before=json.loads(raw);_,raw=reader(spec['before_refs']);before_refs=json.loads(raw);_,raw=reader(spec['after_refs']);after_refs=json.loads(raw)
 adapter.adapt(before,False,before_refs)
 source_path,source=reader(spec['source'])
 if source_path!=Path(__file__).with_name('qualification-container.mjs').absolute():raise ValueError('fixed qualification source required')
 executed=helper.executed_source(source)
 _,ddl=reader(spec['ddl'])
 if spec['ddl_sha256']!='4dc5b549d7d451cfb67ed8843f0d369c295c1196e42cc30619069eb77f29ccae' or hashlib.sha256(ddl).hexdigest()!=spec['ddl_sha256'] or not ddl.decode().startswith('CREATE TABLE IF NOT EXISTS workflow_piece_state '):raise ValueError('bound exact image DDL required')
 if not re.fullmatch(r'sha256:[a-f0-9]{64}',spec['image_id']):raise ValueError('immutable local image required')
 existing=subprocess.run(['docker','ps','-a','--format','{{.Names}}'],capture_output=True,text=True,timeout=15)
 server_name='dolt-replay-'+root.name.rsplit('-',1)[1]
 if existing.returncode or any(name in existing.stdout.splitlines() for name in [server_name,server_name+'-ddl']):raise ValueError('existing replay name refused')
 root.mkdir(mode=0o700);server='dolt-replay-'+root.name.rsplit('-',1)[1];outcome={'format':1,'kind':'disposable-copy0003-replay-result','completed':False,'stage':'copy','restoration_admissible':False,'live_held_observed':False,'source_clean_exit_proven':False,'input_work_tree_sha256':h,'executed_source_sha256':hashlib.sha256(executed.encode()).hexdigest(),'ddl_sha256':spec['ddl_sha256'],'server_source_sha256':hashlib.sha256(server_source().encode()).hexdigest(),'mutable_data_tmpfs_max_bytes':1073741824};failure=None;monitor=None
 def run(args,stdin=None,timeout=30):
  r=subprocess.run(args,input=stdin,text=True,capture_output=True,timeout=timeout)
  if r.returncode:raise ValueError('replay command refused')
  return r.stdout
 try:
  # Dedicated private NEW tree; never reset, checkout, commit or repair inputs.
  if copy.digest_tree(work)[0]!=h:raise ValueError('replay input integrity differs')
  outcome['stage']='server-start'
  run(['docker','run','-d','--init','--name',server,'--restart','no','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','0:0','--memory','1536m','--memory-swap','1536m','--pids-limit','96','--cpus','0.5','--oom-score-adj','1000','--env','HOME=/tmp','--env','GOMAXPROCS=2','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=67108864','--mount','type=bind,src='+str(work)+',dst=/input,readonly','--tmpfs','/data/dolt:rw,nosuid,nodev,noexec,size=1073741824,mode=0700','--workdir','/tmp','--entrypoint','node',spec['image_id'],'-e',server_source()])
  monitor=copy.ResourceMonitor(server).start();metrics=[]
  for attempt in range(30):
   r=subprocess.run(['docker','exec',server,'dolt','--host','127.0.0.1','--port','3307','--no-tls','-u','root','--password','','--use-db=iam_meta/main','sql','-r','json','-q','SELECT 1'],capture_output=True,text=True,timeout=10)
   if r.returncode==0:break
   time.sleep(1)
  else:raise ValueError('replay server readiness refused')
  # All capture modules were hash-bound above. Reuse that already-loaded copy
  # ResourceMonitor rather than helper's path import (no unbound reload).
  helper.resource_monitor=lambda name:copy.ResourceMonitor(name)
  outcome['stage']='pre-capture'
  pre=helper.capture_once(server,spec['image_id'],executed,{},metrics)
  private_write(root/'before-server.json',pre)
  if pre['dolt']!=before['dolt']:raise ValueError('server start changed cold evidence')
  # Execute ONLY pinned SQL via disposable client with no filesystem mounts.
  # No application modules, migrations CLI, hooks or effects are started.
  outcome['stage']='ddl'
  sql_client=server+'-ddl'
  try:
   run(['docker','run','--init','-i','--name',sql_client,'--restart','no','--network','container:'+server,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','256m','--memory-swap','256m','--pids-limit','64','--cpus','0.5','--env','HOME=/tmp','--env','GOMAXPROCS=2','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=16777216','--entrypoint','dolt',spec['image_id'],'--host','127.0.0.1','--port','3307','--no-tls','-u','root','--password','','--use-db=iam_meta/main','sql'],ddl.decode(),60)
  finally:run(['docker','rm','-f',sql_client],timeout=20)
  outcome['stage']='after-capture'
  after=helper.capture_once(server,spec['image_id'],executed,{},metrics)
  private_write(root/'after.json',after)
  stable=helper.capture_once(server,spec['image_id'],executed,{},metrics)
  if after!=stable:raise ValueError('replayed state not stable')
  outcome['stage']='verify-anchors-transformation'
  verdict=adapter.evaluate(before,after,before_refs,after_refs,verifier.verify)
  if copy.digest_tree(work)[0]!=h:raise ValueError('input work changed')
  outcome.update(completed=True,stage='completed',verdict=verdict,client_measurements=metrics,after_sha256=hashlib.sha256((root/'after.json').read_bytes()).hexdigest(),all_after_anchor_refs_equal=True,unchanged_work=True)
 except Exception as e:failure=e
 finally:
  prior={sig:signal.signal(sig,signal.SIG_IGN) for sig in (signal.SIGALRM,signal.SIGTERM,signal.SIGINT)}
  try:
   if monitor:outcome['server_measurement']=monitor.finish()
   try:run(['docker','rm','-f',server],timeout=20);outcome['cleanup_confirmed']=True
   except Exception:outcome['cleanup_confirmed']=False
   fd=os.open(root/'result.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
   with os.fdopen(fd,'w') as f:json.dump(outcome,f);f.flush();os.fsync(f.fileno())
  finally:
   for sig,value in prior.items():signal.signal(sig,value)
 if failure or not outcome['cleanup_confirmed']:raise ValueError('replay refused; keep private evidence')
 return outcome

def private_write(path,value):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f:json.dump(value,f);f.flush();os.fsync(f.fileno())

def bounded_execute(spec,reader):
 def stop(signum,frame):raise TimeoutError('disposable replay deadline')
 prior={sig:signal.signal(sig,stop) for sig in (signal.SIGALRM,signal.SIGTERM,signal.SIGINT)};signal.alarm(900)
 try:return execute(spec,reader)
 finally:
  signal.alarm(0)
  for sig,value in prior.items():signal.signal(sig,value)

def main():
 import argparse
 p=argparse.ArgumentParser();p.add_argument('--spec',required=True);p.add_argument('--spec-sha256',required=True);p.add_argument('--controller-sha256',required=True);p.add_argument('--reader-sha256',required=True);p.add_argument('--execute-reviewed-copy-replay',action='store_true');a=p.parse_args()
 reader_path=Path(__file__).with_name('dolt-copy-capture.py').absolute()
 for path in [reader_path,*reader_path.parents]:
  st=path.lstat()
  if path.is_symlink() or st.st_uid or st.st_gid or st.st_mode&0o022:raise ValueError('protected bootstrap required')
 if hashlib.sha256(reader_path.read_bytes()).hexdigest()!=a.reader_sha256:raise ValueError('reader bootstrap binding differs')
 bootstrap=importlib.util.spec_from_file_location('bound_bootstrap',reader_path);reader=importlib.util.module_from_spec(bootstrap);bootstrap.loader.exec_module(reader)
 reader.read_binding({'path':str(Path(__file__).absolute()),'sha256':a.controller_sha256});_,raw=reader.read_binding({'path':a.spec,'sha256':a.spec_sha256});spec=json.loads(raw)
 if not a.execute_reviewed_copy_replay:raise ValueError('explicit reviewed copy replay required')
 if spec['copy_reader']!={'path':str(reader_path),'sha256':a.reader_sha256}:raise ValueError('spec/bootstrap reader differs')
 print(json.dumps(bounded_execute(spec,reader.read_binding),sort_keys=True))
if __name__=='__main__':
 try:main()
 except Exception:
  print('DOLT_COPY_REPLAY_REFUSED: preserve private replay evidence; no retry',file=__import__('sys').stderr);raise SystemExit(1)
