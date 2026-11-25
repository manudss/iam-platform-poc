#!/usr/bin/env python3
"""B-only isolated reader; SIGUSR1 deferred through cleanup. Review-only caller."""
import json,secrets,signal,subprocess

def resource_monitor(name):
 raise ValueError('bound resource monitor required')

def capture_once(container_id,image_id,executed,bindings,measurements=None):
  name='dolt-held-reader-'+secrets.token_hex(8)
  args=['docker','run','--init','-i','--name',name,'--restart','no','--user','0:0','--network','container:'+container_id,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--oom-score-adj','1000','--memory','768m','--memory-swap','768m','--pids-limit','96','--cpus','0.5','--tmpfs','/data/dolt:rw,nosuid,nodev,noexec,size=16777216','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=67108864','--workdir','/data/dolt','--env','HOME=/tmp','--env','GOMAXPROCS=2','--entrypoint','node',image_id,'--input-type=module','-e',executed,'dolt-only']
  monitor=resource_monitor(name).start()
  started=__import__('time').monotonic()
  try:
   value=subprocess.run(args,input='{"running":true}',text=True,capture_output=True,timeout=180,pass_fds=tuple(fd for _,fd in bindings.values()))
   if value.returncode:raise ValueError('held isolated Dolt read refused')
   envelope=json.loads(value.stdout)
   if set(envelope)!={'format','kind','running','dolt'} or envelope['format']!=1 or envelope['kind']!='dolt-only-tables-v3' or envelope['running'] is not True or not envelope['dolt']:raise ValueError('held Dolt envelope differs')
   return envelope
  finally:
   prior={sig:signal.signal(sig,signal.SIG_IGN) for sig in (signal.SIGALRM,signal.SIGTERM,signal.SIGINT,signal.SIGUSR1)}
   try:
    try:
     metric=monitor.finish();metric['duration_seconds']=__import__('time').monotonic()-started
     if measurements is not None:measurements.append(metric)
    finally:
     cleanup=subprocess.run(['docker','rm','-f',name],text=True,capture_output=True,timeout=20)
     check=subprocess.run(['docker','ps','-a','--filter','name=^/'+name+'$','--format','{{.Names}}'],text=True,capture_output=True,timeout=5)
     if cleanup.returncode or check.returncode or check.stdout.strip():raise ValueError('exact reader absence unverified')
   finally:
    for sig,handler in prior.items():signal.signal(sig,handler)
   if cleanup.returncode:raise ValueError('held reader cleanup unverified')
