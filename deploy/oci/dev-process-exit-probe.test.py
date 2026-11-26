import importlib.util,os,signal,unittest
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('probe',Path(__file__).with_name('dev-process-exit-probe.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def setup_probe(self):
  roles={'edge':[1],'supervisor':[2,3,4],'api':[5],'core':[6],'ssr':[7],'nats':[8],'dolt':[9]}
  records={p:{'pid':p,'start':p+100,'state':'S','cmd_sha256':str(p),'exe':'/exact','pidns':10,'role':role,'ppid':0} for role,pids in roles.items() for p in pids}
  states={p:'S' for p in records};codes={p:0 if p in (8,9) else 15 for p in records};trace=[];events=[]
  def send(fd,sig):trace.append((fd,sig));states[fd]='T' if sig==signal.SIGSTOP else 'Z'
  def stat(pid):return {**records[pid],'state':states[pid],'exit_raw':codes[pid]}
  def scan(pid):return {p:{**v,'state':states[p]} for p,v in records.items()},roles
  return records,states,codes,trace,events,send,stat,scan
 def run_case(self,alter=None):
  case=self.setup_probe();records,states,codes,trace,events,send,stat,scan=case
  poll=type('Poll',(),{'register':lambda *a:None,'poll':lambda *a:[(1,1)]})()
  options={'scan':scan,'stat':stat,'network_boundary':lambda *a:{}}
  if alter:alter(case,options,poll)
  with patch.dict(os.environ,{'GITHUB_ACTIONS':'true','RUNNER_ENVIRONMENT':'github-hosted'}),patch.object(m.os,'geteuid',return_value=0),patch.object(m.Path,'exists',return_value=False),patch.object(m.os,'pidfd_open',side_effect=lambda p,f:p),patch.object(m.os,'close'),patch.object(m.signal,'pidfd_send_signal',side_effect=send),patch.object(m.select,'poll',return_value=poll),patch.object(m,'scan',side_effect=options['scan']),patch.object(m,'stat',side_effect=options['stat']),patch.object(m,'network_boundary',side_effect=options['network_boundary']):
   return m.experiment(1,options.get('checkpoint',events.append),timeout=.01),case
 def test_observation_order_and_no_kill(self):
  proof,case=self.run_case();self.assertFalse(proof['writers_quiesced']);self.assertFalse(proof['capture_qualified']);self.assertNotIn(signal.SIGKILL,[s for p,s in case[3]])
  self.assertEqual([e['role'] for e in proof['events']],['api','core','ssr','nats','dolt'])
 def test_unknown_process_refuses_before_any_signal(self):
  saved=[]
  def alter(case,o,p):saved.append(case);o['scan']=lambda *a:(_ for _ in ()).throw(ValueError('unknown process'))
  with self.assertRaises(ValueError):self.run_case(alter)
  self.assertEqual(saved[0][3],[])
 def test_durable_intent_failure_refuses_before_any_signal(self):
  saved=[]
  def alter(case,o,p):saved.append(case);o['checkpoint']=lambda e:(_ for _ in ()).throw(OSError('fsync'))
  with self.assertRaises(OSError):self.run_case(alter)
  self.assertEqual(saved[0][3],[])
 def test_pidfd_exit_deadline_never_kills(self):
  saved=[]
  def alter(case,o,p):saved.append(case);p.poll=lambda *a:[]
  with self.assertRaisesRegex(ValueError,'deadline'):self.run_case(alter)
  self.assertNotIn(signal.SIGKILL,[s for p,s in saved[0][3]])
 def test_store_nonzero_exit_refuses_before_dolt(self):
  saved=[]
  def alter(case,o,p):saved.append(case);case[2][8]=256
  with self.assertRaisesRegex(ValueError,'not zero'):self.run_case(alter)
  self.assertNotIn((9,signal.SIGTERM),saved[0][3])
 def test_missing_zombie_never_assumed_success(self):
  saved=[]
  def alter(case,o,p):
   saved.append(case);original=o['stat']
   def gone(pid):
    if case[1][pid]=='Z':raise FileNotFoundError('reaped')
    return original(pid)
   o['stat']=gone
  with self.assertRaises(FileNotFoundError):self.run_case(alter)
  self.assertNotIn(signal.SIGKILL,[s for p,s in saved[0][3]])
 def test_remaining_connection_stops_before_nats(self):
  saved=[]
  def alter(case,o,p):saved.append(case);o['network_boundary']=lambda *a:(_ for _ in ()).throw(ValueError('network boundary'))
  with self.assertRaisesRegex(ValueError,'boundary'):self.run_case(alter)
  self.assertNotIn((8,signal.SIGINT),saved[0][3])
 def test_supervisor_never_freezes_no_children_signalled(self):
  saved=[]
  def alter(case,o,p):
   saved.append(case);original=o['stat']
   def unfrozen(pid):
    v=original(pid)
    if pid==2:v['state']='S'
    return v
   o['stat']=unfrozen
  with self.assertRaisesRegex(ValueError,'deadline'):self.run_case(alter)
  self.assertFalse(any(sig!=signal.SIGSTOP for pid,sig in saved[0][3]))
 def test_pid_reuse_refuses_before_signal(self):
  saved=[]
  def alter(case,o,p):
   saved.append(case);original=o['stat']
   o['stat']=lambda pid:{**original(pid),'start':999}
  with self.assertRaisesRegex(ValueError,'identity'):self.run_case(alter)
  self.assertEqual(saved[0][3],[])
 def test_fork_during_freeze_refused_before_child_signal(self):
  saved=[]
  def alter(case,o,p):
   saved.append(case);original=o['scan'];n=[0]
   def scan(pid):
    n[0]+=1;r,roles=original(pid)
    if n[0]>1:r[99]={**r[1],'pid':99}
    return r,roles
   o['scan']=scan
  with self.assertRaisesRegex(ValueError,'set changed'):self.run_case(alter)
  self.assertFalse(any(sig!=signal.SIGSTOP for pid,sig in saved[0][3]))
 def test_proc_permission_failure_refuses_before_signal(self):
  saved=[]
  def alter(case,o,p):
   saved.append(case);o['stat']=lambda pid:(_ for _ in ()).throw(PermissionError('proc'))
  with self.assertRaises(PermissionError):self.run_case(alter)
  self.assertEqual(saved[0][3],[])
if __name__=='__main__':unittest.main()
