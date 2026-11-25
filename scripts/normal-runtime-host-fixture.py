#!/usr/bin/env python3
"""Operator-only bounded host fixture. Never invokes production env or stores.
Not permission to execute. See the reviewed host fixture contract first.
"""
import argparse,hashlib,importlib.util,ipaddress,json,os,re,shutil,stat,subprocess,signal
from pathlib import Path
IMAGE='ghcr.io/manudss/iam-platform-poc@sha256:81aeb18f91f8413d44508866ef7e06becbe4816aa2478869fbff0d33bdef0904'
SOURCE='276d32d3162c940d7744eca9432e8b914976539f'

def protected(path):
 p=Path(path)
 for x in [p,*p.parents]:
  s=x.lstat()
  if x.is_symlink() or s.st_uid or s.st_gid or s.st_mode&0o022:raise ValueError('protected host fixture code required')
 if not p.is_file() or p.stat().st_nlink!=1:raise ValueError('unique host fixture file required')
 return p

def preflight(spec_path):
 if os.geteuid()!=0:raise ValueError('operator root execution required')
 p=protected(spec_path)
 if p.stat().st_mode&0o077:raise ValueError('private fixture spec required')
 spec=json.loads(p.read_text());root=Path(__file__).resolve().parents[1]
 required={'format','kind','image','source_sha','files','out','held_id'}
 if set(spec)!=required or spec['format']!=1 or spec['kind']!='reviewed-host-pre-fifo-fixture' or spec['image']!=IMAGE or spec['source_sha']!=SOURCE:raise ValueError('exact reviewed host fixture contract required')
 names=['scripts/normal-runtime-host-fixture.py','scripts/normal-runtime-docker-fixture.py','deploy/oci/normal-runtime.py']
 if set(spec['files'])!=set(names):raise ValueError('complete exact host fixture code inventory required')
 for rel in names:
  if hashlib.sha256(protected(root/rel).read_bytes()).hexdigest()!=spec['files'][rel]:raise ValueError('host fixture code changed')
 if not re.fullmatch('[a-f0-9]{64}',spec['held_id']):raise ValueError('exact held container ID required')
 out=Path(spec['out'])
 if out.parent!=Path('/root') or not re.fullmatch('normal-host-proof-[a-f0-9]{16}\.json',out.name) or out.exists():raise ValueError('fresh bounded root output path required')
 mem={k:int(v.split()[0]) for k,v in (line.split(':',1) for line in Path('/proc/meminfo').read_text().splitlines())}
 if mem.get('MemAvailable',0)<1048576:raise ValueError('at least 1GiB MemAvailable required; do not stop production to make space')
 if shutil.disk_usage('/root').free<2*1024**3:raise ValueError('at least 2GiB free root space required')
 def docker(args):return subprocess.check_output(['docker',*args],text=True,stderr=subprocess.PIPE,timeout=30)
 info=json.loads(docker(['info','--format','{{json .}}']))
 if info.get('OSType')!='linux' or not info.get('MemoryLimit') or not info.get('PidsLimit'):raise ValueError('Docker resource limit support required')
 ids=docker(['network','ls','-q']).splitlines()
 nets=json.loads(docker(['network','inspect',*ids])) if ids else []
 fixture=[ipaddress.IPv4Network('172.29.0.0/24'),ipaddress.IPv4Network('172.30.0.0/24')]
 for n in nets:
  for conf in n.get('IPAM',{}).get('Config') or []:
   subnet=conf.get('Subnet')
   if subnet:
    existing=ipaddress.ip_network(subnet)
    if existing.version==4 and any(existing.overlaps(f) for f in fixture):raise ValueError('fixture subnets overlap an existing Docker network; do not remove it')
 image=json.loads(docker(['image','inspect',IMAGE]))[0]
 if IMAGE not in image.get('RepoDigests',[]) or image.get('Config',{}).get('Labels',{}).get('org.opencontainers.image.revision')!=SOURCE:raise ValueError('exact existing local image required; no host pull')
 return spec

def memory_available():
 return next(int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))

def checkpoint():
 if memory_available()<512*1024:raise ValueError('host memory pressure; fixture must stop')

