#!/usr/bin/env python3
"""Two-network normal launcher, NOT YET DOCKER-QUALIFIED.
No implicit stop/remove/start of an old container. Every boot begins behind a FIFO.
Firewall and direct probes apply to the exact namespace before the first app instruction.
A successful launch is not a release/backlog/authorization verdict.
"""
import hashlib,ipaddress,json,os,re,stat,subprocess,time,fcntl
from pathlib import Path

LOCK_PATHS=()
LOCK_FDS=()  # configured by the fixed installed parent while it owns updater lock
FIFO='/tmp/lyam-normal-start.fifo'
GUARD='set -eu; rm -f '+FIFO+'; mkfifo -m 600 '+FIFO+'; read -r permit < '+FIFO+'; [ "$permit" = start-normal ]; rm -f '+FIFO+'; exec sh /app/demo/start.sh'
# IPv4 ranges that must never become reachable through the public HTTPS rule.
NONPUBLIC=('0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.0.0.0/24','192.0.2.0/24','192.88.99.0/24','192.168.0.0/16','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/4','240.0.0.0/4')

def call(args,pass_fds=()):
 p=subprocess.run(args,text=True,capture_output=True,timeout=180,pass_fds=tuple(set(pass_fds)|set(LOCK_FDS)))
 if p.returncode:raise ValueError('normal launcher command refused; inspect private diagnostics')
 return p.stdout.strip()
def sha(raw):return hashlib.sha256(raw).hexdigest()
def protected(binding):
 if not isinstance(binding,dict) or set(binding)!={'path','sha256'} or not re.fullmatch('[a-f0-9]{64}',str(binding['sha256'])):raise ValueError('exact file binding required')
 p=Path(binding['path'])
 if not p.is_absolute() or '..' in p.parts:raise ValueError('canonical absolute file required')
 for a in [p,*p.parents]:
  st=a.lstat()
  if a.is_symlink() or st.st_uid or st.st_gid or st.st_mode&0o022:raise ValueError('protected file ancestry required')
 if not p.is_file() or p.stat().st_nlink!=1 or p.stat().st_size>16*1024*1024:raise ValueError('regular unique file required')
 raw=p.read_bytes()
 if sha(raw)!=binding['sha256']:raise ValueError('bound file changed')
 return p,raw
def env_values(raw):
 values={}
 for line in raw.decode().splitlines():
  if not line or line.startswith('#'):continue
  k,sep,v=line.partition('=')
  if not sep or not re.fullmatch('[A-Za-z_][A-Za-z0-9_]*',k) or k in values:raise ValueError('unambiguous env required')
  values[k]=v
 if 'IAM_AUTOMATION_HOLD' in values or values.get('IAM_DEMO_SEED_MODE')!='never' or 'NODE_TLS_REJECT_UNAUTHORIZED' in values:raise ValueError('normal env must have HOLD absent, seednever and verified TLS')
 return values

