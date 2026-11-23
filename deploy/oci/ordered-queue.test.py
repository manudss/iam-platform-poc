import importlib.util, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('queue',Path(__file__).with_name('ordered-queue.py'));q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
S=lambda n:format(n,'040x'); D=lambda n:'sha256:'+format(n,'064x')
def plan(base,*nums):
 entries=[];parent=S(base)
 for n in nums: entries.append({'sha':S(n),'parent':parent,'digest':D(n)});parent=S(n)
 return {'format':1,'base':S(base),'entries':entries}
class Queue(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'state.json';q.atomic(self.path,{'format':1,'history':[{'sha':S(1),'digest':D(1)}]});self.calls=[]
 def tearDown(self):self.tmp.cleanup()
 def runok(self,args,**kw):self.calls.append(args);return SimpleNamespace(returncode=0)
 def test_order_multicommit(self):
  q.deploy(self.path,plan(1,2,3,4),'update',self.runok);self.assertEqual([e['sha'] for e in q.load(self.path)['history']],[S(i) for i in range(1,5)])
 def test_overlap_newer_runner_then_stale(self):
  q.deploy(self.path,plan(1,2,3),'update',self.runok);q.deploy(self.path,plan(1,2),'update',self.runok);self.assertEqual(len(self.calls),2)
 def test_overlap_older_then_newer(self):
  q.deploy(self.path,plan(1,2),'update',self.runok);q.deploy(self.path,plan(1,2,3),'update',self.runok);self.assertEqual(len(self.calls),2)
 def test_rebuilt_overlap_never_replaces_deployed_digest(self):
  q.deploy(self.path,plan(1,2),'update',self.runok);bad=plan(1,2,3);bad['entries'][0]['digest']=D(999)
  q.deploy(self.path,bad,'update',self.runok);self.assertEqual(q.load(self.path)['history'][1]['digest'],D(2));self.assertEqual(len(self.calls),2)
 def test_fail_blocks_followers_and_retry(self):
  with self.assertRaises(RuntimeError):q.deploy(self.path,plan(1,2,3),'update',lambda *a,**k:SimpleNamespace(returncode=3))
  self.assertEqual(len(q.load(self.path)['history']),1)
  with self.assertRaises(ValueError):q.deploy(self.path,plan(1,2,3),'update',self.runok)
 def test_crash_pending_blocks(self):
  def crash(*a,**kw):raise RuntimeError('crash after update could have succeeded')
  with self.assertRaises(RuntimeError):q.deploy(self.path,plan(1,2),'update',crash)
  with self.assertRaises(ValueError):q.deploy(self.path,plan(1,2),'update',self.runok)
 def test_gap_unknown_baseline_duplicate_invalid_digest(self):
  for bad in [plan(5,6),{'format':1,'base':S(1),'entries':[{'sha':S(3),'parent':S(2),'digest':D(3)}]},plan(1,2,2),{'format':1,'base':S(1),'entries':[{'sha':S(2),'parent':S(1),'digest':'latest'}]}]:
   with self.assertRaises(ValueError):q.deploy(self.path,bad,'update',self.runok)


class Recovery(unittest.TestCase):
 def setUp(self):
  import copy
  self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'state.json'
  self.state={'format':1,'history':[{'sha':S(1),'digest':D(1)}],'pending':plan(1,2)['entries'][0],'failed':{'sha':S(2),'exit':3,'at':'original incident timestamp'}}
  q.atomic(self.path,self.state);self.observations=[];self.verifications=[]
 def tearDown(self):self.tmp.cleanup()
 def manifest(self):
  return {'format':1,'kind':'reviewed-recovery','state_fingerprint':q.fingerprint(q.load(self.path)),
   'expected_delivered':{'sha':S(1),'digest':D(1)},'authorization_ref':'operator-attested approval reference, not authentication','evidence_refs':['private incident evidence'],
   'chain':[{'sha':S(2),'parent':S(1),'outcome':'replaced'},{'sha':S(3),'parent':S(2),'outcome':'abandoned'},{'sha':S(4),'parent':S(3),'outcome':'delivered'}],
   'target':{'sha':S(4),'digest':D(4)},'qualification':{'sha':S(4),'digest':D(4),'evidence_refs':['exact target qualification attestation']}}
 def verify(self,*args):self.verifications.append(args)
 def observe(self,container,target):self.observations.append((container,target));return {**target,'running':True,'container':container}
 def recover(self,manifest=None,**kw):return (q.record_reviewed_in_place if manifest and manifest.get('kind')=='reviewed-in-place' else q.record_reviewed_recovery)(self.path,manifest or self.manifest(),'isolated-reviewed-repository','fixture',verify=kw.get('verify',self.verify),observe=kw.get('observe',self.observe))
 def resume_manifest(self):
  s=q.load(self.path)
  return {'format':1,'kind':'reviewed-resume','state_fingerprint':q.fingerprint(s),'expected_delivered':{k:s['history'][-1][k] for k in ['sha','digest']},'authorization_ref':'separate resume approval attestation','evidence_refs':['operator recheck']}
 def receipt(self):
  import hashlib
  directory=Path(self.tmp.name);image='ghcr.io/manudss/iam-platform-poc@'+D(2);proof={}
  for key,value in [('before',{'image':'old','policyHash':'policy'}),('after',{'image':image,'policyHash':'policy'}),('smoke',{'journal':{'count':1},'ledger':'verified-fixture'})]:
   path=directory/(key+'.json');raw=q.json.dumps(value).encode();path.write_bytes(raw);proof[key]={'path':str(path),'sha256':hashlib.sha256(raw).hexdigest()}
  receipt={'format':1,'result':'qualified','transportCoverage':'TLS_EXPECTED_ORIGINS','image':image,'policyHash':'policy',**{k+'_sha256':v['sha256'] for k,v in proof.items()}};path=directory/'receipt.json';raw=q.json.dumps(receipt).encode();path.write_bytes(raw);proof['receipt']={'path':str(path),'sha256':hashlib.sha256(raw).hexdigest()};return proof
 def in_place_manifest(self):
  m=self.manifest();m['kind']='reviewed-in-place';m['original_unresolved']={k:q.load(self.path)[k] for k in ['pending','failed']};m['qualification_receipt']=self.receipt();m['chain']=[{'sha':S(2),'parent':S(1),'outcome':'delivered'}];m['target']={'sha':S(2),'digest':D(2)};m['qualification']={**m['target'],'evidence_refs':['requalified exact image against original before snapshot']};return m
 def test_exact_failed_image_may_be_qualified_in_place_without_redeployment(self):
  s=self.recover(self.in_place_manifest());self.assertEqual([e['sha'] for e in s['history']],[S(1),S(2)]);self.assertTrue(s['resume_required']);self.assertEqual(s['recoveries'][0]['recovery_mode'],'qualified-in-place');self.assertEqual(s['recoveries'][0]['original_unresolved'],{k:self.state[k] for k in ['pending','failed']});self.assertEqual(len(self.verifications),1);self.assertEqual(len(self.observations),1)
  with self.assertRaisesRegex(ValueError,'operator review'):q.deploy(self.path,plan(2,3),'must-not-run',lambda *a,**kw:self.fail('updater called'))
  q.resume_reviewed(self.path,self.resume_manifest(),'fixture',self.observe);calls=[];q.deploy(self.path,plan(2,3),'next-updater',lambda args,**kw:calls.append(args) or SimpleNamespace(returncode=0));self.assertEqual(len(calls),1)
 def test_in_place_refuses_changed_digest_source_outcome_or_qualification(self):
  import copy
  for alter in [lambda m:m['target'].update(digest=D(999)),lambda m:m['target'].update(sha=S(999)),lambda m:m['chain'][0].update(outcome='replaced'),lambda m:m['chain'][0].update(outcome='abandoned'),lambda m:m['chain'][0].update(parent=S(99)),lambda m:m['qualification'].update(digest=D(99)),lambda m:m.update(authorization_ref='')]:
   m=self.in_place_manifest();alter(m);before=self.path.read_bytes()
   with self.assertRaises(ValueError):self.recover(m)
   self.assertEqual(self.path.read_bytes(),before);self.assertEqual(self.observations,[])
 def test_in_place_stale_manifest_and_unobserved_image_cannot_clear_incident(self):
  m=self.in_place_manifest();m['state_fingerprint']='stale'
  with self.assertRaisesRegex(ValueError,'fingerprint'):self.recover(m)
  def fail(*args):raise ValueError('running image changed')
  with self.assertRaisesRegex(ValueError,'changed'):self.recover(self.in_place_manifest(),observe=fail)
  self.assertEqual(q.load(self.path),self.state)
 def test_in_place_failed_pending_mismatch_or_wrong_initial_parent_refuses(self):
  import copy
  for change in [lambda s:s['failed'].update(sha=S(99)),lambda s:s['pending'].update(parent=S(99))]:
   state=copy.deepcopy(self.state);change(state);q.atomic(self.path,state);m=self.in_place_manifest();before=self.path.read_bytes()
   with self.assertRaisesRegex(ValueError,'inconsistent'):self.recover(m)
   self.assertEqual(self.path.read_bytes(),before);self.assertEqual(self.observations,[])
 def test_two_entry_replacement_chain_remains_accepted(self):
  m=self.manifest();m['chain']=[{'sha':S(2),'parent':S(1),'outcome':'replaced'},{'sha':S(3),'parent':S(2),'outcome':'delivered'}];m['target']={'sha':S(3),'digest':D(3)};m['qualification']={**m['target'],'evidence_refs':['target qualified']}
  s=self.recover(m);self.assertEqual(s['history'][-1]['sha'],S(3));self.assertEqual(s['recoveries'][0]['recovery_mode'],'replacement-chain')
 def test_singleton_cli_never_runs_without_pause_or_with_updater_lock_held(self):
  import fcntl
  lock=Path(self.tmp.name)/'update.lock';lock.touch();before=self.path.read_bytes();manifest=q.json.dumps(self.in_place_manifest())
  args=['--update-lock',str(lock),'--repository','not-used','--container','fixture']
  r=self.cli('record-reviewed-in-place',*args,input=manifest);self.assertNotEqual(r.returncode,0);self.assertIn('pause',r.stderr);self.assertEqual(self.path.read_bytes(),before)
  (Path(self.tmp.name)/'PAUSED').touch()
  with lock.open('a') as held:
   fcntl.flock(held,fcntl.LOCK_EX);r=self.cli('record-reviewed-in-place',*args,input=manifest);self.assertNotEqual(r.returncode,0);self.assertIn('Errno 11',r.stderr);self.assertEqual(self.path.read_bytes(),before)
 def test_singleton_is_refused_by_legacy_kind_and_new_kind_requires_exact_incident(self):
  m=self.in_place_manifest();m['kind']='reviewed-recovery'
  with self.assertRaises(ValueError):self.recover(m)
  m=self.in_place_manifest();m['original_unresolved']['failed']={**m['original_unresolved']['failed'],'exit':99}
  with self.assertRaisesRegex(ValueError,'original incident'):self.recover(m)
 def test_in_place_receipt_hash_missing_file_and_failed_digest_refuse(self):
  m=self.in_place_manifest();Path(m['qualification_receipt']['after']['path']).write_text('{}')
  with self.assertRaisesRegex(ValueError,'hash mismatch'):self.recover(m)
  m=self.in_place_manifest();Path(m['qualification_receipt']['smoke']['path']).unlink()
  with self.assertRaisesRegex(ValueError,'absent'):self.recover(m)
  s=q.load(self.path);s['failed']['digest']=D(99);q.atomic(self.path,s)
  with self.assertRaisesRegex(ValueError,'digest divergence'):self.recover(self.in_place_manifest())
 def test_in_place_atomic_crash_does_not_duplicate_and_legacy_format_reader_refuses(self):
  from unittest.mock import patch
  m=self.in_place_manifest();original=q.atomic
  def crash(path,state):original(path,state);raise OSError('after durable replace')
  with patch.object(q,'atomic',side_effect=crash):
   with self.assertRaises(OSError):self.recover(m)
  s=q.load(self.path);self.assertEqual(s['format'],2);self.assertTrue(s['resume_required']);self.assertEqual(s['recoveries'][-1]['kind'],'reviewed-in-place')
  with self.assertRaisesRegex(ValueError,'fingerprint'):self.recover(m)
  self.assertNotEqual(s['format'],1);self.assertEqual(len(s['recoveries']),1)
 def test_record_preserves_failed_entry_without_claiming_intermediates_delivered(self):
  s=self.recover();self.assertEqual(s['format'],2);self.assertTrue(s['resume_required']);self.assertEqual(s['recovery_fence'],S(4));self.assertEqual([e['sha'] for e in s['history']],[S(1),S(4)])
  self.assertEqual(s['recoveries'][0]['original_unresolved'],{k:self.state[k] for k in ['pending','failed']});self.assertEqual(len(self.observations),1);self.assertEqual(len(self.verifications),1)
 def test_stale_fingerprint_rejects_without_observation_or_write(self):
  m=self.manifest();m['state_fingerprint']='0'*64;before=self.path.read_bytes()
  with self.assertRaisesRegex(ValueError,'fingerprint'):self.recover(m)
  self.assertEqual(self.path.read_bytes(),before);self.assertEqual(self.observations,[])
 def test_changed_delivered_cursor_rejects(self):
  m=self.manifest();m['expected_delivered']['digest']=D(999)
  with self.assertRaisesRegex(ValueError,'cursor'):self.recover(m)
  self.assertEqual(q.load(self.path),self.state)
 def test_recovery_refuses_gap_duplicate_replay_false_delivery_and_bad_attestation(self):
  import copy
  base=self.manifest();cases=[]
  for apply in [lambda m:m.update(chain=[]),lambda m:m.update(chain=[m['chain'][0]]),lambda m:m['chain'][1].update(parent=S(999)),lambda m:m['chain'][1].update(sha=S(2)),lambda m:m['chain'][0].update(outcome='delivered'),lambda m:m['chain'][-1].update(outcome='replaced'),lambda m:m['target'].update(sha=S(2)),lambda m:m['qualification'].update(digest=D(99)),lambda m:m.update(authorization_ref=''),lambda m:m.update(evidence_refs=[]),lambda m:m['qualification'].update(evidence_refs=[])]:
   m=copy.deepcopy(base);apply(m);cases.append(m)
  for m in cases:
   with self.subTest(manifest=m),self.assertRaises(ValueError):self.recover(m)
   self.assertEqual(q.load(self.path),self.state)
 def test_source_or_running_image_verification_failure_keeps_incident(self):
  def fail(*args):raise ValueError('not verified')
  for kw in [{'verify':fail},{'observe':fail}]:
   with self.assertRaises(ValueError):self.recover(**kw)
   self.assertEqual(q.load(self.path),self.state)
 def test_crashed_pending_without_failure_needs_its_own_review(self):
  s=q.load(self.path);del s['failed'];q.atomic(self.path,s)
  with self.assertRaisesRegex(ValueError,'pending\\+failed'):self.recover()
 def test_recovered_state_blocks_drain_until_separate_resume(self):
  self.recover()
  with self.assertRaisesRegex(ValueError,'operator review'):q.deploy(self.path,plan(4,5),'must-not-run',lambda *a,**k:self.fail('updater called'))
 def test_resume_requires_fresh_fingerprint_and_observed_target(self):
  self.recover();m=self.resume_manifest();m['state_fingerprint']='stale'
  with self.assertRaisesRegex(ValueError,'fingerprint'):q.resume_reviewed(self.path,m,'fixture',self.observe)
  def fail(*args):raise ValueError('target stopped or changed')
  with self.assertRaisesRegex(ValueError,'changed'):q.resume_reviewed(self.path,self.resume_manifest(),'fixture',fail)
  self.assertTrue(q.load(self.path)['resume_required'])
 def test_resume_then_fence_rejects_stale_plans_but_fresh_successor_works(self):
  self.recover();m=self.resume_manifest();s=q.resume_reviewed(self.path,m,'fixture',self.observe);self.assertFalse(s['resume_required'])
  for old in [plan(1,2,3,4),plan(1,2,3,4,5),plan(2,3,4,5)]:
   with self.assertRaisesRegex(ValueError,'fence'):q.deploy(self.path,old,'must-not-run',lambda *a,**k:self.fail('stale updater called'))
  calls=[];s=q.deploy(self.path,plan(4,5),'fixture-updater',lambda args,**kw:(calls.append(args) or SimpleNamespace(returncode=0)))
  self.assertEqual([e['sha'] for e in s['history']],[S(1),S(4),S(5)]);self.assertEqual(len(calls),1)
  with self.assertRaisesRegex(ValueError,'fingerprint'):q.resume_reviewed(self.path,m,'fixture',self.observe)
 def test_atomic_crash_before_write_retains_old_state(self):
  from unittest.mock import patch
  with patch.object(q,'atomic',side_effect=OSError('simulated before replace')):
   with self.assertRaises(OSError):self.recover()
  self.assertEqual(q.load(self.path),self.state)
 def test_atomic_crash_after_replace_is_visible_and_never_duplicate_replayed(self):
  from unittest.mock import patch
  original=q.atomic;m=self.manifest()
  def crash(path,state):original(path,state);raise OSError('simulated after durable replace')
  with patch.object(q,'atomic',side_effect=crash):
   with self.assertRaises(OSError):self.recover(m)
  self.assertTrue(q.load(self.path)['resume_required'])
  with self.assertRaisesRegex(ValueError,'fingerprint'):self.recover(m)
  self.assertEqual(len(q.load(self.path)['recoveries']),1)
 def test_corrupt_v2_barrier_or_fence_refuses_load_and_legacy_reader_refuses_v2(self):
  import copy
  s=self.recover();self.assertNotEqual(s['format'],1,'legacy format-1-only executable fails closed')
  for change in [lambda x:x.update(resume_required=False),lambda x:x.update(recovery_fence=S(999)),lambda x:x.update(recoveries=[])]:
   bad=copy.deepcopy(s);change(bad);q.atomic(self.path,bad)
   with self.assertRaises(ValueError):q.load(self.path)
 def test_real_local_git_first_parent_chain_and_main_membership(self):
  import subprocess
  repo=Path(self.tmp.name)/'repo';repo.mkdir()
  def git(*args):return subprocess.check_output(['git','-C',str(repo),*args],text=True,stderr=subprocess.DEVNULL).strip()
  git('init','-q');git('config','user.name','Queue Test Fixture');git('config','user.email','fixture@example.invalid');shas=[]
  for i in range(4):
   (repo/'fixture').write_text(str(i));git('add','fixture');git('commit','-qm','Fictional source '+str(i));shas.append(git('rev-parse','HEAD'))
  git('update-ref','refs/remotes/origin/main',shas[-1]);chain=[{'sha':shas[i],'parent':shas[i-1]} for i in range(1,4)];q.verify_source_chain(repo,shas[0],chain)
  bad=[dict(e) for e in chain];bad[0]['parent']=S(999)
  with self.assertRaisesRegex(ValueError,'first-parent'):q.verify_source_chain(repo,shas[0],bad)
  git('checkout','-qb','divergent',shas[0]);(repo/'other').write_text('fictional divergent source');git('add','other');git('commit','-qm','Divergent fixture');tip=git('rev-parse','HEAD')
  with self.assertRaisesRegex(ValueError,'origin/main'):q.verify_source_chain(repo,shas[0],[{'sha':tip,'parent':shas[0]}])
 def test_docker_identity_checks_are_read_only_and_fail_closed(self):
  from unittest.mock import patch
  import copy
  ref='ghcr.io/manudss/iam-platform-poc@'+D(4);target={'sha':S(4),'digest':D(4)}
  running={'State':{'Running':True},'Config':{'Image':ref},'Image':'local-image-id'};image={'Id':'local-image-id','RepoDigests':[ref],'Config':{'Labels':{'org.opencontainers.image.revision':S(4)}}}
  with patch.object(q,'command_output',side_effect=[q.json.dumps([running]),q.json.dumps([image])]) as calls:
   self.assertTrue(q.observe_running('fixture',target)['running']);self.assertEqual(calls.call_count,2);self.assertEqual(calls.call_args_list[0].args[0][:2],['docker','inspect'])
  for alter in [lambda a,b:a['State'].update(Running=False),lambda a,b:a['Config'].update(Image='old image'),lambda a,b:a.update(Image='wrong id'),lambda a,b:b.update(RepoDigests=[]),lambda a,b:b['Config']['Labels'].update({'org.opencontainers.image.revision':S(99)})]:
   a,b=copy.deepcopy(running),copy.deepcopy(image);alter(a,b)
   with patch.object(q,'command_output',side_effect=[q.json.dumps([a]),q.json.dumps([b])]),self.assertRaises(ValueError):q.observe_running('fixture',target)
 def cli(self,command,*args,input=None):
  import subprocess,sys
  return subprocess.run([sys.executable,str(Path(__file__).with_name('ordered-queue.py')),command,'--state',str(self.path),'--pause-file',str(Path(self.tmp.name)/'PAUSED'),*args],input=input,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 def test_inspection_reads_blocked_state_and_pause_prevents_status_or_pending_write(self):
  pause=Path(self.tmp.name)/'PAUSED';pause.touch();before=self.path.read_bytes();r=self.cli('inspect-reviewed-state');self.assertEqual(r.returncode,0);x=q.json.loads(r.stdout);self.assertEqual(x['state_fingerprint'],q.fingerprint(self.state));self.assertTrue(x['pause_present'])
  for cmd in ['status','drain']:
   r=self.cli(cmd,input=q.json.dumps(plan(1,2)));self.assertNotEqual(r.returncode,0);self.assertEqual(self.path.read_bytes(),before)
 def test_recovery_cli_requires_pause_and_existing_uncontended_updater_lock(self):
  import fcntl
  manifest=q.json.dumps(self.manifest());before=self.path.read_bytes();lock=Path(self.tmp.name)/'update.lock'
  for paused in [False,True]:
   if paused:(Path(self.tmp.name)/'PAUSED').touch()
   r=self.cli('record-reviewed-recovery','--update-lock',str(lock),'--repository','not-used','--container','fixture',input=manifest);self.assertNotEqual(r.returncode,0);self.assertEqual(self.path.read_bytes(),before)
  with lock.open('a') as held:
   fcntl.flock(held,fcntl.LOCK_EX)
   r=self.cli('record-reviewed-recovery','--update-lock',str(lock),'--repository','not-used','--container','fixture',input=manifest);self.assertNotEqual(r.returncode,0);self.assertIn('Errno 11',r.stderr);self.assertEqual(self.path.read_bytes(),before)


 def test_resumed_v2_stays_blocked_by_unchanged_external_pause(self):
  pause=Path(self.tmp.name)/'PAUSED';pause.write_text('retained operator pause')
  self.recover();q.resume_reviewed(self.path,self.resume_manifest(),'fixture',self.observe)
  before=self.path.read_bytes()
  for cmd in ['status','drain']:
   r=self.cli(cmd,input=q.json.dumps(plan(4,5)));self.assertNotEqual(r.returncode,0);self.assertEqual(self.path.read_bytes(),before)
  self.assertEqual(pause.read_text(),'retained operator pause')
 def test_inconsistent_pending_and_failed_identity_rejects(self):
  s=q.load(self.path);s['failed']['sha']=S(999);q.atomic(self.path,s)
  with self.assertRaisesRegex(ValueError,'inconsistent'):self.recover()
  self.assertEqual(q.load(self.path),s)
 def test_resume_rejects_an_unresolved_incident_even_with_fresh_manifest(self):
  m={'format':1,'kind':'reviewed-resume','state_fingerprint':q.fingerprint(self.state),'expected_delivered':{'sha':S(1),'digest':D(1)},'authorization_ref':'attestation','evidence_refs':['evidence']}
  with self.assertRaisesRegex(ValueError,'resolved incident'):q.resume_reviewed(self.path,m,'fixture',self.observe)
  self.assertEqual(q.load(self.path),self.state)
 def test_later_incident_keeps_earlier_audit_and_advances_fence_only_after_observation(self):
  self.recover();q.resume_reviewed(self.path,self.resume_manifest(),'fixture',self.observe)
  with self.assertRaises(RuntimeError):q.deploy(self.path,plan(4,5),'fixture-updater',lambda *a,**k:SimpleNamespace(returncode=7))
  m=self.manifest();m['expected_delivered']={'sha':S(4),'digest':D(4)};m['chain']=[{'sha':S(5),'parent':S(4),'outcome':'replaced'},{'sha':S(6),'parent':S(5),'outcome':'delivered'}];m['target']={'sha':S(6),'digest':D(6)};m['qualification']={**m['target'],'evidence_refs':['new target attestation']}
  s=self.recover(m);self.assertEqual(len(s['recoveries']),2);self.assertEqual(s['recoveries'][0]['original_unresolved']['failed'],self.state['failed']);self.assertEqual(s['recovery_fence'],S(6));self.assertTrue(s['resume_required']);self.assertEqual([e['sha'] for e in s['history']],[S(1),S(4),S(6)])

if __name__=='__main__':unittest.main()
