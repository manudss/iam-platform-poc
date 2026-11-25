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
 repo=Path(__file__).resolve().parents[1];root=Path('/root/dolt-evidence-'+os.urandom(8).hex());root.mkdir(mode=0o700);work=root/'work';work.mkdir(mode=0o700);code=root/'code';code.mkdir(mode=0o700)
 name='dolt-copy-'+os.urandom(8).hex();server='dolt-server-'+os.urandom(8).hex();out=root/'capture.json';proof={'format':1,'kind':'synthetic-dolt-copy-runner-proof','synthetic_copy_run_completed':False,'production_data_used':False,'held_path_exercised':False,'verifier_exercised':False,'source_version_established':False};destination=Path('/tmp/dolt-copy-runner-proof.json')
 try:
  started=time.monotonic()
  files=['dolt-copy-capture.py','qualification-container.mjs','dolt-migration-evidence.py','qualification-dolt-piece-storage-verifier.py']
  for file in files:
   p=code/file;shutil.copyfile(repo/'deploy/oci'/file,p);p.chmod(0o700)
  # Build an offline multidir Dolt fixture with one dirty business table.
  seed="const f=require('fs'),{execFileSync:x}=require('child_process');for(const db of ['iam','iam_meta']){const cwd='/fixture/'+db;f.mkdirSync(cwd);x('dolt',['init','--name','Fixture','--email','fixture@example.invalid'],{cwd});x('dolt',['sql','-q','CREATE TABLE fixture_rows (id INT PRIMARY KEY, note VARCHAR(20)); INSERT INTO fixture_rows VALUES (1,\\'synthetic\\')'],{cwd});}"
  run(['docker','run','--rm','--network','none','--user','0:0','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','512m','--pids-limit','64','-v',str(work)+':/fixture','--entrypoint','node',IMAGE,'-e',seed])
  # Init output is owned root, copied code reads only this synthetic tree.
  # Synthetic Dolt init may create group-writable files. Normalize ONLY this
  # generated fixture tree, never a source or operator copy.
  for p in work.rglob('*'):
   if p.is_symlink():raise ValueError('unexpected synthetic symlink')
   p.chmod(0o700 if p.is_dir() else 0o600)
  s=importlib.util.spec_from_file_location('copy_runner',code/'dolt-copy-capture.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
  tree_hash,size,count=m.digest_tree(work);image_id=json.loads(run(['docker','image','inspect',IMAGE]))[0]['Id']
  spec={'format':1,'kind':'reviewed-work-copy-dolt-capture','work_dir':str(work),'tree_sha256':tree_hash,'image_id':image_id,'dolt_version':'2.6.1','source':{'path':str(code/'qualification-container.mjs'),'sha256':hashlib.sha256((code/'qualification-container.mjs').read_bytes()).hexdigest()},'executed_source_sha256':hashlib.sha256(m.executed_source((code/'qualification-container.mjs').read_bytes()).encode()).hexdigest(),'container':name,'out':str(out)}
  path=root/'spec.json';path.write_text(json.dumps(spec));path.chmod(0o600)
  # Synthetic-only diagnostics: same command/source, no production values.
  probe=m.command(spec,spec['source'])+[m.executed_source((code/'qualification-container.mjs').read_bytes()),'dolt-only']
  debug=subprocess.run(probe,input='{"running":false}',text=True,capture_output=True,timeout=300)
  proof['synthetic_debug_exit']=debug.returncode
  if debug.returncode:print('SYNTHETIC_CAPTURE_STDERR '+debug.stderr[-8000:])
  run(['docker','rm','-f',name])
  raw=run(['python3',str(code/'dolt-copy-capture.py'),'--spec',str(path),'--spec-sha256',hashlib.sha256(path.read_bytes()).hexdigest(),'--controller-sha256',hashlib.sha256((code/'dolt-copy-capture.py').read_bytes()).hexdigest(),'--execute-reviewed-work-copy'])
  result=json.loads(raw);capture=json.loads(out.read_text())
  if not result['completed'] or not result['cleanup_confirmed'] or capture['running'] is not False or len(capture['dolt'])!=2 or any(e['evidence']!='dolt-tables-v3' for e in capture['dolt']):raise ValueError('real capture incomplete')
  proof.update(synthetic_copy_run_completed=True,ref_count=2,capture_sha256=hashlib.sha256(out.read_bytes()).hexdigest(),copy_runner_sha256=hashlib.sha256((code/'dolt-copy-capture.py').read_bytes()).hexdigest(),capture_source_sha256=spec['source']['sha256'],cleanup_confirmed=True,source_copy_bytes=size)
  # Running=true capture against a REAL disposable Dolt server, no app.
  after_work=root/'after';shutil.copytree(work,after_work)
  run(['docker','run','-d','--name',server,'--network','none','--user','0:0','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','1536m','--memory-swap','1536m','--pids-limit','128','--cpus','1','--restart','no','-v',str(after_work)+':/data/dolt','--workdir','/data/dolt','--entrypoint','dolt',IMAGE,'sql-server','--host','0.0.0.0','--port','3307','--data-dir','/data/dolt'])
  for attempt in range(30):
   ready=subprocess.run(['docker','exec',server,'dolt','--host','127.0.0.1','--port','3307','--no-tls','-u','root','--password','','--use-db=iam_meta','sql','-r','json','-q','SELECT 1'],text=True,capture_output=True,timeout=10)
   if ready.returncode==0:break
   time.sleep(1)
  else:raise ValueError('synthetic Dolt server not ready')
  ddl='CREATE TABLE workflow_piece_state (tenant VARCHAR(64) NOT NULL, scope_id VARCHAR(200) NOT NULL, state_key VARCHAR(200) NOT NULL, value_json LONGTEXT NOT NULL, PRIMARY KEY(tenant,scope_id,state_key))'
  run(['docker','exec',server,'dolt','--host','127.0.0.1','--port','3307','--no-tls','-u','root','--password','','--use-db=iam_meta','sql','-q',ddl])
  after=json.loads(run(['docker','exec','-i',server,'node','--input-type=module','-e',(code/'qualification-container.mjs').read_text(),'dolt-only'],'{"running":true}'))
  def mod(file,name):
   spec=importlib.util.spec_from_file_location(name,code/file);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
  adapter=mod('dolt-migration-evidence.py','adapter');verifier=mod('qualification-dolt-piece-storage-verifier.py','verifier')
  anchors=lambda env:[{k:row[k] for k in ('database','branch','head','root')} for row in env['dolt']]
  verdict=adapter.evaluate(capture,after,anchors(capture),anchors(after),verifier.verify)
  if not verdict['migration0003_shape_consistent_with_operator_anchor'] or verdict['restoration_admissible']:raise ValueError('synthetic migration verdict differs')
  proof.update(verifier_exercised=True,synthetic_server_capture_completed=True,synthetic_migration_shape_passed=True,anchors_in_fixture_are_self_derived=True,held_path_exercised=False)

 finally:
  # Only synthetic tree, never original or operator data. Bounded exact-name cleanup.
  subprocess.run(['docker','rm','-f',server],text=True,capture_output=True,timeout=30)
  subprocess.run(['docker','rm','-f',name],text=True,capture_output=True,timeout=30)
  proof['duration_seconds']=time.monotonic()-started
  if (root/'attempt.json').exists():proof['attempt']=json.loads((root/'attempt.json').read_text())
  destination.write_text(json.dumps(proof,indent=2));destination.chmod(0o644)
  shutil.rmtree(root)
if __name__=='__main__':main()
