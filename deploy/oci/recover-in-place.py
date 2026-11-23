#!/usr/bin/env python3
"""Explicit reviewed recovery only. Does not install, restart, deploy or resume queue."""
import os,sys,json,re,fcntl,subprocess,hashlib,importlib.util,urllib.request,urllib.error,signal
from pathlib import Path
spec=importlib.util.spec_from_file_location('queue',Path(__file__).with_name('ordered-queue.py'));queue=importlib.util.module_from_spec(spec);spec.loader.exec_module(queue)
def dead(pid):
 try:os.kill(pid,0)
 except ProcessLookupError:return True
 except PermissionError:return False
 return False
def probe(origin):
 try:
  response=urllib.request.urlopen(origin+'/healthz',timeout=15);return response.status
 except urllib.error.HTTPError as e:return e.code
 except Exception:return 0
def checked_file(spec):
 p=Path(spec['path'])
 if not p.is_absolute() or not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=spec['sha256']:raise ValueError('pinned file mismatch')
 return p
def recover(m,run=subprocess.run,is_dead=dead,front=probe,observe=queue.observe_running,record=queue.record_reviewed_in_place,verify=queue.verify_source_chain):
 # Called only under both exclusive locks by main. Tests use fictional isolated files.
 if m.get('format')!=1 or m.get('kind')!='reviewed-in-place-opening':raise ValueError('reviewed opening manifest required')
 queue.reference(m.get('authorization_ref'));queue.references(m.get('evidence_refs'))
 state_path=Path(m['state']);state=queue.load(state_path);review=m['queue_manifest'];queue.checked_manifest(state,review,'reviewed-in-place')
 if not Path(m['pause_file']).is_file():raise ValueError('deployment pause required')
 before=checked_file(m['original_before']);qualification=checked_file(m['qualification_script']);checked_file(m['qualification_helper'])
 if qualification.parent!=Path(m['qualification_helper']['path']).parent or qualification.name!='qualification.py' or Path(m['qualification_helper']['path']).name!='qualification-container.mjs':raise ValueError('pinned qualification pair required')
 token=m['barrier_token'];match=re.fullmatch(r'lyam-update:([1-9][0-9]*):[0-9]{8}T[0-9]{6}Z',token)
 if not match or int(match[1])!=m['former_pid'] or not is_dead(m['former_pid']):raise ValueError('former owner not proven dead')
 barrier=Path(m['barrier_file'])
 if barrier.is_symlink() or barrier.read_text().rstrip('\n')!=token:raise ValueError('foreign barrier')
 target=review['target']
 pending=state.get('pending');failed=state.get('failed')
 if not pending or not failed or state.get('resume_required') or review.get('original_unresolved')!={'pending':pending,'failed':failed}:raise ValueError('exact unresolved original incident required')
 if failed.get('sha')!=pending.get('sha') or failed.get('digest',pending.get('digest'))!=pending.get('digest') or pending.get('parent')!=state['history'][-1]['sha']:raise ValueError('inconsistent failed incident')
 if any(target.get(k)!=pending.get(k) for k in ['sha','digest']):raise ValueError('exact failed pending target required')
 chain=review.get('chain')
 if not isinstance(chain,list) or len(chain)!=1 or any(chain[0].get(k)!=v for k,v in {'sha':pending['sha'],'parent':pending['parent'],'outcome':'delivered'}.items()):raise ValueError('singleton delivered chain required')
 verify(m['repository'],state['history'][-1]['sha'],chain)
 observe(m['container'],target)
 origins=m['origins']
 if not isinstance(origins,list) or not origins or any(not re.fullmatch(r'https://[a-zA-Z0-9.-]+(?::[0-9]+)?',o) for o in origins):raise ValueError('explicit TLS origins required')
 if any(front(o)!=503 for o in origins):raise ValueError('maintenance not proven')
 # Explicit qualification arguments only, never source the updater. Smoke signs in and can append sessions/audit.
 args=m['qualification_args'];required=['container','env-file','data-dir','backup-dir','target-image','evidence-dir','policy','receipt-file']
 if Path(args.get('receipt-file','')).exists():raise ValueError('fresh success receipt path required')
 if set(args)!=set(required) or args['container']!=m['container'] or Path(args['evidence-dir'])/'before.json'!=before:raise ValueError('qualification must retain original before path')
 image='ghcr.io/manudss/iam-platform-poc@'+target['digest']
 command=[str(qualification),'--phase','after','--image',image,'--barrier-file',str(barrier)]
 for key in required:command+=['--'+key,str(args[key])]
 result=run(command,check=False)
 if result.returncode!=0:raise ValueError('qualification failed; maintenance retained')
 checked_file(m['original_before']);observe(m['container'],target)
 # Load only the exact predeclared fresh receipt written after successful comparison.
 receipt_path=Path(args['receipt-file']);receipt=json.loads(receipt_path.read_text());proof={'receipt':{'path':str(receipt_path),'sha256':hashlib.sha256(receipt_path.read_bytes()).hexdigest()}}
 for key in ['before','after','smoke']:proof[key]={'path':receipt[key+'_path'],'sha256':receipt[key+'_sha256']}
 if args['target-image']!=image:raise ValueError('qualification target mismatch')
 if proof['before']!=m['original_before']:raise ValueError('receipt replaced original before')
 review={**review,'qualification_receipt':proof}
 queue.verify_qualification_receipt(proof,target)
 if barrier.is_symlink() or barrier.read_text().rstrip('\n')!=token or not is_dead(m['former_pid']):raise ValueError('barrier ownership changed')
 removed=False
 try:
  barrier.unlink();removed=True
  if any(front(o)!=200 for o in origins):raise ValueError('TLS opening probe failed')
  record(state_path,review,m['repository'],m['container'])
 except BaseException:
  if removed:
   try:
    fd=os.open(barrier,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)
    with os.fdopen(fd,'w') as f:f.write(token+'\n');f.flush();os.fsync(f.fileno())
   except FileExistsError:pass # never overwrite a different owner's barrier
   if any(front(o)!=503 for o in origins):raise RuntimeError('maintenance rearm could not be proven; immediate operator attention required')
  raise
 return {'opened':True,'queue_resume_required':True,'pause_retained':True}
def main():
 def interrupted(*args):raise KeyboardInterrupt('recovery interrupted')
 signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
 m=json.load(sys.stdin)
 # Existing locks only. Lock order matches queue CLI: queue then updater.
 for p in [m['state']+'.lock',m['update_lock']]:
  if not Path(p).is_file():raise ValueError('existing queue and updater locks required')
 with open(m['state']+'.lock','a') as q,open(m['update_lock'],'a') as u:
  fcntl.flock(q,fcntl.LOCK_EX|fcntl.LOCK_NB);fcntl.flock(u,fcntl.LOCK_EX|fcntl.LOCK_NB)
  print(json.dumps(recover(m)))
if __name__=='__main__':
 try:main()
 except Exception:print('Reviewed recovery failed or UNKNOWN. Inspect private evidence; do not resume queue.',file=sys.stderr);sys.exit(1)
