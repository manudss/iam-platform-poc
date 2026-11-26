#!/usr/bin/env python3
"""DEV transaction control proof only, shell writers on empty fictional sources.
No production/normal app adapter. Exactly one permit per role, no retries.
"""
import hashlib,json,os
from pathlib import Path
FIFO='/tmp/dev-source-rw.fifo'
GUARD='set -eu; mkfifo -m 600 '+FIFO+'; read -r p < '+FIFO+'; [ "$p" = commit ]; printf committed > /data/committed; exec sleep 3600'
class Adapter:
 def __init__(self,plan,docker,lockcheck):
  if os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_ENVIRONMENT')!='github-hosted' or Path('/opt/lyam-recovery').exists():raise ValueError('DEV only')
  self.plan=plan;self.original=json.loads(json.dumps(plan));self.docker=docker;self.lockcheck=lockcheck;self.issued=set();self.closed_on_failure=False
 def locks(self):self.lockcheck()
 def closed(self):
  if self.plan!=self.original:raise ValueError('plan changed')
 def bindings(self,p):
  for name in ('baseline','env','policy','runtime'):
   b=p[name]
   if hashlib.sha256(Path(b['path']).read_bytes()).hexdigest()!=b['sha256']:raise ValueError('bound DEV file differs')
 def inspect_prepared(self,p):
  for generation in ('old','new'):
   for role,e in p[generation].items():
    x=json.loads(self.docker('inspect',e['id']))[0]
    if x['Id']!=e['id'] or x['Image']!=e['image_id'] or x['Name'].lstrip('/')!=e['name'] or x['HostConfig']['RestartPolicy']['Name']!='no':raise ValueError('prepared identity differs')
    if generation=='old' and x['State']['Running']:raise ValueError('old writer running')
    if generation=='new':
     if not x['State']['Running'] or x['Config']['Cmd']!=['-c',GUARD]:raise ValueError('exact DEV FIFO writer required')
     if self.docker('exec',e['id'],'sh','-c','test -p '+FIFO+' && printf waiting')!='waiting':raise ValueError('FIFO not waiting')
 def single_writer(self,p):
  allowed={e['id'] for e in p['new'].values()}
  sources=set(p['stores'].values())
  for cid in self.docker('ps','-q','--no-trunc').splitlines():
   x=json.loads(self.docker('inspect',cid))[0]
   if any(m.get('RW') and m.get('Source') in sources for m in x.get('Mounts',[])) and cid not in allowed:raise ValueError('foreign writer')
 def check_permit(self,p,role):
  self.locks();self.bindings(p)
  if role in self.issued:raise ValueError('duplicate permit')
  e=p['new'][role];x=json.loads(self.docker('inspect',e['id']))[0]
  store='dolt' if role=='app' else role
  if not any(m['Source']==p['stores'][store] and m['Destination']=='/data' and m['RW'] for m in x['Mounts']):raise ValueError('exact source mount differs')
 def permit(self,p,role):
  self.issued.add(role)
  self.docker('exec',p['new'][role]['id'],'sh','-c','printf "%s\n" commit > '+FIFO)
 def companions_ready(self,p):
  for role in ('pg','bao'):
   if self.docker('exec',p['new'][role]['id'],'cat','/data/committed')!='committed':raise ValueError('DEV companion marker absent')
 def close_on_failure(self):self.closed_on_failure=True
