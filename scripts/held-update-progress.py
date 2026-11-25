#!/usr/bin/env python3
"""Bounded fixture progress. No process ids, paths, argv or subprocess output in the record."""
import json,os,stat,time
from pathlib import Path
SCENARIOS={'one-clean','three-clean','three-kill-closed-step-0-running','three-kill-closed-step-1-qualified','three-kill-opening','one-orphan-updater','fixture-setup'}
STAGES={'inventory-start','inventory-complete','checkpoint-start','checkpoint-complete','prequal-1-start','prequal-1-complete','prequal-2-start','prequal-2-complete','prequal-3-start','prequal-3-complete','baseline-ready','supervision-ready','go-sent','closed-step-0-running','closed-step-0-qualified','closed-step-1-running','closed-step-1-qualified','closed-step-2-running','closed-step-2-qualified','opening','watchdog-result','scenario-start','orphan-refusal-measured','before-continue','after-continue','before-worker-wait','after-worker-wait','before-child-wait','after-child-wait','scenario-complete','all-scenarios-complete'}
STATES={'alive','absent','unknown','not-measured'}
class Progress:
 def __init__(self,out,clock=time.monotonic):self.out=Path(out);self.clock=clock;self.started=clock();self.sequence=0;self.scenario_started=self.started;self.failures=0;self.timeline=[]
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
  self.timeline.append(dict(value))
  value['timeline']=self.timeline[-128:]
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

def unique_fields(pairs):
 value={}
 for key,item in pairs:
  if key in value:raise ValueError('duplicate diagnostic field')
  value[key]=item
 return value

def validate_record(value,with_timeline=False):
 fields={'scenario','stage','sequence','elapsedSeconds','scenarioElapsedSeconds','childState','workerState','diagnosticFailures'}
 if with_timeline:fields.add('timeline')
 if not isinstance(value,dict) or set(value)!=fields:raise ValueError('invalid diagnostic fields')
 if value['scenario'] not in SCENARIOS or value['stage'] not in STAGES or any(value[k] not in STATES for k in ('childState','workerState')):raise ValueError('invalid diagnostic enum')
 for k in ('sequence','elapsedSeconds','scenarioElapsedSeconds','diagnosticFailures'):
  if type(value[k]) not in (int,float) or not 0<=value[k]<1e12:raise ValueError('invalid diagnostic number')
 if with_timeline:
  timeline=value['timeline']
  if not isinstance(timeline,list) or not 1<=len(timeline)<=128:raise ValueError('invalid diagnostic timeline')
  for row in timeline:validate_record(row)
  if timeline[-1]!={k:v for k,v in value.items() if k!='timeline'}:raise ValueError('diagnostic timeline mismatch')

def publish_diagnostic(out):
 """Only the bounded progress file becomes runner-readable after the fixture ends."""
 path=Path(out)/'held-progress.json'
 try:fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 except FileNotFoundError:return False
 try:
  info=os.fstat(fd)
  if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>65536:raise ValueError('invalid diagnostic file')
  with os.fdopen(os.dup(fd)) as f:value=json.load(f,object_pairs_hook=unique_fields)
  validate_record(value,with_timeline=True)
  os.fchmod(fd,0o644)
 finally:os.close(fd)
 return True

if __name__=='__main__':
 import argparse
 parser=argparse.ArgumentParser();parser.add_argument('--publish-diagnostic',required=True)
 publish_diagnostic(parser.parse_args().publish_diagnostic)
