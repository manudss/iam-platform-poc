import copy,importlib.util,unittest
from pathlib import Path
s=importlib.util.spec_from_file_location('evidence',Path(__file__).with_name('restored-evidence-check.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def fixture(self):
  pg={'rows':{'public.activations':{'act':1},'public.decision_audit':{'old':2}},'schema':{},'sequences':{'public.decision_audit_id_seq':{'last_value':2,'is_called':True}},'sequenceDefinitions':[]};bao={'meta':'hash'}
  before=[{'database':'iam' if i<7 else 'iam_meta','branch':'main' if i==7 else 'branch'+str(i),'head':'same','root':'same'} for i in range(8)];after=copy.deepcopy(before);after[-1]['root']='migrated'
  post=copy.deepcopy(pg);post['rows']['public.decision_audit']['new']=1;post['sequences']['public.decision_audit_id_seq']['last_value']=3
  b=[{'name':x,'messages':1,'consumers':[{'name':'consumer','pending':0,'ack':0,'redelivered':0}]} for x in ['events','journal','kv']];a=copy.deepcopy(b)
  for x in a:
   for c in x['consumers']:del c['redelivered']
  a[1]['messages']+=28
  return {'pg_restoration':{'before':pg,'after':copy.deepcopy(pg)},'bao_restoration':{'before':bao,'after':bao},'postrotation_bao_same_serializer':copy.deepcopy(bao),'dolt_before':before,'dolt_after':after,'postrotation_stores':{'bao':{'different-serializer':'not-compared'},'dolt':after,'postgres':post},'bus_before':b,'bus_after':a,'rotation_smoke':{'journal':{},'held':True,'workflowPreserved':True,'ledger':[1]},'closed_launch':{'launchedHeldCandidate':True,'ipv6DisabledProved':True}}
 def test_real_shapes_diagnostic_never_admits_and_names_missing_bus(self):
  r=m.evaluate(self.fixture());self.assertFalse(r['admissible']);self.assertEqual(r['checks']['audit_added_rows'],1);self.assertEqual(r['checks']['bus_message_deltas']['journal'],28);self.assertIn('bus-after-redelivered-not-captured',r['blockers'])
 def test_unknown_schema_or_loss_never_normalized(self):
  for mutate in [lambda v:v['dolt_after'].pop(),lambda v:v['bus_after'][0]['consumers'][0].update(pending=1),lambda v:v['postrotation_stores']['postgres']['rows']['public.activations'].clear(),lambda v:v['postrotation_bao_same_serializer'].update(new='hash')]:
   v=self.fixture();mutate(v)
   with self.assertRaises(ValueError):m.evaluate(v)
if __name__=='__main__':unittest.main()
