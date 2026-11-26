#!/usr/bin/env python3
"""Read host guard counters after controlled probes. Does not grant admission.
Caller installs guard before any copied process and binds exact addresses/netns.
A nonzero external attempt requires stopping copy and human review, never retry.
"""
import hashlib,ipaddress,re,subprocess,shlex

def call(args):
 p=subprocess.run(args,text=True,capture_output=True,timeout=10)
 if p.returncode:raise ValueError('copy witness command refused')
 return p.stdout

def invariants(tool):
 # Docker creates/removes NAT/filter isolation chains for disposable networks.
 # Bind protection hooks and fixed LYAM chains, not those expected Docker edits.
 raw=call([tool,'-S']);selected=[]
 for line in raw.splitlines():
  tokens=shlex.split(line)
  if tokens and (tokens[0]=='-P' or (len(tokens)>1 and (tokens[1] in ('INPUT','DOCKER-USER') or tokens[1].startswith('LYAM')))):selected.append(line)
 return '\n'.join(selected)

def install(label,ips,backend):
 if not re.fullmatch('LQ[0-9a-f]{12}',label):raise ValueError('bounded unique chain required')
 net=ipaddress.IPv4Network(backend)
 addresses=[str(ipaddress.IPv4Address(ip)) for ip in ips]
 if not addresses or len(set(addresses))!=len(addresses):raise ValueError('exact distinct copy addresses required')
 # Source-specific hooks at position 1, never a global allow or policy edit.
 # Operator reviews the exact plan before any host use. Controlled probes must
 # prove both paths counted before copied entrypoint release.
 hooks=[]
 for ip in addresses:
  hooks.extend([['DOCKER-USER','-s',ip,'-j',label],['INPUT','-s',ip,'-m','conntrack','--ctstate','NEW','-m','comment','--comment',label,'-j','REJECT']])
 own=[['-m','conntrack','--ctstate','ESTABLISHED','--ctdir','REPLY','-j','RETURN'],['-d',str(net),'-j','RETURN'],['-j','REJECT']]
 binding={'label':label,'ips':addresses,'backend':str(net),'pre_v4':invariants('iptables'),'pre_v6':invariants('ip6tables'),'hooks':hooks,'own':own}
 if any(label in shlex.split(l) for l in call(['iptables','-S']).splitlines()):raise ValueError('copy witness marker already present')
 try:
  call(['iptables','-N',label])
  for args in own:call(['iptables','-A',label,*args])
  for args in hooks:call(['iptables','-I',args[0],'1',*args[1:]])
 except BaseException as error:
  cleanup(binding)
  raise ValueError('copy witness install incomplete, reverted own rules') from error
 return binding

def probe(binding,pid,ip):
 if ip not in binding['ips']:raise ValueError('probe source outside witness')
 gateway=str(ipaddress.IPv4Network(binding['backend']).network_address+1)
 call(['nsenter','-t',str(pid),'-n','ip','route','replace','default','via',gateway])
 before=snapshot(binding)
 source="import socket,sys\nfor host in sys.argv[2:]:\n s=socket.socket();s.bind((sys.argv[1],0));s.settimeout(.5)\n try:s.connect((host,443))\n except OSError:pass\n s.close()"
 prefix=['nsenter','-t',str(pid),'-n','iptables'];rules=[['OUTPUT','-d',dst,'-p','tcp','--dport','443','-j','ACCEPT'] for dst in (gateway,'1.1.1.1')]
 try:
  for rule in rules:call([*prefix,'-I',rule[0],'1',*rule[1:]])
  call(['nsenter','-t',str(pid),'-n','/usr/bin/python3','-c',source,ip,gateway,'1.1.1.1'])
 finally:
  for rule in reversed(rules):call([*prefix,'-D',*rule])
 after=snapshot(binding)
 if after['reject_packets']<=before['reject_packets'] or after['host_input_reject_packets']<=before['host_input_reject_packets']:raise ValueError('host witness hooks not reachable or not counted')
 return {'source_ip':ip,'host_and_forward_counters_advanced':True}

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


def canonical(tokens):
 out=list(tokens)
 for flag in ('-s','-d'):
  if flag in out:
   idx=out.index(flag)+1;out[idx]=str(ipaddress.ip_network(out[idx],strict=False))
 return out

def cleanup(binding):
 label=binding['label'];failures=[];lines=call(['iptables','-S']).splitlines()
 # Only exact owned hooks. A foreign reference/collision is never deleted.
 for args in reversed(binding.get('hooks',[])):
  exact=canonical(['-A',*args])
  if any(canonical(shlex.split(line))==exact for line in lines):
   try:call(['iptables','-D',*args])
   except BaseException:failures.append('delete-own-hook')
 remaining=call(['iptables','-S']).splitlines()
 foreign=[l for l in remaining if label in shlex.split(l) and not l.startswith(('-N '+label,'-A '+label+' '))]
 own=[canonical(['-A',label,*a]) for a in binding.get('own',[])]
 actual=[canonical(shlex.split(l)) for l in remaining if l.startswith('-A '+label+' ')]
 if foreign or any(l not in own for l in actual):failures.append('foreign-reference-or-chain-content')
 elif '-N '+label in remaining:
  for args in (['iptables','-F',label],['iptables','-X',label]):
   try:call(args)
   except BaseException:failures.append('delete-own-chain')
 v4=call(['iptables','-S'])
 if any(label in shlex.split(line) for line in v4.splitlines()):failures.append('own-rule-remains')
 if invariants('iptables')!=binding['pre_v4'] or invariants('ip6tables')!=binding['pre_v6']:failures.append('protected-firewall-changed')
 if failures:raise ValueError('copy witness cleanup incomplete: '+','.join(failures))
