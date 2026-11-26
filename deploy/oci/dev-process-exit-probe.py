#!/usr/bin/env python3
"""DEV-only process-exit experiment. No capture, no coherent-backup receipt.
Does not drain API/core, terminate envelope or authorize source-RW work.
"""
import hashlib,json,os,select,signal,time
from pathlib import Path

def stat(pid):
 raw=Path('/proc',str(pid),'stat').read_text();v=raw[raw.rfind(')')+2:].split()
 return {'pid':pid,'ppid':int(v[1]),'state':v[0],'start':int(v[19]),'exit_raw':int(v[49])}

def identity(pid):
 out=stat(pid);base=Path('/proc',str(pid))
 nspid=[v for v in (base/'status').read_text().splitlines() if v.startswith('NSpid:')]
 if len(nspid)!=1:raise ValueError('NSpid missing')
 out['namespace_pid']=int(nspid[0].split()[-1])
 raw=(base/'cmdline').read_bytes();out.update(cmd_sha256=hashlib.sha256(raw).hexdigest(),exe=os.readlink(base/'exe'),pidns=os.stat(base/'ns/pid').st_ino)
 return out,raw.split(b'\0')

def scan(init):
 records={};group=Path('/proc',str(init),'cgroup').read_text().splitlines()
 unified=[v.split(':',2)[2] for v in group if v.startswith('0::')]
 if len(unified)!=1:raise ValueError('DEV probe requires cgroup v2')
 root=Path('/sys/fs/cgroup')/unified[0].lstrip('/')
 pids=set()
 for f in [root/'cgroup.procs',*root.rglob('cgroup.procs')]:pids.update(int(v) for v in f.read_text().split())
 if not 7<=len(pids)<=32:raise ValueError('unexpected bounded process count')
 for pid in sorted(pids):
  rec,args=identity(pid);cmd=[v.decode() for v in args if v];role='unknown'
  if cmd==['node','/app/demo/server.mjs']:role='edge'
  elif len(cmd)>1 and cmd[0] in ('dolt','/usr/local/bin/dolt') and cmd[1]=='sql-server':role='dolt'
  elif len(cmd)>1 and cmd[0].endswith('nats-server') and cmd[1]=='-c':role='nats'
  elif cmd and cmd[0]=='/app/iam-core':role='core'
  elif 'dist/main.js' in cmd and os.readlink('/proc/'+str(pid)+'/cwd')=='/app/api':role='api'
  elif '/app/web/dist/web/server/server.mjs' in cmd:role='ssr'
  elif cmd and cmd[0] in ('sh','/bin/sh') and cmd[1:]==['/app/demo/start.sh']:role='supervisor'
  if role=='unknown':raise ValueError('unknown process in external-bao-v1: '+json.dumps({'exe_name':Path(rec['exe']).name,'argc':len(cmd),'cmd_sha256':rec['cmd_sha256'],'ppid':rec['ppid']},sort_keys=True))
  rec['role']=role;records[pid]=rec
 roles={r:[p for p,v in records.items() if v['role']==r] for r in ('edge','dolt','nats','core','api','ssr','supervisor')}
 if any(len(roles[r])!=1 for r in roles if r!='supervisor') or len(roles['supervisor'])!=3 or roles['edge']!=[init]:raise ValueError('exact external-bao-v1 process roles absent')
 for role in ('nats','core','ssr'):
  if records[roles[role][0]]['ppid'] not in roles['supervisor']:raise ValueError('producer parent is not supervisor')
 return records,roles

def network_boundary(init,closed_ports):
 observations={}
 for name in ('tcp','tcp6'):
  rows=[line.split() for line in Path('/proc',str(init),'net',name).read_text().splitlines()[1:]]
  relevant=[row for row in rows if int(row[1].split(':')[1],16) in closed_ports or int(row[2].split(':')[1],16) in closed_ports]
  observations[name]={'listeners':sum(row[3]=='0A' for row in relevant),'established':sum(row[3]=='01' for row in relevant)}
 if any(v['listeners'] or v['established'] for v in observations.values()):raise ValueError('process network boundary not closed')
 return observations

