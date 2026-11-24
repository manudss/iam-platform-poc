"""Real processes: worker, watchdog and child are separate OS processes of held-update-durable.py. Only the QUEUE is a
fake script (no docker, no gates, no root) that sleeps in a recorded phase; rearm-held-update is a fake that records."""
import hashlib,importlib.util,json,os,signal,subprocess,sys,tempfile,time,unittest
from pathlib import Path
PY=os.path.realpath(sys.executable);H=Path(__file__).parent;SELF=H/'held-update-durable.py'
s=importlib.util.spec_from_file_location('du',SELF);du=importlib.util.module_from_spec(s);s.loader.exec_module(du);du.PROTECT=lambda p:None;du.REQUIRE_UNITS=False
FAKE='''import sys,json,time,os
cmd=sys.argv[1];a=sys.argv.index('--state');st=sys.argv[a+1]
def put(v):
 open(st+'.n','w').write(json.dumps(v));os.replace(st+'.n',st)
def ident():
 raw=open('/proc/%d/stat'%os.getpid()).read();f=raw[raw.rfind(')')+2:].split()
 return {'pid':os.getpid(),'starttime':f[19],'boot_id':open('/proc/sys/kernel/random/boot_id').read().strip()}
if cmd=='held-update-reviewed':
 sys.stdin.read();mode=os.environ.get('FAKE_MODE','hang')
 put({'format':3,'history':[],'opening_intent':{'phase':'closed-step-0-running','queue':ident(),'gates':[]}})
 if mode=='hang':time.sleep(600)
 if mode=='ok':put({'format':3,'history':[{'sha':'T','digest':'sha256:'+'a'*64,'mode':'ui-open-automation-held','automation_held':True}],'recovery_fence':'T','resume_required':True,'recoveries':[{'kind':'reviewed-held-update','target':{'sha':'T','digest':'sha256:'+'a'*64}}],'opening_audits':[{'phase':'ui-open-automation-held','target':{'sha':'T'},'proof':{'automation_held':True,'pause_retained':True}}]});sys.exit(0)
 if mode=='fail':put({'format':3,'history':[],'opening_intent':{'phase':'failed-access-rearmed','queue':ident(),'gates':[]}});sys.exit(3)
if cmd=='rearm-held-update':
 s=json.load(open(st));s['opening_intent']['phase']='interrupted-access-rearmed';put(s);open(st+'.rearmed','a').write('x')
'''
class D(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();d=self.d=Path(self.t.name);self.f=d/'f';self.f.mkdir()
  for n,c in [('queue.py',FAKE),('upd.sh','#!/bin/sh\n'),('man.json','{}')]:(d/n).write_text(c)
  self.state=d/'state.json';self.state.write_text(json.dumps({'format':3,'history':[]}));(d/'pause').write_text('p');(d/'lock').write_text('');(d/'state.json.lock').write_text('')
  fs={str(d/'queue.py'):None,str(d/'upd.sh'):None,str(d/'man.json'):None,PY:None,str(SELF):None}
  self.spec={'kind':'reviewed-held-update-supervision','queue':str(d/'queue.py'),'state':str(self.state),'pause':str(d/'pause'),'lock':str(d/'lock'),'repository':'r','container':'c','updater':str(d/'upd.sh'),'manifest':str(d/'man.json'),'python':PY,'engagement_id':'eng-00000001','target_sha':'T','target_digest':'sha256:'+'a'*64,'self':str(SELF),
   'fileSHA256':{p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in fs}}
  (self.f/'supervision-spec.json').write_text(json.dumps(self.spec));self.procs=[]
 def tearDown(self):
  qi=self.f/'queue-identity.json'
  if qi.exists():
   try:os.kill(json.loads(qi.read_text())['pid'],signal.SIGKILL)   # fake queue child is its own session
   except ProcessLookupError:pass
  for p in self.procs:
   if p.poll() is None:p.kill()
   p.wait(timeout=10)
  self.t.cleanup()
 def run_unit(self,mode,env=None):
  # tests run as non-root: bypass only the root-ancestry check through an import-time hook wrapper
  code="import sys,importlib.util;s=importlib.util.spec_from_file_location('du',%r);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.PROTECT=lambda p:None;m.REQUIRE_UNITS=False;sys.exit(m.main(['%s','--folder',%r,'--poll','1']))"%(str(SELF),mode,str(self.f))
  p=subprocess.Popen([sys.executable,'-c',code],env={**os.environ,**(env or {})});self.procs.append(p);return p
 def wait(self,name,t=20):
  e=time.time()+t
  while time.time()<e:
   if (self.f/name).exists():return json.loads((self.f/name).read_text())
   time.sleep(.1)
  self.fail('timeout '+name)
 def test_state_without_intent_before_go_does_not_complete(self):
  w=self.run_unit('watchdog');time.sleep(2.5);self.assertIsNone(w.poll(),'watchdog exits before GO on a null-intent state')
  self.assertFalse((self.f/'watchdog-result.json').exists());self.assertTrue((self.f/'WATCH_READY').exists())
 def test_decision_pure_categories(self):
  sp=self.spec;f=self.f;st={'format':3}
  self.assertEqual(du.decision(f,sp,{}),'pre-go-await')
  (f/'STARTED').write_text('{}');self.assertEqual(du.decision(f,sp,st),'await-intent')
  (f/'STARTED').write_text('{"engagement_id":"eng-00000001"}')
  (f/'worker-result.json').write_text('{"exit":0}');self.assertEqual(du.decision(f,sp,st),'completed-audit-mismatch-report-only')
  good={'format':3,'history':[{'sha':'T','digest':sp['target_digest'],'mode':'ui-open-automation-held','automation_held':True}],'recovery_fence':'T','resume_required':True,'recoveries':[{'kind':'reviewed-held-update','target':{'sha':'T','digest':sp['target_digest']}}],'opening_audits':[{'phase':'ui-open-automation-held','target':{'sha':'T'},'proof':{'automation_held':True,'pause_retained':True}}]}
  self.assertEqual(du.decision(f,sp,good),'completed')
  self.assertEqual(du.decision(f,sp,{**good,'recovery_fence':'X'}),'completed-audit-mismatch-report-only','a coincident fence is not proof')
  (f/'STARTED').write_text('{"engagement_id":"other-eng"}');self.assertEqual(du.decision(f,sp,good),'completed-audit-mismatch-report-only','another engagement')
  (f/'STARTED').write_text('{"engagement_id":"eng-00000001"}')
  (f/'worker-result.json').write_text('{"exit":1}');self.assertEqual(du.decision(f,sp,st),'failed-before-intent-report-only')
  held={'opening_intent':{'phase':'opening','queue':None}};self.assertEqual(du.decision(f,sp,held),'caught-nonzero-without-failed-phase-report-only')
 def test_boot_difference_and_reused_pid_are_unknown_not_absent(self):
  me=du.identity(os.getpid());me={k:me[k] for k in('pid','starttime','boot_id')}
  self.assertEqual(du.state_of(me),'alive');self.assertEqual(du.state_of({**me,'boot_id':'x'}),'unknown')
  self.assertEqual(du.state_of({**me,'starttime':str(int(me['starttime'])+1)}),'unknown');self.assertEqual(du.state_of({'pid':1}),'unknown')
 def test_success_end_to_end(self):
  wd=self.run_unit('watchdog');w=self.run_unit('worker',{'FAKE_MODE':'ok'});self.wait('worker-identity.json');(self.f/'GO').write_text('1')
  self.assertEqual(self.wait('worker-result.json')['exit'],0);r=self.wait('watchdog-result.json');self.assertEqual(r['action'],'completed')
 def test_sigkill_queue_after_intent_gives_one_rearm_never_a_second(self):
  wd=self.run_unit('watchdog');w=self.run_unit('worker',{'FAKE_MODE':'hang'});self.wait('worker-identity.json');(self.f/'GO').write_text('1')
  qi=self.wait('queue-identity.json');e=time.time()+10
  while time.time()<e and 'closed-step-0' not in self.state.read_text():time.sleep(.1)
  e=time.time()+15
  while time.time()<e and 'observe-live-queue' not in (self.f/'watchdog-events.jsonl').read_text():time.sleep(.2)
  os.kill(qi['pid'],signal.SIGKILL);r=self.wait('watchdog-result.json',30)
  self.assertEqual(r['action'],'interrupted-rearm-permitted');self.assertEqual(r['recovery']['outcome'],'measured-closed')
  self.assertEqual(Path(str(self.state)+'.rearmed').read_text(),'x',"exactly one rearm");self.assertTrue((self.f/'rearm-attempt.json').exists())
  ev=[json.loads(l)['action'] for l in (self.f/'watchdog-events.jsonl').read_text().splitlines()];self.assertIn('observe-live-queue',ev)
 def test_caught_failure_is_report_only(self):
  wd=self.run_unit('watchdog');w=self.run_unit('worker',{'FAKE_MODE':'fail'});self.wait('worker-identity.json');(self.f/'GO').write_text('1')
  self.assertEqual(self.wait('watchdog-result.json')['action'],'caught-failure-report-only');self.assertFalse(Path(str(self.state)+'.rearmed').exists())
 def test_spec_requires_exact_interpreter_and_self(self):
  du.PROTECT=lambda p:None;sp=self.spec;link=self.d/'py';link.symlink_to(PY);sp['fileSHA256'][str(link)]=sp['fileSHA256'][PY];sp['python']=str(link)
  (self.f/'supervision-spec.json').write_text(json.dumps(sp))
  with self.assertRaisesRegex(ValueError,'non-symlink'):du.check_spec(self.f)
 def test_units_bound_to_systemd_properties(self):
  fake=self.d/'systemctl';fake.write_text('#!/bin/sh\ncat "$FAKE_SHOW"\n');fake.chmod(0o755);du.SYSTEMCTL=str(fake)
  me=du.identity(os.getpid());inv='i'*32;os.environ['INVOCATION_ID']=inv
  ent=lambda r:{'unit':'lyam-durable-held-eng-00000001-%s.service'%r,'invocationID':inv,'pid':os.getpid(),'starttime':me['starttime'],'boot_id':me['boot_id'],'controlGroup':'/system.slice/x'}
  (self.f/'unit-bindings.json').write_text(json.dumps({'kind':'held-update','engagementID':'eng-00000001','worker':ent('worker'),'watchdog':ent('watchdog')}))
  props={'InvocationID':inv,'MainPID':str(os.getpid()),'ControlGroup':'/system.slice/x','ActiveState':'active','User':'root','UMask':'0077','Restart':'no','KillMode':'control-group','RuntimeMaxUSec':'infinity','TimeoutStartUSec':'infinity','TimeoutStopUSec':'infinity','StandardOutput':'append','StandardError':'append'}
  show=self.d/'show';os.environ['FAKE_SHOW']=str(show)
  def put(p):show.write_text(''.join('%s=%s\n'%kv for kv in p.items()))
  try:
   put(props);du.verify_units(self.f,'worker',self.spec)
   for k,v in [('InvocationID','z'*32),('MainPID','1'),('Restart','on-failure'),('RuntimeMaxUSec','1h'),('UMask','0022'),('StandardOutput','journal'),('KillMode','process')]:
    put({**props,k:v})
    with self.assertRaises(ValueError,msg=k):du.verify_units(self.f,'worker',self.spec)
   put(props);os.environ['INVOCATION_ID']='other'
   with self.assertRaisesRegex(ValueError,'bound unit main process'):du.verify_units(self.f,'worker',self.spec)
  finally:os.environ.pop('INVOCATION_ID',None);du.SYSTEMCTL='/usr/bin/systemctl'
 def test_launcher_commands_are_exact_and_independent(self):
  c=du.launcher_commands('/f','eng-00000001','/usr/bin/python3.12','/x/held-update-durable.py')
  self.assertEqual([x[1] for x in c],['--unit=lyam-durable-held-eng-00000001-watchdog.service','--unit=lyam-durable-held-eng-00000001-worker.service'])
  for x in c:
   s=' '.join(x);self.assertIn('RuntimeMaxSec=infinity',s);self.assertIn('Restart=no',s);self.assertNotIn('BindsTo',s);self.assertNotIn('PartOf',s);self.assertIn('StandardOutput=append:/f/',s)
 def test_poll_validated(self):
  with self.assertRaises(ValueError):du.main(['watchdog','--folder',str(self.f),'--poll','0'])
 def test_spec_binding_refuses_changed_file(self):
  (self.d/'queue.py').write_text(FAKE+'#x');du.PROTECT=lambda p:None
  with self.assertRaisesRegex(ValueError,'binding'):du.check_spec(self.f)
if __name__=='__main__':unittest.main()
