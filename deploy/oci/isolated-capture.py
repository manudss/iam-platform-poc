#!/usr/bin/env python3
"""Copy-only cold capture helper. FIFO + namespace fence before trusted node.
No app start.sh, no copied automation starts. Source is fixed adjacent qualifier.
"""
import json,os,secrets,subprocess,time
from pathlib import Path
FIFO='/tmp/lyam-copy-capture.fifo'
GUARD='set -eu; mkfifo -m 600 '+FIFO+'; read -r permit < '+FIFO+'; [ "$permit" = capture ]; rm -f '+FIFO+'; exec "$@"'
def capture(cmd,image,env_file,data_dir,network,source,payload):
 policy=json.loads(payload)
 if Path('/opt/lyam-qualification/copies') not in Path(data_dir).resolve().parents or '..' in data_dir.split('/'):raise ValueError('fixed copy data root required')
 if policy.get('isolatedCopy') is not True:raise ValueError('explicit isolated copy capture required')
 net=json.loads(cmd(['docker','network','inspect',network]))[0]
 if net.get('Internal') is not True or net.get('EnableIPv6') is not False:raise ValueError('capture network must be internal IPv4')
 name='lyam-copy-capture-'+secrets.token_hex(8);label='lyam-copy-capture='+name;cid=None
 def ns(pid,*args):return cmd(['nsenter','-t',str(pid),'-n',*args])
 try:
  cid=cmd(['docker','run','-d','--name',name,'--label',label,'--network',network,'--restart','no','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=1g','--memory','2147483648','--memory-swap','2147483648','--pids-limit','256','--cpus','1','--cap-drop','ALL','--security-opt','no-new-privileges:true','--sysctl','net.ipv6.conf.all.disable_ipv6=1','--sysctl','net.ipv6.conf.default.disable_ipv6=1','--env-file',env_file,'-v',data_dir+':/data:ro','--entrypoint','sh',image,'-c',GUARD,'sh','sleep','infinity'])
  x=json.loads(cmd(['docker','inspect',cid]))[0];pid=x['State']['Pid']
  for _ in range(50):
   try:cmd(['docker','exec',cid,'test','-p',FIFO]);break
   except ValueError:time.sleep(.1)
  else:raise ValueError('capture FIFO missing')
  ns(pid,'iptables','-P','OUTPUT','DROP');ns(pid,'ip6tables','-P','OUTPUT','DROP')
  gateway=net['IPAM']['Config'][0]['Gateway'];ns(pid,'ip','route','replace','default','via',gateway)
  for proto in ['tcp','udp']:ns(pid,'iptables','-t','raw','-A','OUTPUT','-p',proto,'--dport','53','-j','DROP')
  ns(pid,'iptables','-A','OUTPUT','-o','lo','-d','127.0.0.1','-j','ACCEPT')
  ns(pid,'iptables','-A','OUTPUT','-m','conntrack','--ctstate','ESTABLISHED','--ctdir','REPLY','-j','ACCEPT')
  for role,port in [('pg',5432),('bao',8200)]:
   values=[v for v in net['Containers'].values() if v['Name']==policy['pgContainer' if role=='pg' else 'baoContainer']]
   if len(values)!=1:raise ValueError('exact copied capture companion missing')
   ip=values[0]['IPv4Address'].split('/')[0]
   ns(pid,'iptables','-A','OUTPUT','-d',ip,'-p','tcp','--dport',str(port),'-j','ACCEPT')
  ns(pid,'iptables','-A','OUTPUT','-j','REJECT')
  # Controlled probes run with trusted host Python in this exact namespace.
  # Public TCP goes through filter REJECT. Embedded Docker DNS hits raw DROP.
  probe="import socket\ns=socket.socket();s.settimeout(.5)\ntry:s.connect(('1.1.1.1',443));raise RuntimeError('public connect unexpectedly succeeded')\nexcept OSError:pass\nd=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)\ntry:d.sendto(b'qualification-deny',('127.0.0.11',53))\nexcept OSError:pass"
  ns(pid,'/usr/bin/python3','-c',probe)
  def count(args,target):
   return sum(int(l.split()[0]) for l in ns(pid,'iptables',*args,'-nvx','-L','OUTPUT').splitlines() if len(l.split())>2 and l.split()[2]==target)
  if count([], 'REJECT')<1 or count(['-t','raw'],'DROP')<1:raise ValueError('capture real deny counters missing')
  exact=(ns(pid,'iptables','-S'),ns(pid,'iptables','-t','raw','-S'),ns(pid,'ip6tables','-S'))
  cmd(['docker','exec',cid,'sh','-c','printf "%s\\n" capture > '+FIFO])
  # PID1 now sleeps. Only this fixed trusted capture module gets policy stdin.
  result=cmd(['docker','exec','-i',cid,'node','--input-type=module','-e',source,'capture'],payload)
  if exact!=(ns(pid,'iptables','-S'),ns(pid,'iptables','-t','raw','-S'),ns(pid,'ip6tables','-S')):raise ValueError('capture fence changed')
  return result
 finally:
  if cid is None:
   candidates=cmd(['docker','ps','-aq','--filter','label='+label]).splitlines()
   if len(candidates)>1:raise ValueError('ambiguous capture orphan identity')
   if candidates:
    orphan=json.loads(cmd(['docker','inspect',candidates[0]]))[0]
    if orphan['Name'].lstrip('/')!=name or orphan['Config'].get('Labels',{}).get('lyam-copy-capture')!=name:raise ValueError('capture orphan binding differs')
    cid=orphan['Id']
  if cid:
   cmd(['docker','rm','-f',cid])
   remaining=cmd(['docker','ps','-aq','--filter','id='+cid])
   if remaining:raise ValueError('capture helper cleanup incomplete')
