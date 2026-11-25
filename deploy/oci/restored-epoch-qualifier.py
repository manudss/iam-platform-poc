#!/usr/bin/env python3
"""Direct fresh current-epoch qualification, not historical restoration admission.
No stop/start, gate opening, HOLD change or journal write. Smoke adds sessions/audit.
"""
import hashlib,importlib.util,json,os,sys,time,signal,math,re
from pathlib import Path

def smoke_projection(value):
 if not isinstance(value,dict) or set(value)!={'journal','ledger','held','workflowPreserved'}:raise ValueError('non-secret smoke schema differs')
 j=value['journal'];ledger=value['ledger']
 if not isinstance(j,dict) or set(j)!={'count','checksum'} or type(j['count']) is not int or j['count']<0 or not re.fullmatch('[a-f0-9]{64}',str(j['checksum'])):raise ValueError('non-secret smoke journal differs')
 if not isinstance(ledger,list) or not ledger or len(ledger)>10000:raise ValueError('non-secret smoke ledger differs')
 for item in ledger:
  if not isinstance(item,dict) or set(item)!={'id','checksum'} or not re.fullmatch('[A-Za-z0-9_.-]{1,128}',str(item['id'])) or not re.fullmatch('[a-f0-9]{64}',str(item['checksum'])):raise ValueError('non-secret smoke ledger item differs')
 if value['held'] is not True or value['workflowPreserved'] is not True:raise ValueError('smoke hold coverage differs')
 return value

def evidence_projection(component,value):
 # Exact raw comparator inputs stay in memory. Persist only hashes/counts, never
 # SQL defaults/functions, ledger payloads, database values or credential bytes.
 if component=='stores' and (not isinstance(value,dict) or set(value)!={'dolt','bao'}):raise ValueError('store evidence shape differs')
 if component=='postgres' and (not isinstance(value,dict) or set(value)!={'rows','schema','sequences','sequenceDefinitions'}):raise ValueError('postgres evidence shape differs')
 if component=='credentials' and (not isinstance(value,dict) or any(v is not None and not re.fullmatch('[a-f0-9]{64}',str(v)) for v in value.values())):raise ValueError('credential hash evidence differs')
 encoded=json.dumps(value,sort_keys=True,separators=(',',':')).encode()
 result={'format':1,'kind':'non-secret-epoch-component-digest','component':component,'sha256':hashlib.sha256(encoded).hexdigest(),'serialized_bytes':len(encoded),'top_level_count':len(value) if isinstance(value,(dict,list)) else None,'raw_values_persisted':False}
 if component=='postgres':
  result['row_multiset_sha256']=hashlib.sha256(json.dumps(value['rows'],sort_keys=True).encode()).hexdigest()
  result['row_count']=sum(sum(rows.values()) for rows in value['rows'].values())
  result['sequence_count']=len(value['sequences'])
 return result

def bounded_source(source):
 return ("const {spawn:epochSpawn}=await import('node:child_process');"
  "const epochWatch=epochSpawn(process.execPath,['-e',\"setTimeout(()=>{try{process.kill(Number(process.argv[1]),'SIGKILL')}catch{}},120000)\",String(process.pid)],{stdio:'ignore'});epochWatch.unref();"
  "process.on('exit',()=>{try{epochWatch.kill('SIGKILL')}catch{}});\n"+source.decode())

