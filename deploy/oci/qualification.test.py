import importlib.util,tempfile,unittest,copy,json,subprocess
from unittest.mock import patch
from pathlib import Path
spec=importlib.util.spec_from_file_location('qual',Path(__file__).with_name('qualification.py'));q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
def baseline():return {'dolt':[{'branch':'personal/kept','root':'root'}],'bao':{'all/plugin':'hash'},'credentials':{'credentials.json':'hash'},'postgres':{'rows':{'public.business':{'row1':1},'public.audit':{'row1':1},'public.activations':{'held':1}},'schema':{'columns':[]},'sequenceDefinitions':[],'sequences':{'public.audit_id':{'last_value':1,'is_called':True}}}}
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
class AfterFixture(unittest.TestCase):
 def test_actual_after_orchestration_keeps_strict_preservation(self):
  from unittest.mock import patch
  import sys
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);evidence=root/'evidence';evidence.mkdir();(root/'barrier').touch();(root/'auth').write_text('{}');(root/'token').write_text('synthetic-only');(root/'data').mkdir()
   policy={'format':1,'origins':['https://fixture.invalid'],'issuer':'https://fixture.invalid','tenant':'fictional','pgContainer':'pg','pgUser':'u','pgDatabase':'db','network':'none','authFile':str(root/'auth'),'baoMetadataRoots':['synthetic'],'baoAddress':'http://bao','baoTokenFile':str(root/'token'),'credentialFiles':['credentials.json'],'appendOnlyTables':['public.audit']}
   pol=root/'policy';pol.write_text(json.dumps(policy));prior=baseline();prior.update({'image':'old-image','migrationLedger':None,'transportCoverage':'TLS_EXPECTED_ORIGINS','policyHash':q.digest(pol.read_bytes())});(evidence/'before.json').write_text(json.dumps(prior))
   info={'Config':{'Image':'new-image','Env':['IAM_AUTOMATION_HOLD=1','IAM_DEMO_SEED_MODE=never']},'HostConfig':{'RestartPolicy':{'Name':'no'},'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true']},'State':{'Running':True},'RestartCount':0}
   def io(args,input=None):
    if args[:2]==['docker','inspect']:return json.dumps([info])
    if args[-1]=='smoke':return '{}'
    if args[-1]=='capture':return json.dumps({'dolt':prior['dolt'],'bao':prior['bao']})
    raise AssertionError('unexpected IO')
   argv=['qualification','--phase','after','--container','candidate','--image','new-image','--env-file','unused','--data-dir',str(root/'data'),'--backup-dir',str(root),'--barrier-file',str(root/'barrier'),'--target-image','new-image','--evidence-dir',str(evidence),'--policy',str(pol),'--require-automation-hold']
   with patch.object(sys,'argv',argv),patch.object(q,'cmd',side_effect=io),patch.object(q,'postgres',return_value=prior['postgres']),patch.object(q,'credential_hashes',return_value=prior['credentials']),patch.object(q.time,'sleep'),patch.object(q.urllib.request,'urlopen',return_value=type('Response',(),{'status':503})()):
    q.main()
    changed=copy.deepcopy(prior['postgres']);changed['rows']['public.business']={}
    with patch.object(q,'postgres',return_value=changed):
     with self.assertRaisesRegex(ValueError,'unexpected preservation'):q.main()

class ExactActivations(unittest.TestCase):
 def test_held_exact_vs_ordinary_append(self):
  before=baseline();after=copy.deepcopy(before);p={'appendOnlyTables':['public.audit','public.activations']}
  q.exact_held_activations(before,after)
  after['postgres']['rows']['public.activations']['new']=1
  self.assertEqual(q.compare(before,after,p),[])
  with self.assertRaisesRegex(ValueError,'activation journal'):q.exact_held_activations(before,after)
  del after['postgres']['rows']['public.activations']
  with self.assertRaisesRegex(ValueError,'activation journal'):q.exact_held_activations(before,after)

class ClosedRuntime(unittest.TestCase):
 def test_launcher_omitting_runtime_guards_is_rejected(self):
  good={'Config':{'Env':['IAM_AUTOMATION_HOLD=1','IAM_DEMO_SEED_MODE=never']},'HostConfig':{'RestartPolicy':{'Name':'no'},'CapDrop':['ALL'],'CapAdd':None,'Privileged':False,'SecurityOpt':['no-new-privileges:true']}}
  q.closed_runtime(good)
  for key,value in [('CapDrop',[]),('SecurityOpt',[]),('CapAdd',['NET_ADMIN']),('Privileged',True),('RestartPolicy',{'Name':'on-failure'})]:
   mutated=copy.deepcopy(good);mutated['HostConfig'][key]=value
   with self.assertRaises(ValueError,msg=key):q.closed_runtime(mutated)
  for missing in ['IAM_AUTOMATION_HOLD=1','IAM_DEMO_SEED_MODE=never']:
   mutated=copy.deepcopy(good);mutated['Config']['Env'].remove(missing)
   with self.assertRaises(ValueError,msg=missing):q.closed_runtime(mutated)

