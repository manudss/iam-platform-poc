import unittest,importlib.util,tempfile,json,copy,hashlib,os
from pathlib import Path
s=importlib.util.spec_from_file_location('ex',Path(__file__).with_name('activation161-exception.py'));ex=importlib.util.module_from_spec(s);s.loader.exec_module(ex)
qspec=importlib.util.spec_from_file_location('q',Path(__file__).with_name('qualification.py'));q=importlib.util.module_from_spec(qspec);qspec.loader.exec_module(q)
H=lambda n:format(n,'064x')
class ExceptionMode(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.d=Path(self.tmp.name);self.policy={'appendOnlyTables':['public.activations'],'pgContainer':'fictional','pgUser':'fixture','pgDatabase':'fixture'};self.policyfile=self.d/'policy.json';self.policyfile.write_text(json.dumps(self.policy));ph=ex.sha(self.policyfile.read_bytes())
  expected=json.loads((ex.HERE/'activation161-column-metadata.json').read_text());template=copy.deepcopy(expected[0]);template.update(column_name='error',ordinal_position=7,table_catalog='fixture',udt_catalog='fixture')
  self.b={'image':'old','policyHash':ph,'dolt':[1],'bao':{'x':'y'},'credentials':{'x':'y'},'postgres':{'schema':{'columns':[template],'constraints':[]},'rows':{'public.activations':{H(1):2,H(2):1},'public.other':{H(3):1}},'sequences':{'public.seq':{'last_value':3,'is_called':True}},'sequenceDefinitions':[]}}
  self.a=copy.deepcopy(self.b);self.a['image']=ex.IMAGE;self.a['postgres']['rows']['public.activations']={H(4):2,H(5):1}
  for i,col in enumerate(expected,8):self.a['postgres']['schema']['columns'].append({**col,'ordinal_position':i,'table_catalog':'fixture','udt_catalog':'fixture'})
  self.c={'format':1,'transaction':{'read_only':True,'isolation':'repeatable read','snapshot':'1:1:','database':'fixture'},'postgres':self.a['postgres'],'projection':{'pairs':[{'whole':H(4),'legacy':H(1),'multiplicity':2},{'whole':H(5),'legacy':H(2),'multiplicity':1}],'row_count':3,'nonnull_new_columns':0}}
  self.before=self.d/'before.json';self.before.write_text(json.dumps(self.b));incident={'history':[{'sha':'b'*40}],'pending':{'sha':'a'*40,'digest':ex.IMAGE.split('@')[1],'parent':'b'*40},'failed':{'sha':'a'*40,'exit':4}};self.incident=self.d/'state.json';self.incident.write_text(json.dumps(incident));ex.STATE=self.incident;ex.UPDATE_LOCK=self.d/'update.lock';ex.PAUSE=self.d/'PAUSED';ex.UPDATE_LOCK.touch();ex.PAUSE.touch();Path(str(self.incident)+'.lock').touch()
  self.m={'format':1,'kind':'reviewed-activation161-closed','image':ex.IMAGE,'source_sha':'a'*40,'before_sha256':ex.sha(self.before.read_bytes()),'policy_file':str(self.policyfile),'policy_sha256':ph,'incident_file':str(self.incident),'incident_sha256':ex.sha(self.incident.read_bytes()),'original_incident':incident,'code_sha256':{n:ex.sha((ex.HERE/n).read_bytes())for n in ex.CODE},'authorization_ref':'operator reference to explicit one-run approval','evidence_refs':['reviewed incident'],'one_shot_claim':str(self.d/'consumed')}
  self.manifest=self.d/'manifest.json';self.manifest.write_text(json.dumps(self.m))
 def tearDown(self):
  for r in getattr(self,'runs',[]):r.close()
  self.tmp.cleanup()
 def runobj(self,output=None):
  r=ex.ExceptionRun(self.manifest,ex.sha(self.manifest.read_bytes()),self.before,self.policyfile,ex.IMAGE,'after',output or self.d/'result');self.runs=getattr(self,'runs',[])+[r];return r
 def test_positive_exact_multiset_and_incompatible_receipt(self):
  r=self.runobj();self.assertEqual(r.capture(lambda *a,**k:json.dumps(self.c)),self.a['postgres']);r.save(q.private_json,self.b,self.a,{'journal':{'count':3},'ledger':[]},q.compare);out=json.loads((self.d/'result/closed-exception-result.json').read_text());self.assertNotEqual(out['format'],1);self.assertNotEqual(out['result'],'qualified');self.assertFalse(out['queue_compatible']);self.assertEqual((self.d/'result/capture.json').stat().st_mode&0o777,0o600)
  r.close()
  with self.assertRaises(ValueError):self.runobj()
 def test_readonly_missing_wrong_snapshot_and_collector_failure_refuse(self):
  r=self.runobj()
  for key,value in [('read_only',False),('isolation','read committed'),('snapshot','')]:
   c=copy.deepcopy(self.c);c['transaction'][key]=value
   with self.assertRaises(ValueError):r.capture(lambda *a,**k:json.dumps(c))
  with self.assertRaises(RuntimeError):r.capture(lambda *a,**k:(_ for _ in []).throw(RuntimeError('collector failed')))
 def test_negative_mutations_fail(self):
  cases=[lambda:self.a['postgres']['schema']['columns'].append({'extra':1}),lambda:self.a['postgres']['schema']['columns'][1].update(is_nullable='NO'),lambda:self.a['postgres']['schema']['columns'][1].update(data_type='integer'),lambda:self.c['projection'].update(nonnull_new_columns=1),lambda:self.c['projection']['pairs'][0].update(legacy=H(99)),lambda:self.c['projection']['pairs'][0].update(multiplicity=1),lambda:self.c['projection']['pairs'].append({'whole':H(4),'legacy':H(1),'multiplicity':1}),lambda:self.a['postgres']['rows']['public.other'].update({H(9):1}),lambda:self.a['postgres']['sequences']['public.seq'].update(last_value=1),lambda:self.a.update(image='wrong'),lambda:self.a.update(bao={}),lambda:self.a.update(dolt=[]),lambda:self.a.update(credentials={})]
  for mutate in cases:
   self.tearDown();self.setUp();r=self.runobj();r.capture_value=self.c;mutate()
   with self.subTest(mutation=mutate),self.assertRaises((ValueError,KeyError)):r.verify(self.b,self.a,q.compare)
   self.tearDown()
 def test_after_other_run_or_projection_other_snapshot_refuses(self):
  r=self.runobj();r.capture(lambda *a,**k:json.dumps(self.c));changed=copy.deepcopy(self.a);changed['postgres']['rows']['public.other']={H(88):1}
  with self.assertRaises(ValueError):r.verify(self.b,changed,q.compare)
  r.capture_value['projection']['pairs'][0]['whole']=H(99)
  with self.assertRaises(ValueError):r.verify(self.b,self.a,q.compare)
 def test_policy_before_incident_code_pins_fail_after_capture(self):
  r=self.runobj();r.capture_value=self.c;self.before.write_text('{}')
  with self.assertRaises(ValueError):r.verify(self.b,self.a,q.compare)
 def test_old_queue_and_recovery_reject_exception_format(self):
  spec=importlib.util.spec_from_file_location('queue',Path(__file__).with_name('ordered-queue.py'));queue=importlib.util.module_from_spec(spec);spec.loader.exec_module(queue)
  r=self.runobj();r.capture_value=self.c;r.save(q.private_json,self.b,self.a,{'journal':{},'ledger':[]},q.compare)
  # Supply internally consistent hashes so refusal is about incompatible receipt, not absent files.
  files={};out=self.d/'result';values={'before':self.before,'after':out/'after.json','smoke':out/'smoke.json','receipt':out/'closed-exception-result.json'}
  for k,p in values.items():files[k]={'path':str(p),'sha256':ex.sha(p.read_bytes())}
  with self.assertRaisesRegex(ValueError,'successful qualification receipt'):queue.verify_qualification_receipt(files,{'digest':ex.IMAGE.split('@')[1]})
 def test_manifest_and_collector_hash_mutations_refuse(self):
  r=self.runobj();self.manifest.write_text('{}')
  with self.assertRaises(ValueError):r.recheck()
  # A pin to a collector different from the actual versioned SQL is rejected before a run.
  self.tearDown();self.setUp();self.m['code_sha256']['activation161-capture.sql']='0'*64;self.manifest.write_text(json.dumps(self.m))
  with self.assertRaises(ValueError):self.runobj()
 def test_exact_duplicate_row_multiplicity_missing_extra_and_new_nonnull_refuse(self):
  r=self.runobj();r.capture_value=copy.deepcopy(self.c);r.capture_value['projection']['pairs'][0]['multiplicity']=3
  with self.assertRaises(ValueError):r.verify(self.b,self.a,q.compare)
  r.capture_value=copy.deepcopy(self.c);r.capture_value['projection']['pairs'].pop()
  with self.assertRaises(ValueError):r.verify(self.b,self.a,q.compare)
 def test_exception_only_after_and_no_implicit_manifest(self):
  for phase,image,manifest_hash in [('before',ex.IMAGE,ex.sha(self.manifest.read_bytes())),('after','other',ex.sha(self.manifest.read_bytes())),('after',ex.IMAGE,'0'*64)]:
   with self.assertRaises(ValueError):ex.ExceptionRun(self.manifest,manifest_hash,self.before,self.policyfile,image,phase,self.d/'result')
 def test_locks_and_real_registry_cannot_be_bypassed(self):
  import fcntl
  with open(ex.UPDATE_LOCK,'a')as held:
   fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
   with self.assertRaises(BlockingIOError):self.runobj()
  copied=self.d/'copy.json';copied.write_bytes(self.incident.read_bytes());self.m['incident_file']=str(copied);self.manifest.write_text(json.dumps(self.m))
  with self.assertRaises(ValueError):self.runobj()
 def test_claim_reuse_with_fresh_output_refuses(self):
  r=self.runobj();r.close()
  with self.assertRaises(FileExistsError):self.runobj(self.d/'new-output')
 def test_all_actual_pin_mutations_after_capture_refuse(self):
  from unittest.mock import patch
  original_here=ex.HERE
  for name in ['policy','incident','helper','metadata','manifest','source','digest']:
   self.tearDown();self.setUp();code=self.d/'code';code.mkdir()
   for filename in ex.CODE:(code/filename).write_bytes((original_here/filename).read_bytes())
   with patch.object(ex,'HERE',code):
    r=self.runobj();r.capture_value=copy.deepcopy(self.c)
    if name=='policy':self.policyfile.write_text('{}')
    elif name=='incident':self.incident.write_text('{}')
    elif name=='helper':(code/'qualification-container.mjs').write_text('changed')
    elif name=='metadata':(code/'activation161-column-metadata.json').write_text('[]')
    elif name=='manifest':self.manifest.write_text('{}')
    else:
     self.m['source_sha' if name=='source' else 'image']='changed';self.manifest.write_text(json.dumps(self.m))
    with self.subTest(pin=name),self.assertRaises(ValueError):r.verify(self.b,self.a,q.compare)
 def test_smoke_appended_activation_fails_final_postsmoke_projection(self):
  r=self.runobj();r.capture_value=copy.deepcopy(self.c);r.capture_value['projection']['pairs'].append({'whole':H(88),'legacy':H(99),'multiplicity':1});r.capture_value['projection']['row_count']=4;r.capture_value['postgres']['rows']['public.activations'][H(88)]=1
  final=copy.deepcopy(self.a);final['postgres']=r.capture_value['postgres']
  with self.assertRaises(ValueError):r.verify(self.b,final,q.compare)
 def test_cli_conflicting_and_partial_flags_refuse(self):
  import subprocess,sys
  base=[sys.executable,str(ex.HERE/'qualification.py'),'--phase','after']
  for name in ['container','image','env-file','data-dir','backup-dir','barrier-file','target-image','evidence-dir']:base+=['--'+name,str(ex.PAUSE if name=='barrier-file' else self.d)]
  policy=self.d/'cli-policy.json';policy.write_text(json.dumps({'format':1,'origins':[],'issuer':'x','tenant':'t','pgContainer':'x','pgUser':'x','pgDatabase':'x','network':'x','authFile':'x','baoMetadataRoots':[],'baoAddress':'x','baoTokenFile':'x','credentialFiles':[],'appendOnlyTables':[]}))
  # All three manifest fields are supplied for conflict cases. Missing policy proves flag refusal precedes external work.
  for extra in [['--reviewed-activation161-manifest','x'],['--reviewed-activation161-manifest','x','--reviewed-activation161-manifest-sha256','x','--closed-exception-output','x','--receipt-file','x'],['--reviewed-activation161-manifest','x','--reviewed-activation161-manifest-sha256','x','--closed-exception-output','x','--isolated-loopback-test']]:
   out=subprocess.run(base+['--policy',str(policy)]+extra,capture_output=True,text=True);self.assertEqual(out.returncode,1);self.assertFalse((self.d/'closed-exception-result.json').exists())
 def test_failed_exit_zero_or_noninteger_refuse_even_with_matching_pins(self):
  for value in [0,'4',None,False]:
   self.tearDown();self.setUp();state=json.loads(self.incident.read_text());state['failed']['exit']=value;self.incident.write_text(json.dumps(state));self.m['original_incident']=state;self.m['incident_sha256']=ex.sha(self.incident.read_bytes());self.manifest.write_text(json.dumps(self.m))
   with self.subTest(exit=value),self.assertRaisesRegex(ValueError,'unresolved failed'):self.runobj()
 def test_production_order_smoke_then_final_capture_then_save(self):
  import ast
  tree=ast.parse((ex.HERE/'qualification.py').read_text());fn=next(x for x in tree.body if isinstance(x,ast.FunctionDef)and x.name=='main')
  smoke=[];capture=[];save=[]
  for node in ast.walk(fn):
   if isinstance(node,ast.Assign)and any(isinstance(t,ast.Name)and t.id=='smoke_result' for t in node.targets):smoke.append(node.lineno)
   if isinstance(node,ast.Call)and isinstance(node.func,ast.Attribute)and isinstance(node.func.value,ast.Name)and node.func.value.id=='exception':
    if node.func.attr=='capture':capture.append(node.lineno)
    if node.func.attr=='save':save.append(node.lineno)
  self.assertEqual(len(smoke),1);self.assertEqual(len(capture),1);self.assertEqual(len(save),1);self.assertLess(smoke[0],capture[0]);self.assertLess(capture[0],save[0])
 def test_locks_remain_held_until_attempt_process_close(self):
  import fcntl
  r=self.runobj();r.capture(lambda *a,**k:json.dumps(self.c))
  for path in [ex.UPDATE_LOCK,Path(str(ex.STATE)+'.lock')]:
   with open(path,'a')as f:
    with self.assertRaises(BlockingIOError):fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
  r.close()
  for path in [ex.UPDATE_LOCK,Path(str(ex.STATE)+'.lock')]:
   with open(path,'a')as f:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
 def test_authorized_database_catalog_not_fixture_name_and_catalog_tampering(self):
  r=self.runobj();r.capture_value=self.c
  self.assertTrue(r.verify(self.b,self.a,q.compare))
  self.a['postgres']['schema']['columns'][1]['udt_catalog']='wrong-db'
  with self.assertRaisesRegex(ValueError,'metadata'):r.verify(self.b,self.a,q.compare)
  self.a['postgres']['schema']['columns'][1]['udt_catalog']='fixture';r.policy['pgDatabase']='other'
  with self.assertRaisesRegex(ValueError,'authorized database'):r.verify(self.b,self.a,q.compare)
 def test_catalog_context_and_strict_metadata_mutations(self):
  for change in ['database','before_catalog','udt_name','datetime_precision','ordinal_position','column_default','is_nullable']:
   self.tearDown();self.setUp();r=self.runobj();r.capture_value=self.c
   if change=='database':self.c['transaction']['database']='other'
   elif change=='before_catalog':self.b['postgres']['schema']['columns'][0]['table_catalog']='other'
   elif change=='datetime_precision':self.a['postgres']['schema']['columns'][3][change]=3
   else:self.a['postgres']['schema']['columns'][1][change]={'udt_name':'varchar','ordinal_position':77,'column_default':'now()','is_nullable':'NO'}[change]
   with self.subTest(change=change),self.assertRaises(ValueError):r.verify(self.b,self.a,q.compare)
 def test_coherent_third_database_catalog_accepted_from_before_and_live(self):
  for obj in [self.b,self.a]:
   for col in obj['postgres']['schema']['columns']:col.update(table_catalog='third_database',udt_catalog='third_database')
  r=self.runobj();r.policy['pgDatabase']='third_database';self.c['transaction']['database']='third_database';r.capture_value=self.c
  self.assertTrue(r.verify(self.b,self.a,q.compare))
 def test_legacy_udt_catalog_guard_isolated(self):
  self.b['postgres']['schema']['columns'][0]['udt_catalog']='wrong';self.a['postgres']['schema']['columns'][0]['udt_catalog']='wrong'
  r=self.runobj();r.capture_value=self.c
  with self.assertRaisesRegex(ValueError,'authorized database'):r.verify(self.b,self.a,q.compare)
 def test_single_legacy_catalog_guard_isolated(self):
  col=copy.deepcopy(self.b['postgres']['schema']['columns'][0]);col.update(column_name='legacy_second',ordinal_position=6,table_catalog='second',udt_catalog='fixture');self.b['postgres']['schema']['columns'].insert(0,col);self.a['postgres']['schema']['columns'].insert(0,copy.deepcopy(col))
  r=self.runobj();r.capture_value=self.c
  with self.assertRaisesRegex(ValueError,'original database'):r.verify(self.b,self.a,q.compare)
 def test_new_column_table_catalog_guard_isolated(self):
  self.a['postgres']['schema']['columns'][1]['table_catalog']='wrong'
  r=self.runobj();r.capture_value=self.c
  with self.assertRaisesRegex(ValueError,'position/catalog'):r.verify(self.b,self.a,q.compare)
if __name__=='__main__':unittest.main()