def snapshot(held_id):
 def run(args):return subprocess.check_output(args,text=True,stderr=subprocess.PIPE,timeout=30).strip()
 ids=run(['docker','ps','-aq']).splitlines()
 containers=json.loads(run(['docker','inspect',*ids])) if ids else []
 rows=[];held=None
 for c in containers:
  if c.get('Name','').lstrip('/').startswith('normal-host-'):raise ValueError('concurrent or leftover host fixture refused')
  state=c.get('State',{})
  rows.append({'id':c['Id'],'name':c.get('Name'),'status':state.get('Status'),'running':state.get('Running'),'pid':state.get('Pid'),'started_at':state.get('StartedAt'),'finished_at':state.get('FinishedAt'),'oom_killed':state.get('OOMKilled'),'restart_count':c.get('RestartCount'),'networks':c.get('NetworkSettings',{}).get('Networks',{})})
  if c['Id']==held_id:held=c
 if not held or not held.get('State',{}).get('Running') or 'IAM_AUTOMATION_HOLD=1' not in held.get('Config',{}).get('Env',[]):raise ValueError('exact held runtime must remain running')
 pid=held['State']['Pid'];ns=os.stat('/proc/'+str(pid)+'/ns/net').st_ino
 held_rules={t:hashlib.sha256(run(['nsenter','-t',str(pid),'-n',t,'-S']).encode()).hexdigest() for t in ('iptables','ip6tables')}
 ids=run(['docker','network','ls','-q']).splitlines();nets=json.loads(run(['docker','network','inspect',*ids])) if ids else []
 networks=[]
 for n in nets:
  if n.get('Name','').startswith('normal-host-'):raise ValueError('leftover fixture network refused')
  networks.append({k:n.get(k) for k in ('Id','Name','Driver','Internal','EnableIPv6','IPAM','Containers')})
 host_rules={t:hashlib.sha256(run([t,'-S']).encode()).hexdigest() for t in ('iptables','ip6tables')}
 return {'containers':sorted(rows,key=lambda x:x['id']),'networks':sorted(networks,key=lambda x:x['Id']),'held_namespace':{'id':held_id,'pid':pid,'inode':ns,'rules':held_rules},'host_filter_rules':host_rules,'memory_available_kib':memory_available()}


def execute_reviewed(spec,engine):
 before=snapshot(spec['held_id']);out=Path(spec['out']);error=None
 def interrupted(signum,frame):
  for sig in (signal.SIGALRM,signal.SIGTERM,signal.SIGINT):signal.signal(sig,signal.SIG_IGN)
  signal.alarm(0);raise TimeoutError('host fixture interrupted; owned cleanup required')
 prior={sig:signal.signal(sig,interrupted) for sig in (signal.SIGALRM,signal.SIGTERM,signal.SIGINT)}
 signal.alarm(600)
 try:engine.execute(argparse.Namespace(image=spec['image'],source_sha=spec['source_sha'],out=spec['out']),host_fixture=True,checkpoint=checkpoint)
 except Exception as e:error=e
 finally:
  signal.alarm(0)
  for sig in prior:signal.signal(sig,signal.SIG_IGN)
 try:
  try:
   after=snapshot(spec['held_id'])
   unchanged=all(before[k]==after[k] for k in ('containers','networks','held_namespace','host_filter_rules'))
   summary={'checked':True,'unchanged':unchanged,'before_sha256':hashlib.sha256(json.dumps(before,sort_keys=True).encode()).hexdigest(),'after_sha256':hashlib.sha256(json.dumps(after,sort_keys=True).encode()).hexdigest(),'memory_before_kib':before['memory_available_kib'],'memory_after_kib':after['memory_available_kib'],'comparisons':{k:before[k]==after[k] for k in ('containers','networks','held_namespace','host_filter_rules')}}
  except Exception:summary={'checked':False,'unchanged':False}
  result=json.loads(out.read_text()) if out.exists() else {'format':1,'result':'refused','app_started':False,'stage':'host-fixture-before-artifact'}
  result['production_observation']=summary
  if not summary['unchanged']:result['result']='refused'
  fd=os.open(out,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'w') as f:json.dump(result,f,indent=2);f.flush();os.fsync(f.fileno())
  if error:raise error
  if not summary['unchanged']:raise ValueError('production or host namespace changed')
 finally:
  for sig,handler in prior.items():signal.signal(sig,handler)


def main():
 p=argparse.ArgumentParser();p.add_argument('--spec',required=True);p.add_argument('--execute-reviewed-host-fixture',action='store_true');a=p.parse_args()
 spec=preflight(a.spec)
 if not a.execute_reviewed_host_fixture:
  print('Host fixture prerequisites verified; no resources created, no qualification');return
 path=Path(__file__).with_name('normal-runtime-docker-fixture.py');s=importlib.util.spec_from_file_location('host_fixture_engine',path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
 execute_reviewed(spec,m)
if __name__=='__main__':
 try:main()
 except Exception:
  print('HOST_FIXTURE_REFUSED: inspect bounded artifact if created',file=__import__('sys').stderr);raise SystemExit(1)