def load_fixed(binding,name,reader):
 path,_=reader(binding)
 if path!=Path(__file__).with_name(name).absolute():raise ValueError('fixed installed epoch module required')
 s=importlib.util.spec_from_file_location('epoch_'+name.replace('.','_').replace('-','_'),path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def _execute(spec,lock_bindings):
 # Bootstrap only this fixed read primitive, then verify its bytes before any
 # data/runtime action. Caller admission owns this module's own reviewed hash.
 path=Path(__file__).with_name('restored-runtime-check.py').absolute()
 for a in [path,*path.parents]:
  st=a.lstat()
  if a.is_symlink() or st.st_uid or st.st_gid or st.st_mode&0o022:raise ValueError('protected fixed bootstrap required')
 if spec.get('runtime_controller',{}).get('path')!=str(path) or hashlib.sha256(path.read_bytes()).hexdigest()!=spec['runtime_controller']['sha256']:raise ValueError('runtime controller binding differs')
 s=importlib.util.spec_from_file_location('epoch_runtime',path);r=importlib.util.module_from_spec(s);s.loader.exec_module(r)
 required={'format','kind','runtime_controller','qualifier','capture','runtime','evidence_dir','auth','bao_token'}
 if set(spec)!=required or spec['format']!=1 or spec['kind']!='fresh-restored-held-epoch':raise ValueError('exact current epoch qualification spec required')
 q=load_fixed(spec['qualifier'],'qualification.py',r.read)
 r.read(spec['capture']);r.read(spec['auth']);r.read(spec['bao_token']);r.locks(lock_bindings)
 runtime=spec['runtime'];env_path,envraw=r.read(runtime['env']);env=r.parse_env(envraw)
 policy_path,policyraw=r.read(runtime['policy']);policy=json.loads(policyraw)
 if policy['authFile']!=spec['auth']['path'] or policy['baoTokenFile']!=spec['bao_token']['path']:raise ValueError('exact epoch secret source bindings required')
 evidence=Path(spec['evidence_dir'])
 if not evidence.is_absolute() or '..' in evidence.parts or evidence.exists():raise ValueError('new absolute epoch evidence required')
 for parent in [evidence.parent,*evidence.parent.parents]:
  st=parent.lstat()
  if parent.is_symlink() or st.st_uid or st.st_gid or st.st_mode&0o022:raise ValueError('protected epoch evidence directory required')
 target=runtime['target'];image='ghcr.io/manudss/iam-platform-poc@'+target['digest'];observations=[]
 def closed():
  current=r.verify(runtime,lock_bindings)
  if observations and current!=observations[0]:raise ValueError('epoch runtime/gates changed')
  observations.append(current)
 # No arbitrary callback enters from the spec. This closure calls only the
 # fixed hash-bound installed runtime check directly.
 start=time.time();q.held_running_baseline(runtime['container'],image,evidence,policy_path,env['LYAM_DATA_DIR'],lock_bindings,closed,spec['capture'],transport_coverage='LOCAL_TLS_SNI_EPOCH_NOT_PUBLIC')
 baseline_path=evidence/'held-running-baseline.json';before=json.loads(baseline_path.read_text())
 _,source=r.read(spec['capture']);_,authraw=r.read(spec['auth']);_,tokenraw=r.read(spec['bao_token'])
 q.CAPTURE_LOCK_FDS=tuple(fd for path,fd in lock_bindings.values())
 smoke_error=None;after={};smoke=None
 q.private_json(evidence/'epoch-attempt.json',{'kind':'fresh-held-smoke-attempt','started_at':time.time(),'may_mutate_sessions_audit':True,'restoration_admissible':False})
 # Bound the remote Node process itself, not just docker exec's client.
 executed_source=bounded_source(source)
 executed_sha256=hashlib.sha256(executed_source.encode()).hexdigest()
 try:
  ledger_file=Path(env['LYAM_DATA_DIR'])/'migrations/journal.json'
  if not ledger_file.is_file():raise ValueError('existing migration ledger required before smoke')
  pre=json.loads(q.cmd(['docker','exec','-i',runtime['container'],'node','--input-type=module','-e',executed_source,'epoch-pre-smoke-check'],json.dumps(policy)))
  if pre.get('held') is not True or not isinstance(pre.get('hashes'),dict) or not pre['hashes'] or any(not re.fullmatch('[a-f0-9]{64}',str(v)) for v in pre['hashes'].values()):raise ValueError('pre-smoke readable log/workflow coverage required')
  q.private_json(evidence/'epoch-pre-smoke.json',{'held':True,'workflow_count':len(pre['hashes']),'executed_source_sha256':executed_sha256,'capture_source_sha256':spec['capture']['sha256'],'timeout_prefix_bound_by_controller':True})
 except BaseException:
  q.CAPTURE_LOCK_FDS=()
  raise

 try:
  try:
   smoke=json.loads(q.cmd(['docker','exec','-i',runtime['container'],'node','--input-type=module','-e',executed_source,'smoke'],json.dumps({**policy,'auth':json.loads(authraw),'reviewedLegacyRollback':False})))
   # Whitelist only non-secret smoke facts. Never persist raw stdout/stderr.
   safe=smoke_projection(smoke)
   q.private_json(evidence/'epoch-smoke.json',safe)
  except Exception as error:
   smoke_error=error
   stage=getattr(q,'CHILD_STAGE',None)
   allowed=getattr(q,'CHILD_STAGES',set())
   q.private_json(evidence/'epoch-smoke-refusal.json',{'returned':False,'diagnostic_stage':stage if stage in allowed else 'unverified','may_have_mutated':True})
   for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,signal.SIG_IGN)
   signal.alarm(120)
  finally:
   # Even a failed/interrupted smoke may have written sessions/audit. Capture
   # independent components immediately, before validation, with a recovery cap.
   failures=[];recovery_deadline=time.monotonic()+120
   for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,signal.SIG_IGN)
   for name,read_state in (
    ('stores',lambda:json.loads(q.cmd(['docker','exec','-i',runtime['container'],'node','--input-type=module','-e',executed_source,'capture'],json.dumps({**policy,'running':True,'baoToken':tokenraw.decode().strip()})))),
    ('postgres',lambda:q.postgres(policy)),
    ('credentials',lambda:q.credential_hashes(Path(env['LYAM_DATA_DIR']),policy)),
    ('migrationLedger',lambda:json.loads((Path(env['LYAM_DATA_DIR'])/'migrations/journal.json').read_text()))):
    try:
     remaining=recovery_deadline-time.monotonic()
     if remaining<=0:raise TimeoutError('recovery capture budget exhausted')
     signal.alarm(math.ceil(remaining))
     value=read_state();q.private_json(evidence/('epoch-after-'+name+'.json'),evidence_projection(name,value))
     if name=='stores':after.update(value)
     else:after[name]=value
    except Exception:failures.append(name)
   signal.alarm(0)
   q.private_json(evidence/'epoch-attempt-outcome.json',{'smoke_returned':smoke is not None,'smoke_refused_or_interrupted':smoke_error is not None,'capture_failed_components':failures,'restoration_admissible':False,'may_have_mutated':True})
   after.update(image=image,policyHash=hashlib.sha256(policyraw).hexdigest(),transportCoverage='LOCAL_TLS_SNI_EPOCH_NOT_PUBLIC')
   q.private_json(evidence/'epoch-after-summary.json',{'format':1,'complete':not failures,'failed_components':failures,'components':{key:evidence_projection(key,value) for key,value in after.items()},'raw_comparison_inputs_persisted':False})
  signal.alarm(120)
  if smoke_error:raise ValueError('smoke refused or interrupted; inspect non-secret epoch evidence') from None
  if failures:raise ValueError('post-smoke capture incomplete; retained partial evidence')
 finally:q.CAPTURE_LOCK_FDS=()
 q.exact_held_activations(before,after)
 if before.get('transportCoverage')!=after.get('transportCoverage') or q.compare(before,after,policy) or before['migrationLedger']!=after['migrationLedger']:raise ValueError('same epoch stores changed beyond declared append-only audit')
 if not isinstance(smoke.get('journal'),dict) or not smoke.get('ledger'):raise ValueError('epoch smoke coverage absent')
 closed()
 for binding in (spec['qualifier'],spec['runtime_controller'],spec['capture'],spec['auth'],spec['bao_token']):r.read(binding)
 r.locks(lock_bindings)
 audit_before=before['postgres']['rows'].get('public.decision_audit',{});audit_after=after['postgres']['rows'].get('public.decision_audit',{})
 added=sum(audit_after.values())-sum(audit_before.values())
 if not 0<=added<=1000:raise ValueError('epoch smoke audit change beyond bound')
 result={'audit_added_rows':added,'format':1,'kind':'fresh-restored-held-epoch-result','started_at':start,'completed_at':time.time(),'container_id':runtime['expected_container_id'],'target':target,'historical_tls_baseline_missing':True,'transport':'LOCAL_TLS_SNI_NOT_PUBLIC','restoration_admissible':False,'effect_authority':False,'session_audit_smoke_executed':True,'executed_source_sha256':executed_sha256,'source_hashes':{key:spec[key]['sha256'] for key in ('runtime_controller','qualifier','capture')},'evidence_hashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in evidence.iterdir() if p.is_file()}}
 q.private_json(evidence/'epoch-result.json',result)
 return result

def execute(spec,lock_bindings):
 def interrupted(signum,frame):
  for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,signal.SIG_IGN)
  signal.alarm(0)
  raise TimeoutError('bounded current epoch interrupted')
 prior={sig:signal.signal(sig,interrupted) for sig in (signal.SIGALRM,signal.SIGTERM,signal.SIGINT)}
 signal.alarm(600)
 try:return _execute(spec,lock_bindings)
 finally:
  signal.alarm(0)
  for sig,handler in prior.items():signal.signal(sig,handler)

