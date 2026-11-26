#!/usr/bin/env python3
"""Read host guard counters after controlled probes. Does not grant admission.
Caller installs guard before any copied process and binds exact addresses/netns.
A nonzero external attempt requires stopping copy and human review, never retry.
"""
import hashlib,ipaddress,re,subprocess

def call(args):
 p=subprocess.run(args,text=True,capture_output=True,timeout=10)
 if p.returncode:raise ValueError('copy witness command refused')
 return p.stdout

def install(label,ips,backend):
 if not re.fullmatch('LQ[0-9a-f]{12}',label):raise ValueError('bounded unique chain required')
 net=ipaddress.IPv4Network(backend)
 addresses=[str(ipaddress.IPv4Address(ip)) for ip in ips]
 if not addresses or len(set(addresses))!=len(addresses):raise ValueError('exact distinct copy addresses required')
 # -N is exclusive. Existing chain is unresolved, never silently reuse/reset.
 call(['iptables','-N',label])
 call(['iptables','-A',label,'-m','conntrack','--ctstate','ESTABLISHED','--ctdir','REPLY','-j','RETURN'])
 call(['iptables','-A',label,'-d',str(net),'-j','RETURN'])
 call(['iptables','-A',label,'-j','REJECT'])
 for ip in addresses:
  call(['iptables','-I','DOCKER-USER','1','-s',ip,'-j',label])
  call(['iptables','-I','INPUT','1','-s',ip,'-m','conntrack','--ctstate','NEW','-m','comment','--comment',label,'-j','REJECT'])
 return {'label':label,'ips':addresses,'backend':str(net)}

def snapshot(binding):
 raw=call(['iptables','-nvx','-L',binding['label'],'--line-numbers'])
 rejects=[]
 for line in raw.splitlines():
  row=line.split()
  if len(row)>3 and row[3]=='REJECT':rejects.append(int(row[1]))
 if len(rejects)!=1:raise ValueError('exact host rejection witness missing')
 input_raw=call(['iptables','-nvx','-L','INPUT'])
 host=sum(int(l.split()[0]) for l in input_raw.splitlines() if binding['label'] in l and ' REJECT ' in l)
 return {'host_input_reject_packets':host,'reject_packets':rejects[0],'rules_sha256':hashlib.sha256((call(['iptables','-S',binding['label']])+''.join(l for l in call(['iptables','-S','INPUT']).splitlines() if binding['label'] in l)+''.join(l for l in call(['iptables','-S','DOCKER-USER']).splitlines() if binding['label'] in l)).encode()).hexdigest()}

def verify_quiet(before,after):
 if before['rules_sha256']!=after['rules_sha256'] or before['reject_packets']!=after['reject_packets'] or before.get('host_input_reject_packets')!=after.get('host_input_reject_packets'):raise ValueError('copy attempted external host traffic; stop and review')
 return {'host_guard_unchanged':True,'new_rejected_packets':0,'limitation':'host forwarded attempts only; namespace reject and raw DNS counters require independent comparison'}


def cleanup(binding):
 for ip in binding['ips']:
  call(['iptables','-D','DOCKER-USER','-s',ip,'-j',binding['label']])
  call(['iptables','-D','INPUT','-s',ip,'-m','conntrack','--ctstate','NEW','-m','comment','--comment',binding['label'],'-j','REJECT'])
 call(['iptables','-F',binding['label']]);call(['iptables','-X',binding['label']])
 if binding['label'] in call(['iptables','-S']):raise ValueError('copy host guard cleanup incomplete')
