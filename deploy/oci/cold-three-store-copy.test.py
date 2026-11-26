import importlib.util,tempfile,json,io,tarfile,unittest,os,stat
from pathlib import Path
H=Path(__file__).parent
s=importlib.util.spec_from_file_location('r',H/'cold-three-store-copy.py');r=importlib.util.module_from_spec(s);s.loader.exec_module(r)
T={'sha':'a'*40,'digest':'sha256:'+'b'*64};IMG='sha256:'+'c'*64
def mk(d,role):
 src=Path(d)/'src'/role;src.mkdir(parents=True);(src/'f').write_text(role)
 out=Path(d)/(role+'.tar.gz')
 with tarfile.open(out,'w:gz') as t:t.add(src,arcname=role)
 return out
class W:
 def install(s,l,ips,b):return {'label':l}
 def snapshot(s,b):return {}
 def verify_quiet(s,a,b):return {'host_guard_unchanged':True}
class L:
 def lock_proof(s):pass
 def __init__(s,log):s.log=log
 def launch(s,c,b):s.log.append(('launch',c['kind'],c['dns_upstreams']));b({'container_id':'x','pid':5});s.log.append(('fifo',));return {'container_id':'x','pid':5}
 def postcheck(s,c,p):s.log.append(('postcheck',))
class LC:
 def __init__(s,log):s.log=log
 def launch(s,c,ev,n):s.log.append(('attempt',ev));n.launch(c,lambda proof:s.log.append(('effects',)));return {'container_id':'x','pid':5}
class P:
 before_phase='in-launch'
 def __init__(s,log,ok=True,before_fail=False):s.log=log;s.ok=ok;s.bf=before_fail
 def before(s,n,r,p):
  s.log.append(('before',))
  if s.bf:raise ValueError('before failed')
 def after(s,n,r,l):return {'ok':s.ok}
class Fake:
 def __init__(s,internal=True):s.probe='ok';s.policy=True;s.drops=0;s.ph_running=False;s.rm_ids=[];s.log=[];s.internal=internal;s.present=set();s.fail_clean=False
 def __call__(s,a,inp=None):
  s.log.append((a[:3],inp is not None))
  if a[0]=='nsenter':
   tool=a[4];rest=a[5:]
   if tool=='/usr/bin/python3':return json.dumps({'sealed':False})
   if tool=='python3':
    if s.probe=='reach':return ''
    if s.probe!='nocount':s.drops+=1
    raise ValueError('refused')
   if rest[:3]==['-t','raw','-nvx']:return '1 1 DROP all'
   if rest[:1]==['-S']:return ('-P OUTPUT DROP\n-A OUTPUT -o lo -j ACCEPT' if s.policy else '-P OUTPUT ACCEPT')
   if rest[:2]==['-nvx','-L']:return 'Chain OUTPUT (policy DROP %d packets, 0 bytes)'%s.drops
   return ''
  if a[1:3]==['network','create']:s.present.add(('n',a[-1]));return ''
  if a[1:3]==['network','inspect']:
   sub=s.sub.get(a[3]);return json.dumps([{'Id':'f'*64,'Internal':s.internal,'EnableIPv6':False,'Driver':'bridge','Containers':{},'IPAM':{'Config':[{'Subnet':sub}]}}])
  if a[1:3]==['image','inspect']:return json.dumps([{'Config':{'Entrypoint':['/ep'],'Cmd':['x']}}])
  if a[1]=='create':
   s.present.add(('c',a[a.index('--name')+1]))
   return ('p'*64 if '--entrypoint' in a and 'node' in a else 'e'*64)
  if a[1]=='inspect' and a[-1]=='p'*64:return json.dumps([{'Id':'p'*64,'Name':'/lq-test-e1-app','State':{'Running':s.ph_running,'Status':'created','StartedAt':'0001-01-01T00:00:00Z'},'Mounts':[],'Config':{'Labels':{'lyam-qualification':'test-e1','lyam-placeholder':'1'}},'HostConfig':{'NetworkMode':'none'}}])
  if a[1:3]==['rm','-v']:s.present.discard(('c','lq-test-e1-app'));s.rm_ids.append(a[-1]);return ''
  if a[1]=='inspect':
   n=a[-1];role='pg' if n.endswith('pg') else 'bao'
   return json.dumps([{'State':{'Pid':5,'Running':True},'HostConfig':{},'NetworkSettings':{'Networks':{'lq-be':{'IPAddress':s.ips[role],'Aliases':[role]}}}}])
  if a[1:3]==['rm','-f']:s.present.discard(('c',a[-1]));return ''
  if a[1:3]==['network','rm']:s.present.discard(('n',a[-1]));return ''
  if a[1:3]==['ps','-a'] or a[1:3]==['network','ls']:
   n=a[-1][1:-1];return 'id' if (('c',n) in s.present or ('n',n) in s.present) else ''
  if a[1]=='exec' and 'status' in a:return json.dumps({'sealed':False})
  return ''
