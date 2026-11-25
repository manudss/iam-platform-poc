#!/usr/bin/env python3
"""Direct fresh current-epoch qualification, not historical restoration admission.
No stop/start, gate opening, HOLD change or journal write. Smoke adds sessions/audit.
"""
import hashlib,importlib.util,json,os,sys,time
from pathlib import Path

def load_fixed(binding,name,reader):
 path,_=reader(binding)
 if path!=Path(__file__).with_name(name).absolute():raise ValueError('fixed installed epoch module required')
 s=importlib.util.spec_from_file_location('epoch_'+name.replace('.','_').replace('-','_'),path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def execute(spec,lock_bindings):
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
 runtime=spec['runtime'];env_path,envraw=r.read(runtime['env']);env={line.split('=',1)[0]:line.split('=',1)[1] for line in envraw.decode().splitlines() if line and not line.startswith('#')}
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
 try:
  smoke=json.loads(q.cmd(['docker','exec','-i',runtime['container'],'node','--input-type=module','-e',source.decode(),'smoke'],json.dumps({**policy,'auth':json.loads(authraw),'reviewedLegacyRollback':False})))
  after=json.loads(q.cmd(['docker','exec','-i',runtime['container'],'node','--input-type=module','-e',source.decode(),'capture'],json.dumps({**policy,'running':True,'baoToken':tokenraw.decode().strip()})))
  ledger=Path(env['LYAM_DATA_DIR'])/'migrations/journal.json'
  after.update(migrationLedger=json.loads(ledger.read_text()) if ledger.exists() else None,credentials=q.credential_hashes(Path(env['LYAM_DATA_DIR']),policy),postgres=q.postgres(policy),image=image,policyHash=hashlib.sha256(policyraw).hexdigest(),transportCoverage='LOCAL_TLS_SNI_EPOCH_NOT_PUBLIC')
 finally:q.CAPTURE_LOCK_FDS=()
 q.exact_held_activations(before,after)
 if before.get('transportCoverage')!=after.get('transportCoverage') or q.compare(before,after,policy) or before['migrationLedger']!=after['migrationLedger']:raise ValueError('same epoch stores changed beyond declared append-only audit')
 if not isinstance(smoke.get('journal'),dict) or not smoke.get('ledger'):raise ValueError('epoch smoke coverage absent')
 closed()
 for binding in (spec['qualifier'],spec['runtime_controller'],spec['capture'],spec['auth'],spec['bao_token']):r.read(binding)
 r.locks(lock_bindings)
 q.private_json(evidence/'epoch-after.json',after);q.private_json(evidence/'epoch-smoke.json',smoke)
 audit_before=before['postgres']['rows'].get('public.decision_audit',{});audit_after=after['postgres']['rows'].get('public.decision_audit',{})
 added=sum(audit_after.values())-sum(audit_before.values())
 if not 0<=added<=1000:raise ValueError('epoch smoke audit change beyond bound')
 result={'audit_added_rows':added,'format':1,'kind':'fresh-restored-held-epoch-result','started_at':start,'completed_at':time.time(),'container_id':runtime['expected_container_id'],'target':target,'historical_tls_baseline_missing':True,'transport':'LOCAL_TLS_SNI_NOT_PUBLIC','restoration_admissible':False,'effect_authority':False,'session_audit_smoke_executed':True,'source_hashes':{key:spec[key]['sha256'] for key in ('runtime_controller','qualifier','capture')},'evidence_hashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in evidence.iterdir() if p.is_file()}}
 q.private_json(evidence/'epoch-result.json',result)
 return result

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
