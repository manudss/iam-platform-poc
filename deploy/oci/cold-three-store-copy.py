#!/usr/bin/env python3
"""Cold three-store restore + isolated replay for the CURRENT baseline (v2).
Fixed adapter, no CLI, no spec-selected commands. Only touches: baseline
archives (read), /opt/lyam-qualification/copies/<engagement> (create), and its
own labelled docker networks/containers. NOT Docker-qualified: needs a real
GHA fixture run before any claim of readiness.
Order: restore -> two internal networks (inspected) -> companions created with
static IP + FIFO guard (not started) -> witness bound to IPs -> start -> namespace
fence -> release FIFO -> Bao unseal from local root-0600 file via stdin ->
producer normal-runtime.launch(kind isolated-copy) -> fixed probes -> exact cleanup.
"""
import hashlib,ipaddress,json,os,re,stat,tarfile,time
from pathlib import Path
COPIES=Path('/opt/lyam-qualification/copies')
ROLES=('dolt','pg','bao')
ENG=re.compile(r'[a-z0-9][a-z0-9-]{3,40}')
IMG=re.compile(r'sha256:[0-9a-f]{64}')
BAO_CMD=['server','-config=/bao/config/bao.hcl']  # live args; image Cmd is dev mode, never reused
FIFO='/tmp/lyam-companion-start.fifo'
# Wrapper runs BEFORE the original entrypoint; original argv is passed as "$@".
GUARD='set -eu; rm -f '+FIFO+'; mkfifo -m 600 '+FIFO+'; read -r p < '+FIFO+'; [ "$p" = start-companion ]; rm -f '+FIFO+'; exec "$@"'

def sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for c in iter(lambda:f.read(1<<20),b''):h.update(c)
 return h.hexdigest()

def safe_extract(archive,dest,top):
 """Regular files/dirs only, single expected top dir. uid/gid/modes kept (copy only)."""
 with tarfile.open(archive,'r:gz') as t:
  members=t.getmembers()
  if not members:raise ValueError('empty archive')
  for m in members:
   parts=Path(m.name).parts
   if m.name.startswith('/') or '..' in parts or not parts or parts[0]!=top:raise ValueError('archive member outside store dir')
   if not (m.isreg() or m.isdir()):raise ValueError('archive link/device member refused')
  for m in members:
   try:t.extract(m,dest,numeric_owner=True,filter='tar')
   except TypeError:t.extract(m,dest,numeric_owner=True)
 return len(members)

def restore(baseline,spec,engagement_dir):
 out={}
 for role in ROLES:
  a=baseline['archives'][role];p=Path(a['path'])
  if p.is_symlink() or sha(p)!=a['sha256']:raise ValueError('archive differs from baseline hash')
  dest=engagement_dir/role;dest.mkdir(mode=0o700)
  top=Path(spec['stores'][role]['path']).name
  n=safe_extract(p,dest,top)
  if sha(p)!=a['sha256']:raise ValueError('archive moved during restore')
  st=spec['stores'][role]
  if st.get('uid') is not None and st.get('gid') is not None:
   o=(dest/top).lstat()
   if (o.st_uid,o.st_gid)!=(st['uid'],st['gid']):raise ValueError('restored store owner differs from spec')
  out[role]={'path':str(dest/top),'archive_sha256':a['sha256'],'members':n}
 return out

def private_root_file(p):
 p=Path(p);s=p.lstat()
 if p.is_symlink() or not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or stat.S_IMODE(s.st_mode)!=0o600:raise ValueError('root-owned 0600 regular file required')
 return p

def check_copy_root(root):
 st=root.lstat()
 if st.st_uid!=0 or stat.S_IMODE(st.st_mode)!=0o700:raise ValueError('private copy root required')

def check_spec(spec):
  """Refuse any spec still carrying unresolved (null) bindings."""
  def walk(v,path):
   if v is None:raise ValueError('unresolved binding: '+path)
   if isinstance(v,dict):
    for k,x in v.items():
     if k in ('restart_count','uid','gid') and path.startswith(('identities.app','stores.dolt')) and x is None:raise ValueError('unresolved binding: '+path+'.'+k)
     if x is not None:walk(x,path+'.'+k)
  for k in ('identities','stores'):walk(spec[k],k)
  for r in ('app','pg','bao'):
   if not IMG.fullmatch(spec['identities'][r].get('image_id') or ''):raise ValueError('image id (not registry digest) required: '+r)
  return spec

