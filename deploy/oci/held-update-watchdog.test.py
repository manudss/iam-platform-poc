import importlib.util,json,os,subprocess,sys,tempfile,unittest,fcntl
from pathlib import Path
H=Path(__file__).parent
def ld(n,f):
 s=importlib.util.spec_from_file_location(n,H/f);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
q=ld('q','ordered-queue.py');w=ld('w','held-update-watchdog.py')
class W(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();self.d=Path(self.t.name);self.st=self.d/'s.json';self.lock=self.d/'l';self.lock.write_text('')
 def put(self,phase,queue):self.st.write_text(json.dumps({'format':3,'history':[],'opening_intent':{'phase':phase,'queue':queue,'gates':[],'container':'c','manifest':{}}}))
 def dead(self):
  p=subprocess.Popen(['true']);i=q.queue_identity(p.pid);p.wait();return i
 def test_live_and_unknown_never_rearm(self):
  me=q.queue_identity();calls=[]
  self.put('opening',me);self.assertEqual(w.tick(q,self.st,self.lock,5,rearm=calls.append)[0],'observe-live-queue')
  self.put('opening',{**me,'starttime':str(int(me['starttime'])+1)});self.assertEqual(w.tick(q,self.st,self.lock,5,rearm=calls.append)[0],'identity-unknown')
  self.put('opening',None);self.assertEqual(w.tick(q,self.st,self.lock,5,rearm=calls.append)[0],'identity-unknown');self.assertEqual(calls,[])
 def test_two_ticks_required_then_single_rearm(self):
  self.put('closed-step-0-running',self.dead());calls=[]
  c,n,r=w.tick(q,self.st,self.lock,0,rearm=calls.append);self.assertEqual((c,n,r,calls),('interrupted-absent',1,None,[]))
  c,n,r=w.tick(q,self.st,self.lock,n,rearm=calls.append);self.assertEqual((r,len(calls)),('rearmed',1))
 def test_lock_held_by_live_child_blocks_and_is_not_killed(self):
  self.put('opening',self.dead());calls=[];f=open(self.lock,'a');fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
  self.assertEqual(w.tick(q,self.st,self.lock,1,rearm=calls.append)[0],'orphan-child-live');self.assertEqual(calls,[]);f.close()
 def test_caught_failure_and_completed_not_rearmed(self):
  calls=[];self.put('failed-access-rearmed',self.dead());self.assertEqual(w.tick(q,self.st,self.lock,5,rearm=calls.append)[0],'caught-failure-report-only')
  self.st.write_text(json.dumps({'format':3,'history':[]}));self.assertEqual(w.tick(q,self.st,self.lock,5,rearm=calls.append)[0],'completed');self.assertEqual(calls,[])
 def test_rearm_failure_is_reported_once(self):
  self.put('opening',self.dead())
  def boom(p):raise OSError('x')
  self.assertEqual(w.tick(q,self.st,self.lock,1,rearm=boom)[:3:2],('recovery-failed','OSError'))
if __name__=='__main__':unittest.main()
