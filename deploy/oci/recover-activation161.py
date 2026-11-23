#!/usr/bin/env python3
"""Reviewed activation161 opening only. Never deploys, qualifies or resumes a queue."""
import atexit,copy,fcntl,hashlib,importlib.util,json,os,re,signal,sys,time,datetime
from pathlib import Path

def module(name,file):
 spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
ex=module('activation161_closed','activation161-exception.py')
q=module('qualification161','qualification.py')
queue=module('queue161','ordered-queue.py')
old=module('recovery161_helpers','recover-in-place.py')
HERE=Path(__file__).resolve().parent
CODE=ex.CODE+['recover-activation161.py','ordered-queue.py','recover-in-place.py']
KIND='reviewed-activation161-opening'
RESULT='verified-with-reviewed-exception-no-opening'
BARRIER=Path('/var/lib/lyam-front-gate/MAINTENANCE')

def pinned(spec):
 p=Path(spec['path'])
 if not p.is_absolute() or p.is_symlink() or not p.is_file() or ex.sha(p.read_bytes())!=spec['sha256']:raise ValueError('opening pinned file mismatch')
 return p

def verify_closed(m):
 """Verify all original files, original consumed claim, and strict preservation again."""
 manifest=pinned(m['closed_manifest']);cm,cmsha=ex.read(manifest)
 before_path=pinned(m['before']);before,_=ex.read(before_path)
 if cm.get('format')!=1 or cm.get('kind')!='reviewed-activation161-closed' or cm.get('image')!=ex.IMAGE:raise ValueError('closed exception manifest required')
 ex.pins(cm,before_path)
 if Path(cm['one_shot_claim']).read_text()!=cmsha+'\n':raise ValueError('closed claim does not bind manifest')
 result_path=pinned(m['closed_result']);r,_=ex.read(result_path)
 if r.get('format')!='activation161-closed-exception-v1' or r.get('type')!='closed-qualification-only' or r.get('result')!=RESULT or r.get('queue_compatible')is not False or r.get('image')!=ex.IMAGE:raise ValueError('closed exception result required, never normal receipt')
 if r.get('exception_manifest_sha256')!=cmsha or r.get('before_sha256')!=m['before']['sha256'] or r.get('policy_sha256')!=cm['policy_sha256']:raise ValueError('closed result link mismatch')
 values={}
 for name in ['after.json','smoke.json','capture.json']:
  path=result_path.parent/name
  if path.is_symlink() or ex.sha(path.read_bytes())!=r.get('files',{}).get(name):raise ValueError('closed artifact changed')
  values[name]=json.loads(path.read_text())
 smoke=values['smoke.json']
 if not isinstance(smoke.get('journal'),dict) or not smoke.get('ledger'):raise ValueError('closed smoke coverage absent')
 if before.get('transportCoverage')!='TLS_EXPECTED_ORIGINS' or values['after.json'].get('transportCoverage')!='TLS_EXPECTED_ORIGINS':raise ValueError('original TLS qualification required')
 # No constructor, locks, output, or claim is replayed. This is the pure verifier.
 verifier=object.__new__(ex.ExceptionRun);verifier.manifest=cm;verifier.policy=json.loads(Path(cm['policy_file']).read_text());verifier.capture_value=values['capture.json'];verifier.recheck=lambda:ex.pins(cm,before_path)
 verifier.verify(before,values['after.json'],q.compare)
 return cm,before,verifier

def identity(container,command=q.cmd):
 rows=json.loads(command(['docker','inspect','--type','container',container]))
 if len(rows)!=1:raise ValueError('one live container required')
 x=rows[0]
 if not x['State']['Running'] or x['State'].get('Paused') or x['State'].get('Restarting'):raise ValueError('container not steadily running')
 return {k:x[k] for k in ['Id','Image','RestartCount']}|{'StartedAt':x['State']['StartedAt']}

def live_capture(m,verifier,command=q.cmd):
 """Actual new capture each attempt, not an operator-supplied path or old receipt."""
 p=verifier.policy;data=Path(m['data_dir']);source=(HERE/'qualification-container.mjs').read_text()
 state=json.loads(command(['docker','exec','-i',m['container'],'node','--input-type=module','-e',source,'capture'],json.dumps({**p,'running':True,'baoToken':Path(p['baoTokenFile']).read_text().strip()})))
 ledger=data/'migrations/journal.json';state['migrationLedger']=json.loads(ledger.read_text())if ledger.exists()else None
 state['credentials']=q.credential_hashes(data,p);state['postgres']=verifier.capture(command)
 state.update(image=ex.IMAGE,policyHash=ex.sha(Path(verifier.manifest['policy_file']).read_bytes()),transportCoverage='TLS_EXPECTED_ORIGINS')
 return state

