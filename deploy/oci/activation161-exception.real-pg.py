import importlib.util,json,subprocess,os,copy,hashlib,tempfile
from pathlib import Path
root=Path(__file__).resolve().parent
s=importlib.util.spec_from_file_location('ex',root/'activation161-exception.py');ex=importlib.util.module_from_spec(s);s.loader.exec_module(ex)
s=importlib.util.spec_from_file_location('q',root/'qualification.py');q=importlib.util.module_from_spec(s);s.loader.exec_module(q)
env={**os.environ,'PGHOST':'127.0.0.1','PGPORT':'15449','PGUSER':'postgres','PGDATABASE':'lyam_fixture'}
def sql(text):
 r=subprocess.run(['psql','-X','-A','-t','-q','-v','ON_ERROR_STOP=1'],input=text,text=True,capture_output=True,env=env)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout
server=Path(os.environ['PG_BIN']);work=tempfile.TemporaryDirectory(prefix='activation161-pg-');data=Path(work.name)/'data'
subprocess.run([str(server/'initdb'),'-D',str(data),'-U','postgres','-A','trust'],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
subprocess.run([str(server/'pg_ctl'),'-D',str(data),'-l',str(Path(work.name)/'server.log'),'-o','-p 15449 -h 127.0.0.1','-w','start'],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
try:
 subprocess.run(['createdb','lyam_fixture'],env={**env,'PGDATABASE':'postgres'},check=True,capture_output=True)
 # Restore isolated fixture to before161, matching14 old rows.
 sql('DROP TABLE IF EXISTS activations; CREATE TABLE activations(tenant text,seq int,commit_hash text,activated_at timestamptz DEFAULT now(),state text NOT NULL DEFAULT \'recorded\',error text,request_id text); INSERT INTO activations(tenant,seq,commit_hash) SELECT \'fixture\',g,\'commit-\'||g FROM generate_series(1,14)g; CREATE TABLE IF NOT EXISTS other(id serial PRIMARY KEY,v text);')
 q.query=lambda p,text:json.loads(sql(text))
 pgbefore=q.postgres({});before={'image':'old','policyHash':'policy','postgres':pgbefore,'dolt':[1],'bao':{'a':'b'},'credentials':{'c':'d'}}
 sql('ALTER TABLE activations ADD COLUMN actor_id text;ALTER TABLE activations ADD COLUMN actor_kind text;ALTER TABLE activations ADD COLUMN applied_at timestamptz;')
 c=json.loads(sql((root/'activation161-capture.sql').read_text()));after={**before,'image':ex.IMAGE,'postgres':c['postgres']}
 r=object.__new__(ex.ExceptionRun);r.capture_value=c;r.manifest={'policy_sha256':'policy'};r.policy={'appendOnlyTables':['public.activations'],'pgDatabase':'lyam_fixture'};r.recheck=lambda:True
 assert r.verify(before,after,q.compare)
 # Readonly mutation must break SQL, not succeed silently.
 mutated=(root/'activation161-capture.sql').read_text().replace(" IF current_setting", " UPDATE public.activations SET commit_hash='forbidden';\n IF current_setting",1)
 try:sql(mutated);raise AssertionError('read-only write unexpectedly succeeded')
 except RuntimeError as e:assert 'read-only' in str(e)
 # Missing read-only must fail the explicit transaction assertion.
 mutated=(root/'activation161-capture.sql').read_text().replace('REPEATABLE READ READ ONLY','REPEATABLE READ READ WRITE')
 try:sql(mutated);raise AssertionError('read-write capture unexpectedly accepted')
 except RuntimeError as e:assert 'required read-only' in str(e)
 print(json.dumps({'postgres':'17.12','realCaptureAndVerifier':True,'rows':14,'database':'lyam_fixture','snapshot':c['transaction'],'readonlyMutationRefused':True,'readwriteModeRefused':True,'nonTargetSequenceChecksRetained':True}))
finally:
 subprocess.run([str(server/'pg_ctl'),'-D',str(data),'-w','stop'],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 work.cleanup()
