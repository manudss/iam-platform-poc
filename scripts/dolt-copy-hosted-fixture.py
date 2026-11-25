#!/usr/bin/env python3
"""Real Docker/Dolt copy runner on disposable GitHub host, synthetic rows only.
No production mount, account or credentials. Never on E5.
"""
import hashlib,importlib.util,json,os,shutil,subprocess,tempfile,time
from pathlib import Path
IMAGE='ghcr.io/manudss/iam-platform-poc@sha256:81aeb18f91f8413d44508866ef7e06becbe4816aa2478869fbff0d33bdef0904'
def run(args,stdin=None):
 r=subprocess.run(args,input=stdin,text=True,capture_output=True,timeout=600)
 if r.returncode:raise ValueError('hosted Dolt fixture command refused')
 return r.stdout.strip()
def main():
 if os.geteuid()!=0 or os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_ENVIRONMENT')!='github-hosted' or Path('/opt/lyam').exists() or Path('/opt/lyam-recovery').exists():raise ValueError('disposable hosted root runner required')
 repo=Path(__file__).resolve().parents[1];root=Path('/root/dolt-evidence-'+os.urandom(8).hex());root.mkdir(mode=0o700);work=root/'work';incoming=root/'incoming';incoming.mkdir(mode=0o700);code=root/'code';code.mkdir(mode=0o700)
 name='dolt-copy-'+os.urandom(8).hex();server='dolt-server-'+os.urandom(8).hex();out=root/'capture.json';proof={'format':1,'kind':'synthetic-dolt-copy-runner-proof','synthetic_copy_run_completed':False,'production_data_used':False,'held_path_exercised':False,'verifier_exercised':False,'source_version_established':False};destination=Path('/tmp/dolt-copy-runner-proof.json')
 try:
  started=time.monotonic()
  files=['dolt-copy-capture.py','qualification-container.mjs','dolt-migration-evidence.py','qualification-dolt-piece-storage-verifier.py','dolt-held-capture.py']
  for file in files:
   p=code/file;shutil.copyfile(repo/'deploy/oci'/file,p);p.chmod(0o700)
  # Real tables, view, procedure, four refs per database. Dirty main is kept.
  seed="""const f=require('fs'),{execFileSync:x}=require('child_process');for(const db of ['iam','iam_meta']){const cwd='/fixture/'+db;f.mkdirSync(cwd);const sql=q=>x('dolt',['sql','-q',q],{cwd});x('dolt',['init','--name','Fixture','--email','fixture@example.invalid'],{cwd});sql('CREATE TABLE fixture_rows (id INT PRIMARY KEY, note LONGTEXT); CREATE TABLE fixture_extra (id INT PRIMARY KEY, n INT); CREATE VIEW fixture_view AS SELECT id FROM fixture_rows; CREATE PROCEDURE fixture_proc() SELECT 1');x('dolt',['sql'],{cwd,input:'INSERT INTO fixture_rows VALUES '+Array.from({length:1024},(_,i)=>"("+i+",'"+'x'.repeat(16384)+"')").join(',')+';'});sql('INSERT INTO fixture_extra VALUES(1,7)');x('dolt',['add','.'],{cwd});x('dolt',['commit','-m','synthetic baseline'],{cwd});for(const branch of ['personal','wf_run_1','wf_run_2'])x('dolt',['branch',branch],{cwd});sql("INSERT INTO fixture_rows VALUES(9999,'dirty synthetic')");}"""
  run(['docker','run','--rm','--network','none','--user','0:0','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','512m','--pids-limit','64','-v',str(incoming)+':/fixture','--entrypoint','node',IMAGE,'-e',seed])
  # Physical padding separately exercises copy/tmpfs, not SQL query scale.
  with (incoming/'synthetic-padding.bin').open('wb') as f:
   for _ in range(20):f.write(os.urandom(1024*1024))
  module=importlib.util.spec_from_file_location('copy_runner',code/'dolt-copy-capture.py');m=importlib.util.module_from_spec(module);module.loader.exec_module(m)
  prepared=m.prepare_work_copy(incoming,work)
  proof['work_preparation']={k:prepared[k] for k in ('incoming_unchanged','content_equal')}
  proof['work_preparation']['inventory_sha256']=hashlib.sha256((root/'preparation.json').read_bytes()).hexdigest()
  tree_hash,size,count=m.digest_tree(work);image_id=json.loads(run(['docker','image','inspect',IMAGE]))[0]['Id']
  spec={'format':1,'kind':'reviewed-work-copy-dolt-capture','work_dir':str(work),'tree_sha256':tree_hash,'image_id':image_id,'dolt_version':'2.6.1','source':{'path':str(code/'qualification-container.mjs'),'sha256':hashlib.sha256((code/'qualification-container.mjs').read_bytes()).hexdigest()},'executed_source_sha256':hashlib.sha256(m.executed_source((code/'qualification-container.mjs').read_bytes()).encode()).hexdigest(),'container':name,'out':str(out)}
  path=root/'spec.json';path.write_text(json.dumps(spec));path.chmod(0o600)
  raw=run(['python3',str(code/'dolt-copy-capture.py'),'--spec',str(path),'--spec-sha256',hashlib.sha256(path.read_bytes()).hexdigest(),'--controller-sha256',hashlib.sha256((code/'dolt-copy-capture.py').read_bytes()).hexdigest(),'--execute-reviewed-work-copy'])
  result=json.loads(raw);capture=json.loads(out.read_text())
  if not result['completed'] or not result['cleanup_confirmed'] or capture['running'] is not False or len(capture['dolt'])!=8 or any(e['evidence']!='dolt-tables-v3' for e in capture['dolt']):raise ValueError('real capture incomplete')
  proof.update(synthetic_copy_run_completed=True,ref_count=8,capture_sha256=hashlib.sha256(out.read_bytes()).hexdigest(),copy_runner_sha256=hashlib.sha256((code/'dolt-copy-capture.py').read_bytes()).hexdigest(),capture_source_sha256=spec['source']['sha256'],cleanup_confirmed=True,source_copy_bytes=size)
  # Running=true capture against a REAL disposable Dolt server, no app.
  after_work=root/'after';shutil.copytree(work,after_work)
  run(['docker','run','-d','--name',server,'--network','none','--user','0:0','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','1536m','--memory-swap','1536m','--pids-limit','128','--cpus','1','--restart','no','-v',str(after_work)+':/data/dolt','--workdir','/data/dolt','--entrypoint','dolt',IMAGE,'sql-server','--host','0.0.0.0','--port','3307','--data-dir','/data/dolt'])
  for attempt in range(30):
   ready=subprocess.run(['docker','exec',server,'dolt','--host','127.0.0.1','--port','3307','--no-tls','-u','root','--password','','--use-db=iam_meta','sql','-r','json','-q','SELECT 1'],text=True,capture_output=True,timeout=10)
   if ready.returncode==0:break
   time.sleep(1)
  else:raise ValueError('synthetic Dolt server not ready')
  # Read dist from EXACT image, never execute the application module.
  dist=run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','128m','--pids-limit','32','--entrypoint','node',image_id,'-e',"process.stdout.write(require('fs').readFileSync('/app/api/dist/workflows/store.js','utf8'))"])
  match=__import__('re').search(r"async pieceTable\(c\).*?c.query\('([^']+)'\)",dist,__import__('re').S)
  if not match:raise ValueError('exact image migration DDL not found')
  ddl=match[1]
  proof['migration_image_id']=image_id
  proof['migration_dist_sha256']=hashlib.sha256(dist.encode()).hexdigest()
  proof['migration_ddl_sha256']=hashlib.sha256(ddl.encode()).hexdigest()
  run(['docker','exec',server,'dolt','--host','127.0.0.1','--port','3307','--no-tls','-u','root','--password','','--use-db=iam_meta','sql','-q',ddl])

  def mod(file,name):
   spec=importlib.util.spec_from_file_location(name,code/file);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
  helper=mod('dolt-held-capture.py','helper')
  # Host enters ONLY disposable server netns; loopback allowed, other egress refused.
  pid=json.loads(run(['docker','inspect',server]))[0]['State']['Pid']
  for rule in [['-P','OUTPUT','DROP'],['-A','OUTPUT','-o','lo','-j','ACCEPT'],['-A','OUTPUT','-m','conntrack','--ctstate','ESTABLISHED,RELATED','-j','ACCEPT'],['-A','OUTPUT','-j','REJECT']]:run(['nsenter','-t',str(pid),'-n','iptables',*rule])
  proof['synthetic_netns_output_drop_loopback_accept']=True
  server_monitor=m.ResourceMonitor(server).start();held_measurements=[]
  capture_started=time.monotonic()
  try:after=helper.capture_once(server,image_id,helper.executed_source((code/'qualification-container.mjs').read_bytes()),{},held_measurements)
  finally:
   proof['held_helper_measurements']=held_measurements
   proof['server_capture_measurement']=server_monitor.finish()
  proof['sql_capture_duration_seconds']=time.monotonic()-capture_started
  proof['table_entries_captured']=sum(len(r['tables']) for r in after['dolt'])
  proof['rows_per_main_fixture_table']=1025
  adapter=mod('dolt-migration-evidence.py','adapter');verifier=mod('qualification-dolt-piece-storage-verifier.py','verifier')
  anchors=lambda env:[{k:row[k] for k in ('database','branch','head','root')} for row in env['dolt']]
  verdict=adapter.evaluate(capture,after,anchors(capture),anchors(after),verifier.verify)
  if not verdict['migration0003_shape_consistent_with_operator_anchor_refs_only'] or verdict['restoration_admissible']:raise ValueError('synthetic migration verdict differs')
  proof.update(verifier_exercised=True,synthetic_server_capture_completed=True,isolated_held_helper_exercised=True,synthetic_migration_shape_passed=True,anchors_in_fixture_are_self_derived=True,held_path_exercised=False)

 finally:
  # Only synthetic tree, never original or operator data. Bounded exact-name cleanup.
  subprocess.run(['docker','rm','-f',server],text=True,capture_output=True,timeout=30)
  subprocess.run(['docker','rm','-f',name],text=True,capture_output=True,timeout=30)
  proof['duration_seconds']=time.monotonic()-started
  if (root/'attempt.json').exists():proof['attempt']=json.loads((root/'attempt.json').read_text())
  destination.write_text(json.dumps(proof,indent=2));destination.chmod(0o644)
  shutil.rmtree(root)
if __name__=='__main__':main()