class T_(unittest.TestCase):
 def setup(s,d):
  check=r.check_copy_root;r.check_copy_root=lambda p:None;s.addCleanup(setattr,r,'check_copy_root',check)
  r.COPIES=Path(d)/'copies';base={'target':T,'coherent_three_store_backup':True,'archives':{}};spec={'engagement_id':'test-e1','target':T,'stores':{},'identities':{k:{'uid':70,'gid':70,'image_id':IMG,'image':'ghcr.io/manudss/iam-platform-poc@'+T['digest']} for k in('app','pg','bao')}}
  for k in r.ROLES:
   a=mk(d,k);base['archives'][k]={'path':str(a),'sha256':r.sha(a)};spec['stores'][k]={'path':'/live/'+k}
  kf=Path(d)/'k';kf.write_text(json.dumps({'unseal_keys_b64':['KEY1'],'unseal_threshold':1,'root_token':'RT'}));hcl=Path(d)/'h';hcl.write_text('x')
  spec['copy']={'backend':{'name':'lq-be','subnet':'10.9.0.0/24'},'frontend':{'name':'lq-fe','subnet':'10.9.1.0/24'},'ips':{'pg':'10.9.0.2','bao':'10.9.0.3'},'bao_hcl_copy':str(hcl),'unseal_key_binding':{'path':str(kf),'sha256':__import__('hashlib').sha256(kf.read_bytes()).hexdigest()},'port':8081,'public_probe':'1.1.1.1','tls_probe':'x.io','resources':{'memory_bytes':1<<30,'pids':128,'nano_cpus':10**9}}
  f=Fake();f.sub={'lq-be':'10.9.0.0/24','lq-fe':'10.9.1.0/24'};f.ips=spec['copy']['ips'];return base,spec,f
 def patch_root(s):
  orig=r.private_root_file;r.private_root_file=lambda p:Path(p);s.addCleanup(setattr,r,'private_root_file',orig)
 def test_happy_order_and_secret_stdin_only_and_cleanup(s):
  s.patch_root()
  with tempfile.TemporaryDirectory() as d:
   base,spec,f=s.setup(d);log=[];mark=lambda e:log.append(('mark',e['phase']));res=r.Isolated(f,W(),L(log),None).qualify(base,spec,{'path':'/e','sha256':'0'*64},P(log),mark,LC(log),'/ev/a.json')
   s.assertTrue(res['direct_execution']);s.assertEqual(res['baseline'],base);s.assertEqual(res['cleanup'],[])
   s.assertEqual(f.present,set());calls=[c[0] for c in f.log]
   s.assertLess(calls.index(['docker','network','create']),calls.index(['docker','create','--memory']))
   s.assertLess([i for i,c in enumerate(calls) if c[0]=='nsenter'][0],[i for i,c in enumerate(calls) if c[0]=='docker' and c[1]=='exec'][0])
   s.assertEqual(sum(1 for c in f.log if c[1]),1)
   s.assertEqual(log[0],('mark','companions-start'));s.assertEqual([x[0] for x in log],['mark','attempt','launch','before','effects','fifo']);s.assertEqual(log[2],('launch','isolated-copy',[]))
 def test_noninternal_network_refused_and_cleaned(s):
  s.patch_root()
  with tempfile.TemporaryDirectory() as d:
   base,spec,f=s.setup(d);f.internal=False
   with s.assertRaises(ValueError):r.Isolated(f,W(),L([]),None).qualify(base,spec,{},P([]),lambda e:None,LC([]),'/e')
   s.assertEqual(f.present,set());s.assertFalse(any(c[0][1]=='create' for c in f.log))
 def test_failed_probe_raises_and_cleans(s):
  s.patch_root()
  with tempfile.TemporaryDirectory() as d:
   base,spec,f=s.setup(d)
   with s.assertRaises(ValueError):r.Isolated(f,W(),L([]),None).qualify(base,spec,{},P([],ok=False),lambda e:None,LC([]),'/e')
   s.assertEqual(f.present,set())
 def test_missing_or_failing_marker_blocks_all_effects(s):
  s.patch_root()
  for m in (None,lambda e:(_ for _ in ()).throw(ValueError('persist failed'))):
   with tempfile.TemporaryDirectory() as d:
    base,spec,f=s.setup(d)
    with s.assertRaises(ValueError):r.Isolated(f,W(),L([]),None).qualify(base,spec,{},P([]),m,LC([]),'/e')
    s.assertFalse(any(c[0][1:3] in (['start','lq-test-e1-pg'],) or c[0][1]=='start' for c in f.log));s.assertEqual(f.present,set())
    if m is None:s.assertEqual(f.log,[])
 def test_before_failure_blocks_effects_and_fifo(s):
  s.patch_root()
  with tempfile.TemporaryDirectory() as d:
   base,spec,f=s.setup(d);log=[]
   with s.assertRaises(ValueError):r.Isolated(f,W(),L(log),None).qualify(base,spec,{},P(log,before_fail=True),lambda e:None,LC(log),'/e')
   x=[a[0] for a in log];s.assertNotIn('effects',x);s.assertNotIn('fifo',x);s.assertEqual(f.present,set())
 def test_cleanup_residue_raises(s):
  with tempfile.TemporaryDirectory() as d:
   f=Fake();f.present={('c','x')};i=r.Isolated(lambda a,inp=None:('id' if a[1]=='ps' else ''),W(),None,None)
   with s.assertRaises(ValueError):i.cleanup(['x'],[],{})
 def test_hash_traversal_symlink_refused(s):
  with tempfile.TemporaryDirectory() as d:
   base,spec,f=s.setup(d);base['archives']['pg']['sha256']='0'*64
   with s.assertRaises(ValueError):r.restore(base,spec,Path(d))
  with tempfile.TemporaryDirectory() as d:
   for kind in('trav','link'):
    p=Path(d)/(kind+'.tgz')
    with tarfile.open(p,'w:gz') as t:
     if kind=='trav':i=tarfile.TarInfo('x/../../e');i.size=0;t.addfile(i,io.BytesIO(b''))
     else:i=tarfile.TarInfo('x/l');i.type=tarfile.SYMTYPE;i.linkname='/etc';t.addfile(i)
    with s.assertRaises(ValueError):r.safe_extract(p,Path(d)/'o','x')
 def test_tar_extract_real_py310(s):
  with tempfile.TemporaryDirectory() as d:
   a=mk(d,'pg');n=r.safe_extract(a,Path(d)/'out','pg');s.assertTrue((Path(d)/'out/pg/f').exists())
 def test_unseal_hash_mismatch_and_dev_cmd(s):
  s.patch_root()
  with tempfile.TemporaryDirectory() as d:
   k=Path(d)/'k';k.write_text('{}')
   with s.assertRaises(ValueError):r.Isolated(lambda a,i=None:'',W(),None,None).unseal('n',{'path':str(k),'sha256':'0'*64})
  f=Fake()
  f.run=None
  i=r.Isolated(lambda a,inp=None:json.dumps([{'Config':{'Entrypoint':['e'],'Cmd':['server','-dev']}}]),W(),None,None)
  with s.assertRaises(ValueError):i.companion('e1','bao','n','sha256:'+'c'*64,'net','10.0.0.2',[])
 def test_unseal_requires_root600_file(s):
  with tempfile.TemporaryDirectory() as d:
   k=Path(d)/'k';k.write_text('K');k.chmod(0o644)
   with s.assertRaises(ValueError):r.private_root_file(k)

