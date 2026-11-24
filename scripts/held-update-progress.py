#!/usr/bin/env python3
"""Bounded fixture progress. No process ids, paths, argv or subprocess output in the record."""
import json,os,time
from pathlib import Path
SCENARIOS={'one-clean','three-clean','three-kill-closed-step-0-running','three-kill-closed-step-1-qualified','three-kill-opening','one-orphan-updater'}
STAGES={'scenario-start','orphan-refusal-measured','before-continue','after-continue','before-worker-wait','after-worker-wait','before-child-wait','after-child-wait','scenario-complete','all-scenarios-complete'}
STATES={'alive','absent','unknown','not-measured'}
class Progress:
 def __init__(self,out,clock=time.monotonic):self.out=Path(out);self.clock=clock;self.started=clock();self.sequence=0;self.scenario_started=self.started;self.failures=0
 def safe(self,scenario,stage,child=lambda:'not-measured',worker=lambda:'not-measured'):
  try:return self.write(scenario,stage,child(),worker())
  except Exception:
   self.failures+=1
   return None
 def write(self,scenario,stage,child='not-measured',worker='not-measured'):
  if scenario not in SCENARIOS or stage not in STAGES or child not in STATES or worker not in STATES:raise ValueError('bounded progress enum required')
  now=self.clock()
  if now<self.started:raise ValueError('progress clock reversed')
  if stage=='scenario-start':self.scenario_started=now
  self.sequence+=1
  value={'scenario':scenario,'stage':stage,'sequence':self.sequence,'elapsedSeconds':round(now-self.started,3),'scenarioElapsedSeconds':round(now-self.scenario_started,3),'childState':child,'workerState':worker,'diagnosticFailures':self.failures}
  path=self.out/'held-progress.json';tmp=self.out/'held-progress.tmp'
  try:
   fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
   with os.fdopen(fd,'w') as f:json.dump(value,f,sort_keys=True);f.flush();os.fsync(f.fileno())
   os.replace(tmp,path);fd=os.open(self.out,os.O_RDONLY|os.O_DIRECTORY)
   try:os.fsync(fd)
   finally:os.close(fd)
  finally:
   try:tmp.unlink(missing_ok=True)
   except OSError:pass
  return value
