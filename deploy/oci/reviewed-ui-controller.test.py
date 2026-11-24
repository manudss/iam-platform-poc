import importlib.util,tempfile,unittest,json,hashlib,subprocess
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('ui',Path(__file__).with_name('reviewed-ui-held.py'));u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)
class Controller(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
 def tearDown(self):self.tmp.cleanup()
 def file(self,name,value):
  p=self.root/name;p.write_text(value);return {'path':str(p),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
 def test_unprotected_ancestry_refused_before_read(self):
  spec=self.file('evidence','{}')
  with self.assertRaisesRegex(ValueError,'ancestry'):u.read_spec(spec)
 def test_evidence_mutation_refused(self):
  spec=self.file('evidence','{}');Path(spec['path']).write_text('{"tampered":true}')
  with patch.object(u,'protected',side_effect=Path),self.assertRaisesRegex(ValueError,'bytes mismatch'):u.read_spec(spec)
 def test_duplicate_hold_and_missing_hold_refused(self):
  for value in ['IAM_AUTOMATION_HOLD=0\n','IAM_AUTOMATION_HOLD=1\nIAM_AUTOMATION_HOLD=1\n']:
   m={'opening':{'env':self.file('env',value)}}
   with patch.object(u,'protected',side_effect=Path),self.assertRaises(ValueError):u.settings(m)
 def test_gate_defaults_match_updater_and_explicit_paths_retained(self):
  m={'opening':{'env':self.file('env','IAM_AUTOMATION_HOLD=1\n')}}
  with patch.object(u,'protected',side_effect=Path):env=u.settings(m)
  self.assertEqual(env['LYAM_FRONT_BARRIER_FILE'],'/var/lib/lyam-front-gate/MAINTENANCE')
  self.assertEqual(env['LYAM_OPS_BARRIER_FILE'],'/var/lib/lyam-front-gate/OPS-MAINTENANCE')
  m['opening']['env']=self.file('env','IAM_AUTOMATION_HOLD=1\nLYAM_FRONT_BARRIER_FILE=/fixture/gate\nLYAM_OPS_BARRIER_FILE=/fixture/ops\n')
  with patch.object(u,'protected',side_effect=Path):env=u.settings(m)
  self.assertEqual(env['LYAM_FRONT_BARRIER_FILE'],'/fixture/gate');self.assertEqual(env['LYAM_OPS_BARRIER_FILE'],'/fixture/ops')
 def test_wrong_closed_receipt_image_or_open_claim_refused(self):
  for value in ['state=CLOSED_QUALIFIED\nheld=true\npublic_status=503\nimage=wrong','state=DELIVERED\nheld=true\npublic_status=200\nimage=wrong']:
   m={'opening':{'env':self.file('env','IAM_AUTOMATION_HOLD=1\n'),'closed_receipt':self.file('receipt',value)}}
   with patch.object(u,'protected',side_effect=Path),self.assertRaisesRegex(ValueError,'target/state'):u.verify(m,'lyam',{'digest':'sha256:'+'a'*64})
 def test_timeout_before_open_leaves_both_gates(self):
  gates=[self.root/n for n in ['gate','ops']]
  for p in gates:p.write_text('gate')
  before=self.file('before.json','{}');m={'opening':{'before':before,'env':{'path':'env'},'qualifier':{'path':'qualifier'},'policy':{'path':'policy','sha256':'p'}}}
  env={'LYAM_FRONT_BARRIER_FILE':str(gates[0]),'LYAM_OPS_BARRIER_FILE':str(gates[1])}
  with patch.object(u,'verify',return_value=(env,{})),patch.object(u,'run',side_effect=subprocess.TimeoutExpired('qualification',180)),self.assertRaises(subprocess.TimeoutExpired):u.open_gates(m,'lyam',{'digest':'d'})
  self.assertTrue(all(p.exists() for p in gates))
 def test_foreign_gate_or_symlink_not_overwritten(self):
  target=self.root/'file';target.write_text('foreign');intent={'gates':[{'path':str(target),'bytes_hex':b'owned'.hex()}]}
  with patch.object(u,'protected_parent'),self.assertRaisesRegex(ValueError,'foreign'):u.close_gates(intent)
  self.assertEqual(target.read_text(),'foreign');target.unlink();target.symlink_to(self.root/'absent')
  with patch.object(u,'protected_parent'),self.assertRaisesRegex(ValueError,'symlink'):u.close_gates(intent)
 def test_access_rearm_retains_exact_bytes_and_is_idempotent(self):
  p=self.root/'gate';intent={'gates':[{'path':str(p),'bytes_hex':b'owned\n'.hex()}]}
  with patch.object(u,'protected_parent'):u.close_gates(intent);u.close_gates(intent)
  self.assertEqual(p.read_bytes(),b'owned\n')
 def test_redirect_refused(self):
  class Response:
   status=302
  class Opener:
   def open(self,*a,**kw):return Response()
  with patch.object(u.urllib.request,'build_opener',return_value=Opener()),self.assertRaisesRegex(ValueError,'TLS health'):u.status('https://example.invalid',200)
 def test_each_of_three_tls_origins_required(self):
  origins=['https://a.invalid','https://b.invalid','https://c.invalid']
  for failing in origins:
   seen=[]
   def probe(origin,expected):
    seen.append(origin)
    if origin==failing:raise ValueError('TLS failed')
   with patch.object(u,'status',side_effect=probe),self.assertRaises(ValueError):u.check_origins(origins,200)
   self.assertEqual(seen,origins[:origins.index(failing)+1])
  with patch.object(u,'status') as probe:u.check_origins(origins,200)
  self.assertEqual(probe.call_count,3)
 def test_positive_open_orders_fresh_qualification_before_unlink_and_public200(self):
  gates=[self.root/n for n in ['gate','ops']]
  for p in gates:p.write_text('gate')
  before=self.file('before.json','{}')
  m={'opening':{'before':before,'env':{'path':'env'},'qualifier':{'path':'qualifier'},'policy':{'path':'policy','sha256':'p'}}}
  env={'LYAM_FRONT_BARRIER_FILE':str(gates[0]),'LYAM_OPS_BARRIER_FILE':str(gates[1])};calls=[]
  def verify(*args,**kwargs):
   public=kwargs.get('public',503);calls.append(('verify',public))
   self.assertEqual([p.exists() for p in gates],[public==503,public==503])
   return env,{}
  def run(args):
   calls.append(('qualifier',args[2]));self.assertTrue(all(p.exists() for p in gates))
   (self.root/'after-new.json').write_text('{}');(self.root/'smoke-new.json').write_text('{}');return ''
  real=Path.unlink
  def unlink(p,*a,**k):calls.append(('unlink',p.name));return real(p,*a,**k)
  with patch.object(u,'verify',side_effect=verify),patch.object(u,'run',side_effect=run),patch.object(Path,'unlink',unlink):out=u.open_gates(m,'lyam',{'digest':'d'})
  self.assertEqual(calls,[('verify',503),('qualifier','after'),('verify',503),('unlink','gate'),('unlink','ops'),('verify',200)])
  self.assertEqual(out['fresh_qualification']['result'],'qualified-held-before-opening');self.assertFalse(out['zero_writes'])
 def test_login_document_rejects_health_only_or_loading_shell(self):
  class Response:
   status=200;headers={'Content-Type':'text/html'}
   def read(self,n):return b'<html>healthy</html>'
  class Opener:
   def open(self,*a,**kw):return Response()
  with patch.object(u.urllib.request,'build_opener',return_value=Opener()),self.assertRaisesRegex(ValueError,'UI login document absent'):u.ui_document('https://a.invalid')
  Response.read=lambda self,n:b'<title>Sign in</title><app-root>Sign in</app-root>'
  with patch.object(u.urllib.request,'build_opener',return_value=Opener()):u.ui_document('https://a.invalid')
  Response.read=lambda self,n:b'<title>lyam</title><app-root></app-root>'
  with patch.object(u.urllib.request,'build_opener',return_value=Opener()),self.assertRaisesRegex(ValueError,'UI login document absent'):u.ui_document('https://a.invalid')
 def test_rearm_preserves_mode_and_owner_from_intent(self):
  import os
  p=self.root/'gate';intent={'gates':[{'path':str(p),'bytes_hex':b'owned'.hex(),'mode':0o640,'uid':os.geteuid(),'gid':os.getegid()}]}
  with patch.object(u,'protected_parent'):u.close_gates(intent)
  self.assertEqual(p.stat().st_mode&0o777,0o640);self.assertEqual(p.stat().st_uid,os.geteuid())
class VerifyBindings(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.digest='sha256:'+'a'*64;self.target={'digest':self.digest};self.image='ghcr.io/manudss/iam-platform-poc@'+self.digest;self.api_fail=False
  self.opening={};self.paths={};self.bytes={}
  def add(key,raw,path=None):
   p=self.root/(key+'.py' if key=='qualifier' else key);p.write_text(raw);logical=str(path or p);self.paths[logical]=p;self.bytes[logical]=raw.encode();spec={'path':logical,'sha256':hashlib.sha256(raw.encode()).hexdigest()};self.opening[key]=spec;return logical
  self.add=add
  self.helper=add('helper','helper bytes');self.qualifier=add('qualifier','def policy_load(p):return {}\ndef exact_held_activations(b,a):pass\ndef compare(b,a,p):return []\ndef closed_runtime(i):pass\n')
  self.policy=add('policy',json.dumps({'requireAutomationHold':True,'origins':['https://a.invalid','https://b.invalid','https://c.invalid']}),'/opt/lyam/qualification.json')
  self.qualcontainer=add('container','container source',str(Path(self.qualifier).with_name('qualification-container.mjs')))
  self.config=add('config',json.dumps({'image':self.image,'qualificationSHA256':{k:hashlib.sha256(self.bytes[k]).hexdigest() for k in [self.qualifier,self.policy,self.qualcontainer]}}))
  self.gate=add('gate','ownedgate');self.ops=add('ops','ownedops');self.pause=add('pause','paused');self.integrity=add('integrity','integrity source');self.launch=add('launch_proof','{}')
  self.env={'IAM_AUTOMATION_HOLD':'1','LYAM_CONTAINER':'lyam','LYAM_CLOSED_IMPLEMENTATION':self.helper,'LYAM_CLOSED_CONFIG':self.config,'LYAM_POST_UPDATE_CHECK':self.qualifier,'LYAM_FRONT_BARRIER_FILE':self.gate,'LYAM_OPS_BARRIER_FILE':self.ops,'LYAM_PAUSE_FILE':self.pause}
  add('env',''.join(k+'='+v+'\n' for k,v in self.env.items()))
  policyhash=self.opening['policy']['sha256'];common={'policyHash':policyhash,'transportCoverage':'TLS_EXPECTED_ORIGINS','image':self.image}
  add('before',json.dumps(common));add('after',json.dumps(common));add('smoke',json.dumps({'journal':{},'ledger':{'v':1}}))
  self.fields={'state':'CLOSED_QUALIFIED','held':'true','public_status':'503','image':self.image,'config_sha256':self.opening['config']['sha256'],'implementation_sha256':hashlib.sha256(self.bytes[self.helper]).hexdigest(),'launch_proof':self.launch,'launch_proof_sha256':self.opening['launch_proof']['sha256'],'gate_sha256':self.opening['gate']['sha256'],'ops_sha256':self.opening['ops']['sha256']}
  add('closed_receipt',''.join(k+'='+v+'\n' for k,v in self.fields.items()));self.m={'opening':self.opening};self.calls=[]
 def tearDown(self):self.tmp.cleanup()
 def read(self,spec):
  p=spec['path'];return Path(p),self.paths[p].read_bytes()
 def protect(self,path):return self.paths.get(str(path),Path(path))
 def command(self,args):
  self.calls.append(args)
  if args[0]=='python3':return 'config_sha256='+self.opening['config']['sha256']
  if args[0]==self.helper:return '{"liveVerified":true}'
  if args[:2]==['docker','inspect']:return json.dumps([{'Config':{'Image':self.image},'State':{'Running':True}}])
  if args[:2]==['docker','exec']:
   if self.api_fail:raise ValueError('held API proof absent')
   return ''
  raise AssertionError(args)
 def verify(self):
  with patch.object(u,'read_spec',side_effect=self.read),patch.object(u,'protected',side_effect=self.protect),patch.object(u,'run',side_effect=self.command),patch.object(u,'status') as status:
   out=u.verify(self.m,'lyam',self.target);self.assertEqual(status.call_count,3);return out
 def mutate_fields(self,key,value):
  self.fields[key]=value;self.paths[self.opening['closed_receipt']['path']].write_text(''.join(k+'='+v+'\n' for k,v in self.fields.items()))
 def test_positive_verify_links_exact_config_helper_qualifier_policy_and_gates(self):
  env,fields=self.verify();self.assertEqual(env,self.env);self.assertEqual(fields,self.fields);self.assertEqual(len(self.calls),4)
 def real_producer_receipt(self):
  # Concatenation follows actual update.sh printf: whole integrity block, then
  # explicit closed fields including the same three helper hashes again.
  hashes={'launcher_sha256':'b'*64,'preflight_sha256':'c'*64,'implementation_sha256':self.fields['implementation_sha256']}
  self.fields.update(hashes)
  integrity={'config_sha256':self.fields['config_sha256'],'qualification_inventory_sha256':'e'*64,**hashes}
  self.fields['qualification_inventory_sha256']='e'*64
  self.integrity_output=''.join(k+'='+v+'\n' for k,v in integrity.items())
  raw=self.integrity_output+''.join(k+'='+v+'\n' for k,v in self.fields.items() if k not in {'config_sha256','qualification_inventory_sha256'})
  self.paths[self.opening['closed_receipt']['path']].write_text(raw)
  return raw
 def test_real_update_concatenated_receipt_complete_verify(self):
  self.real_producer_receipt()
  original=self.command
  def run(args):return self.integrity_output if args[0]=='python3' else original(args)
  with patch.object(self,'command',side_effect=run):
   env,fields=self.verify();self.assertEqual(fields,self.fields)
 def test_receipt_compatibility_negative_counts_conflicts_and_other_keys(self):
  raw=self.real_producer_receipt()
  mutations=[raw+'launcher_sha256='+'b'*64+'\n',raw+'state=CLOSED_QUALIFIED\n',raw.replace('launcher_sha256='+'b'*64,'launcher_sha256='+'d'*64,1),raw.replace('launcher_sha256='+'b'*64+'\n','',1)]
  for value in mutations:
   with self.subTest(value=len(value)),self.assertRaisesRegex(ValueError,'duplicate closed receipt'):u.receipt_fields(value.encode())
 def test_single_keys_valid_and_nonhex_duplicate_refused(self):
  self.assertEqual(u.receipt_fields(b'state=CLOSED_QUALIFIED\n'),{'state':'CLOSED_QUALIFIED'})
  with self.assertRaisesRegex(ValueError,'helper hash invalid'):u.receipt_fields(b'launcher_sha256=x\nlauncher_sha256=x\n')
 def test_changed_integrity_binding_refused_exact_reason(self):
  self.mutate_fields('config_sha256','bad')
  with self.assertRaisesRegex(ValueError,'closed integrity binding changed'):self.verify()
 def test_helper_changed_refused_exact_reason(self):
  self.paths[self.helper].write_text('changed')
  with self.assertRaisesRegex(ValueError,'helper changed'):self.verify()
 def test_config_targets_other_image_refused_exact_reason(self):
  c=json.loads(self.paths[self.config].read_text());c['image']='other';self.paths[self.config].write_text(json.dumps(c))
  with self.assertRaisesRegex(ValueError,'reviewed config targets another image'):self.verify()
 def test_qualifier_or_policy_outside_inventory_refused_exact_reason(self):
  old=self.paths[self.config].read_text()
  for path in [self.qualifier,self.policy,self.qualcontainer]:
   c=json.loads(old);c['qualificationSHA256'][path]='wrong';self.paths[self.config].write_text(json.dumps(c))
   with self.assertRaisesRegex(ValueError,'qualification must match reviewed config inventory'):self.verify()
 def test_hold_api_absent_refused_exact_reason(self):
  self.api_fail=True
  with self.assertRaisesRegex(ValueError,'held API proof absent'):self.verify()
 def test_incoherent_explicit_gate_path_refused_by_receipt_binding(self):
  self.env['LYAM_FRONT_BARRIER_FILE']=self.ops
  self.paths[self.opening['env']['path']].write_text(''.join(k+'='+v+'\n' for k,v in self.env.items()))
  with self.assertRaisesRegex(ValueError,'gate ownership changed'):self.verify()
 def test_gate_hash_changed_refused_exact_reason(self):
  self.paths[self.gate].write_text('foreign')
  with self.assertRaisesRegex(ValueError,'gate ownership changed'):self.verify()
if __name__=='__main__':unittest.main()