class PH(P):
 before_phase='pre-launch'
class PT(T_):
 def test_placeholder_removed_by_id_before_launch(s):
  s.patch_root()
  with tempfile.TemporaryDirectory() as d:
   base,spec,f=s.setup(d);log=[];r.Isolated(f,W(),L(log),None).qualify(base,spec,{},PH(log),lambda e:None,LC(log),'/e')
   s.assertEqual(f.rm_ids,['p'*64]);x=[a[0] for a in log];s.assertLess(x.index('before'),x.index('attempt'))
 def test_running_placeholder_refused_and_removed(s):
  s.patch_root()
  with tempfile.TemporaryDirectory() as d:
   base,spec,f=s.setup(d);f.ph_running=True;log=[]
   with s.assertRaises(ValueError):r.Isolated(f,W(),L(log),None).qualify(base,spec,{},PH(log),lambda e:None,LC(log),'/e')
   s.assertEqual(f.rm_ids,['p'*64]);s.assertNotIn('before',[a[0] for a in log]);s.assertNotIn('attempt',[a[0] for a in log])
 def test_name_conflict_refused_without_create(s):
  i=r.Isolated(lambda a,inp=None:'id' if a[1]=='ps' else '',W(),None,None)
  with s.assertRaises(ValueError):i.before_with_placeholder('e',{'app':'n'},{'identities':{'app':{'image_id':'i'}}},{},None,lambda e:None)
