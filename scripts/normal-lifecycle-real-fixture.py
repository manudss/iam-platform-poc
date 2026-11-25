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
 isolated=os.environ.get('LYAM_SYNTHETIC_ISOLATED_COPY')=='1'
 repo=Path(__file__).resolve().parents[1];root=Path(('/opt/lyam-qualification/copies/' if isolated else '/root/')+'normal-real-'+secrets.token_hex(8));
 if isolated:root.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 root.mkdir(mode=0o700);prefix=root.name;owned=[];nets=[];result={'kind':'synthetic-three-store-normal-lifecycle','production_data_used':False,'passed':False,'stage':'setup','same_image_twice':True,'update_shell_exercised':False,'queue_exercised':False,'boot_exercised':False}
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
   if role=='backend' or isolated:args+=['--internal']
   ids[role]=docker(*args,name);nets.append(name)
  pg=prefix+'-pg';bao=prefix+'-bao';seed=prefix+'-seed';app=prefix+'-app';old=prefix+'-old'
  for name in [pg,bao,seed,app,old]:owned.append(name)
  companion_safety=['--cap-drop','ALL','--security-opt','no-new-privileges:true','--sysctl','net.ipv6.conf.all.disable_ipv6=1','--sysctl','net.ipv6.conf.default.disable_ipv6=1'] if isolated else []
  docker('run','-d',*companion_safety,*(['--user','999:999'] if isolated else []),'--name',pg,'--network',nets[0],'--ip','172.27.0.10','--network-alias','pg','--memory','512m','--pids-limit','128','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_USER=lyam','-e','POSTGRES_DB=lyam','postgres@sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73')
  docker('run','-d',*companion_safety,*(['--user','100:1000'] if isolated else []),'--name',bao,'--network',nets[0],'--ip','172.27.0.11','--network-alias','bao','--memory','256m','--pids-limit','64','-e','BAO_DEV_ROOT_TOKEN_ID=synthetic-fixture-only','openbao/openbao@sha256:71156a1c6623a5fa3f5e61b0c6a8ead0faf0df29a778339188443551995d1315','server','-dev','-dev-listen-address=0.0.0.0:8200')
  for _ in range(60):
   r=subprocess.run(['docker','exec',pg,'pg_isready','-U','lyam'],capture_output=True,timeout=5)
   b=subprocess.run(['docker','exec','-e','BAO_ADDR=http://127.0.0.1:8200',bao,'bao','status'],capture_output=True,timeout=5)
   if r.returncode==0 and b.returncode==0:break
   time.sleep(1)
  else:raise ValueError('companions unavailable')
  docker('exec','-e','BAO_ADDR=http://127.0.0.1:8200','-e','BAO_TOKEN=synthetic-fixture-only',bao,'bao','kv','put','secret/fixture-ready','value=synthetic')
  if isolated:
   for companion in [pg,bao]:
    pid=str(json.loads(docker('inspect',companion))[0]['State']['Pid'])
    ns=['nsenter','-t',pid,'-n']
    for proto in ['udp','tcp']:run(ns+['iptables','-t','raw','-I','OUTPUT','1','-p',proto,'--dport','53','-j','DROP'])
    # Companions answer the app, never initiate external traffic.
    for command in [['-P','OUTPUT','DROP'],['-A','OUTPUT','-o','lo','-d','127.0.0.1','-j','ACCEPT'],['-A','OUTPUT','-m','conntrack','--ctstate','ESTABLISHED','--ctdir','REPLY','-j','ACCEPT'],['-A','OUTPUT','-j','REJECT']]:run(ns+['iptables',*command])
    for command in [['-P','OUTPUT','DROP'],['-A','OUTPUT','-o','lo','-j','ACCEPT']]:run(ns+['ip6tables',*command])
    # Host Python joins only network namespace; no installed companion tool needed.
    probe="import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(.5);s.sendto(b'qualification-deny',('127.0.0.11',53));\ntry:s.recvfrom(100)\nexcept (TimeoutError,OSError):pass"
    run(ns+['/usr/bin/python3','-c',probe])
    table=run(ns+['iptables','-t','raw','-nvx','-L','OUTPUT'])
    if not any(len(x.split())>2 and x.split()[2]=='DROP' and int(x.split()[0])>0 for x in table.splitlines()):raise ValueError('companion DNS denial counter missing')
   result['companion_dns_raw_denial']=True
  data=root/'data';data.mkdir(mode=0o700)
  result['stage']='seed'
  docker('run','-d','--name',seed,'--network','none','--memory','2048m','--pids-limit','256','-v',str(data)+':/data','-e','IAM_AUTOMATION_HOLD=1','-e','IAM_DEMO_SEED_MODE=auto',IMAGE)
  wait(seed,3000,'/health');docker('stop','-t','30',seed)
  # Fictional generated data only. Real external providers are not configured.
  env=root/'normal.env';env.write_text('IAM_DEMO_SEED_MODE=never\nIAM_PG_URL=postgres://lyam@pg:5432/lyam\nIAM_BAO_ADDR=http://bao:8200\nIAM_BAO_TOKEN=synthetic-fixture-only\nIAM_PUBLIC_ORIGIN=http://localhost:18088\n');env.chmod(0o600)
  code=root/'code';code.mkdir(mode=0o700)
  for filename in ['normal-runtime.py','normal-lifecycle.py']:shutil.copyfile(repo/'deploy/oci'/('isolated-runtime.py' if isolated and filename=='normal-runtime.py' else filename),code/filename)
  def load(filename):
   s=importlib.util.spec_from_file_location(filename.replace('.','_'),code/filename);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
  n=load('normal-runtime.py');l=load('normal-lifecycle.py');im=json.loads(docker('image','inspect',IMAGE))[0]
  cfg={'format':1,'kind':'normal-two-network','image':IMAGE,'image_id':im['Id'],'source_sha':SHA,'container':app,'data_dir':str(data),'port':18088,'env':{'path':str(env),'sha256':hashlib.sha256(env.read_bytes()).hexdigest()},'backend':{'name':nets[0],'id':ids['backend']},'frontend':{'name':nets[1],'id':ids['frontend']},'pg':{'name':pg,'id':json.loads(docker('inspect',pg))[0]['Id'],'ip':'172.27.0.10'},'bao':{'name':bao,'id':json.loads(docker('inspect',bao))[0]['Id'],'ip':'172.27.0.11'},'public_probe':'1.1.1.1','tls_probe':'example.com','dns_upstreams':['1.1.1.1','9.9.9.9'],'companion_extra_internal':[]}
  if isolated:cfg.update(kind='isolated-copy',dns_upstreams=[],resources={'memory_bytes':2147483648,'pids':256,'nano_cpus':1000000000});result['runtime_kind']='isolated-copy'
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
  if '--updater' in __import__('sys').argv:
   result['stage']='actual-updater-shell'
   from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
   import threading,urllib.request
   backup=root/'backups';backup.mkdir(mode=0o700);gate=root/'front/MAINTENANCE';gate.parent.mkdir(mode=0o755)
   class Front(BaseHTTPRequestHandler):
    def do_GET(self):
     if gate.exists():self.send_response(503);self.end_headers();return
     try:
      with urllib.request.urlopen('http://127.0.0.1:18088/healthz',timeout=3) as response:code=response.status
     except Exception:code=502
     self.send_response(code);self.end_headers()
    def log_message(self,*args):pass
   front=ThreadingHTTPServer(('127.0.0.1',18089),Front);threading.Thread(target=front.serve_forever,daemon=True).start()
   for f in (repo/'deploy/oci').iterdir():
    if f.is_file():shutil.copyfile(f,code/f.name)
   (code/'update.sh').chmod(0o700)
   profile=root/'normal-profile.json';profile.write_text(json.dumps(cfg));profile.chmod(0o600)
   # This fixture-only checker tests real shell/checker ordering and local health.
   # It is NOT the full application qualification.py/OIDC/preservation policy.
   checker=root/'fixture-check.py'
   checker.write_text("#!/usr/bin/python3\nimport sys,subprocess,json\nfrom pathlib import Path\na=sys.argv;get=lambda k:a[a.index(k)+1];phase=get('--phase');x=json.loads(subprocess.check_output(['docker','inspect',get('--container')]))[0];assert Path(get('--barrier-file')).is_file();assert x['State']['Running'] is (phase=='after')\n")
   checker.chmod(0o700)
   full_qualification='--full-qualification' in __import__('sys').argv
   if full_qualification:
    token=root/'bao-token';token.write_text('synthetic-fixture-only');token.chmod(0o600)
    auth=root/'auth.json';auth.write_text(json.dumps({'username':'demo-alice','password':'demo-only-not-a-secret'}));auth.chmod(0o600)
    docker('exec','-e','BAO_ADDR=http://127.0.0.1:8200','-e','BAO_TOKEN=synthetic-fixture-only',bao,'bao','kv','put','secret/iam/qualification','value=synthetic')
    policy=root/'qualification.json';policy.write_text(json.dumps({'format':1,'isolatedLoopbackTest':True,'requireAutomationHold':False,'origins':['http://127.0.0.1:18089'],'issuer':'http://127.0.0.1:18089/core','tenant':'acme-demo','network':nets[0],'pgContainer':pg,'pgUser':'lyam','pgDatabase':'lyam','baoAddress':'http://172.27.0.11:8200','baoTokenFile':str(token),'baoMetadataRoots':['secret/metadata/iam'],'authFile':str(auth),'credentialFiles':['core-state/credentials.json','core-state/iam-poc-account-blocks.json','core-state/iam-poc-authn-enrollments.json','core-state/iam-poc-password-history.json'],'appendOnlyTables':['public.activations','public.decision_audit'],'transformationVerifiers':{}}));policy.chmod(0o600)
    checker.write_text('#!/bin/sh\nexec python3 '+str(code/'qualification.py')+' --isolated-loopback-test --policy '+str(policy)+' "$@"\n')
   settings={'LYAM_CONTAINER':app,'LYAM_DATA_DIR':str(data),'LYAM_BACKUP_DIR':str(backup),'LYAM_PORT':'18088','LYAM_LOCK_FILE':str(lock),'LYAM_PAUSE_FILE':str(root/'PAUSE'),'LYAM_FRONT_BARRIER_FILE':str(gate),'LYAM_NORMAL_RUNTIME':str(profile),'LYAM_NORMAL_RUNTIME_SHA256':hashlib.sha256(profile.read_bytes()).hexdigest(),'LYAM_NORMAL_LIFECYCLE_SHA256':hashlib.sha256((code/'normal-lifecycle.py').read_bytes()).hexdigest(),'LYAM_NORMAL_LAUNCHER_SHA256':hashlib.sha256((code/'normal-runtime.py').read_bytes()).hexdigest(),'LYAM_POST_UPDATE_CHECK':str(checker),'LYAM_HEALTH_TIMEOUT':'120'}
   values=dict(line.split('=',1) for line in env.read_text().splitlines());values.update(settings);values['IAM_PUBLIC_ORIGIN']='http://127.0.0.1:18089';env.write_text(''.join(k+'='+v+'\n' for k,v in values.items()))
   shim=root/'fixture-bin';shim.mkdir(mode=0o700);docker_cli=shutil.which('docker')
   shim_docker=shim/'docker';shim_docker.write_text("#!/usr/bin/python3\nimport os,sys\na=sys.argv[1:]\nif a[:1]==['run']:a=['run','--memory','2048m','--memory-swap','2048m','--pids-limit','256','--cpus','2']+a[1:]\nos.execv("+repr(docker_cli)+",['docker']+a)\n");shim_docker.chmod(0o700)
   try:
    process=subprocess.run(['sh',str(code/'update.sh'),'--image',IMAGE,'--env-file',str(env),'--require-qualification'],capture_output=True,text=True,timeout=700,env={**os.environ,'PATH':str(shim)+':'+os.environ['PATH']})
    result['updater_exit']=process.returncode
    if process.returncode:raise ValueError('actual updater shell refused')
    if gate.exists():raise ValueError('fixture front not reopened')
    archives=list(backup.glob('lyam-data-*.tar.gz'))
    if len(archives)!=1:raise ValueError('actual cold data archive missing')
    records=list(backup.glob('normal-attempt-*.json.completed'))
    if len(records)!=1:raise ValueError('actual lifecycle completion missing')
    names=docker('ps','-a','--format','{{.Names}}').splitlines()
    owned.extend(name for name in names if name.startswith(app+'-preserved-'))
    result.update(update_shell_exercised=True,updater_cold_data_archives=1,updater_completed_attempts=1,updater_front_reopened=True,updater_qualification=('actual qualification.py and qualification-container.mjs before/after, synthetic OIDC and 3 stores' if full_qualification else 'fixture ordering/stopped-before/running-after checker only; NOT full qualification/OIDC'),updater_same_image=True,full_qualification_exercised=full_qualification)
   finally:front.shutdown();front.server_close()
  count=docker('exec',pg,'psql','-U','lyam','-d','lyam','-Atc','SELECT count(*) FROM lifecycle_fixture;')
  if count!='2':raise ValueError('PG continuity differs')
  result.update(passed=True,stage='completed',attempts=attempts,pg_fixture_rows=2,bao_real=True,dolt_real=True,limits='fixture app2GiB/PID256/CPU2,PG512MiB,Bao256MiB',limitation='Same exact image lifecycle; full qualifier only when full_qualification_exercised=true; no queue/new-SHA/boot or PG/Bao cold-archive proof; Bao dev not durable restart proof.')
 finally:
  failures=[]
  # A failed updater may already have renamed the old app. Collect only this
  # random fixture prefix before cleanup, including ambiguous failed attempts.
  try:
   existing=docker('ps','-a','--format','{{.Names}}').splitlines()
   owned.extend(name for name in existing if name.startswith(prefix+'-') and name not in owned)
  except Exception:failures.append('enumeration')
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
