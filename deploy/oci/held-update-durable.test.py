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
 if mode=='ok':put({'format':3,'history':[{'sha':'T','digest':'sha256:'+'a'*64,'mode':'ui-open-automation-held','automation_held':True}],'recovery_fence':'T','resume_required':True,'recoveries':[{'kind':'reviewed-held-update','manifest':{'engagement_id':'eng-00000001'},'target':{'sha':'T','digest':'sha256:'+'a'*64}}],'opening_audits':[{'phase':'ui-open-automation-held','manifest':{'engagement_id':'eng-00000001'},'target':{'sha':'T'},'proof':{'automation_held':True,'pause_retained':True}}]});sys.exit(0)
 if mode=='fail':put({'format':3,'history':[],'opening_intent':{'phase':'failed-access-rearmed','queue':ident(),'gates':[]}});sys.exit(3)
if cmd=='rearm-held-update':
 s=json.load(open(st));s['opening_intent']['phase']='interrupted-access-rearmed';put(s);open(st+'.rearmed','a').write('x')
'''
class D(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();d=self.d=Path(self.t.name);self.f=d/'f';self.f.mkdir()
  for n,c in [('queue.py',FAKE),('upd.sh','#!/bin/sh\n'),('man.json','{"engagement_id":"eng-00000001"}')]:(d/n).write_text(c)
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
  good={'format':3,'history':[{'sha':'T','digest':sp['target_digest'],'mode':'ui-open-automation-held','automation_held':True}],'recovery_fence':'T','resume_required':True,'recoveries':[{'kind':'reviewed-held-update','manifest':{'engagement_id':'eng-00000001'},'target':{'sha':'T','digest':sp['target_digest']}}],'opening_audits':[{'phase':'ui-open-automation-held','manifest':{'engagement_id':'eng-00000001'},'target':{'sha':'T'},'proof':{'automation_held':True,'pause_retained':True}}]}
  self.assertEqual(du.decision(f,sp,good),'completed')
  old={'engagement_id':'eng-00000001','old':1}
  self.assertEqual(du.decision(f,sp,{**good,'recoveries':[{**good['recoveries'][0],'manifest':old}]}),'completed-audit-mismatch-report-only','older recovery for the same target')
  self.assertEqual(du.decision(f,sp,{**good,'opening_audits':[{**good['opening_audits'][0],'manifest':old}]}),'completed-audit-mismatch-report-only','older opening audit for the same target')
  self.assertEqual(du.decision(f,sp,{**good,'opening_audits':[{k:v for k,v in good['opening_audits'][0].items() if k!='manifest'}]}),'completed-audit-mismatch-report-only','audit without engagement link')
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
 def test_units_worker_ended_vs_ambiguous(self):
  fake=self.d/'systemctl2';fake.write_text('#!/bin/sh\ncat "$FAKE_DIR/$3"\n');fake.chmod(0o755);du.SYSTEMCTL=str(fake)
  me=du.identity(os.getpid());inv='i'*32;winv='w'*32;os.environ['INVOCATION_ID']=inv
  ch=subprocess.Popen(['sleep','60']);dead=du.identity(ch.pid);ch.kill();ch.wait()
  wu='lyam-durable-held-eng-00000001-worker.service';du_='lyam-durable-held-eng-00000001-watchdog.service'
  def bind(wid):
   (self.f/'unit-bindings.json').write_text(json.dumps({'kind':'held-update','engagementID':'eng-00000001','worker':{'unit':wu,'invocationID':winv,'pid':dead['pid'],'starttime':dead['starttime'],'boot_id':dead['boot_id'],'controlGroup':'/w'},'watchdog':{'unit':du_,'invocationID':inv,'pid':os.getpid(),'starttime':me['starttime'],'boot_id':me['boot_id'],'controlGroup':'/d'}}))
  base={'User':'root','UMask':'0077','Restart':'no','KillMode':'control-group','RuntimeMaxUSec':'infinity','TimeoutStartUSec':'infinity','TimeoutStopUSec':'infinity','StandardOutput':'append','StandardError':'append'}
  wd={**base,'InvocationID':inv,'MainPID':str(os.getpid()),'ControlGroup':'/d','ActiveState':'active'}
  wk={**base,'InvocationID':winv,'MainPID':'0','ControlGroup':'/w','ActiveState':'inactive'}
  dd=self.d/'show';dd.mkdir();os.environ['FAKE_DIR']=str(dd)
  def put(w,k):
   (dd/wu).write_text(''.join('%s=%s\n'%kv for kv in w.items()));(dd/du_).write_text(''.join('%s=%s\n'%kv for kv in k.items()))
  try:
   bind(0);put(wk,wd)
   self.assertEqual(du.verify_units(self.f,'watchdog',self.spec)['_worker_status'],'ended')       # nominal end
   put({**wk,'ActiveState':'failed'},wd);self.assertEqual(du.verify_units(self.f,'watchdog',self.spec)['_worker_status'],'ended')   # killed
   for name,w,k in [('other invocation',{**wk,'InvocationID':'x'*32},wd),('ended but MainPID set',{**wk,'MainPID':'5'},wd),('inactive watchdog',wk,{**wd,'ActiveState':'inactive','MainPID':'0'}),('props drift on ended worker',{**wk,'Restart':'always'},wd),('active worker not matching pid',{**wk,'ActiveState':'active','MainPID':'1'},wd)]:
    put(w,k)
    with self.assertRaises(ValueError,msg=name):du.verify_units(self.f,'watchdog',self.spec)
   put(wk,wd);ent=json.loads((self.f/'unit-bindings.json').read_text());ent['worker']['pid']=os.getpid();ent['worker']['starttime']=me['starttime'];ent['worker']['boot_id']=me['boot_id']
   (self.f/'unit-bindings.json').write_text(json.dumps(ent))
   with self.assertRaises(ValueError,msg='bound pid still alive while unit inactive'):du.verify_units(self.f,'watchdog',self.spec)
   bind(0);put(wk,wd)
   with self.assertRaises(ValueError,msg='worker role never accepts ended'):du.verify_units(self.f,'worker',self.spec)
  finally:os.environ.pop('INVOCATION_ID',None);os.environ.pop('FAKE_DIR',None);du.SYSTEMCTL='/usr/bin/systemctl'
 def test_units_revalidated_at_second_tick_before_the_single_attempt(self):
  saved=(du.REQUIRE_UNITS,du.await_units,du.verify_units,du.decision)
  try:
   for drift in (False,True):
    for n in ('watchdog-identity.json','watchdog-events.jsonl','watchdog-result.json','STOP_WATCHDOG','WATCH_READY','heartbeat.json'):
     (self.f/n).unlink(missing_ok=True)
    calls=[];rec=[]
    def vu(folder,role,spec):
     calls.append(role)
     if drift and len(calls)>=2:raise ValueError('unit binding drifted')
    du.REQUIRE_UNITS=True;du.await_units=lambda *a,**k:None;du.verify_units=vu;du.decision=lambda f,sp,st:'interrupted-rearm-permitted'
    du.watchdog(self.f,self.spec,recover=lambda f,sp:rec.append(1) or {'kind':'x'},poll=1)
    res=json.loads((self.f/'watchdog-result.json').read_text())
    if drift:self.assertEqual(rec,[]);self.assertEqual(res['action'],'identity-unknown-report-only');self.assertTrue(res['report_only'])
    else:self.assertEqual(rec,[1]);self.assertEqual(res['action'],'interrupted-rearm-permitted');self.assertEqual(len(calls),2)
  finally:du.REQUIRE_UNITS,du.await_units,du.verify_units,du.decision=saved
 def test_orphan_updater_child_alive_is_observed_never_rearmed(self):
  f=self.f;sp=self.spec;(f/'STARTED').write_text('{"engagement_id":"eng-00000001"}')
  me=du.identity(os.getpid());me={k:me[k] for k in('pid','starttime','boot_id')}
  ch=subprocess.Popen(['sleep','30']);ci=du.identity(ch.pid);ci={k:ci[k] for k in('pid','starttime','boot_id')}
  dp=subprocess.Popen(['true']);dd=du.identity(dp.pid);dp.wait();dead={k:dd[k] for k in('pid','starttime','boot_id')} if dd else None
  (f/'worker-identity.json').write_text(json.dumps(me));(f/'queue-identity.json').write_text(json.dumps(me))
  try:
   if dead is None:self.skipTest('no dead identity')
   (f/'worker-identity.json').write_text(json.dumps({**dead}));(f/'queue-identity.json').write_text(json.dumps(dead))
   st=lambda uc:{'opening_intent':{'phase':'closed-step-0-updater-spawned','queue':dead,'updater_child':uc}}
   self.assertEqual(du.decision(f,sp,st({'identity':ci,'step':0})),'orphan-updater-alive-observe')
   self.assertEqual(du.decision(f,sp,st({'identity':{**ci,'starttime':str(int(ci['starttime'])+1)},'step':0})),'identity-unknown-report-only')
   self.assertEqual(du.decision(f,sp,st('garbage')),'identity-unknown-report-only')
   self.assertEqual(du.decision(f,sp,st(None)),'interrupted-rearm-permitted')
   ch.kill();ch.wait()
   self.assertEqual(du.decision(f,sp,st({'identity':ci,'step':0})),'interrupted-rearm-permitted')
  finally:
   ch.kill();ch.wait()
 def test_launcher_commands_are_exact_and_independent(self):
  c=du.launcher_commands('/f','eng-00000001','/usr/bin/python3.12','/x/held-update-durable.py')
  self.assertEqual([x[1] for x in c],['--unit=lyam-durable-held-eng-00000001-watchdog.service','--unit=lyam-durable-held-eng-00000001-worker.service'])
  for x in c:
   s=' '.join(x);self.assertIn('RuntimeMaxSec=infinity',s);self.assertIn('Restart=no',s);self.assertNotIn('BindsTo',s);self.assertNotIn('PartOf',s);self.assertIn('StandardOutput=append:/f/',s)
 def test_heartbeat_requires_wall_and_monotonic_advance(self):
  hb=self.f/'heartbeat.json';n=[0]
  def w(m,wl):hb.write_text(json.dumps({'alive':True,'monotone':m,'wall':wl}))
  real=time.sleep
  def fake(x):
   n[0]+=1;w(time.monotonic(),time.time()-(0 if self.mode=='ok' else 0)) if self.mode!='frozen' else w(time.monotonic(),self.frozen)
  self.frozen=time.time();self.mode='frozen';w(time.monotonic(),self.frozen);du.time=type('T',(),{'sleep':staticmethod(fake),'monotonic':staticmethod(time.monotonic),'time':staticmethod(time.time)})
  try:
   self.assertFalse(du.heartbeat_fresh(self.f,1),'wall frozen')
   self.mode='ok';self.assertTrue(du.heartbeat_fresh(self.f,1))
  finally:du.time=time
 def test_poll_validated(self):
  with self.assertRaises(ValueError):du.main(['watchdog','--folder',str(self.f),'--poll','0'])
 def test_spec_binding_refuses_changed_file(self):
  (self.d/'queue.py').write_text(FAKE+'#x');du.PROTECT=lambda p:None
  with self.assertRaisesRegex(ValueError,'binding'):du.check_spec(self.f)
if __name__=='__main__':unittest.main()
