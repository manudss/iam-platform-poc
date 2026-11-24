#!/usr/bin/env python3
"""Independent watchdog for an interrupted held-update. Read-only decision every tick; at most ONE
rearm-held-update call, only when the queue identity is CERTAINLY absent on two consecutive ticks and
the updater lock is free. Never opens, retries, restarts or kills anything. Categories are distinct.
State is read-only here; the durable result is written by the queue's rearm (intent phase)."""
import fcntl,importlib.util,json,os,sys,time
from pathlib import Path
HELD=('held-update-prepared','ops-gate-planned','ops-gate-created','closed-step-','opening')
def load_queue(path):
 spec=importlib.util.spec_from_file_location('oq',path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
def decide(q,state_path,absent_ticks):
 """-> (category, absent_ticks). Pure apart from reading state and /proc."""
 try:st=json.loads(Path(state_path).read_text())
 except Exception:return 'identity-unknown',0
 i=st.get('opening_intent')
 if not i:return 'completed' if not st.get('opening_intent') else 'identity-unknown',0
 ph=str(i.get('phase',''))
 if ph.startswith('failed-access-'):return 'caught-failure-report-only',0   # queue already handled/closed or marked unknown: report, never auto-rearm
 if ph.startswith('interrupted-access-rearmed'):return 'recovery-done',0
 if not ph.startswith(HELD):return 'identity-unknown',0
 s=q.queue_state(i.get('queue'))
 if s=='alive':return 'observe-live-queue',0
 if s=='unknown':return 'identity-unknown',0
 return 'interrupted-absent',absent_ticks+1
def lock_free(lock_path):
 f=open(lock_path,'a')
 try:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);return f
 except OSError:f.close();return None
def tick(q,state_path,lock_path,absent_ticks,rearm=None):
 cat,n=decide(q,state_path,absent_ticks)
 if cat!='interrupted-absent' or n<2:return cat,n,None
 f=lock_free(lock_path)   # a live child inheriting the lock blocks: observed, never killed
 if f is None:return 'orphan-child-live',n,None
 try:
  cat2,_=decide(q,state_path,n)   # re-validate under the lock
  if cat2!='interrupted-absent':return cat2,0,None
  try:(rearm or q.rearm_held_update)(state_path);return 'recovery-running-done',n,'rearmed'
  except BaseException as e:return 'recovery-failed',n,type(e).__name__
 finally:f.close()
def main(argv):
 import argparse
 a=argparse.ArgumentParser();a.add_argument('--queue-module',required=True);a.add_argument('--state',required=True);a.add_argument('--lock',required=True);a.add_argument('--interval',type=int,default=5);a.add_argument('--out',required=True)
 o=a.parse_args(argv);q=load_queue(o.queue_module);n=0
 while True:
  cat,n,res=tick(q,o.state,o.lock,n)
  line=json.dumps({'t':time.time(),'category':cat,'absent_ticks':n,'result':res})
  with open(o.out,'a') as f:f.write(line+'\n');f.flush();os.fsync(f.fileno())
  if res is not None or cat in('recovery-failed','completed','recovery-done','caught-failure-report-only'):return 1 if cat=='recovery-failed' else 0
  time.sleep(o.interval)
if __name__=='__main__':sys.exit(main(sys.argv[1:]))