def plan_record(m,closed,live_hash,observe=queue.observe_running,verify=queue.verify_source_chain):
 """All recorder validation before unlink. No state writes here."""
 state=queue.load(ex.STATE);review=m['queue_manifest'];queue.checked_manifest(state,review,KIND)
 if state!=closed['original_incident'] or ex.sha(ex.STATE.read_bytes())!=closed['incident_sha256']:raise ValueError('live registry differs from closed original bytes')
 pending=state.get('pending');failed=state.get('failed');target=review.get('target',{})
 if not pending or not failed or state.get('resume_required',False)is not False or type(failed.get('exit'))is not int or failed['exit']==0:raise ValueError('unresolved failed incident required')
 if review.get('original_unresolved')!={'pending':pending,'failed':failed}:raise ValueError('original incident mismatch')
 if target!={'sha':closed['source_sha'],'digest':ex.IMAGE.split('@')[1]} or any(target[k]!=pending.get(k)for k in ['sha','digest']) or failed.get('sha')!=pending['sha'] or failed.get('digest',pending['digest'])!=pending['digest'] or pending.get('parent')!=state['history'][-1]['sha']:raise ValueError('exact failed source/digest/parent required')
 chain=review.get('chain')
 if chain!=[{'sha':pending['sha'],'parent':pending['parent'],'outcome':'delivered'}]:raise ValueError('exact singleton first-parent chain required')
 verify(m['repository'],state['history'][-1]['sha'],chain);observed=observe(m['container'],target)
 now=datetime.datetime.now(datetime.timezone.utc).isoformat();new=copy.deepcopy(state)
 audit={'kind':KIND,'recovery_mode':'activation161-reviewed-exception','at':now,'state_fingerprint':queue.fingerprint(state),'authorization_ref':m['authorization_ref'],'evidence_refs':m['evidence_refs'],'original_unresolved':copy.deepcopy(review['original_unresolved']),'chain':chain,'target':target,'observed_running':observed,'closed_result':m['closed_result'],'closed_manifest':m['closed_manifest'],'live_evidence_sha256':live_hash}
 new.setdefault('recoveries',[]).append(audit);new['history'].append({**target,'at':now,'mode':'observed-activation161-exception'});del new['pending'];del new['failed'];new.update(format=2,recovery_fence=target['sha'],resume_required=True)
 return state,new

