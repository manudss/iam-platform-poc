#!/usr/bin/env python3
"""Manual-only caller. Exit 10 from updater means qualified but still closed, not delivered."""
import argparse,importlib.util,hashlib,json,os,subprocess,sys,urllib.request,urllib.error
from pathlib import Path

def main():
 p=argparse.ArgumentParser();p.add_argument('--updater',required=True);p.add_argument('--image',required=True);p.add_argument('--env-file',required=True);p.add_argument('--receipt',required=True);a=p.parse_args()
 def root_owned(path):
  p=Path(path).absolute()
  if p.is_symlink() or not p.is_file():raise ValueError('controller must be regular')
  for q in [p]+list(p.parents):
   st=q.stat()
   if st.st_uid!=0 or st.st_gid!=0 or st.st_mode&0o022:raise ValueError('protected root controller required')
  return p
 updater=root_owned(a.updater)
 root_owned(__file__)
 integrity=root_owned(updater.parent/'closed-recovery-integrity.py')
 proof=dict(line.split('=',1) for line in subprocess.check_output(['python3',str(integrity),a.env_file],text=True).splitlines())
 receipt=Path(a.receipt)
 for directory in [receipt.absolute().parent]+list(receipt.absolute().parent.parents):
  st=directory.stat()
  if st.st_uid!=0 or st.st_gid!=0 or st.st_mode&0o022:raise ValueError('receipt requires protected root directory')
 if receipt.exists():raise ValueError('receipt must be fresh')
 r=subprocess.run(['sh',a.updater,'--image',a.image,'--env-file',a.env_file,'--closed-recovery','--closed-receipt',a.receipt],check=False)
 if r.returncode!=10:raise ValueError('updater did not return CLOSED_QUALIFIED, no implicit retry/rollback')
 try:
  expected={'state':'CLOSED_QUALIFIED','image':a.image,'held':'true','public_status':'503'}
  fields=dict(line.split('=',1) for line in receipt.read_text().splitlines())
  if any(fields.get(k)!=v for k,v in proof.items()):raise ValueError('reviewed helper proof mismatch')
  if any(fields.get(k)!=v for k,v in expected.items()):raise ValueError('closed receipt mismatch')
  env=dict(line.split('=',1) for line in Path(a.env_file).read_text().splitlines() if '=' in line and not line.startswith('#'))
  for field,key in [('implementation_sha256','LYAM_CLOSED_IMPLEMENTATION'),('launcher_sha256','LYAM_CLOSED_LAUNCHER'),('preflight_sha256','LYAM_CLOSED_PREFLIGHT')]:
   if hashlib.sha256(Path(env[key]).read_bytes()).hexdigest()!=fields.get(field):raise ValueError('helper changed from receipt')
  ops=Path(env.get('LYAM_OPS_BARRIER_FILE',str(Path(env.get('LYAM_FRONT_BARRIER_FILE','/var/lib/lyam-front-gate/MAINTENANCE')).parent/'OPS-MAINTENANCE')))
  if hashlib.sha256(ops.read_bytes()).hexdigest()!=fields.get('ops_sha256'):raise ValueError('operator barrier changed from receipt')
  pause=Path(env.get('LYAM_PAUSE_FILE','/opt/lyam/UPDATE_PAUSED'))
  if not pause.is_file():raise ValueError('update pause disappeared')
  gate=Path(env.get('LYAM_FRONT_BARRIER_FILE','/var/lib/lyam-front-gate/MAINTENANCE'))
  if hashlib.sha256(gate.read_bytes()).hexdigest()!=fields.get('gate_sha256'):raise ValueError('owned maintenance changed from receipt')
  launch=Path(fields['launch_proof'])
  if hashlib.sha256(launch.read_bytes()).hexdigest()!=fields['launch_proof_sha256']:raise ValueError('launch proof changed')
  launch_state=json.loads(launch.read_text())
  if str(launch_state['ipv6DisabledProved']).lower()!=fields.get('ipv6_disabled_proved') or hashlib.sha256(json.dumps(launch_state['ipv6State'],sort_keys=True).encode()).hexdigest()!=fields.get('ipv6_state_sha256'):raise ValueError('IPv6 receipt mismatch')
  live=subprocess.run([env['LYAM_CLOSED_IMPLEMENTATION'],'--mode','postcheck','--proof-file',str(launch),'--image',a.image,'--container',env.get('LYAM_CONTAINER','lyam'),'--env-file',a.env_file,'--data-dir',env.get('LYAM_DATA_DIR','/opt/lyam/data'),'--port',env.get('LYAM_PORT','8080')],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=180)
  if json.loads(live.stdout)['liveVerified'] is not True:raise ValueError('live proof missing')
  if env.get('IAM_AUTOMATION_HOLD')!='1':raise ValueError('persistent host hold absent')
  origin=env['IAM_PUBLIC_ORIGIN'].rstrip('/')
  try:status=urllib.request.urlopen(origin+'/healthz',timeout=15).status
  except urllib.error.HTTPError as e:status=e.code
  if status!=503:raise ValueError('public maintenance not verified')
  code="const fs=require('node:fs');const m=/automation hold: (\\{[^\\n]+\\})/.exec(fs.readFileSync('/data/api.log','utf8'));if(process.env.IAM_AUTOMATION_HOLD!=='1'||!m||JSON.parse(m[1]).held!==true)process.exit(1);fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));"
  subprocess.run(['docker','exec',env.get('LYAM_CONTAINER','lyam'),'node','-e',code],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=30)
 except Exception:
  settings=dict(line.split('=',1) for line in Path(a.env_file).read_text().splitlines() if '=' in line and not line.startswith('#'))
  subprocess.run(['docker','stop',settings.get('LYAM_CONTAINER','lyam')],check=False,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
  raise
 print('CLOSED_QUALIFIED: receipt, public 503 and API hold verified; NOT open, no queue cursor changed')
 return 10
if __name__=='__main__':
 try:sys.exit(main())
 except Exception:print('Closed recovery caller failed. Keep maintenance and pause; inspect private evidence, no automatic compensation.',file=sys.stderr);sys.exit(4)