class FT(T_):
 def run_with(s,**kw):
  s.patch_root()
  with tempfile.TemporaryDirectory() as d:
   base,spec,f=s.setup(d)
   for k,v in kw.items():setattr(f,k,v)
   log=[]
   with s.assertRaises(ValueError):r.Isolated(f,W(),L(log),None).qualify(base,spec,{},P(log),lambda e:None,LC(log),'/e')
   x=[a[0] for a in log];s.assertNotIn('attempt',x);s.assertNotIn('fifo',x);s.assertEqual(f.present,set())
   return f
 def test_probe_reaching_443_blocks_fifo(s):
  f=s.run_with(probe='reach');s.assertFalse(any(c[0][1:3]==['exec','pg'] for c in f.log))
 def test_policy_not_drop_refused(s):s.run_with(policy=False)
 def test_probe_not_counted_refused(s):s.run_with(probe='nocount')
 def test_fence_has_policy_before_allow_and_reply_only(s):
  s.patch_root()
  with tempfile.TemporaryDirectory() as d:
   base,spec,f=s.setup(d);r.Isolated(f,W(),L([]),None).qualify(base,spec,{},P([]),lambda e:None,LC([]),'/e')
   ns=[c[0] for c in f.log if c[0][0]=='nsenter']
   s.assertTrue(len(ns)>0)
 def test_missing_uid_refused(s):
  s.patch_root()
  with tempfile.TemporaryDirectory() as d:
   base,spec,f=s.setup(d);del spec['identities']['pg']['uid']
   with s.assertRaises(ValueError):r.Isolated(f,W(),L([]),None).qualify(base,spec,{},P([]),lambda e:None,LC([]),'/e')
class HT(T_):
 def test_markers_before_create_and_id_before_capture(s):
  s.patch_root()
  with tempfile.TemporaryDirectory() as d:
   base,spec,f=s.setup(d);log=[]
   r.Isolated(f,W(),L(log),None).qualify(base,spec,{},PH(log),lambda e:log.append(('mark',e['phase'])),LC(log),'/e')
   x=[a[0]+(a[1] if a[0]=='mark' else '') for a in log]
   s.assertLess(x.index('markplaceholder-planned'),x.index('markplaceholder-created'));s.assertLess(x.index('markplaceholder-created'),x.index('before'))
   cr=[c[0] for c in f.log]
 def test_marker_failure_after_create_removes_placeholder_no_capture(s):
  s.patch_root()
  with tempfile.TemporaryDirectory() as d:
   base,spec,f=s.setup(d);log=[]
   def mark(e):
    if e['phase']=='placeholder-created':raise ValueError('persist failed')
   with s.assertRaises(ValueError):r.Isolated(f,W(),L(log),None).qualify(base,spec,{},PH(log),mark,LC(log),'/e')
   s.assertEqual(f.rm_ids,['p'*64]);s.assertNotIn('before',[a[0] for a in log])
