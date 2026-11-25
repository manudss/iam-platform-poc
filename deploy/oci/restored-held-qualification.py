#!/usr/bin/env python3
"""Direct fresh held qualification for restored adoption, not a receipt parser.
Runs only the fixed protected installed qualifier. Audit evidence is computed here.
"""
import hashlib,json,subprocess,sys,time
from pathlib import Path


def execute(q,manifest,container,target,lock_fds):
 # Protection/hash checks are applied to the installed controllers and policy,
 # not delegated to a manifest-provided command string.
 c=q.opening_controller(manifest)
 env,_=c.verify(manifest,container,target,public=503)
 opening=manifest['opening']
 qualifier=Path(__file__).with_name('qualification.py').absolute()
 if opening.get('qualifier',{}).get('path')!=str(qualifier):raise ValueError('fixed installed qualifier required')
 c.read_spec(opening['qualifier']);before_path,before_raw=c.read_spec(opening['before']);policy_path,policy_raw=c.read_spec(opening['policy'])
 before=json.loads(before_raw)
 if before.get('policyHash')!=hashlib.sha256(policy_raw).hexdigest():raise ValueError('baseline policy differs')
 if before_path.name!='before.json':raise ValueError('exact existing preservation baseline required')
 evidence=before_path.parent
 old={p.name for p in evidence.iterdir()}
 image='ghcr.io/manudss/iam-platform-poc@'+target['digest']
 first=q.observe_running(container,target)
 start=time.time()
 args=[sys.executable,str(qualifier),'--phase','after','--container',container,'--image',image,'--env-file',opening['env']['path'],'--data-dir',env.get('LYAM_DATA_DIR','/opt/lyam/data'),'--backup-dir',env.get('LYAM_BACKUP_DIR','/opt/lyam/backups'),'--barrier-file',env['LYAM_FRONT_BARRIER_FILE'],'--target-image',image,'--evidence-dir',str(evidence),'--policy',str(policy_path),'--require-automation-hold']
 result=subprocess.run(args,text=True,capture_output=True,timeout=600,pass_fds=tuple(lock_fds))
 if result.returncode:raise ValueError('direct fresh qualification refused; inspect private local diagnostics')
 second=q.observe_running(container,target)
 if not first.get('container_id') or first!=second:raise ValueError('container identity changed during qualification')
 new={p.name for p in evidence.iterdir()}-old
 after=[n for n in new if n.startswith('after-') and n.endswith('.json')];smoke=[n for n in new if n.startswith('smoke-') and n.endswith('.json')]
 if len(after)!=1 or len(smoke)!=1 or len(new)!=2:raise ValueError('fresh unique qualification output set required')
 files={}
 for key,name in [('after',after[0]),('smoke',smoke[0])]:
  p=evidence/name;raw=p.read_bytes();binding={'path':str(p),'sha256':hashlib.sha256(raw).hexdigest()};c.read_spec(binding)
  if not start-1<=p.stat().st_mtime<=time.time()+1:raise ValueError('fresh qualification file time differs')
  files[key]=binding
 current=json.loads((evidence/after[0]).read_text());smoke_value=json.loads((evidence/smoke[0]).read_text())
 if current.get('image')!=image or current.get('policyHash')!=hashlib.sha256(policy_raw).hexdigest() or current.get('transportCoverage')!='TLS_EXPECTED_ORIGINS':raise ValueError('fresh output identity/transport differs')
 if not isinstance(smoke_value.get('journal'),dict) or not smoke_value.get('ledger'):raise ValueError('fresh smoke journal/ledger absent')
 c.read_spec(opening['env']);c.read_spec(opening['qualifier']);c.read_spec(opening['before']);c.read_spec(opening['policy'])
 return {'kind':'direct-installed-held-qualification','started_at':start,'completed_at':time.time(),'observed_running':second,'controller':opening['qualifier'],'policy':opening['policy'],'before':opening['before'],**files,'store_fingerprint':hashlib.sha256(json.dumps({k:current.get(k) for k in ('dolt','bao','postgres','credentials','migrationLedger')},sort_keys=True,separators=(',',':')).encode()).hexdigest()}