def validate(c):
 need={'format','kind','image','image_id','container','data_dir','port','env','backend','frontend','pg','bao','public_probe','source_sha','tls_probe','dns_upstreams','companion_extra_internal','resources'}
 if set(c)!=need or c['format']!=1 or c['kind'] not in ('normal-two-network','isolated-copy'):raise ValueError('exact normal runtime contract required')
 r=c['resources']
 if not isinstance(r,dict) or set(r)!={'memory_bytes','pids','nano_cpus'} or type(r['memory_bytes']) is not int or not 512*1024**2<=r['memory_bytes']<=8*1024**3 or type(r['pids']) is not int or not 64<=r['pids']<=1024 or type(r['nano_cpus']) is not int or not 100000000<=r['nano_cpus']<=2000000000:raise ValueError('explicit bounded resource profile required')
 if not re.fullmatch('ghcr.io/manudss/iam-platform-poc@sha256:[a-f0-9]{64}',c['image']) or not re.fullmatch('sha256:[a-f0-9]{64}',c['image_id']):raise ValueError('immutable image binding required')
 if c['kind']=='isolated-copy' and not str(Path(c['data_dir'])).startswith('/opt/lyam-qualification/copies/'):raise ValueError('copy data root must be dedicated and fixed')
 if not re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{0,63}',c['container']):raise ValueError('bounded container name required')
 if type(c['port']) is not int or not 1024<=c['port']<=65535:raise ValueError('explicit unprivileged loopback port required')
 if c['backend']['id']==c['frontend']['id'] or c['backend']['name']==c['frontend']['name']:raise ValueError('two distinct networks required')
 for n in ('backend','frontend'):
  if set(c[n])!={'name','id'} or not re.fullmatch('[A-Za-z0-9_.-]{1,64}',c[n]['name']) or not re.fullmatch('[a-f0-9]{64}',c[n]['id']):raise ValueError('exact network identity required')
 for role,port in [('pg',5432),('bao',8200)]:
  v=c[role]
  if set(v)!={'name','id','ip'} or not re.fullmatch('[a-f0-9]{64}',v['id']) or not ipaddress.IPv4Address(v['ip']).is_private:raise ValueError('private companion identity required')
 if not re.fullmatch('[a-f0-9]{40}',c['source_sha']) or not re.fullmatch('[a-zA-Z0-9.-]+',c['tls_probe']):raise ValueError('exact source and TLS probe hostname required')
 if c['kind']=='isolated-copy' and c['dns_upstreams']!=[]:raise ValueError('copy has no DNS upstreams')
 if c['kind']=='normal-two-network' and (not isinstance(c['dns_upstreams'],list) or not 1<=len(c['dns_upstreams'])<=2 or len(set(c['dns_upstreams']))!=len(c['dns_upstreams']) or any(not ipaddress.IPv4Address(v).is_global for v in c['dns_upstreams'])):raise ValueError('one or two exact public DNS upstreams required')
 if not isinstance(c['companion_extra_internal'],list) or len(c['companion_extra_internal'])>1:raise ValueError('at most one transitional internal companion network')
 for n in c['companion_extra_internal']:
  if set(n)!={'name','id'} or not re.fullmatch('[a-f0-9]{64}',n['id']):raise ValueError('exact transitional network identity required')
 if not ipaddress.IPv4Address(c['public_probe']).is_global:raise ValueError('global IPv4 probe required')
 p=Path(c['data_dir'])
 if not p.is_absolute() or '..' in p.parts or str(p.resolve())!=str(p) or not p.is_dir():raise ValueError('canonical data directory required')
 return c

def inspect(name):return json.loads(call(['docker','inspect','--type','container',name]))[0]
def topology(c):
 for role in ('backend','frontend'):
  n=json.loads(call(['docker','network','inspect',c[role]['id']]))[0]
  if n.get('Id')!=c[role]['id'] or n.get('Name')!=c[role]['name'] or n.get('Driver')!='bridge' or n.get('Internal') is not (role=='backend' or c['kind']=='isolated-copy') or n.get('EnableIPv6') is not False:raise ValueError('network topology differs')
 for extra in c['companion_extra_internal']:
  n=json.loads(call(['docker','network','inspect',extra['id']]))[0]
  if n.get('Id')!=extra['id'] or n.get('Name')!=extra['name'] or n.get('Internal') is not True or n.get('EnableIPv6') is not False:raise ValueError('transitional companion network must be internal IPv4')
 for role in ('pg','bao'):
  x=inspect(c[role]['id']);nets=x.get('NetworkSettings',{}).get('Networks',{})
  if x.get('Id')!=c[role]['id'] or x.get('Name','').lstrip('/')!=c[role]['name'] or x.get('State',{}).get('Running') is not True or set(nets)!=({c['backend']['name']}|{n['name'] for n in c['companion_extra_internal']}) or x.get('HostConfig',{}).get('PortBindings'):raise ValueError('companion must be running only on private backend without published ports')
  net=nets[c['backend']['name']]
  if net.get('NetworkID')!=c['backend']['id'] or net.get('IPAddress')!=c[role]['ip'] or net.get('IPAMConfig',{}).get('IPv4Address')!=c[role]['ip'] or role not in net.get('Aliases',[]):raise ValueError('companion alias/IP differs')