class CT(unittest.TestCase):
 def test_null_binding_refused(s):
  sp={'identities':{k:{'image_id':'sha256:'+'c'*64} for k in('app','pg','bao')},'stores':{'dolt':{'uid':None,'gid':None}}}
  with s.assertRaises(ValueError):r.check_spec(sp)
  sp['stores']['dolt']={'uid':0,'gid':0};sp['identities']['app']['image_id']=None
  with s.assertRaises(ValueError):r.check_spec(sp)
class QT(unittest.TestCase):
 def test_qualification_args_and_evidence(s):
  with tempfile.TemporaryDirectory() as d:
   sc=Path(d)/'q.py';sc.write_text('x');ev=Path(d)/'ev';calls=[]
   def run(a,i=None):
    calls.append(a)
    if '--phase' in a and a[a.index('--phase')+1]=='before':ev.mkdir()
    if a[a.index('--phase')+1]=='before':(ev/'before.json').write_text('{}')
    else:(ev/'after-1.json').write_text('{}');(ev/'smoke-1.json').write_text('{}')
    return ''
   q=r.Qualification(run,sc,__import__('hashlib').sha256(b'x').hexdigest(),'/p','/e','/b','/bk',str(ev),'img')
   n={'app':'c'};rs={'dolt':{'path':'/d'}}
   with s.assertRaises(ValueError):q.after(n,rs,None)
   pol=Path(d)/'policy';pol.write_text('{}');q.policy=str(pol);q.policy_binding={'sha256':__import__('hashlib').sha256(b'{}').hexdigest()}
   q.before(n,rs,None);res=q.after(n,rs,None)
   s.assertTrue(res['ok']);s.assertIn('--isolated-loopback-test',calls[0]);s.assertNotIn('--backup-file',calls[0])
   with s.assertRaises(ValueError):r.Qualification(run,sc,'0'*64,'/p','/e','/b','/bk',str(ev),'img')
class BindingTest(unittest.TestCase):
 def test_policy_hash_identity_paths_and_migration_binding(s):
  with tempfile.TemporaryDirectory() as d:
   old=r.COPIES;r.COPIES=Path(d);s.addCleanup(setattr,r,'COPIES',old)
   root=Path(d)/'test-e1';root.mkdir(mode=0o700)
   policy=root/'policy';script=root/'qualifier';script.write_text('fixture')
   p={'pgContainer':'lq-test-e1-pg','baoContainer':'lq-test-e1-bao','network':'copy-net','baoAddress':'http://10.9.0.3:8200','isolatedCopy':True,'isolatedLoopbackTest':True,'requireAutomationHold':False,'authFile':str(root/'auth'),'baoTokenFile':str(root/'token'),'origins':['http://127.0.0.1:18089']}
   spec={'engagement_id':'test-e1','copy':{'backend':{'name':'copy-net'},'ips':{'bao':'10.9.0.3'},'migration_ledger_binding':{'present':False,'sha256':None}}}
   q=r.Qualification(lambda *a:None,script,r.sha(script),str(policy),str(root/'env'),str(root/'barrier'),str(root/'backups'),str(root/'evidence'),'image')
   orig=r.private_root_file;r.private_root_file=lambda p:Path(p);s.addCleanup(setattr,r,'private_root_file',orig)
   def save(value):
    policy.write_text(json.dumps(value));spec['copy']['policy_binding']={'path':str(policy),'sha256':r.sha(policy)}
   save(p);q.bind_copy(spec,{'path':str(root/'env')})
   for key,bad in [('pgContainer','pg'),('baoContainer','bao'),('network','prod'),('baoAddress','http://127.0.0.1:8200'),('isolatedCopy',False),('authFile','/outside'),('origins',['http://evil.invalid'])]:
    with s.subTest(key=key):
     save({**p,key:bad})
     with s.assertRaises(ValueError):q.bind_copy(spec,{'path':str(root/'env')})
   save(p);spec['copy']['policy_binding']['sha256']='0'*64
   with s.assertRaises(ValueError):q.bind_copy(spec,{'path':str(root/'env')})
   save(p);spec['copy'].pop('migration_ledger_binding')
   with s.assertRaises(ValueError):q.bind_copy(spec,{'path':str(root/'env')})
unittest.main()
