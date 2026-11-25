#!/usr/bin/env python3
"""Real signal + Docker removal on disposable GitHub runner only. No production."""
import hashlib,importlib.util,json,os,signal,subprocess,tempfile,time
from pathlib import Path
IMAGE='ghcr.io/manudss/iam-platform-poc@sha256:81aeb18f91f8413d44508866ef7e06becbe4816aa2478869fbff0d33bdef0904'
def main():
 if os.geteuid()!=0 or os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_ENVIRONMENT')!='github-hosted' or Path('/opt/lyam').exists() or Path('/opt/lyam-recovery').exists():raise ValueError('disposable hosted runner required')
 path=Path(__file__).resolve().parents[1]/'deploy/oci/dolt-current-client.py';s=importlib.util.spec_from_file_location('client',path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
 original=m.subprocess.run;records=[];caught=[]
 previous=signal.signal(signal.SIGUSR1,lambda s,f:caught.append(s))
 try:
  for phase in ['monitor-finish','docker-remove']:
   names=[];injected=[]
   def run(args,**kw):
    if args[:2]==['docker','run']:names.append(args[args.index('--name')+1])
    if args[:3]==['docker','rm','-f'] and phase=='docker-remove':os.kill(os.getpid(),signal.SIGUSR1);injected.append(phase)
    return original(args,**kw)
   class Monitor:
    def start(self):return self
    def finish(self):
     if phase=='monitor-finish':os.kill(os.getpid(),signal.SIGUSR1);injected.append(phase)
     return {'samples':1,'fixture_monitor_only':True}
   m.resource_monitor=lambda name:Monitor();m.subprocess.run=run
   envelope={'format':1,'kind':'dolt-only-tables-v3','running':True,'dolt':[{'synthetic':True}]}
   # The REAL bounded reader starts a harmless Node emitter in its own none netns.
   # No database server is needed to exercise cleanup and real process signals.
   source='process.stdout.write('+json.dumps(json.dumps(envelope))+')'
   # capture_once normally joins held netns. Here use an explicitly disposable
   # holder, never an arbitrary user service.
   holder='current-holder-'+os.urandom(8).hex()
   p=original(['docker','run','-d','--name',holder,'--network','none','--memory','128m','--pids-limit','32','--entrypoint','node',IMAGE,'-e','setTimeout(()=>{},120000)'],capture_output=True,text=True,timeout=30)
   if p.returncode:raise ValueError('holder refused')
   try:
    m.capture_once(holder,IMAGE,source,{},[])
    check=original(['docker','ps','-a','--filter','name=^/'+names[0]+'$','--format','{{.Names}}'],text=True,capture_output=True,timeout=10)
    if check.returncode or check.stdout.strip() or injected!=[phase] or caught:raise ValueError('cleanup proof refused')
    records.append({'phase':phase,'real_signal_sent':True,'reader_absent':True,'reader_name':names[0]})
   finally:
    r=original(['docker','rm','-f',holder],capture_output=True,text=True,timeout=20)
    if r.returncode:raise ValueError('holder cleanup refused')
 finally:m.subprocess.run=original;signal.signal(signal.SIGUSR1,previous)
 Path('/tmp/dolt-current-cleanup-proof.json').write_text(json.dumps({'kind':'disposable-real-docker-cleanup-signals','production_data_used':False,'client_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'records':records}))
if __name__=='__main__':main()
