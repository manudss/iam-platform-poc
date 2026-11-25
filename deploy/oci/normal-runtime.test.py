import copy,hashlib,importlib.util,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('normal',Path(__file__).with_name('normal-runtime.py'));n=importlib.util.module_from_spec(s);s.loader.exec_module(n)
class Tests(unittest.TestCase):
 def setUp(self):
  self.proof=patch.object(n,'lock_proof');self.proof.start();self.addCleanup(self.proof.stop)
 def config(self,d):
  return {'format':1,'kind':'normal-two-network','image':'ghcr.io/manudss/iam-platform-poc@sha256:'+'a'*64,'image_id':'sha256:'+'b'*64,'source_sha':'c'*40,'container':'app-normal','data_dir':d,'port':8080,'env':{'path':d+'/env','sha256':'d'*64},'backend':{'name':'backend','id':'e'*64},'frontend':{'name':'front','id':'f'*64},'pg':{'name':'pg','id':'1'*64,'ip':'172.19.0.10'},'bao':{'name':'bao','id':'2'*64,'ip':'172.19.0.11'},'public_probe':'1.1.1.1','tls_probe':'example.com','dns_upstreams':['1.1.1.1','9.9.9.9'],'companion_extra_internal':[]}
 def test_closed_default_ipv4_order_and_ipv6_drop(self):
  with tempfile.TemporaryDirectory() as d:
   c=self.config(d);n.validate(c);rules=n.rules(c)
   public=rules['iptables'].index(['-A','OUTPUT','-p','tcp','--dport','443','-j','ACCEPT'])
   for net in n.NONPUBLIC:self.assertLess(rules['iptables'].index(['-A','OUTPUT','-d',net,'-j','REJECT']),public)
   self.assertEqual(rules['ip6tables'][0],['-P','OUTPUT','DROP']);self.assertEqual(rules['ip6tables'][-1][-2:],['-j','REJECT'])
 def test_ambiguous_normal_env_or_tls_override_refuses(self):
  self.assertEqual(n.env_values(b'IAM_DEMO_SEED_MODE=never\n'),{'IAM_DEMO_SEED_MODE':'never'})
  for raw in [b'IAM_DEMO_SEED_MODE=never\nIAM_AUTOMATION_HOLD=0\n',b'IAM_DEMO_SEED_MODE=never\nNODE_TLS_REJECT_UNAUTHORIZED=0\n',b'IAM_DEMO_SEED_MODE=never\nIAM_DEMO_SEED_MODE=never\n']:
   with self.assertRaises(ValueError):n.env_values(raw)
 def test_invalid_topology_bindings_refuse(self):
  with tempfile.TemporaryDirectory() as d:
   for mutate in [lambda c:c.update(port=80),lambda c:c.update(public_probe='169.254.169.254'),lambda c:c.update(frontend=c['backend']),lambda c:c.update(source_sha='moving')]:
    c=self.config(d);mutate(c)
    with self.assertRaises(ValueError):n.validate(c)
 def test_fifo_regenerated_on_every_start(self):
  self.assertIn('rm -f '+n.FIFO+'; mkfifo',n.GUARD);self.assertLess(n.GUARD.index('read -r permit'),n.GUARD.index('exec sh /app/demo/start.sh'))
 def test_pre_fifo_failure_stops_and_removes_only_new_container_no_effect_callback(self):
  with tempfile.TemporaryDirectory() as d:
   c=self.config(d);raw=b'IAM_DEMO_SEED_MODE=never\n';c['env']['sha256']=hashlib.sha256(raw).hexdigest();trace=[];effects=[]
   def call(args,pass_fds=()):
    trace.append(args)
    if args[:3]==['docker','image','inspect']:return json.dumps([{'Id':c['image_id'],'RepoDigests':[c['image']],'Config':{'Env':[],'Labels':{'org.opencontainers.image.revision':c['source_sha']}}}])
    if args[:2]==['docker','run']:
     self.assertEqual(len(pass_fds),1);self.assertEqual(os.read(pass_fds[0],999),raw)
     with self.assertRaises(OSError):os.write(pass_fds[0],b'changed')
     return 'new-container'
    if args[:3]==['docker','network','connect']:raise ValueError('injected before namespace probes')
    if args[:2] in (['docker','stop'],['docker','rm']):return ''
    raise AssertionError(args[:3])
   with patch.object(n,'protected',return_value=(Path(d)/'env',raw)),patch.object(n,'topology'),patch.object(n,'call',side_effect=call),self.assertRaises(ValueError):n.launch(c,effects.append)
   self.assertEqual(effects,[]);self.assertEqual(trace[-2:],[['docker','stop','new-container'],['docker','rm','new-container']]);self.assertFalse(any(x[:2]==['docker','start'] for x in trace))
 def test_postcheck_refuses_changed_config_before_identity(self):
  with tempfile.TemporaryDirectory() as d,patch.object(n,'topology'),patch.object(n,'protected'),patch.object(n,'identity',side_effect=AssertionError('too early')):
   with self.assertRaises(ValueError):n.postcheck(self.config(d),{'config_sha256':'wrong'})
 def test_exact_namespace_flow_persists_effect_marker_before_fifo_and_keeps_ambiguous_container(self):
  for fail_marker in (False,True):
   with self.subTest(fail_marker=fail_marker),tempfile.TemporaryDirectory() as d:
    c=self.config(d);raw=b'IAM_DEMO_SEED_MODE=never\n';trace=[];count=[0]
    networks={c['backend']['name']:{'Gateway':'172.19.0.1','IPAddress':'172.19.0.20'},c['frontend']['name']:{'Gateway':'172.20.0.1','IPAddress':'172.20.0.20'}}
    info={'State':{'Pid':123},'NetworkSettings':{'Networks':networks},'Config':{'Env':['IAM_DEMO_SEED_MODE=never']}}
    image={'Id':c['image_id'],'RepoDigests':[c['image']],'Config':{'Env':[],'Labels':{'org.opencontainers.image.revision':c['source_sha']}}}
    def call(args,pass_fds=()):
     trace.append(args)
     if args[:3]==['docker','image','inspect']:return json.dumps([image])
     if args[:2]==['docker','run']:return 'new-container'
     if args[:3]==['docker','network','connect']:return ''
     if args[:3]==['docker','network','inspect']:return json.dumps([{'IPAM':{'Config':[{'Gateway':'172.19.0.1' if args[3]==c['backend']['id'] else '172.20.0.1'}]}}])
     if args[0]=='nsenter':
      if args[-1]=='-S':return '-P INPUT ACCEPT\n-P FORWARD ACCEPT\n-P OUTPUT ACCEPT'
      if '-nvx' in args:
       count[0]+=1;return str(count[0])+' 1 REJECT all -- * * 0.0.0.0/0 0.0.0.0/0\n1 1 all -- normal-probe-'+next((x[-1].removeprefix('normal-probe-') for x in reversed(trace) if '--comment' in x and '-I' in x),'private')
      return ''
     if args[:2]==['docker','exec']:
      if args[-1]=='example.com':return 'TLS_DNS_OK'
      if args[-1].endswith("console.log('IPV6_DISABLED')"):return 'IPV6_DISABLED'
      if 'CapEff' in args[-1]:return 'CapEff: 0000\nCapBnd: 0000\nNoNewPrivs: 1'
      if args[3]=='sh':return ''
      tests=json.loads(args[-1]);return json.dumps({**{k:not k.startswith(('private','metadata','public_','backend_','frontend_','dns_other')) for k,h,p in tests['tcp']},**{k:True for k,h,expected in tests['dns']}})
     if args[:2] in (['docker','stop'],['docker','rm']):return ''
     raise AssertionError(args[:4])
    def marker(proof):
     trace.append(['MARKER'])
     if fail_marker:raise ValueError('ambiguous write')
    with patch.object(n,'protected',return_value=(Path(d)/'env',raw)),patch.object(n,'topology'),patch.object(n,'call',side_effect=call),patch.object(n,'inspect',return_value=info),patch.object(n,'identity',return_value=info),patch.object(n.os,'stat',return_value=type('Stat',(),{'st_ino':42})()):
     if fail_marker:
      with self.assertRaises(ValueError):n.launch(c,marker)
      self.assertIn(['MARKER'],trace);self.assertEqual(trace[-1],['docker','stop','new-container']);self.assertNotIn(['docker','rm','new-container'],trace)
     else:
      result=n.launch(c,marker);self.assertEqual(result['namespace_inode'],42)
      release=next(i for i,a in enumerate(trace) if a[:4]==['docker','exec','new-container','sh'])
      self.assertLess(trace.index(['MARKER']),release)
 def test_real_lock_proof_absent_unheld_wrong_inode_and_held(self):
  self.proof.stop()
  import fcntl
  oldfds,oldpaths=n.LOCK_FDS,n.LOCK_PATHS
  try:
   n.LOCK_FDS=();n.LOCK_PATHS=()
   with self.assertRaises(ValueError):n.lock_proof()
   with tempfile.TemporaryDirectory() as d:
    path=Path(d)/'lock';path.touch()
    with path.open('a') as f:
     n.LOCK_FDS=(f.fileno(),);n.LOCK_PATHS=(str(path),)
     with self.assertRaises(ValueError):n.lock_proof()
     fcntl.flock(f,fcntl.LOCK_EX);n.lock_proof()
     other=Path(d)/'other';other.touch();n.LOCK_PATHS=(str(other),)
     with self.assertRaises(ValueError):n.lock_proof()
  finally:n.LOCK_FDS=oldfds;n.LOCK_PATHS=oldpaths
if __name__=='__main__':unittest.main()
