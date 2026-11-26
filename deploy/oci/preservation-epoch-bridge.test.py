import copy,importlib.util,json,unittest
from pathlib import Path
s=importlib.util.spec_from_file_location('bridge',Path(__file__).with_name('preservation-epoch-bridge.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def raw(v):return json.dumps(v,sort_keys=True).encode()
def anchor(a,o):return {'original_sha256':m.digest(raw(a)),'old_policy_sha256':m.digest(raw(o)),'independent_source_sha256':'f'*64,'source_kind':'pre-rotation-operator-proof'}
class Tests(unittest.TestCase):
 def fixture(self):
  old={'origins':['https://lyam.dss.name','https://89-168-55-36.sslip.io'],'requireAutomationHold':True,'appendOnlyTables':['public.activations','public.decision_audit'],'network':'old','authFile':'/old/auth'};new={**old,'network':'new','authFile':'/new/auth'};changes={k:{'before':old[k],'after':new[k]} for k in ['network','authFile']}
  original={'dolt':[{'root':'same'}],'bao':{'meta':'hash'},'credentials':{'cred':'hash'},'migrationLedger':{'entries':[1]},'image':'same','transportCoverage':'TLS_EXPECTED_ORIGINS','policyHash':m.digest(raw(old)),'postgres':{'schema':{},'sequenceDefinitions':[],'rows':{'public.activations':{'act':1},'public.business':{'biz':1},'public.decision_audit':{'old':2}},'sequences':{'public.decision_audit_id_seq':{'last_value':5,'is_called':True}}}}
  current=copy.deepcopy(original);current.update(kind='held-running-baseline',epoch='postrotation-current',originalPreservationReplaced=False,policyHash=m.digest(raw(new)));current['postgres']['rows']['public.decision_audit']['new']=1;current['postgres']['sequences']['public.decision_audit_id_seq']['last_value']=6
  return original,current,old,new,changes
 def test_only_policy_locations_and_audit_append(self):
  a,b,o,n,c=self.fixture();proof=m.bridge(raw(a),raw(b),raw(o),raw(n),c,anchor(a,o));self.assertFalse(proof['effect_authority']);self.assertEqual(proof['audit_added_rows'],1);self.assertEqual(proof['audit_sequence_delta'],1);self.assertEqual(proof['origin_coverage'],'unchanged-including-legacy-SNI')
 def test_missing_independent_anchor_refuses(self):
  a,b,o,n,c=self.fixture()
  with self.assertRaises(ValueError):m.bridge(raw(a),raw(b),raw(o),raw(n),c,{})
 def test_data_loss_new_activation_policy_reduction_or_unbound_relocation_refuse(self):
  mutators=[lambda a,b,o,n,c:b['bao'].clear(),lambda a,b,o,n,c:b['postgres']['rows']['public.decision_audit'].update(old=1),lambda a,b,o,n,c:b['postgres']['rows']['public.activations'].update(new=1),lambda a,b,o,n,c:n['origins'].pop(),lambda a,b,o,n,c:c.clear(),lambda a,b,o,n,c:b.update(unknown=True),lambda a,b,o,n,c:b['postgres']['sequences']['public.decision_audit_id_seq'].update(last_value=0)]
  for mutate in mutators:
   a,b,o,n,c=self.fixture();mutate(a,b,o,n,c)
   with self.assertRaises(ValueError):m.bridge(raw(a),raw(b),raw(o),raw(n),c,anchor(a,o))
if __name__=='__main__':unittest.main()
