#!/usr/bin/env python3
"""Small host-only held proof. No exec, health request, helper or mutation.
Reads host /proc, Docker inspect, and nsenter firewall listing only.
"""
import hashlib,json,os,subprocess
from pathlib import Path

def run(args):
 r=subprocess.run(args,text=True,capture_output=True,timeout=10)
 if r.returncode:raise ValueError('host-only observation command refused')
 return r.stdout

def verify(spec,expected,reader):
 required={'env','gates','pause','journal','policy4_sha256','policy6_sha256','networks_sha256','mounts_sha256','ports_sha256','target','container'}
 if set(spec)!=required:raise ValueError('exact host-only proof spec required')
 env_path,envraw=reader(spec['env']);values={}
 for line in envraw.decode().splitlines():
  if not line or line.startswith('#'):continue
  k,sep,v=line.partition('=')
  if not sep or k in values:raise ValueError('ambiguous active environment')
  values[k]=v
 if env_path!=Path('/opt/lyam-recovery/active/lyam.env') or env_path.stat().st_mode&0o777!=0o600:raise ValueError('private fixed env required')
 if values.get('IAM_AUTOMATION_HOLD')!='1' or values.get('IAM_DEMO_SEED_MODE')!='never':raise ValueError('active hold/seed differ')
 for key,path in [('pause','/opt/lyam-recovery/active/UPDATE_PAUSED'),('journal','/opt/lyam-recovery/active/deploy-queue/state.json')]:
  p,_=reader(spec[key])
  if str(p)!=path:raise ValueError('fixed pause/journal required')
 if set(spec['gates'])!={'maintenance','operations'}:raise ValueError('both gate bindings required')
 for key,envkey in [('maintenance','LYAM_FRONT_BARRIER_FILE'),('operations','LYAM_OPS_BARRIER_FILE')]:
  p,_=reader(spec['gates'][key])
  if str(p)!=values[envkey]:raise ValueError('configured gate differs')
 if values.get('LYAM_LOCK_FILE')!='/opt/lyam-recovery/active/.update.lock' or values.get('LYAM_QUEUE_STATE')!='/opt/lyam-recovery/active/deploy-queue/state.json' or values.get('LYAM_PAUSE_FILE')!='/opt/lyam-recovery/active/UPDATE_PAUSED':raise ValueError('actual queue/locks/pause required')
 x=json.loads(run(['docker','inspect','--type','container',spec['container']]))[0];s=x['State'];hc=x['HostConfig'];cfg=x['Config']
 image='ghcr.io/manudss/iam-platform-poc@'+spec['target']['digest']
 if x['Id']!=expected['container_id'] or x['Image']!=expected['image_id'] or cfg['Image']!=image or s['Pid']!=expected['pid'] or s['StartedAt']!=expected['started_at'] or not s['Running'] or s['OOMKilled'] or x['RestartCount']!=0:raise ValueError('held stable identity differs')
 actual={}
 for item in cfg['Env']:
  k,sep,v=item.partition('=')
  if not sep or k in actual and actual[k]!=v:raise ValueError('contradictory runtime env')
  actual[k]=v
 if any(actual.get(k)!=v for k,v in values.items()) or actual.get('IAM_AUTOMATION_HOLD')!='1' or actual.get('IAM_DEMO_SEED_MODE')!='never':raise ValueError('runtime env differs')
 if set(hc.get('CapDrop')or[])!={'ALL'} or hc.get('CapAdd') or hc.get('Privileged') or hc['RestartPolicy']['Name']!='no' or not any(v in ['no-new-privileges','no-new-privileges:true'] for v in hc.get('SecurityOpt')or[]):raise ValueError('runtime powers differ')
 pid=str(s['Pid']);proc=Path('/proc')/pid
 if (proc/'ns/net').stat().st_ino!=expected['netns_inode']:raise ValueError('held namespace differs')
 status=(proc/'status').read_text();fields=dict(line.split(':',1) for line in status.splitlines() if ':' in line)
 if int(fields['CapEff'].strip(),16) or int(fields['CapBnd'].strip(),16) or fields['NoNewPrivs'].strip()!='1':raise ValueError('live capabilities differ')
 digest=lambda value:hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
 for field,value in [('networks',x['NetworkSettings']['Networks']),('mounts',x['Mounts']),('ports',hc['PortBindings'])]:
  if digest(value)!=spec[field+'_sha256']:raise ValueError('actual runtime topology differs')
 im=json.loads(run(['docker','image','inspect',expected['image_id']]))[0]
 if im['Id']!=expected['image_id'] or image not in im['RepoDigests'] or im['Config']['Labels'].get('org.opencontainers.image.revision')!=spec['target']['sha']:raise ValueError('actual image differs')
 for tool,key in [('iptables','policy4_sha256'),('ip6tables','policy6_sha256')]:
  raw=run(['nsenter','-t',pid,'-n',tool,'-S']).encode()
  if hashlib.sha256(raw).hexdigest()!=spec[key]:raise ValueError('namespace firewall differs')
 # No timestamp, load counter or firewall counter in return equality.
 return {'kind':'host-only-current-held','container_id':x['Id'],'image_id':x['Image'],'pid':s['Pid'],'started_at':s['StartedAt'],'netns_inode':expected['netns_inode'],'tls_checked':False,'ipv6_kernel_state_checked':False,'api_hold_observed':False,'restoration_admissible':False}
