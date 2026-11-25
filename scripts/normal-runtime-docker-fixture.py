#!/usr/bin/env python3
"""Disposable GitHub runner only. Real namespace policy, fixture fake PG/Bao.
The app NEVER starts: marker callback refuses FIFO release after all probes.
No production stores, env, credentials, accounts or host connection.
"""
import argparse,fcntl,hashlib,importlib.util,json,os,shutil,subprocess,sys,tempfile
from pathlib import Path

def run(args):
 p=subprocess.run(args,text=True,capture_output=True,timeout=240)
 if p.returncode:raise ValueError('fixture command failed')
 return p.stdout.strip()
def main():
 p=argparse.ArgumentParser();p.add_argument('--image',required=True);p.add_argument('--source-sha',required=True);p.add_argument('--out',required=True);a=p.parse_args()
 if os.geteuid()!=0 or os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_ENVIRONMENT')!='github-hosted':raise ValueError('disposable hosted root runner required')
 if Path('/opt/lyam').exists() or Path('/opt/lyam-recovery').exists():raise ValueError('production marker present')
 out=Path(a.out);out.parent.mkdir(parents=True,exist_ok=True)
 root=Path(tempfile.mkdtemp(prefix='normal-fixture-',dir='/root'));root.chmod(0o700);prefix='normal-ci-'+str(os.getpid());created=[];networks=[];stage='pull';result={'format':1,'result':'refused','app_started':False,'stage':stage}
 spec=importlib.util.spec_from_file_location('normal',Path(__file__).resolve().parents[1]/'deploy/oci/normal-runtime.py');n=importlib.util.module_from_spec(spec);spec.loader.exec_module(n)
 try:
  run(['docker','pull',a.image]);image=json.loads(run(['docker','image','inspect',a.image]))[0]
  ids={};stage='networks'
  for role,subnet in [('backend','172.29.0.0/24'),('frontend','172.30.0.0/24')]:
   name=prefix+'-'+role;args=['docker','network','create','--driver','bridge','--subnet',subnet]
   if role=='backend':args+=['--internal']
   ids[role]=run(args+[name]);networks.append(name)
  peers={};stage='fake-companions'
  for role,ip,port in [('pg','172.29.0.10',5432),('bao','172.29.0.11',8200)]:
   name=prefix+'-'+role;code="require('net').createServer(s=>s.end()).listen("+str(port)+",'0.0.0.0')"
   cid=run(['docker','run','-d','--name',name,'--restart','no','--network',prefix+'-backend','--ip',ip,'--network-alias',role,'--entrypoint','node',a.image,'-e',code]);created.append(cid);peers[role]={'name':name,'id':cid,'ip':ip}
  data=root/'data';data.mkdir(mode=0o700);env=root/'lyam.env';raw=b'IAM_DEMO_SEED_MODE=never\n';env.write_bytes(raw);env.chmod(0o600);lock=root/'lock';lock.touch(mode=0o600)
  cfg={'format':1,'kind':'normal-two-network','image':a.image,'image_id':image['Id'],'source_sha':a.source_sha,'container':prefix+'-app','data_dir':str(data),'port':18088,'env':{'path':str(env),'sha256':hashlib.sha256(raw).hexdigest()},'backend':{'name':prefix+'-backend','id':ids['backend']},'frontend':{'name':prefix+'-frontend','id':ids['frontend']},**peers,'public_probe':'1.1.1.1','tls_probe':'example.com','dns_upstreams':['1.1.1.1','9.9.9.9'],'companion_extra_internal':[]}
  class NoEffects(Exception):pass
  reached=[]
  def refuse(proof):reached.append(proof);raise NoEffects()
  stage='launcher-real-docker'
  with lock.open('a') as fd:
   fcntl.flock(fd,fcntl.LOCK_EX);n.LOCK_FDS=(fd.fileno(),);n.LOCK_PATHS=(str(lock),)
   try:n.launch(cfg,refuse)
   except NoEffects:pass
   else:raise ValueError('fixture must never permit app startup')
  if len(reached)!=1:raise ValueError('pre-FIFO probes never completed')
  app=json.loads(run(['docker','inspect',cfg['container']]))[0];created.append(app['Id'])
  if app['State']['Running'] or app['Config']['Cmd']!=['-c',n.GUARD]:raise ValueError('fixture app was not stopped at FIFO')
  if list(data.iterdir()):raise ValueError('app data changed before FIFO')
  result={'format':1,'result':'pre-fifo-network-qualified','app_started':False,'stage':'complete','image':a.image,'source_sha':a.source_sha,'normal_controller_sha256':hashlib.sha256(Path(n.__file__).read_bytes()).hexdigest(),'probe_runs':3,'stores':'empty fixture data and fake TCP PG/Bao only','limitation':'No release, full app, real stores, boot or production qualification'}
 except Exception:
  result['stage']=stage
  raise
 finally:
  out.write_text(json.dumps(result,indent=2));out.chmod(0o644)
  # Prefix-owned resources only, including an app created before an exception.
  names=run(['docker','ps','-a','--format','{{.Names}}']).splitlines()
  for name in names:
   if name.startswith(prefix+'-'):run(['docker','rm','-f',name])
  for network in reversed(networks):run(['docker','network','rm',network])
  shutil.rmtree(root)
if __name__=='__main__':
 try:main()
 except Exception:
  print('NORMAL_RUNTIME_FIXTURE_REFUSED: inspect bounded stage artifact',file=sys.stderr);sys.exit(1)