class Opening:
 def __init__(self,path,expected_sha):
  self.path=Path(path);self.m,self.hash=ex.read(self.path);self.locks=[];self.claimed=False;self.started=False
  if self.hash!=expected_sha or self.m.get('format')!=1 or self.m.get('kind')!=KIND:raise ValueError('explicit pinned opening manifest required')
  m=self.m;queue.reference(m.get('authorization_ref'));queue.references(m.get('evidence_refs'))
  if set(m.get('code_sha256',{}))!=set(CODE):raise ValueError('both stage and recorder code pins required')
  try:
   for p in [Path(str(ex.STATE)+'.lock'),ex.UPDATE_LOCK]:
    if not p.is_file() or p.is_symlink():raise ValueError('existing real locks required')
    f=open(p,'a');self.locks.append(f);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
   self.recheck()
   cm,_,_=verify_closed(m)
   claim=Path(m['one_shot_claim'])
   if not claim.is_absolute() or claim==Path(cm['one_shot_claim']):raise ValueError('distinct absolute opening claim required')
   fd=os.open(claim,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
   with os.fdopen(fd,'w')as f:f.write(self.hash+'\n');f.flush();os.fsync(f.fileno())
   self.claimed=True
   self.output=Path(m['output']);self.output.mkdir(mode=0o700)
  except BaseException:self.close();raise
  atexit.register(self.close)
 def close(self):
  for f in self.locks:
   if not f.closed:f.close()
 def recheck(self):
  if any(f.closed for f in self.locks) or ex.read(self.path)[1]!=self.hash:raise ValueError('opening pins or locks lost')
  if not ex.PAUSE.is_file():raise ValueError('external pause absent')
  if self.claimed and Path(self.m['one_shot_claim']).read_text()!=self.hash+'\n':raise ValueError('opening claim changed')
  for name in CODE:
   if ex.sha((HERE/name).read_bytes())!=self.m['code_sha256'][name]:raise ValueError('opening code changed')
  return verify_closed(self.m)
 def run(self,capture=live_capture,observe=queue.observe_running,verify=queue.verify_source_chain,front=old.probe,is_dead=old.dead,identify=identity,write=queue.atomic):
  if self.started:raise ValueError('opening attempt already consumed')
  self.started=True
  m=self.m;cm,before,v=self.recheck();barrier=Path(m['barrier_file']);token=m['barrier_token']
  if barrier!=BARRIER:raise ValueError('real front gate path required')
  match=re.fullmatch(r'lyam-update:([1-9][0-9]*):[0-9]{8}T[0-9]{6}Z',token)
  if not match or int(match[1])!=m['former_pid']:raise ValueError('exact former barrier owner required')
  origins=v.policy.get('origins')
  if m.get('origins')!=origins or not origins or any(not re.fullmatch(r'https://[a-zA-Z0-9.-]+(?::[0-9]+)?',o)for o in origins):raise ValueError('exact original TLS origins required')
  def gate():
   if not is_dead(m['former_pid']) or barrier.is_symlink() or barrier.read_text().rstrip('\n')!=token:raise ValueError('live owner or foreign barrier')
   if any(front(o)!=503 for o in origins):raise ValueError('TLS maintenance required')
  gate();target=m['queue_manifest']['target'];observe(m['container'],target);initial=identify(m['container']);started=time.monotonic()
  v.capture_value=None
  after=capture(m,v);v.verify(before,after,q.compare)
  if identify(m['container'])!=initial:raise ValueError('container changed during live capture')
  # Evidence is exclusively generated by this invocation, never supplied from a file.
  evidence={'format':'activation161-live-opening-v1','after':after,'capture':v.capture_value,'container_identity':initial,'opening_manifest_sha256':self.hash,'closed_result_sha256':m['closed_result']['sha256']}
  path=self.output/'live-evidence.json';q.private_json(path,evidence);live_hash=ex.sha(path.read_bytes())
  original,prepared=plan_record(m,cm,live_hash,observe,verify)
  self.recheck();gate()
  if ex.sha(path.read_bytes())!=live_hash or time.monotonic()-started>60:raise ValueError('live capture absent, modified or stale')
  if identify(m['container'])!=initial:raise ValueError('container restarted before opening')
  # No new cross-system transaction is claimed. Uncontrolled workers can still
  # write after the final snapshot. Divergence stops rather than widens policy.
  removed=False;write_started=False
  try:
   removed=True
   barrier.unlink()
   if any(front(o)!=200 for o in origins):raise ValueError('TLS opening probe failed')
   if not ex.PAUSE.is_file() or ex.read(ex.STATE)[0]!=original or ex.sha(ex.STATE.read_bytes())!=cm['incident_sha256'] or identify(m['container'])!=initial:raise ValueError('state or container changed before record')
   self.recheck();observe(m['container'],target)
   write_started=True;write(ex.STATE,prepared)
   confirmed=queue.load(ex.STATE)
   if confirmed!=prepared or not ex.PAUSE.is_file() or identify(m['container'])!=initial:raise ValueError('record confirmation uncertain')
   return {'opened':True,'queue_resume_required':True,'pause_retained':True,'kind':KIND,'closed_result_sha256':m['closed_result']['sha256'],'live_evidence_sha256':live_hash}
  except BaseException as failure:
   if removed:
    try:
     fd=os.open(barrier,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)
     with os.fdopen(fd,'w')as f:f.write(token+'\n');f.flush();os.fsync(f.fileno())
    except FileExistsError:pass
    if any(front(o)!=503 for o in origins):raise RuntimeError('maintenance rearm unproven, immediate operator inspection required')from failure
   if write_started:raise RuntimeError('queue write attempted, front rearmed; inspect durable state and audit, no automatic retry')from failure
   raise

def main():
 import argparse
 p=argparse.ArgumentParser();p.add_argument('--manifest',required=True);p.add_argument('--manifest-sha256',required=True);a=p.parse_args()
 def stop(*args):raise KeyboardInterrupt('opening interrupted')
 signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
 attempt=Opening(a.manifest,a.manifest_sha256)
 try:print(json.dumps(attempt.run()))
 finally:attempt.close()
if __name__=='__main__':
 try:main()
 except BaseException:print('Exception161 opening failed or uncertain. Inspect private state/audit, retain pause, never retry automatically.',file=sys.stderr);sys.exit(1)
