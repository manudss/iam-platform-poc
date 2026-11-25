#!/usr/bin/env python3
"""Disposable real 3-store normal lifecycle, two starts, no production.
Same image twice tests lifecycle mechanics, not new-SHA queue/update.sh yet.
"""
import fcntl,hashlib,importlib.util,json,os,secrets,shutil,signal,subprocess,time
from pathlib import Path
IMAGE='ghcr.io/manudss/iam-platform-poc@sha256:81aeb18f91f8413d44508866ef7e06becbe4816aa2478869fbff0d33bdef0904'
SHA='276d32d3162c940d7744eca9432e8b914976539f'
def run(args,input=None,timeout=300):
 r=subprocess.run(args,input=input,text=True,capture_output=True,timeout=timeout)
 if r.returncode:raise ValueError('fixture command refused')
 return r.stdout.strip()
def main():
 if os.geteuid()!=0 or os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_ENVIRONMENT')!='github-hosted' or Path('/opt/lyam').exists() or Path('/opt/lyam-recovery').exists():raise ValueError('disposable runner only')
 repo=Path(__file__).resolve().parents[1];root=Path('/root/normal-real-'+secrets.token_hex(8));root.mkdir(mode=0o700);prefix=root.name;owned=[];nets=[];result={'kind':'synthetic-three-store-normal-lifecycle','production_data_used':False,'passed':False,'stage':'setup','same_image_twice':True,'update_shell_exercised':False,'queue_exercised':False,'boot_exercised':False}
 def docker(*args):return run(['docker',*args])
 def wait(name,port,path):
  for _ in range(100):
   r=subprocess.run(['docker','exec',name,'node','-e',"fetch('http://127.0.0.1:"+str(port)+path+"').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],capture_output=True,timeout=10)
   if r.returncode==0:return
   state=json.loads(docker('inspect',name))[0]['State']
   if not state['Running']:raise ValueError('synthetic app died')
   time.sleep(2)
  raise ValueError('synthetic health timeout')
 try:
  for image in [IMAGE,'postgres@sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73','openbao/openbao@sha256:71156a1c6623a5fa3f5e61b0c6a8ead0faf0df29a778339188443551995d1315']:docker('pull',image)
  ids={}
  for role,subnet in [('backend','172.27.0.0/24'),('frontend','172.28.0.0/24')]:
   name=prefix+'-'+role;args=['network','create','--subnet',subnet,'--gateway',subnet.split('/')[0].rsplit('.',1)[0]+'.1']
   if role=='backend':args+=['--internal']
   ids[role]=docker(*args,name);nets.append(name)
  pg=prefix+'-pg';bao=prefix+'-bao';seed=prefix+'-seed';app=prefix+'-app';old=prefix+'-old'
  for name in [pg,bao,seed,app,old]:owned.append(name)
  docker('run','-d','--name',pg,'--network',nets[0],'--ip','172.27.0.10','--network-alias','pg','--memory','512m','--pids-limit','128','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_USER=lyam','-e','POSTGRES_DB=lyam','postgres@sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73')
  docker('run','-d','--name',bao,'--network',nets[0],'--ip','172.27.0.11','--network-alias','bao','--memory','256m','--pids-limit','64','-e','BAO_DEV_ROOT_TOKEN_ID=synthetic-fixture-only','openbao/openbao@sha256:71156a1c6623a5fa3f5e61b0c6a8ead0faf0df29a778339188443551995d1315','server','-dev','-dev-listen-address=0.0.0.0:8200')
  for _ in range(60):
   r=subprocess.run(['docker','exec',pg,'pg_isready','-U','lyam'],capture_output=True,timeout=5)
   b=subprocess.run(['docker','exec','-e','BAO_ADDR=http://127.0.0.1:8200',bao,'bao','status'],capture_output=True,timeout=5)
   if r.returncode==0 and b.returncode==0:break
   time.sleep(1)
  else:raise ValueError('companions unavailable')
  docker('exec','-e','BAO_ADDR=http://127.0.0.1:8200','-e','BAO_TOKEN=synthetic-fixture-only',bao,'bao','kv','put','secret/fixture-ready','value=synthetic')
  data=root/'data';data.mkdir(mode=0o700)
  result['stage']='seed'
  docker('run','-d','--name',seed,'--network','none','--memory','2048m','--pids-limit','256','-v',str(data)+':/data','-e','IAM_AUTOMATION_HOLD=1','-e','IAM_DEMO_SEED_MODE=auto',IMAGE)
  wait(seed,3000,'/health');docker('stop','-t','30',seed)
  # Fictional generated data only. Real external providers are not configured.
  env=root/'normal.env';env.write_text('IAM_DEMO_SEED_MODE=never\nIAM_PG_URL=postgres://lyam@pg:5432/lyam\nIAM_BAO_ADDR=http://bao:8200\nIAM_BAO_TOKEN=synthetic-fixture-only\nIAM_PUBLIC_ORIGIN=http://localhost:18088\n');env.chmod(0o600)
  code=root/'code';code.mkdir(mode=0o700)
  for filename in ['normal-runtime.py','normal-lifecycle.py']:shutil.copyfile(repo/'deploy/oci'/filename,code/filename)
  def load(filename):
   s=importlib.util.spec_from_file_location(filename.replace('.','_'),code/filename);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
  n=load('normal-runtime.py');l=load('normal-lifecycle.py');im=json.loads(docker('image','inspect',IMAGE))[0]
  cfg={'format':1,'kind':'normal-two-network','image':IMAGE,'image_id':im['Id'],'source_sha':SHA,'container':app,'data_dir':str(data),'port':18088,'env':{'path':str(env),'sha256':hashlib.sha256(env.read_bytes()).hexdigest()},'backend':{'name':nets[0],'id':ids['backend']},'frontend':{'name':nets[1],'id':ids['frontend']},'pg':{'name':pg,'id':json.loads(docker('inspect',pg))[0]['Id'],'ip':'172.27.0.10'},'bao':{'name':bao,'id':json.loads(docker('inspect',bao))[0]['Id'],'ip':'172.27.0.11'},'public_probe':'1.1.1.1','tls_probe':'example.com','dns_upstreams':['1.1.1.1','9.9.9.9'],'companion_extra_internal':[]}
  lock=root/'update.lock';lock.touch(mode=0o600);attempts=[]
  with lock.open('rb') as f:
   fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);n.LOCK_FDS=(f.fileno(),);n.LOCK_PATHS=(str(lock),)
   for generation in [1,2]:
    result['stage']='normal-start-'+str(generation)
    # Resource flags are added ONLY to this disposable app invocation.
    original=n.call
    def bounded(args,pass_fds=()):
     if args[:2]==['docker','run']:args=args[:2]+['--memory','2048m','--memory-swap','2048m','--pids-limit','256','--cpus','2','--oom-score-adj','1000']+args[2:]
     return original(args,pass_fds)
    n.call=bounded
    try:proof=l.launch(cfg,str(root/('normal-attempt-'+str(generation)+'.json')),n)
    finally:n.call=original
    wait(app,3000,'/health');wait(app,8080,'/healthz');n.postcheck(cfg,proof);l.postcheck(cfg,str(root/('normal-attempt-'+str(generation)+'.json')),n)
    # Persist in real PG and Bao to prove unchanged companions survive app swap.
    docker('exec',pg,'psql','-U','lyam','-d','lyam','-v','ON_ERROR_STOP=1','-c','CREATE TABLE IF NOT EXISTS lifecycle_fixture(id int primary key); INSERT INTO lifecycle_fixture VALUES('+str(generation)+');')
    docker('exec','-e','BAO_ADDR=http://127.0.0.1:8200','-e','BAO_TOKEN=synthetic-fixture-only',bao,'bao','kv','put','secret/lifecycle-fixture','generation='+str(generation))
    rows=docker('exec',app,'dolt','--host','127.0.0.1','--port','3307','--no-tls','-u','root','--password','','--use-db=iam','sql','-r','json','-q','SELECT COUNT(*) AS n FROM dolt_status')
    if not json.loads(rows).get('rows'):raise ValueError('real Dolt query unavailable')
    observed=json.loads(docker('inspect',app))[0]
    attempts.append({'generation':generation,'container_id':observed['Id'],'image':observed['Image'],'healthy':True,'postcheck':True,'effects_marker_exists':Path(str(root/('normal-attempt-'+str(generation)+'.json'))+'.effects').is_file()})
    l.atomic_new(Path(str(root/('normal-attempt-'+str(generation)+'.json'))+'.completed'),{'fixture_completed':True})
    if generation==1:docker('stop','-t','30',app);docker('rename',app,old)
  count=docker('exec',pg,'psql','-U','lyam','-d','lyam','-Atc','SELECT count(*) FROM lifecycle_fixture;')
  if count!='2':raise ValueError('PG continuity differs')
  result.update(passed=True,stage='completed',attempts=attempts,pg_fixture_rows=2,bao_real=True,dolt_real=True,limits='fixture app2GiB/PID256/CPU2,PG512MiB,Bao256MiB',limitation='Same exact image twice, lifecycle Python only. No update.sh/queue/new-SHA/boot proof; Bao dev not durable restart proof.')
 finally:
  failures=[]
  for name in reversed(owned):
   p=subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=20)
   if p.returncode and subprocess.run(['docker','inspect',name],capture_output=True,timeout=5).returncode==0:failures.append('container')
  for name in reversed(nets):
   if subprocess.run(['docker','network','rm',name],capture_output=True,timeout=15).returncode:failures.append('network')
  result['cleanup_failures']=failures
  if failures:result['passed']=False
  Path('/tmp/normal-lifecycle-real-proof.json').write_text(json.dumps(result))
  shutil.rmtree(root)
 if not result['passed']:raise ValueError('real lifecycle refused')
if __name__=='__main__':main()