def experiment(init,checkpoint,timeout=30,retain_handles=None):
 """Fixed external-bao-v1 profile. checkpoint must fsync exclusive event bytes.
 This deliberately leaves the envelope/supervisors stopped for outer DEV cleanup.
 No process is resumed, retried, or KILLed here. Any mismatch refuses.
 """
 if os.geteuid()!=0 or os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_ENVIRONMENT')!='github-hosted' or Path('/opt/lyam').exists() or Path('/opt/lyam-recovery').exists():raise ValueError('disposable GitHub runner only')
 return observe_bound_profile(init,checkpoint,timeout,retain_handles)

def observe_bound_profile(init,checkpoint,timeout=30,retain_handles=None):
 """Physical external-bao-v1 primitive. Caller owns gates/locks/spec validation."""
 records,roles=scan(init);handles={};events=[]
 try:
  for pid in records:handles[pid]=os.pidfd_open(pid,0)
 except BaseException:
  for fd in handles.values():os.close(fd)
  raise
 def same(pid):
  now=stat(pid)
  if now['start']!=records[pid]['start']:raise ValueError('process identity changed')
  return now
 def send(pid,sig):
  same(pid);signal.pidfd_send_signal(handles[pid],sig)
 def await_state(pid,state):
  until=time.monotonic()+timeout
  while time.monotonic()<until:
   now=same(pid)
   if now['state'] in state:return now
   time.sleep(.02)
  raise ValueError('process state deadline')
 try:
  checkpoint({'phase':'dev-process-experiment-intent','records':records,'application_drain_claimed':False})
  # Freeze edge admission and all respawn parents before interrupting children.
  for pid in [init,*roles['supervisor']]:send(pid,signal.SIGSTOP);await_state(pid,{'T'})
  after,_=scan(init)
  # Only state may differ. No fork/exec/new PID may escape the fixed inventory.
  if set(after)!=set(records) or any(any(after[p][k]!=records[p][k] for k in ('start','cmd_sha256','exe','pidns','role','ppid')) for p in records):raise ValueError('process set changed during freeze')
  closed_ports=[]
  for role in ('api','core','ssr','nats','dolt'):
   for parent in [init,*roles['supervisor']]:
    if same(parent)['state']!='T':raise ValueError('supervisor/envelope resumed')
   pid=roles[role][0];sig=signal.SIGINT if role=='nats' else signal.SIGTERM
   checkpoint({'phase':'dev-signal-intent','role':role,'pid':pid,'start':records[pid]['start'],'signal':int(sig)})
   send(pid,sig)
   poll=select.poll();poll.register(handles[pid],select.POLLIN)
   if not poll.poll(timeout*1000):raise ValueError('pidfd exit deadline')
   stopped=await_state(pid,{'Z'})
   if role in ('nats','dolt') and stopped['exit_raw']!=0:raise ValueError('store process exit not zero: '+role)
   event={'role':role,'pid':pid,'start':stopped['start'],'state':stopped['state'],'exit_raw':stopped['exit_raw'],'clean_exit_zero':stopped['exit_raw']==0,'application_drain_claimed':False}
   checkpoint({'phase':'dev-process-exit-observed',**event});events.append(event)
   closed_ports.extend({'api':[3000],'core':[8081],'ssr':[4000],'nats':[4222],'dolt':[3307]}[role])
   checkpoint({'phase':'dev-network-boundary','after_role':role,'closed_ports':list(closed_ports),'observation':network_boundary(init,closed_ports)})
  # No active userspace writers remain in this exact cgroup. Zombies are not
  # executing; envelope and respawn shells must still be stopped, never resumed.
  for pid in records:
   state=same(pid)['state']
   expected='T' if pid in [init,*roles['supervisor']] else 'Z'
   if state!=expected:raise ValueError('unexpected final process state')
  checkpoint({'phase':'dev-all-processes-nonexecuting','active_writers':0,'remaining_envelope_and_supervisors':'stopped'})
  proof={'records':records,'kind':'DEV-process-exit-experiment','events':events,'writers_quiesced':False,'envelope_terminated':False,'application_drain_claimed':False,'capture_qualified':False,'limitation':'Exit observation only; no file/TCP/inflight/PG/Bao durability or envelope termination proof'}
  checkpoint(proof);return proof
 finally:
  if retain_handles is not None:retain_handles.update(handles)
  else:
   for fd in handles.values():os.close(fd)