def rules(c,gateways=()):
 common=[['-P','OUTPUT','DROP'],['-A','OUTPUT','-m','conntrack','--ctstate','ESTABLISHED','--ctdir','REPLY','-j','ACCEPT']]
 v4=common+[['-A','OUTPUT','-o','lo','-d','127.0.0.1/32','-j','ACCEPT']]
 for role,port in [('pg',5432),('bao',8200)]:v4.append(['-A','OUTPUT','-d',c[role]['ip'],'-p','tcp','--dport',str(port),'-j','ACCEPT'])
 for resolver in c['dns_upstreams']:
  for proto in ('tcp','udp'):v4.append(['-A','OUTPUT','-d',resolver,'-p',proto,'--dport','53','-j','ACCEPT'])
 for proto in (() if c['kind']=='isolated-copy' else ('tcp','udp')):v4.append(['-A','OUTPUT','-d','127.0.0.11','-p',proto,'-m','conntrack','--ctorigdst','127.0.0.11','--ctorigdstport','53','-j','ACCEPT'])
 # Reject private/LAN/host destinations BEFORE the general public443 allow.
 for address in gateways:v4.append(['-A','OUTPUT','-d',str(ipaddress.IPv4Address(address))+'/32','-j','REJECT'])
 for net in NONPUBLIC:v4.append(['-A','OUTPUT','-d',net,'-j','REJECT'])
 if c['kind']=='normal-two-network':v4.append(['-A','OUTPUT','-p','tcp','--dport','443','-j','ACCEPT'])
 v4.append(['-A','OUTPUT','-j','REJECT'])
 v6=common+[['-A','OUTPUT','-o','lo','-d','::1/128','-j','ACCEPT'],['-A','OUTPUT','-j','REJECT']]
 return {'iptables':v4,'ip6tables':v6}

def identity(c,cid,pid,ns):
 x=inspect(cid)
 if x.get('Id')!=cid or x.get('State',{}).get('Pid')!=pid or not x['State'].get('Running') or os.stat('/proc/'+str(pid)+'/ns/net').st_ino!=ns:raise ValueError('exact namespace identity changed')
 hc=x['HostConfig'];cfg=x['Config'];nets=x['NetworkSettings']['Networks']
 if x.get('Image')!=c['image_id'] or cfg.get('Image')!=c['image'] or cfg.get('Entrypoint')!=['sh'] or cfg.get('Cmd')!=['-c',GUARD]:raise ValueError('exact FIFO image command differs')
 if set(nets)!={c['backend']['name'],c['frontend']['name']} or any(nets[c[r]['name']].get('NetworkID')!=c[r]['id'] for r in ('backend','frontend')):raise ValueError('app network differs')
 for k,want in {'RestartPolicy':{'Name':'no','MaximumRetryCount':0},'CapDrop':['ALL'],'PortBindings':{'8080/tcp':[{'HostIp':'127.0.0.1','HostPort':str(c['port'])}]},'Dns':c['dns_upstreams'],'Memory':c['resources']['memory_bytes'],'MemorySwap':c['resources']['memory_bytes'],'PidsLimit':c['resources']['pids'],'NanoCpus':c['resources']['nano_cpus'],'Sysctls':{'net.ipv6.conf.all.disable_ipv6':'1','net.ipv6.conf.default.disable_ipv6':'1'}}.items():
  got=hc.get(k)
  if k=='Dns' and c['kind']=='isolated-copy' and got is None:got=[]
  if got!=want:raise ValueError('runtime security or network option differs')
 if hc.get('Privileged') or hc.get('CapAdd') or hc.get('ExtraHosts') or not any(v in ('no-new-privileges','no-new-privileges:true') for v in hc.get('SecurityOpt') or []):raise ValueError('runtime powers differ')
 mounts=x.get('Mounts',[])
 if len(mounts)!=1 or mounts[0].get('Source')!=c['data_dir'] or mounts[0].get('Destination')!='/data' or not mounts[0].get('RW') or mounts[0].get('Type')!='bind':raise ValueError('exact data mount required')
 return x

PROBE="""const net=require('net'),dns=require('dns').promises;async function tcp(h,p){return await new Promise(r=>{const s=net.connect(p,h);let done=false;const end=v=>{if(done)return;done=true;s.destroy();r(v)};s.setTimeout(1500);s.on('connect',()=>end(true));s.on('error',()=>end(false));s.on('timeout',()=>end(false))})};(async()=>{const a=JSON.parse(process.argv[1]);const out={};for(const [k,h,p]of a.tcp)out[k]=await tcp(h,p);for(const [k,h,expected]of a.dns){try{out[k]=(await dns.lookup(h,{family:4})).address===expected}catch{out[k]=false}};console.log(JSON.stringify(out))})().catch(()=>process.exit(1))"""