class HeldSmoke(unittest.TestCase):
 def test_actual_smoke_refuses_missing_capture_or_workflow_drift(self):
  import subprocess,os
  source=Path(__file__).with_name('qualification-container.mjs').read_text()
  prefix="""let diagnosticStage='init';import{createHash,randomBytes}from'node:crypto';const hash=x=>createHash('sha256').update(x).digest('hex');let captures=0;async function workflowHashes(){captures++;return {workflow:process.env.CASE==='drift'&&captures>1?'changed':'retained'};}
  const p={requireAutomationHold:true,auth:{username:'fictional',password:'fictional'},origins:['https://fixture.invalid'],issuer:'https://fixture.invalid/core',tenant:'acme-demo'};
  const readFileSync=path=>path.endsWith('api.log')?(process.env.CASE==='missing'?'no captured hold':'[startup] automation hold: {\"held\":true}') : JSON.stringify(path.includes('manifest')?{versions:[{id:'0001',checksum:'same'}]}:{format:1,entries:[{id:'0001',checksum:'same'}]});const existsSync=()=>true;
  const claims=Buffer.from(JSON.stringify({iss:p.issuer,aud:'demo-web'})).toString('base64url');let state='';globalThis.fetch=async(url,opts={})=>{if(String(url).includes('/authorize?')){const u=new URL(url);state=u.searchParams.get('state');if(u.searchParams.get('redirect_uri').includes('example.invalid'))return new Response('unknown client');return new Response('<input name=\"username\"><input name=\"chain\" value=\"password-only\">');}if(String(url).endsWith('/authorize/login'))return new Response('',{status:302,headers:{location:p.origins[0]+'/callback?code=fixture&state='+state}});return new Response('{}',{status:200,headers:{'content-type':'application/json'}});};
  const originalFetch=globalThis.fetch;globalThis.fetch=async(...args)=>{const r=await originalFetch(...args);r.headers.getSetCookie=()=>[];return r;};
  const json=async(url)=>String(url).endsWith('/token')?{id_token:'x.'+claims+'.x'}:[];
  """
  body=source[source.index('async function smoke()'):source.index('\ntry{',source.index('async function smoke()'))]
  with tempfile.TemporaryDirectory() as d:
   file=Path(d)/'smoke.mjs';file.write_text(prefix+body+"\ntry{await smoke();}catch(e){console.error('QUALIFICATION_DIAG_V1:'+diagnosticStage);process.exitCode=1;}")
   for case in ['ok','missing','drift']:
    r=subprocess.run(['node',str(file)],capture_output=True,text=True,env={**os.environ,'IAM_AUTOMATION_HOLD':'1','CASE':case})
    self.assertEqual(r.returncode==0,case=='ok',(case,r.stderr))
    if case!='ok':self.assertEqual(r.stderr.strip(),'QUALIFICATION_DIAG_V1:'+('smoke-hold' if case=='missing' else 'smoke-workflows-after'))

class Diagnostic(unittest.TestCase):
 def test_allowlist_only(self):
  for stderr,want in [('secret-body\nQUALIFICATION_DIAG_V1:smoke-oidc-login\n','smoke-oidc-login'),('QUALIFICATION_DIAG_V1:secret-password\n',None),('QUALIFICATION_DIAG_V1:smoke-oidc-login/secret\n',None),('secret\n',None)]:
   q.stage('smoke')
   with patch.object(q.subprocess,'run',return_value=subprocess.CompletedProcess([],1,'secret-out',stderr)):
    with self.assertRaisesRegex(ValueError,'command failed') as error:q.cmd(['docker','exec','smoke'])
   self.assertEqual(q.CHILD_STAGE,want);self.assertNotIn('secret',str(error.exception))
 def test_nonchild_stderr_never_parsed(self):
  q.stage('postgres')
  with patch.object(q.subprocess,'run',return_value=subprocess.CompletedProcess([],1,'','QUALIFICATION_DIAG_V1:smoke-oidc-login\n')):
   with self.assertRaises(ValueError):q.cmd(['psql'])
  self.assertIsNone(q.CHILD_STAGE)
 def test_top_level_does_not_leak_exception(self):
  with tempfile.TemporaryDirectory() as d:
   policy=Path(d)/'p';policy.write_text('secret-invalid-json')
   import sys
   args=[sys.executable,str(Path(__file__).with_name('qualification.py')),'--phase','after','--policy',str(policy)]
   for name in ['container','image','env-file','data-dir','backup-dir','barrier-file','target-image','evidence-dir']:args+=['--'+name,'secret']
   r=subprocess.run(args,capture_output=True,text=True)
   self.assertNotEqual(r.returncode,0);self.assertIn('QUALIFICATION_DIAG_V1:policy-load',r.stderr);self.assertNotIn('secret',r.stderr);self.assertNotIn('Traceback',r.stderr)
 def test_js_child_stages_static(self):
  source=Path(__file__).with_name('qualification-container.mjs').read_text()
  import re
  self.assertLessEqual(set(re.findall("diagnosticStage='([^']+)'",source)),q.CHILD_STAGES)

if __name__=='__main__':unittest.main()