def main():
 import argparse,fcntl
 p=argparse.ArgumentParser();p.add_argument('--spec',required=True);p.add_argument('--spec-sha256',required=True);p.add_argument('--controller-sha256',required=True);p.add_argument('--execute-fresh-held-epoch',action='store_true');a=p.parse_args()
 if os.geteuid()!=0:raise ValueError('operator root execution required')
 self_path=Path(__file__).absolute()
 for path in [self_path,*self_path.parents]:
  st=path.lstat()
  if path.is_symlink() or st.st_uid or st.st_gid or st.st_mode&0o022:raise ValueError('protected installed epoch controller required')
 if hashlib.sha256(self_path.read_bytes()).hexdigest()!=a.controller_sha256:raise ValueError('epoch controller changed')
 raw=Path(a.spec).read_bytes()
 if hashlib.sha256(raw).hexdigest()!=a.spec_sha256:raise ValueError('epoch spec changed')
 for path in [Path(a.spec),*Path(a.spec).parents]:
  st=path.lstat()
  if path.is_symlink() or st.st_uid or st.st_gid or st.st_mode&0o022:raise ValueError('protected reviewed epoch spec required')
 spec=json.loads(raw)
 if not a.execute_fresh_held_epoch:raise ValueError('fresh authenticated smoke requires explicit execute flag, no journal action implied')
 root=Path('/opt/lyam-recovery/active');paths={'journal':root/'deploy-queue/state.json.lock','updater':root/'.update.lock'}
 import contextlib
 with contextlib.ExitStack() as stack:
  bindings={}
  for key,path in paths.items():
   if not path.is_file() or path.is_symlink():raise ValueError('existing actual lock file required')
   file=stack.enter_context(path.open('a'));fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB);bindings[key]=(str(path),file.fileno())
  result=execute(spec,bindings)
  print(json.dumps({'kind':result['kind'],'historical_tls_baseline_missing':True,'restoration_admissible':False,'effect_authority':False,'evidence_dir':spec['evidence_dir']}))
if __name__=='__main__':
 try:main()
 except Exception:
  print('Fresh held epoch qualification refused; leave HOLD/pause/gates and evidence unchanged',file=sys.stderr);sys.exit(1)