class Isolated:
 """run(args,input_bytes=None)->str is the only effect channel (docker/nsenter).
 witness: host guard module. launcher: producer normal-runtime module."""
 def __init__(self,run,witness,launcher,prepare_env,clock=time.time):
  self.run=run;self.w=witness;self.L=launcher;self.prep=prepare_env;self.steps=[]
 def do(self,label,args,inp=None):
  self.steps.append('begin-'+label)
  out=self.run(args,inp);self.steps.append(label);return out
 def js(self,label,args):return json.loads(self.do(label,args))[0]

 def network(self,eng,name,subnet,track):
  net=ipaddress.IPv4Network(subnet)
  if not net.is_private:raise ValueError('private subnet required')
  self.do('net-'+name,['docker','network','create','--driver','bridge','--internal','--subnet',str(net),'--gateway',str(net.network_address+1),'--label','lyam-qualification='+eng,name]);track.append(name)
  n=self.js('inspect-net-'+name,['docker','network','inspect',name])
  cfg=n.get('IPAM',{}).get('Config',[])
  if n.get('Internal') is not True or n.get('EnableIPv6') is not False or n.get('Driver')!='bridge' or n.get('Containers') or [c.get('Subnet') for c in cfg]!=[str(net)]:raise ValueError('copy network differs from spec')
  return n['Id']

 def companion(self,eng,role,name,image_id,net,ip,mounts,extra_ro=(),cmd=None,user=None,tmpfs=()):
  if not IMG.fullmatch(image_id):raise ValueError('immutable image id required')
  im=self.js('image-'+role,['docker','image','inspect',image_id])
  orig=(im['Config'].get('Entrypoint') or [])+(cmd if cmd is not None else (im['Config'].get('Cmd') or []))
  if any('-dev' in x for x in orig):raise ValueError('dev-mode command refused')
  if not orig:raise ValueError('image has no entrypoint to guard')
  a=['docker','create','--memory',('536870912' if role=='pg' else '268435456'),'--memory-swap',('536870912' if role=='pg' else '268435456'),'--pids-limit',('128' if role=='pg' else '64'),'--cpus','0.25','--name',name,'--network',net,'--ip',ip,'--network-alias',role,'--cap-drop','ALL','--security-opt','no-new-privileges:true','--restart','no','--label','lyam-qualification='+eng,'--entrypoint','sh','--sysctl','net.ipv6.conf.all.disable_ipv6=1','--sysctl','net.ipv6.conf.default.disable_ipv6=1']
  if user:a+=['--user',user]
  for spec_t in tmpfs:a+=['--tmpfs',spec_t]
  for h,c in mounts:a+=['-v',h+':'+c]
  for h,c in extra_ro:a+=['-v',h+':'+c+':ro']
  cid=self.do('create-'+role,a+[image_id,'-c',GUARD,'sh']+orig).strip()
  return cid

 def uidgid(self,spec,role):
  i=spec['identities'][role]
  if type(i.get('uid')) is not int or type(i.get('gid')) is not int:raise ValueError('companion uid/gid required, root chown fails under cap-drop ALL')
  return i['uid'],i['gid']
 def own(self,spec,role):return '%d:%d'%self.uidgid(spec,role)

 def fence(self,pid,probe_ip,gateway=None):
  """Default-deny egress in the companion netns BEFORE FIFO release.
  OUTPUT/ FORWARD policy DROP first, IPv6 DROP, then allow only loopback and
  conntrack REPLY (not RELATED). TCP/443 negative probe must move the drop counter."""
  def ns(tool,*a):return self.do('fence-'+tool,['nsenter','-t',str(pid),'-n',tool,*a])
  for tool in ('iptables','ip6tables'):
   ns(tool,'-P','OUTPUT','DROP');ns(tool,'-P','FORWARD','DROP')
  if gateway:ns('ip','route','replace','default','via',gateway)
  for proto in ('tcp','udp'):ns('iptables','-t','raw','-A','OUTPUT','-p',proto,'--dport','53','-j','DROP')
  ns('iptables','-A','OUTPUT','-o','lo','-j','ACCEPT')
  ns('iptables','-A','OUTPUT','-m','conntrack','--ctstate','ESTABLISHED','--ctdir','REPLY','-j','ACCEPT')
  rules=ns('iptables','-S');rules6=ns('ip6tables','-S')
  if '-P OUTPUT DROP' not in rules or '-P OUTPUT DROP' not in rules6 or 'RELATED' in rules:raise ValueError('default-deny egress not established')
  def dropped():
   m=re.search(r'policy DROP (\d+) packets',ns('iptables','-nvx','-L','OUTPUT'))
   if not m:raise ValueError('output drop counter unreadable')
   return int(m.group(1))
  before=dropped()
  try:
   self.do('fence-probe443',['nsenter','-t',str(pid),'-n','python3','-c','import socket,sys;s=socket.socket();s.settimeout(2);s.connect((sys.argv[1],443))',probe_ip])
   raise ValueError('companion reached TCP/443: fence failed')
  except ValueError as e:
   if 'fence failed' in str(e):raise
  if dropped()<=before:raise ValueError('negative probe not counted by DROP policy')
  dns="import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)\ntry:s.sendto(b'copy-deny',('127.0.0.11',53))\nexcept OSError:pass"
  self.do('fence-probeDNS',['nsenter','-t',str(pid),'-n','/usr/bin/python3','-c',dns])
  raw=ns('iptables','-t','raw','-nvx','-L','OUTPUT')
  if not any(len(l.split())>2 and l.split()[2]=='DROP' and int(l.split()[0])>0 for l in raw.splitlines()):raise ValueError('companion raw DNS deny counter missing')
  return rules

 def counters(self,pid):
  out={}
  for table in ('filter','raw'):
   raw=self.do('counter-'+table,['nsenter','-t',str(pid),'-n','iptables','-t',table,'-nvx','-L','OUTPUT'])
   policy=re.search(r'policy DROP (\d+) packets',raw)
   out[table]=[int(policy.group(1)) if policy else 0]+[int(l.split()[0]) for l in raw.splitlines() if len(l.split())>2 and l.split()[2] in ('DROP','REJECT')]
  return out

 def unseal(self,name,binding):
  """binding={'path','sha256'}: operator keys.json. Only unseal_keys_b64 is read;
  root_token is never read into a variable. Key goes via stdin, never argv/log."""
  p=private_root_file(binding['path']);raw=p.read_bytes()
  if hashlib.sha256(raw).hexdigest()!=binding['sha256']:raise ValueError('unseal key file differs from reviewed binding')
  d=json.loads(raw);keys=d.get('unseal_keys_b64');th=d.get('unseal_threshold')
  if not isinstance(keys,list) or not keys or any(not isinstance(k,str) or not k for k in keys) or type(th) is not int or not 1<=th<=len(keys):raise ValueError('unexpected unseal key schema')
  del d
  observed=self.js('bao-unseal-identity',['docker','inspect',name]);pid=observed['State']['Pid']
  # Host Python joins only copied Bao network namespace. JSON key on stdin,
  # fixed loopback API, no token, no key argv, no reliance on CLI prompt/dash.
  source="import json,sys,time,urllib.request;payload=sys.stdin.buffer.read();req=urllib.request.Request('http://127.0.0.1:8200/v1/sys/unseal',data=payload,headers={'Content-Type':'application/json'})\nfor attempt in range(60):\n try:\n  with urllib.request.urlopen(req,timeout=3) as response:state=json.load(response)\n  print(json.dumps({'sealed':state['sealed']}));break\n except OSError:\n  if attempt==59:raise\n  time.sleep(.5)"
  for k in keys[:th]:
   response=json.loads(self.do('unseal',['nsenter','-t',str(pid),'-n','/usr/bin/python3','-c',source],json.dumps({'key':k}).encode()))
  if response.get('sealed') is not False:raise ValueError('bao still sealed')

 def before_with_placeholder(self,eng,names,spec,restored,probes,mark):
  """qualification.py --phase before needs an existing STOPPED container of the app
  name. Hardened never-started placeholder (network none, no mounts); durable
  markers before creation and after its id is known, before any capture; exact-id
  removal + proven absence before lifecycle.launch. before proves restored DATA,
  not the final container."""
  name=names['app'];label='lyam-qualification='+eng
  if self.run(['docker','ps','-a','-q','--filter','name=^'+name+'$'],None).strip():raise ValueError('app name already present')
  mark({'phase':'placeholder-planned','engagement':eng,'name':name})
  pid=self.do('placeholder-create',['docker','create','--name',name,'--network','none','--restart','no','--cap-drop','ALL','--read-only','--security-opt','no-new-privileges:true','--memory','64m','--memory-swap','64m','--pids-limit','16','--label',label,'--label','lyam-placeholder=1','--entrypoint','node',spec['identities']['app']['image_id']]).strip()
  err=None
  try:
   mark({'phase':'placeholder-created','engagement':eng,'name':name,'id':pid})
   def check():
    x=self.js('placeholder-inspect',['docker','inspect',pid]);st=x['State'];lab=x.get('Config',{}).get('Labels') or {}
    if x.get('Id')!=pid or x['Name'].lstrip('/')!=name or lab.get('lyam-qualification')!=eng or lab.get('lyam-placeholder')!='1':raise ValueError('placeholder identity differs')
    if st.get('Running') is not False or st.get('Status')!='created' or not str(st.get('StartedAt','')).startswith('0001-01-01') or x.get('Mounts') or x['HostConfig'].get('NetworkMode')!='none':raise ValueError('placeholder not pristine/stopped')
   check()
   probes.before(names,restored,None)
   check()  # still never started after capture
  except BaseException as e:err=e
  finally:
   self.run(['docker','rm','-v',pid],None)
   if self.run(['docker','ps','-a','-q','--filter','name=^'+name+'$'],None).strip():raise ValueError('placeholder still present')
  if err:raise err

 def qualify(self,baseline,spec,env_binding,probes,before_effects,lifecycle,evidence_path):
  """probes: reviewed object with before(names,restored,proof)->None (app still
  behind FIFO, must raise on failure) and after(names,restored,proof)->{'ok':True,...}.
  lifecycle=producer normal-lifecycle module (durable attempt/effects/launched);
  its launch(c,evidence_path,n) is the ONLY app start path."""
  if not callable(before_effects) or not callable(getattr(probes,'before',None)) or not callable(getattr(probes,'after',None)) or not hasattr(lifecycle,'launch') or not evidence_path:raise ValueError('durable effect marker and fixed probes required before any effect')
  self.L.lock_proof()
  check_spec(spec)
  eng=spec['engagement_id']
  if not ENG.fullmatch(eng):raise ValueError('bounded engagement id required')
  if isinstance(probes,Qualification):probes.bind_copy(spec,env_binding)
  if baseline.get('coherent_three_store_backup') is not True or baseline.get('target')!=spec['target'] or set(baseline.get('archives',{}))!=set(ROLES):raise ValueError('baseline not bound to target')
  c=spec['copy'];root=COPIES/eng
  for role in ('pg','bao','app'):
   if self.run(['docker','ps','-aq','--filter','name=^lq-'+eng+'-'+role+'$'],None).strip():raise ValueError('copy container name already exists, operator review')
  for role in ('backend','frontend'):
   if self.run(['docker','network','ls','-q','--filter','name=^'+c[role]['name']+'$'],None).strip():raise ValueError('copy network name already exists, operator review')
  if root.parent!=COPIES or root.is_symlink():raise ValueError('copy root unsafe')
  if c['backend']['name']==c['frontend']['name'] or not ENG.fullmatch(eng):raise ValueError('two distinct networks required')
  COPIES.mkdir(mode=0o700,exist_ok=True);root.mkdir(mode=0o700,exist_ok=True)
  check_copy_root(root)
  fd=os.open(root/'RESTORE-STARTED',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  os.close(fd)
  names={r:'lq-'+eng+'-'+r for r in ('pg','bao','app')};nets=[];made=[];result=None;err=None;binding=None;app_binding=None;app_before=None;counter_before={}
  try:
   restored=restore(baseline,spec,root)
   ids={}
   for role in ('backend','frontend'):
    ids[role]=self.network(eng,c[role]['name'],c[role]['subnet'],nets)
   bao_source=private_root_file(c['bao_hcl_copy'])
   # Keep reviewed source root600. Runtime bind is group-readable ONLY by copied
   # Bao native gid; directory traversal on host is not exposed inside bind.
   bao_hcl=root/'bao-runtime.hcl';fd=os.open(bao_hcl,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o640)
   with os.fdopen(fd,'wb') as file:file.write(bao_source.read_bytes());file.flush();os.fsync(file.fileno())
   os.chown(bao_hcl,0,self.uidgid(spec,'bao')[1]);bao_hcl.chmod(0o640)
   cid={}
   cid['pg']=self.companion(eng,'pg',names['pg'],spec['identities']['pg']['image_id'],c['backend']['name'],c['ips']['pg'],[(restored['pg']['path'],'/var/lib/postgresql/data')],user=self.own(spec,'pg'),tmpfs=['/var/run/postgresql:uid=%d,gid=%d,mode=0755'%self.uidgid(spec,'pg')]);made.append(names['pg'])
   cid['bao']=self.companion(eng,'bao',names['bao'],spec['identities']['bao']['image_id'],c['backend']['name'],c['ips']['bao'],[(restored['bao']['path'],'/bao/file')],[(str(bao_hcl),'/bao/config/bao.hcl')],cmd=BAO_CMD,user=self.own(spec,'bao'));made.append(names['bao'])
   # witness bound to static IPs BEFORE any docker start
   binding=self.w.install('LQ'+hashlib.sha256(eng.encode()).hexdigest()[:12],[c['ips']['pg'],c['ips']['bao']],c['backend']['subnet'])
   before=self.w.snapshot(binding)
   pids={}
   before_effects({'phase':'companions-start','engagement':eng,'networks':ids,'companions':cid})  # durable marker BEFORE any start/permit; raising aborts
   for r in ('pg','bao'):
    self.do('start-'+r,['docker','start',names[r]])
    x=self.js('inspect-'+r,['docker','inspect',names[r]])
    nw=x['NetworkSettings']['Networks'][c['backend']['name']]
    if x['HostConfig'].get('PortBindings') or nw['IPAddress']!=c['ips'][r] or r not in nw.get('Aliases',[]) or x['State'].get('Running') is not True:raise ValueError('companion identity/ip/alias differs')
    pids[r]=x['State']['Pid']
    self.w.probe(binding,pids[r],c['ips'][r])
    self.fence(pids[r],c['public_probe'],str(ipaddress.IPv4Network(c['backend']['subnet']).network_address+1))
    counter_before[r]=self.counters(pids[r])
   before=self.w.snapshot(binding)
   for r in ('pg','bao'):
    self.do('release-'+r,['docker','exec',names[r],'sh','-c','test -p '+FIFO+' && printf "%s\\n" start-companion > '+FIFO])
   self.unseal(names['bao'],c['unseal_key_binding'])
   contract={'format':1,'kind':'isolated-copy','image':spec['identities']['app']['image'],'image_id':spec['identities']['app']['image_id'],'container':names['app'],'data_dir':restored['dolt']['path'],'port':c['port'],'env':env_binding,'backend':{'name':c['backend']['name'],'id':ids['backend']},'frontend':{'name':c['frontend']['name'],'id':ids['frontend']},'pg':{'name':names['pg'],'id':cid['pg'],'ip':c['ips']['pg']},'bao':{'name':names['bao'],'id':cid['bao'],'ip':c['ips']['bao']},'public_probe':c['public_probe'],'source_sha':spec['target']['sha'],'tls_probe':c['tls_probe'],'dns_upstreams':[],'companion_extra_internal':[],'resources':c['resources']}
   if getattr(probes,'before_phase','in-launch')=='pre-launch':self.before_with_placeholder(eng,names,spec,restored,probes,before_effects)
   iso=self
   class Proxy:
    def __getattr__(s,k):return getattr(iso.L,k)
    def launch(s,cc,effects):
     # before-phase runs while app is created but still behind its FIFO; failure
     # raises before the durable effects marker, so no permit is written.
     def commit(proof):
      nonlocal app_binding,app_before
      app=iso.js('copy-app-identity',['docker','inspect',proof['container_id']])
      ips=[entry['IPAddress'] for entry in app['NetworkSettings']['Networks'].values()]
      app_binding=iso.w.install('LQ'+hashlib.sha256((eng+'app').encode()).hexdigest()[:12],ips,c['backend']['subnet'])
      for ip in ips:iso.w.probe(app_binding,proof['pid'],ip)
      app_before=iso.w.snapshot(app_binding);counter_before['app']=iso.counters(proof['pid'])
      if getattr(probes,'before_phase','in-launch')!='pre-launch':probes.before(names,restored,proof)
      effects(proof)
     return iso.L.launch(cc,commit)

   # Own the exact fixed name before launch, including ambiguous marker failures.
   made.append(names['app'])
   launched=lifecycle.launch(contract,evidence_path,Proxy())
   pr=probes.after(names,restored,launched)
   after=self.w.snapshot(binding);quiet=self.w.verify_quiet(before,after)
   if app_binding:self.w.verify_quiet(app_before,self.w.snapshot(app_binding))
   for role,pid in {**pids,'app':launched.get('pid')}.items():
    if pid is not None and self.counters(pid)!=counter_before[role]:raise ValueError('copy initiated denied traffic after permit: '+role)
   if not isinstance(pr,dict) or pr.get('ok') is not True:raise ValueError('fixed copy probes failed')
   result={'direct_execution':True,'baseline':baseline,'target':spec['target'],'historical_preservation_claimed':False,'restored':restored,'guard':quiet,'launch_proof_sha256':hashlib.sha256(json.dumps(launched,sort_keys=True,default=str).encode()).hexdigest(),'probe':pr,'steps':list(self.steps)}
  except BaseException as e:err=e
  finally:
   failures=[]
   try:self.cleanup(made,nets,names)
   except BaseException as e:failures.append(type(e).__name__+':'+('witness:'+','.join(k for k in ('delete-own-hook','foreign-reference-or-chain-content','delete-own-chain','own-rule-remains','protected-firewall-changed') if k in str(e)) if 'witness' in str(e) else 'container-network'))
   if app_binding and hasattr(self.w,'cleanup'):
    try:self.w.cleanup(app_binding)
    except BaseException as e:failures.append(type(e).__name__+':'+('witness:'+','.join(k for k in ('delete-own-hook','foreign-reference-or-chain-content','delete-own-chain','own-rule-remains','protected-firewall-changed') if k in str(e)) if 'witness' in str(e) else 'container-network'))
   if binding and hasattr(self.w,'cleanup'):
    try:self.w.cleanup(binding)
    except BaseException as e:failures.append(type(e).__name__+':'+('witness:'+','.join(k for k in ('delete-own-hook','foreign-reference-or-chain-content','delete-own-chain','own-rule-remains','protected-firewall-changed') if k in str(e)) if 'witness' in str(e) else 'container-network'))
   if failures:raise ValueError('copy cleanup incomplete: '+','.join(failures)) from err
  if err:raise err
  result['cleanup']=[]
  result['retained_private_copy']={'path':str(root),'mode':'0700','contains_copied_secrets':True,'purged':False,'retained_at':time.time(),'purge_due_at':time.time()+7200,'purge_requires_operator':True}
  return result

 def cleanup(self,made,nets,names):
  """No swallowing: remove, then inspect exact absence, else raise."""
  for n in reversed(made):self.run(['docker','rm','-f','-v',n],None)
  for n in nets:self.run(['docker','network','rm',n],None)
  for n in made:
   if self.run(['docker','ps','-a','-q','--filter','name=^'+n+'$'],None).strip():raise ValueError('copy container still present')
  for n in nets:
   if self.run(['docker','network','ls','-q','--filter','name=^'+n+'$'],None).strip():raise ValueError('copy network still present')


class Qualification:
  """Fixed qualification.py caller (producer file, hash-bound). CLI per the
  attached source: --phase --container --image --env-file --data-dir --backup-dir
  --barrier-file --target-image --evidence-dir --policy --isolated-loopback-test.
  No shell, no secrets in argv (policy/auth/token are files named by the policy).
  'before' REQUIRES `docker inspect -f {{.State.Running}} <container>` == false and
  runs `docker run --rm` itself, so it must happen before the app container exists
  or while it is a stopped placeholder: see open question to producer."""
  before_phase='pre-launch'
  def __init__(self,run,script,script_sha256,policy,env_path,barrier,backup_dir,evidence_dir,image,
               load=lambda p:Path(p).read_bytes()):
    self.run=run;self.script=Path(script);self.policy=policy;self.env=env_path;self.barrier=barrier
    self.backup=backup_dir;self.evidence=evidence_dir;self.image=image
    if hashlib.sha256(load(script)).hexdigest()!=script_sha256:raise ValueError('qualification code differs from reviewed hash')
    self.done=[]
  def bind_copy(self,spec,env_binding):
    root=COPIES/spec['engagement_id'];c=spec['copy']
    binding=c.get('policy_binding',{})
    p=private_root_file(self.policy);raw=p.read_bytes()
    if binding.get('path')!=str(p) or hashlib.sha256(raw).hexdigest()!=binding.get('sha256'):raise ValueError('exact copy policy hash binding required')
    policy=json.loads(raw);prefix='lq-'+spec['engagement_id']
    expected={'pgContainer':prefix+'-pg','baoContainer':prefix+'-bao','network':c['backend']['name'],'baoAddress':'http://'+c['ips']['bao']+':8200','isolatedCopy':True,'isolatedLoopbackTest':True,'requireAutomationHold':False}
    if any(policy.get(k)!=v for k,v in expected.items()):raise ValueError('copy policy contacts wrong service or mode')
    for path in [self.policy,self.env,self.barrier,self.backup,self.evidence,policy['authFile'],policy['baoTokenFile']]:
     pp=Path(path)
     if root not in pp.parents or '..' in pp.parts:raise ValueError('copy policy paths must stay under engagement root')
    if env_binding['path']!=self.env:raise ValueError('copy env binding differs from qualifier')
    if not policy.get('origins') or any(not o.startswith('http://127.0.0.1:') for o in policy['origins']):raise ValueError('only exact copy loopback front allowed')
    self.policy_binding=binding
    self.ledger_binding=c.get('migration_ledger_binding')
    if not isinstance(self.ledger_binding,dict) or set(self.ledger_binding)!={'present','sha256'} or type(self.ledger_binding['present']) is not bool:raise ValueError('copied migration ledger binding required')
  def args(self,phase,names,restored):
    return ['python3',str(self.script),'--phase',phase,'--container',names['app'],'--image',self.image,'--env-file',self.env,
      '--data-dir',restored['dolt']['path'],'--backup-dir',self.backup,'--barrier-file',self.barrier,'--target-image',self.image,
      '--evidence-dir',self.evidence,'--policy',self.policy,'--isolated-loopback-test']
  def before(self,names,restored,proof):
    if not hasattr(self,'policy_binding') or hashlib.sha256(Path(self.policy).read_bytes()).hexdigest()!=self.policy_binding['sha256']:raise ValueError('copy policy not bound or changed')
    ledger=Path(restored['dolt']['path'])/'migrations/journal.json'
    if hasattr(self,'ledger_binding'):
     expected=self.ledger_binding
     if ledger.exists()!=expected['present'] or (sha(ledger) if ledger.exists() else None)!=expected['sha256']:raise ValueError('restored migration ledger differs from reviewed baseline')
    self.run(self.args('before',names,restored),None);self.done.append('before')
  def after(self,names,restored,launched):
    if not hasattr(self,'policy_binding') or hashlib.sha256(Path(self.policy).read_bytes()).hexdigest()!=self.policy_binding['sha256']:raise ValueError('copy policy changed')
    if self.done!=['before']:raise ValueError('before phase must precede after')
    out=self.run(self.args('after',names,restored),None);self.done.append('after')
    ev=Path(self.evidence)
    files={f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(ev.iterdir()) if f.is_file()} if ev.is_dir() else {}
    if 'before.json' not in files or not any(n.startswith('after-') for n in files) or not any(n.startswith('smoke-') for n in files):raise ValueError('qualification evidence incomplete')
    return {'ok':True,'phases':list(self.done),'evidence_sha256':files,'transport':'ISOLATED_LOOPBACK_NO_PUBLIC_TLS_PROOF'}
