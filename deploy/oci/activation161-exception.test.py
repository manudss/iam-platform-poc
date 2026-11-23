import unittest,importlib.util,tempfile,json,copy,hashlib,os
from pathlib import Path
s=importlib.util.spec_from_file_location('ex',Path(__file__).with_name('activation161-exception.py'));ex=importlib.util.module_from_spec(s);s.loader.exec_module(ex)
qspec=importlib.util.spec_from_file_location('q',Path(__file__).with_name('qualification.py'));q=importlib.util.module_from_spec(qspec);qspec.loader.exec_module(q)
H=lambda n:format(n,'064x')
class ExceptionMode(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.d=Path(self.tmp.name);self.policy={'appendOnlyTables':['public.activations'],'pgContainer':'fictional','pgUser':'fixture','pgDatabase':'fixture'};self.policyfile=self.d/'policy.json';self.policyfile.write_text(json.dumps(self.policy));ph=ex.sha(self.policyfile.read_bytes())
  expected=json.loads((ex.HERE/'activation161-column-metadata.json').read_text());template=copy.deepcopy(expected[0]);template.update(column_name='error',ordinal_position=7,table_catalog='fixture')
  self.b={'image':'old','policyHash':ph,'dolt':[1],'bao':{'x':'y'},'credentials':{'x':'y'},'postgres':{'schema':{'columns':[template],'constraints':[]},'rows':{'public.activations':{H(1):2,H(2):1},'public.other':{H(3):1}},'sequences':{'public.seq':{'last_value':3,'is_called':True}},'sequenceDefinitions':[]}}
  self.a=copy.deepcopy(self.b);self.a['image']=ex.IMAGE;self.a['postgres']['rows']['public.activations']={H(4):2,H(5):1}
  for i,col in enumerate(expected,8):self.a['postgres']['schema']['columns'].append({**col,'ordinal_position':i,'table_catalog':'fixture'})
  self.c={'format':1,'transaction':{'read_only':True,'isolation':'repeatable read','snapshot':'1:1:'},'postgres':self.a['postgres'],'projection':{'pairs':[{'whole':H(4),'legacy':H(1),'multiplicity':2},{'whole':H(5),'legacy':H(2),'multiplicity':1}],'row_count':3,'nonnull_new_columns':0}}
  self.before=self.d/'before.json';self.before.write_text(json.dumps(self.b));incident={'history':[{'sha':'b'*40}],'pending':{'sha':'a'*40,'digest':ex.IMAGE.split('@')[1],'parent':'b'*40},'failed':{'sha':'a'*40,'exit':4}};self.incident=self.d/'incident.json';self.incident.write_text(json.dumps(incident))
  self.m={'format':1,'kind':'reviewed-activation161-closed','image':ex.IMAGE,'source_sha':'a'*40,'before_sha256':ex.sha(self.before.read_bytes()),'policy_file':str(self.policyfile),'policy_sha256':ph,'incident_file':str(self.incident),'incident_sha256':ex.sha(self.incident.read_bytes()),'original_incident':incident,'code_sha256':{n:ex.sha((ex.HERE/n).read_bytes())for n in ex.CODE},'authorization_ref':'operator reference to explicit one-run approval','evidence_refs':['reviewed incident'],'one_shot_claim':str(self.d/'consumed')}
  self.manifest=self.d/'manifest.json';self.manifest.write_text(json.dumps(self.m))
 def tearDown(self):self.tmp.cleanup()
 def runobj(self):return ex.ExceptionRun(self.manifest,ex.sha(self.manifest.read_bytes()),self.before,self.policyfile,ex.IMAGE,'after',self.d/'result')
 def test_positive_exact_multiset_and_incompatible_receipt(self):
  r=self.runobj();self.assertEqual(r.capture(lambda *a,**k:json.dumps(self.c)),self.a['postgres']);r.save(q.private_json,self.b,self.a,{'journal':{'count':3},'ledger':[]},q.compare);out=json.loads((self.d/'result/closed-exception-result.json').read_text());self.assertNotEqual(out['format'],1);self.assertNotEqual(out['result'],'qualified');self.assertFalse(out['queue_compatible']);self.assertEqual((self.d/'result/capture.json').stat().st_mode&0o777,0o600)
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
   self.tmp.cleanup();self.setUp();r=self.runobj();r.capture_value=self.c;mutate()
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
  self.tmp.cleanup();self.setUp();self.m['code_sha256']['activation161-capture.sql']='0'*64;self.manifest.write_text(json.dumps(self.m))
  with self.assertRaises(ValueError):self.runobj()
 def test_exact_duplicate_row_multiplicity_missing_extra_and_new_nonnull_refuse(self):
  r=self.runobj();r.capture_value=copy.deepcopy(self.c);r.capture_value['projection']['pairs'][0]['multiplicity']=3
  with self.assertRaises(ValueError):r.verify(self.b,self.a,q.compare)
  r.capture_value=copy.deepcopy(self.c);r.capture_value['projection']['pairs'].pop()
  with self.assertRaises(ValueError):r.verify(self.b,self.a,q.compare)
 def test_exception_only_after_and_no_implicit_manifest(self):
  for phase,image,manifest_hash in [('before',ex.IMAGE,ex.sha(self.manifest.read_bytes())),('after','other',ex.sha(self.manifest.read_bytes())),('after',ex.IMAGE,'0'*64)]:
   with self.assertRaises(ValueError):ex.ExceptionRun(self.manifest,manifest_hash,self.before,self.policyfile,image,phase,self.d/'result')
if __name__=='__main__':unittest.main()