def lock_proof():
 if not LOCK_FDS or len(LOCK_FDS)!=len(LOCK_PATHS):raise ValueError('actual inherited exclusive locks required')
 for path,fd in zip(LOCK_PATHS,LOCK_FDS):
  p=Path(path);a=os.fstat(fd);b=p.lstat()
  if p.is_symlink() or not stat.S_ISREG(a.st_mode) or (a.st_dev,a.st_ino)!=(b.st_dev,b.st_ino):raise ValueError('lock inode differs')
  with p.open('a') as other:
   try:fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
   except BlockingIOError:pass
   else:raise ValueError('exclusive lock absent')
  fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)

def prepare(c):
 lock_proof();validate(c);env_path,raw=protected(c['env']);env=env_values(raw);topology(c)
 image=json.loads(call(['docker','image','inspect',c['image']]))[0]
 if image.get('Id')!=c['image_id'] or c['image'] not in image.get('RepoDigests',[]) or image.get('Config',{}).get('Labels',{}).get('org.opencontainers.image.revision')!=c['source_sha']:raise ValueError('image identity differs')
 return env_path,raw,env,image

def launch(c,before_effects):
 env_path,raw,env,image=prepare(c)
 # Docker refuses an already-existing name. Never replace a possibly live image.
 args=['docker','run','--memory',str(c['resources']['memory_bytes']),'--memory-swap',str(c['resources']['memory_bytes']),'--pids-limit',str(c['resources']['pids']),'--cpus',str(c['resources']['nano_cpus']/1000000000),'-d','--name',c['container'],'--restart','no','--cap-drop','ALL','--security-opt','no-new-privileges:true','--sysctl','net.ipv6.conf.all.disable_ipv6=1','--sysctl','net.ipv6.conf.default.disable_ipv6=1','--network',c['backend']['name'],'-p','127.0.0.1:'+str(c['port'])+':8080','-v',c['data_dir']+':/data','--env-file',str(env_path),'--entrypoint','sh',c['image'],'-c',GUARD]
 for resolver in c['dns_upstreams']:args[args.index('--entrypoint'):args.index('--entrypoint')]=['--dns',resolver]
 # The reviewed environment is read once. A sealed anonymous descriptor holds
 # those exact bytes for the Docker CLI, not a mutable pathname reread.
 fd=os.memfd_create('lyam-normal-env',os.MFD_ALLOW_SEALING);os.write(fd,raw);os.lseek(fd,0,os.SEEK_SET)
 fcntl.fcntl(fd,fcntl.F_ADD_SEALS,fcntl.F_SEAL_WRITE|fcntl.F_SEAL_GROW|fcntl.F_SEAL_SHRINK|fcntl.F_SEAL_SEAL)
 args[args.index('--env-file')+1]='/proc/self/fd/'+str(fd)
 try:cid=call(args,pass_fds=(fd,))
 finally:os.close(fd)
 effects=False
 try:
  call(['docker','network','connect',c['frontend']['id'],cid])
  x=inspect(cid);pid=x['State']['Pid'];ns=os.stat('/proc/'+str(pid)+'/ns/net').st_ino
  def nscmd(*args):identity(c,cid,pid,ns);return call(['nsenter','-t',str(pid),'-n',*args])
  gateways=[]
  for role in ('backend','frontend'):
   network=json.loads(call(['docker','network','inspect',c[role]['id']]))[0]
   candidates=[v.get('Gateway') for v in network.get('IPAM',{}).get('Config',[]) if v.get('Gateway') and ipaddress.ip_address(v['Gateway']).version==4]
   if len(candidates)!=1:raise ValueError('single IPv4 network gateway required')
   gateways.append(candidates[0])
  for tool,commands in rules(c,gateways+[x['NetworkSettings']['Networks'][c[r]['name']]['IPAddress'] for r in ('backend','frontend')]).items():
   if nscmd(tool,'-S')!='-P INPUT ACCEPT\n-P FORWARD ACCEPT\n-P OUTPUT ACCEPT':raise ValueError('unexpected preexisting filter policy')
   for command in commands:nscmd(tool,*command)
  if c['kind']=='isolated-copy':
   # A route into the INTERNAL bridge lets OUTPUT denial counters prove the
   # barrier instead of mistaking a missing route for firewall enforcement.
   nscmd('ip','route','replace','default','via',gateways[1])
   for proto in ('tcp','udp'):nscmd('iptables','-t','raw','-A','OUTPUT','-p',proto,'--dport','53','-j','DROP')
   hosts="require('fs').appendFileSync('/etc/hosts',"+json.dumps('\n'+c['pg']['ip']+' pg\n'+c['bao']['ip']+' bao\n')+")"
   call(['docker','exec',cid,'node','-e',hosts])
  exact={tool:nscmd(tool,'-S') for tool in ('iptables','ip6tables')}
  image_env=dict(v.split('=',1) for v in image['Config'].get('Env',[]));expected={**image_env,**env}
  if 'IAM_AUTOMATION_HOLD' in expected:raise ValueError('image must not bake HOLD')
  observed={}
  for item in identity(c,cid,pid,ns)['Config'].get('Env',[]):
   k,v=item.split('=',1)
   if k in observed:raise ValueError('duplicate runtime environment')
   observed[k]=v
  if observed!=expected:raise ValueError('actual runtime env differs from reviewed bytes')
  def reject_counter(tool):
   rows=[line.split() for line in nscmd(tool,'-nvx','-L','OUTPUT').splitlines() if ' REJECT ' in line]
   return sum(int(row[0]) for row in rows)
  negative=[('private','10.0.0.1',443),('private172','172.16.0.1',443),('private192','192.168.0.1',443),('metadata','169.254.169.254',443),('public_http',c['public_probe'],80),('public_smtp',c['public_probe'],25),('metadata80','169.254.169.254',80),('dns_other','8.8.4.4' if '8.8.4.4' not in c['dns_upstreams'] else '8.8.8.8',53)]
  if c['kind']=='isolated-copy':negative=[v for v in negative if v[0]!='dns_other']+[('public_https',c['public_probe'],443)]
  for role,gateway in zip(('backend','frontend'),gateways):
   ni=x['NetworkSettings']['Networks'][c[role]['name']]
   negative.extend([(role+'_gateway',gateway,443),(role+'_own',ni['IPAddress'],443)])
  for generation in range(3):
   tests={'tcp':[['pg',c['pg']['ip'],5432],['bao',c['bao']['ip'],8200],['https',c['public_probe'],443]],'dns':[['pg_alias','pg',c['pg']['ip']],['bao_alias','bao',c['bao']['ip']]]}
   result=json.loads(call(['docker','exec',cid,'node','-e',PROBE,json.dumps(tests)]))
   if result!={'pg':True,'bao':True,'https':c['kind']=='normal-two-network','pg_alias':True,'bao_alias':True}:raise ValueError('normal namespace probes failed')
   for name,host,port in negative:
    rule=['-p','tcp','-m','conntrack','--ctorigdst',host,'--ctorigdstport',str(port),'-m','comment','--comment','normal-probe-'+name]
    nscmd('iptables','-I','OUTPUT','1',*rule)
    try:
     before=reject_counter('iptables')
     outcome=json.loads(call(['docker','exec',cid,'node','-e',PROBE,json.dumps({'tcp':[[name,host,port]],'dns':[]})]))
     matched=[l.split() for l in nscmd('iptables','-nvx','-L','OUTPUT').splitlines() if 'normal-probe-'+name in l]
     if outcome!={name:False} or len(matched)!=1 or int(matched[0][0])<1 or reject_counter('iptables')<=before:raise ValueError('dedicated deny probe lacks actual rejection')
    finally:nscmd('iptables','-D','OUTPUT',*rule)
  for typ,proto in ([('3','1')] if c['kind']=='isolated-copy' else [('2','17'),('3','1')]):
   before=reject_counter('iptables')
   socketprobe="import socket,sys;s=socket.socket(socket.AF_INET,int(sys.argv[1]),int(sys.argv[2]));s.sendto(bytes.fromhex('0800f7fd00010001') if sys.argv[2]=='1' else b'fixture',(sys.argv[3],53))"
   try:nscmd('/usr/bin/python3','-c',socketprobe,typ,proto,('8.8.4.4' if '8.8.4.4' not in c['dns_upstreams'] else '8.8.8.8'))
   except ValueError:pass
   if reject_counter('iptables')<=before:raise ValueError('UDP/ICMP rejection not established')
  ipv6=call(['docker','exec',cid,'node','-e',"const f=require('fs');const names=f.readdirSync('/proc/sys/net/ipv6/conf').filter(n=>n!=='lo');if(names.some(n=>f.readFileSync('/proc/sys/net/ipv6/conf/'+n+'/disable_ipv6','utf8').trim()!=='1'))process.exit(1);console.log('IPV6_DISABLED')"])
  if ipv6!='IPV6_DISABLED':raise ValueError('IPv6 inactivity not proved')
  for tool,value in exact.items():
   if nscmd(tool,'-S')!=value:raise ValueError('network rules changed before app start')
  if c['kind']=='isolated-copy':
   dns="require('dns').resolve4('qualification-denied.example.com',e=>process.exit(e?0:1));setTimeout(()=>process.exit(0),2000)"
   call(['docker','exec',cid,'node','-e',dns])
   rawdns=nscmd('iptables','-t','raw','-nvx','-L','OUTPUT')
   if not any(len(l.split())>2 and l.split()[2]=='DROP' and int(l.split()[0])>0 for l in rawdns.splitlines()):raise ValueError('real DNS denial counter required')
  tls="const https=require('https'),dns=require('dns').promises;(async()=>{await dns.lookup(process.argv[1],{family:4});https.get('https://'+process.argv[1]+'/',{timeout:10000},r=>{r.resume();console.log('TLS_DNS_OK')}).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))})().catch(()=>process.exit(1))"
  if c['kind']=='normal-two-network' and call(['docker','exec',cid,'node','-e',tls,c['tls_probe']])!='TLS_DNS_OK':raise ValueError('verified DNS/TLS probe failed')
  status=call(['docker','exec',cid,'node','-e',"console.log(require('fs').readFileSync('/proc/1/status','utf8').split('\\n').filter(x=>/^(CapEff|CapBnd|NoNewPrivs):/.test(x)).join('\\n'))"])
  if not re.search(r'CapEff:\s+0+\b',status) or not re.search(r'CapBnd:\s+0+\b',status) or not re.search(r'NoNewPrivs:\s+1\b',status):raise ValueError('live capability proof failed')
  topology(c);protected(c['env']);identity(c,cid,pid,ns)
  proof={'format':1,'kind':'normal-launch-observation','container_id':cid,'namespace_inode':ns,'pid':pid,'config_sha256':sha(json.dumps(c,sort_keys=True).encode()),'env_sha256':sha(raw),'rules':exact,'probes':result,'limitation':'No release, external backlog, health, persistence or TLS qualification implied'}
  proof['runtime_kind']=c['kind']
  if c['kind']=='isolated-copy':proof['raw_dns_rules']=nscmd('iptables','-t','raw','-S');proof['limitation']='Isolated copy only. No public DNS/TLS/provider/normal-egress proof'
  # Caller must atomically persist effects-released BEFORE this returns. A
  # persistence error prevents FIFO write. After marker, ambiguous means no retry.
  effects=True
  before_effects(proof)
  topology(c);identity(c,cid,pid,ns)
  call(['docker','exec',cid,'sh','-c','test -p '+FIFO+' && printf "%s\n" start-normal > '+FIFO])
  return proof
 except BaseException:
  # New container only, never start it again or restore anything automatically.
  call(['docker','stop',cid])
  if not effects:call(['docker','rm',cid])
  raise

