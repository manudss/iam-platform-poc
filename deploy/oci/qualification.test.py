import importlib.util,tempfile,unittest,copy,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('qual',Path(__file__).with_name('qualification.py'));q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
def baseline():return {'dolt':[{'branch':'personal/kept','root':'root'}],'bao':{'all/plugin':'hash'},'credentials':{'credentials.json':'hash'},'postgres':{'rows':{'public.business':{'row1':1},'public.audit':{'row1':1}},'schema':{'columns':[]},'sequenceDefinitions':[],'sequences':{'public.audit_id':{'last_value':1,'is_called':True}}}}
class Preserve(unittest.TestCase):
 def setUp(self):self.p={'appendOnlyTables':['public.audit']};self.before=baseline();self.after=copy.deepcopy(self.before)
 def test_identical(self):self.assertEqual(q.compare(self.before,self.after,self.p),[])
 def test_audit_append_allowed_not_business(self):
  self.after['postgres']['rows']['public.audit']['row2']=1;self.assertEqual(q.compare(self.before,self.after,self.p),[])
  self.after['postgres']['rows']['public.business']['row2']=1;self.assertIn('postgres-rows:public.business',q.compare(self.before,self.after,self.p))
 def test_old_audit_row_must_survive(self):
  self.after['postgres']['rows']['public.audit']={'row2':99};self.assertTrue(q.compare(self.before,self.after,self.p))
 def test_duplicates_cannot_disappear(self):
  self.before['postgres']['rows']['public.audit']['row1']=2;self.assertTrue(q.compare(self.before,self.after,self.p))
 def test_personal_dirty_branch_never_disposable(self):
  self.after['dolt'][0]['root']='lost';self.assertIn('dolt',q.compare(self.before,self.after,self.p))
 def test_missing_secret_metadata_is_loss_not_absence(self):
  self.after['bao']={};self.assertIn('bao',q.compare(self.before,self.after,self.p))
 def test_credential_replacement_detected(self):
  self.after['credentials']['credentials.json']='new';self.assertIn('credentials',q.compare(self.before,self.after,self.p))
 def test_schema_constraint_drift_detected(self):
  self.after['postgres']['schema']['constraint']='changed';self.assertIn('postgres-schema',q.compare(self.before,self.after,self.p))
 def test_table_drop_detected(self):
  del self.after['postgres']['rows']['public.business'];self.assertIn('postgres-tables',q.compare(self.before,self.after,self.p))
 def test_sequence_monotonic_and_called(self):
  self.after['postgres']['sequences']['public.audit_id']['last_value']=2;self.assertEqual(q.compare(self.before,self.after,self.p),[])
  self.after['postgres']['sequences']['public.audit_id']['last_value']=0;self.assertTrue(q.compare(self.before,self.after,self.p))
 def test_policy_required_independent_coverage(self):
  with tempfile.TemporaryDirectory() as d:
   file=Path(d)/'policy.json';file.write_text('{}')
   with self.assertRaises(ValueError):q.policy_load(file)
   example=Path(__file__).with_name('qualification.policy.example.json');self.assertEqual(q.policy_load(example)['format'],1)
 def test_http_only_explicit_isolated_loopback_never_production(self):
  p=json.loads(Path(__file__).with_name('qualification.policy.example.json').read_text());p['origins']=['http://127.0.0.1:19087'];p['isolatedLoopbackTest']=True
  with tempfile.TemporaryDirectory() as d:
   file=Path(d)/'p.json';file.write_text(json.dumps(p))
   with self.assertRaises(ValueError):q.policy_load(file)
   self.assertEqual(q.policy_load(file,True)['origins'],p['origins'])
   p['origins']=['http://example.invalid'];file.write_text(json.dumps(p))
   with self.assertRaises(ValueError):q.policy_load(file,True)
   p['origins']=['http://127.0.0.1.evil.invalid'];file.write_text(json.dumps(p))
   with self.assertRaises(ValueError):q.policy_load(file,True)
 def test_private_evidence_never_overwritten(self):
  with tempfile.TemporaryDirectory() as d:
   file=Path(d)/'private.json';q.private_json(file,{'ok':True});self.assertEqual(file.stat().st_mode&0o777,0o600)
   with self.assertRaises(FileExistsError):q.private_json(file,{})

class ActivationJournal(unittest.TestCase):
 def setUp(self):self.original=q.query;self.p={'tenant':'t1'}
 def tearDown(self):q.query=self.original
 def read(self,rows):
  q.query=lambda p,sql:rows
  return q.activation_journal(self.p)
 def test_complete_state_and_projection(self):
  rows=[{'tenant':'t1','seq':2,'commit':'abc','state':'applied','error':None,'requestId':None}]
  self.assertEqual(self.read(rows),rows);self.assertEqual(q.journal_projection(rows),[{'seq':2,'commit':'abc'}])
 def test_missing_or_invalid_privileged_journal_never_becomes_empty(self):
  good={'tenant':'t1','seq':1,'commit':'abc','state':'applied'}
  for rows in [None,{},[{'seq':1,'commit':'abc'}],[{**good,'tenant':'other'}],[{**good,'seq':True}],[{**good,'state':'unknown'}],[{**good,'commit':''}],[good,good],[{**good,'error':{}}]]:
   with self.subTest(rows=rows):
    with self.assertRaises(ValueError):self.read(rows)
 def test_empty_verified_only_from_exact_sql_array(self):self.assertEqual(self.read([]),[])
 def test_query_preserves_all_columns_and_quotes_tenant(self):
  captured=[]
  q.query=lambda p,sql:captured.append(sql) or []
  q.activation_journal({'tenant':"a'b"})
  self.assertIn('SELECT a.*',captured[0]);self.assertIn("tenant='a''b'",captured[0]);self.assertIn('ORDER BY seq',captured[0])


class SafeDiagnostics(unittest.TestCase):
 def test_child_codes_accept_only_closed_schema(self):
  prefix='LYAM_QUALIFICATION_DIAGNOSTIC '
  self.assertEqual(q.child_code(prefix+'{"stage":"SESSION_VERIFY","http":403}'),{'stage':'SESSION_VERIFY','http':403})
  for body in ['{"stage":"SECRET_MARKER","http":403}','{"stage":"SMOKE","http":403}','{"stage":"OIDC_TOKEN","http":"secret"}','{"stage":"OIDC_TOKEN","http":403,"body":"secret"}','not-json']:
   self.assertIsNone(q.child_code(prefix+body))
 def test_exception_content_and_commands_never_enter_code(self):
  q.stage('SMOKE');q.child_diagnostic=q.child_code('secret response and password')
  self.assertEqual(q.diagnostic_code(),{'stage':'SMOKE'})

if __name__=='__main__':unittest.main()