def postcheck(c,proof):
 lock_proof();validate(c);topology(c);env_path,raw=protected(c['env']);env=env_values(raw)
 if set(proof.get('rules',{}))!={'iptables','ip6tables'}:raise ValueError('complete namespace policy observation required')
 if proof.get('config_sha256')!=sha(json.dumps(c,sort_keys=True).encode()):raise ValueError('launcher contract changed')
 x=identity(c,proof['container_id'],proof['pid'],proof['namespace_inode'])
 image=json.loads(call(['docker','image','inspect',c['image']]))[0]
 if image.get('Id')!=c['image_id'] or image.get('Config',{}).get('Labels',{}).get('org.opencontainers.image.revision')!=c['source_sha']:raise ValueError('postcheck image binding changed')
 expected={**dict(v.split('=',1) for v in image['Config'].get('Env',[])),**env}
 observed=dict(v.split('=',1) for v in x['Config'].get('Env',[]))
 if expected!=observed or len(observed)!=len(x['Config'].get('Env',[])):raise ValueError('postcheck runtime environment differs')
 for tool,value in proof['rules'].items():
  if tool not in ('iptables','ip6tables') or call(['nsenter','-t',str(proof['pid']),'-n',tool,'-S'])!=value:raise ValueError('normal namespace policy changed')
 if c['kind']=='isolated-copy' and call(['nsenter','-t',str(proof['pid']),'-n','iptables','-t','raw','-S'])!=proof.get('raw_dns_rules'):raise ValueError('copy raw DNS overlay changed')
 return {'live_verified':True,'container_id':proof['container_id'],'namespace_inode':proof['namespace_inode']}
