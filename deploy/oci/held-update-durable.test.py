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
 def run_unit(self,mode,env=None,delay=0,capture=False):
  # tests run as non-root: bypass only the root-ancestry check through an import-time hook wrapper
  code="import sys,importlib.util,time;time.sleep(%r);s=importlib.util.spec_from_file_location('du',%r);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.PROTECT=lambda p:None;m.REQUIRE_UNITS=False;sys.exit(m.main(['%s','--folder',%r,'--poll','1']))"%(delay,str(SELF),mode,str(self.f))
  p=subprocess.Popen([sys.executable,'-c',code],env={**os.environ,**(env or {})},stderr=subprocess.PIPE if capture else None);self.procs.append(p);return p
 def wait(self,name,t=20):
  e=time.time()+t
  while time.time()<e:
   if (self.f/name).exists():return json.loads((self.f/name).read_text())
   time.sleep(.1)
  self.fail('timeout '+name)
 def start_ready(self,env=None,delay=.5):
  # Model slow watchdog scheduling explicitly; worker identity alone is not readiness.
  wd=self.run_unit('watchdog',delay=delay);w=self.run_unit('worker',env)
  self.wait('worker-identity.json')
  deadline=time.monotonic()+20
  while time.monotonic()<deadline:
   self.assertIsNone(wd.poll(),'watchdog exited before GO');self.assertIsNone(w.poll(),'worker exited before GO')
   if (self.f/'WATCH_READY').exists() and (self.f/'heartbeat.json').exists() and du.heartbeat_fresh(self.f,1):
    (self.f/'GO').write_text('1');return wd,w
   time.sleep(.05)
  self.fail('watchdog readiness did not advance before GO')
 def test_worker_identity_alone_refuses_early_go(self):
  # Deterministically reproduce the failed fixture ordering with the real guarded worker.
  w=self.run_unit('worker',{'FAKE_MODE':'ok'},capture=True);self.wait('worker-identity.json')
  self.assertFalse((self.f/'WATCH_READY').exists());(self.f/'GO').write_text('1')
  _,err=w.communicate(timeout=5);self.assertNotEqual(w.returncode,0);self.assertIn(b'watchdog not ready',err)
  self.assertFalse((self.f/'queue-identity.json').exists());self.assertFalse((self.f/'STARTED').exists())
 def test_worker_refusal_before_start_is_terminal_without_rearm(self):
  # Real worker raises before STARTED. Start watchdog only afterwards so the refusal is deterministic.
  w=self.run_unit('worker',{'FAKE_MODE':'ok'},capture=True);self.wait('worker-identity.json')
  (self.f/'GO').write_text('1');_,err=w.communicate(timeout=5)
  self.assertNotEqual(w.returncode,0);self.assertIn(b'watchdog not ready',err)
  self.assertTrue(self.wait('worker-result.json')['before_start'])
  self.run_unit('watchdog');r=self.wait('watchdog-result.json',5)
  self.assertEqual(r['action'],'failed-before-start-report-only');self.assertTrue(r['needs_operator'])
  self.assertFalse((self.f/'STARTED').exists());self.assertFalse((self.f/'queue-identity.json').exists())
  self.assertFalse((self.f/'rearm-attempt.json').exists());self.assertFalse(Path(str(self.state)+'.rearmed').exists())
 def test_state_without_intent_before_go_does_not_complete(self):
  w=self.run_unit('watchdog');time.sleep(2.5);self.assertIsNone(w.poll(),'watchdog exits before GO on a null-intent state')
  self.assertFalse((self.f/'watchdog-result.json').exists());self.assertTrue((self.f/'WATCH_READY').exists())
 def test_decision_pure_categories(self):
  sp=self.spec;f=self.f;st={'format':3}
  self.assertEqual(du.decision(f,sp,{}),'pre-go-await')
  (f/'worker-result.json').write_text('{"exit":1,"before_start":true}');self.assertEqual(du.decision(f,sp,{}),'failed-before-start-report-only')
  (f/'STARTED').write_text('{}');self.assertEqual(du.decision(f,sp,st),'failed-before-intent-report-only')
  (f/'worker-result.json').unlink()
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
  wd,w=self.start_ready({'FAKE_MODE':'ok'},delay=2)
  self.assertEqual(self.wait('worker-result.json')['exit'],0);r=self.wait('watchdog-result.json');self.assertEqual(r['action'],'completed')
 def test_sigkill_queue_after_intent_gives_one_rearm_never_a_second(self):
  wd,w=self.start_ready({'FAKE_MODE':'hang'})
  qi=self.wait('queue-identity.json');e=time.time()+10
  while time.time()<e and 'closed-step-0' not in self.state.read_text():time.sleep(.1)
  e=time.time()+15
  while time.time()<e and 'observe-live-queue' not in (self.f/'watchdog-events.jsonl').read_text():time.sleep(.2)
  os.kill(qi['pid'],signal.SIGKILL);r=self.wait('watchdog-result.json',30)
  self.assertEqual(r['action'],'interrupted-rearm-permitted');self.assertEqual(r['recovery']['outcome'],'measured-closed')
  self.assertEqual(Path(str(self.state)+'.rearmed').read_text(),'x',"exactly one rearm");self.assertTrue((self.f/'rearm-attempt.json').exists())
  ev=[json.loads(l)['action'] for l in (self.f/'watchdog-events.jsonl').read_text().splitlines()];self.assertIn('observe-live-queue',ev)
 def test_caught_failure_is_report_only(self):
  wd,w=self.start_ready({'FAKE_MODE':'fail'})
  self.assertEqual(self.wait('watchdog-result.json')['action'],'caught-failure-report-only');self.assertFalse(Path(str(self.state)+'.rearmed').exists())
 def test_spec_requires_exact_interpreter_and_self(self):
  du.PROTECT=lambda p:None;sp=self.spec;link=self.d/'py';link.symlink_to(PY);sp['fileSHA256'][str(link)]=sp['fileSHA256'][PY];sp['python']=str(link)
  (self.f/'supervision-spec.json').write_text(json.dumps(sp))
  with self.assertRaisesRegex(ValueError,'non-symlink'):du.check_spec(self.f)
 def test_units_bound_to_systemd_properties(self):
  fake=self.d/'systemctl';fake.write_text('#!/bin/sh\ncat "$FAKE_SHOW"\ncase "$3" in *-worker.service) echo RemainAfterExit=yes;; *) echo RemainAfterExit=no;; esac\n');fake.chmod(0o755);du.SYSTEMCTL=str(fake)
  me=du.identity(os.getpid());inv='i'*32;os.environ['INVOCATION_ID']=inv
  ent=lambda r:{'unit':'lyam-durable-held-eng-00000001-%s.service'%r,'invocationID':inv,'pid':os.getpid(),'starttime':me['starttime'],'boot_id':me['boot_id'],'controlGroup':'/system.slice/x'}
  (self.f/'unit-bindings.json').write_text(json.dumps({'kind':'held-update','engagementID':'eng-00000001','worker':ent('worker'),'watchdog':ent('watchdog')}))
  props={'InvocationID':inv,'MainPID':str(os.getpid()),'ControlGroup':'/system.slice/x','ActiveState':'active','User':'root','UMask':'0077','Restart':'no','KillMode':'control-group','RuntimeMaxUSec':'infinity','TimeoutStartUSec':'infinity','TimeoutStopUSec':'infinity','StandardOutput':'append','StandardError':'append','SubState':'running','Result':'success','ExecMainPID':str(os.getpid()),'ExecMainCode':'0','ExecMainStatus':'0','ExecMainStartTimestampMonotonic':'1000','ExecMainExitTimestampMonotonic':'0'}
  show=self.d/'show';os.environ['FAKE_SHOW']=str(show)
  def put(p):show.write_text(''.join('%s=%s\n'%kv for kv in p.items()))
  try:
   put(props);du.verify_units(self.f,'worker',self.spec)
   for k,v in [('InvocationID','z'*32),('MainPID','1'),('Restart','on-failure'),('RuntimeMaxUSec','1h'),('UMask','0022'),('StandardOutput','journal'),('KillMode','process'),('SubState','exited')]:
    put({**props,k:v})
    with self.assertRaises(ValueError,msg=k):du.verify_units(self.f,'worker',self.spec)
   put(props);os.environ['INVOCATION_ID']='other'
   with self.assertRaisesRegex(ValueError,'bound unit main process'):du.verify_units(self.f,'worker',self.spec)
  finally:os.environ.pop('INVOCATION_ID',None);du.SYSTEMCTL='/usr/bin/systemctl'
 def test_units_worker_retained_end_vs_lost_vs_ambiguous(self):
  fake=self.d/'systemctl2';fake.write_text('#!/bin/sh\ncat "$FAKE_DIR/$3"\n');fake.chmod(0o755);du.SYSTEMCTL=str(fake)
  me=du.identity(os.getpid());inv='i'*32;winv='w'*32;os.environ['INVOCATION_ID']=inv
  ch=subprocess.Popen(['sleep','60']);dead=du.identity(ch.pid);ch.kill();ch.wait()
  cg=self.d/'cg';cgd=cg/'w';cgd.mkdir(parents=True);(cgd/'cgroup.procs').write_text('');du.CGROOT=str(cg)
  wu='lyam-durable-held-eng-00000001-worker.service';du_='lyam-durable-held-eng-00000001-watchdog.service'
  def bind(pid=None):
   w=dict(dead) if pid is None else pid
   (self.f/'unit-bindings.json').write_text(json.dumps({'kind':'held-update','engagementID':'eng-00000001','worker':{'unit':wu,'invocationID':winv,'pid':w['pid'],'starttime':w['starttime'],'boot_id':w['boot_id'],'controlGroup':'/w'},'watchdog':{'unit':du_,'invocationID':inv,'pid':os.getpid(),'starttime':me['starttime'],'boot_id':me['boot_id'],'controlGroup':'/d'}}))
  base={'User':'root','UMask':'0077','Restart':'no','KillMode':'control-group','RuntimeMaxUSec':'infinity','TimeoutStartUSec':'infinity','TimeoutStopUSec':'infinity','StandardOutput':'append','StandardError':'append'}
  wd={**base,'InvocationID':inv,'MainPID':str(os.getpid()),'ControlGroup':'/d','ActiveState':'active','SubState':'running','RemainAfterExit':'no','Result':'success','ExecMainPID':str(os.getpid()),'ExecMainCode':'0','ExecMainStatus':'0','ExecMainStartTimestampMonotonic':'500','ExecMainExitTimestampMonotonic':'0'}
  ex={**base,'InvocationID':winv,'MainPID':'0','ControlGroup':'/w','ActiveState':'active','SubState':'exited','RemainAfterExit':'yes','Result':'success','ExecMainPID':str(dead['pid']),'ExecMainCode':'1','ExecMainStatus':'0','ExecMainStartTimestampMonotonic':'1000','ExecMainExitTimestampMonotonic':'2000'}
  dd=self.d/'show';dd.mkdir();os.environ['FAKE_DIR']=str(dd)
  def put(w,k):
   (dd/wu).write_text(''.join('%s=%s\n'%kv for kv in w.items()));(dd/du_).write_text(''.join('%s=%s\n'%kv for kv in k.items()))
  V=lambda role='watchdog':du.verify_units(self.f,role,self.spec)
  try:
   bind();put(ex,wd)
   with self.assertRaises(ValueError,msg='retained end without a recorded start stamp is unknown'):V()
   ent_w=json.loads((self.f/'unit-bindings.json').read_text())['worker'];du.worker_start_stamp(self.f,'1000',ent_w,'eng-00000001')   # the earlier running sighting, published for exactly this worker identity
   for k,v in (('pid',dead['pid']+1),('invocationID','q'*32),('boot_id','other'),('starttime','1'),('controlGroup','/other'),('unit','x')):   # a record bound to another identity does not authorise this end
    other=dict(ent_w);other[k]=v;(self.f/'worker-unit-start.json').rename(self.f/'keep.json');du.worker_start_stamp(self.f,'1000',other,'eng-00000001')
    with self.assertRaises(ValueError,msg='record for other '+k):V()
    (self.f/'worker-unit-start.json').unlink();(self.f/'keep.json').rename(self.f/'worker-unit-start.json')
   rr=json.loads((self.f/'worker-unit-start.json').read_text());rr['engagementID']='other';(self.f/'worker-unit-start.json').write_text(json.dumps(rr))
   with self.assertRaises(ValueError,msg='record for other engagement'):V()
   (self.f/'worker-unit-start.json').unlink();du.worker_start_stamp(self.f,'1000',ent_w,'eng-00000001')
   bind();put(ex,wd)
   for name,w in (('other start stamp',{**ex,'ExecMainStartTimestampMonotonic':'999'}),('exit before start',{**ex,'ExecMainExitTimestampMonotonic':'999'}),('exit stamp zero',{**ex,'ExecMainExitTimestampMonotonic':'0'}),('exit stamp empty',{**ex,'ExecMainExitTimestampMonotonic':''})):
    put(w,wd)
    with self.assertRaises(ValueError,msg=name):V()
   put(ex,wd)
   r=V();self.assertEqual((r['_worker_status'],r['_worker_exit']),('exited',0))                         # nominal end, retained record: RemainAfterExit
   put({**ex,'ExecMainStatus':'7'},wd);self.assertEqual(V()['_worker_exit'],7)
   put({**ex,'ActiveState':'failed','SubState':'failed','Result':'exit-code','ExecMainStatus':'1'},wd);self.assertEqual(V()['_worker_status'],'failed')   # failed, retained
   put({**ex,'ActiveState':'failed','SubState':'failed','Result':'signal','ExecMainCode':'2','ExecMainStatus':'9'},wd);self.assertEqual(V()['_worker_status'],'failed')   # killed, retained
   put({**ex,'ActiveState':'failed','SubState':'failed','Result':'core-dump','ExecMainCode':'3','ExecMainStatus':'11'},wd);self.assertEqual(V()['_worker_status'],'failed')
   # THE REAL DEFECT: the manager forgot the unit after exit (no retention): empty InvocationID/ControlGroup/inactive/MainPID 0. Distinct category, never ended.
   put({**ex,'InvocationID':'','ControlGroup':'','ActiveState':'inactive','SubState':'dead','ExecMainPID':'0'},wd)
   with self.assertRaises(du.UnitRecordLost):V()
   for name,w,k in [('other invocation',{**ex,'InvocationID':'x'*32},wd),('ended but MainPID set',{**ex,'MainPID':'5'},wd),('inactive watchdog',ex,{**wd,'ActiveState':'inactive','SubState':'dead','MainPID':'0'}),
     ('props drift on retained worker',{**ex,'Restart':'always'},wd),('active worker not matching pid',{**ex,'SubState':'running','MainPID':'1'},wd),
     ('inactive but not lost (invocation kept)',{**ex,'ActiveState':'inactive','SubState':'dead'},wd),('no retention contract',{**ex,'RemainAfterExit':'no'},wd),
     ('other control group',{**ex,'ControlGroup':'/other'},wd),('ExecMainPID differs from bound',{**ex,'ExecMainPID':'1'},wd),('success result with failed state',{**ex,'Result':'exit-code'},wd),
     ('success result but ExecMainCode not exited',{**ex,'ExecMainCode':'2'},wd),('unknown failure result',{**ex,'ActiveState':'failed','SubState':'failed','Result':'weird'},wd),*[('failed tuple '+n,{**ex,'ActiveState':'failed','SubState':'failed','Result':rs,'ExecMainCode':c,'ExecMainStatus':st},wd) for n,rs,c,st in (('exit-code code0 status0','exit-code','0','0'),('exit-code status0','exit-code','1','0'),('exit-code status256','exit-code','1','256'),('signal with CLD_EXITED','signal','1','9'),('signal 0','signal','2','0'),('signal 65','signal','2','65'),('core-dump with CLD_KILLED','core-dump','2','11'),('timeout code0','timeout','0','0'),('timeout coherent-looking','timeout','1','1'),('watchdog','watchdog','2','6'),('resources','resources','1','1'))],('exited without status',{**ex,'ExecMainStatus':''},wd)]:
    put(w,k)
    with self.assertRaises(ValueError,msg=name):V()
   put(ex,wd);(cgd/'cgroup.procs').write_text('4242\n')
   with self.assertRaises(ValueError,msg='bound cgroup still populated'):V()
   (cgd/'cgroup.procs').write_text('');child=cgd/'child'/'grand';child.mkdir(parents=True);(cgd/'child'/'cgroup.procs').write_text('');(child/'cgroup.procs').write_text('77\n')
   with self.assertRaises(ValueError,msg='root empty but a descendant cgroup is populated'):V()
   (child/'cgroup.procs').write_text('');self.assertEqual(V()['_worker_status'],'exited')               # empty recursively
   (cgd/'cgroup.events').write_text('populated 1\nfrozen 0\n')
   with self.assertRaises(ValueError,msg='cgroup.events says populated'):V()
   (cgd/'cgroup.events').write_text('populated 0\nfrozen 0\n');self.assertEqual(V()['_worker_status'],'exited')
   (child/'cgroup.procs').unlink()
   with self.assertRaises(ValueError,msg='unreadable/missing procs in a descendant is unknown, not ended'):V()
   import shutil as _sh;_sh.rmtree(cgd/'child');(cgd/'cgroup.events').unlink()
   (cgd/'cgroup.procs').write_text('');import shutil;shutil.rmtree(cgd);self.assertEqual(V()['_worker_status'],'exited')   # cgroup gone: accepted only with the retained manager record
   cgd.mkdir();(cgd/'cgroup.procs').write_text('')
   # manager-side ControlGroup retired after exit (real run 45480617922): the invocation record is retained, only the cgroup is empty
   retired={**ex,'ControlGroup':''}
   put(retired,wd);r=V();self.assertEqual((r['_worker_status'],r['_worker_exit']),('exited',0))              # bound path empty => accepted
   put({**ex,'ActiveState':'failed','SubState':'failed','Result':'exit-code','ExecMainStatus':'3','ControlGroup':''},wd);self.assertEqual(V()['_worker_status'],'failed')
   import shutil as _s;_s.rmtree(cgd);put(retired,wd);self.assertEqual(V()['_worker_status'],'exited');cgd.mkdir();(cgd/'cgroup.procs').write_text('')   # bound path certainly gone => accepted
   (cgd/'cgroup.procs').write_text('9\n');put(retired,wd)
   with self.assertRaises(ValueError,msg='retired manager cgroup but bound path populated'):V()
   (cgd/'cgroup.procs').write_text('');(cgd/'kid').mkdir();(cgd/'kid'/'cgroup.procs').write_text('5\n')
   with self.assertRaises(ValueError,msg='retired manager cgroup but a live descendant of the bound path'):V()
   _s.rmtree(cgd/'kid');(cgd/'cgroup.procs').chmod(0)
   try:
    if os.geteuid()!=0:
     with self.assertRaises(ValueError,msg='bound path unreadable is unknown, not ended'):V()
   finally:(cgd/'cgroup.procs').chmod(0o644)
   for name,w in (('running with empty cgroup',{**ex,'ControlGroup':'','ActiveState':'active','SubState':'running','MainPID':str(dead['pid'])}),('other non-empty cgroup',{**ex,'ControlGroup':'/other'}),
                  ('retired cgroup but empty invocation (lost record is a different category)',{**ex,'ControlGroup':'','InvocationID':''}),('retired cgroup, other invocation',{**ex,'ControlGroup':'','InvocationID':'x'*32}),
                  ('retired cgroup but MainPID set',{**ex,'ControlGroup':'','MainPID':'5'}),('retired cgroup but inactive/dead',{**ex,'ControlGroup':'','ActiveState':'inactive','SubState':'dead'}),
                  ('retired cgroup, start stamp drift',{**ex,'ControlGroup':'','ExecMainStartTimestampMonotonic':'1001'}),('retired cgroup, exit before start',{**ex,'ControlGroup':'','ExecMainExitTimestampMonotonic':'1'}),
                  ('retired cgroup, ExecMainPID other',{**ex,'ControlGroup':'','ExecMainPID':'1'})):
    put(w,wd)
    with self.assertRaises(ValueError,msg=name):V()
   put({**ex,'InvocationID':'','ControlGroup':'','ActiveState':'inactive','SubState':'dead','ExecMainPID':'0'},wd)
   with self.assertRaises(du.UnitRecordLost):V()                                                               # lost record stays its own report-only category
   put({**ex,'ControlGroup':''},wd);(self.f/'worker-unit-start.json').rename(self.f/'keep2.json')
   with self.assertRaises(ValueError,msg='retired cgroup without the recorded running start'):V()
   (self.f/'keep2.json').rename(self.f/'worker-unit-start.json')
   # drift between the cgroup scan and the manager re-read
   real=du.unit_properties;calls=[0]
   def drifting(unit):
    p=real(unit)
    if unit==wu:
     calls[0]+=1
     if calls[0]>=2:p=dict(p,ControlGroup='/w',ExecMainExitTimestampMonotonic='2001')
    return p
   put(retired,wd);du.unit_properties=drifting
   try:
    with self.assertRaises(ValueError,msg='manager record changed after the cgroup scan'):V()
   finally:du.unit_properties=real
   put(retired,wd);self.assertEqual(V()['_worker_status'],'exited')
   bind({'pid':os.getpid(),'starttime':me['starttime'],'boot_id':me['boot_id']});put(ex,wd)
   with self.assertRaises(ValueError,msg='bound pid still alive while unit says exited'):V()
   bind();put(ex,wd)
   with self.assertRaises(ValueError,msg='worker role never accepts a retained end'):V('worker')
  finally:os.environ.pop('INVOCATION_ID',None);os.environ.pop('FAKE_DIR',None);du.SYSTEMCTL='/usr/bin/systemctl';du.CGROOT='/sys/fs/cgroup'
 def test_start_record_publication_is_atomic_complete_and_concurrent_safe(self):
  import multiprocessing,os as _os
  ent={'unit':'lyam-durable-held-eng-00000001-worker.service','invocationID':'i'*32,'pid':4242,'starttime':'99','boot_id':'b','controlGroup':'/w'}
  d=self.d/'pub';d.mkdir()
  du.worker_start_stamp(d,'1000',ent,'eng-00000001');rec=json.loads((d/'worker-unit-start.json').read_text())
  self.assertEqual(rec,du.worker_record('1000',ent,'eng-00000001'));self.assertEqual(du.worker_start_stamp(d,'1000',ent,'eng-00000001'),1000)
  self.assertEqual(sorted(p.name for p in d.iterdir()),['worker-unit-start.json'])                            # no temp leftovers
  with self.assertRaises(ValueError):du.worker_start_stamp(d,'1001',ent,'eng-00000001')                       # another stamp, same record name
  with self.assertRaises(ValueError):du.worker_start_stamp(d,'1000',{**ent,'pid':1},'eng-00000001')
  with self.assertRaises(ValueError):du.worker_start_stamp(d,'0',ent,'eng-00000001')
  # concurrent publishers with a barrier between temp write and link: every reader sees either no final file or a COMPLETE one
  e2=self.d/'pub2';e2.mkdir();ready=multiprocessing.Barrier(4);bad=multiprocessing.Value('i',0)
  def runner(k):
   real=_os.link
   def slow(a,b):ready.wait(10);return real(a,b)       # all publishers hold a complete private temp file, then race to link
   _os.link=slow
   try:du.worker_start_stamp(e2,'1000',ent,'eng-00000001')
   except Exception:bad.value+=1
  ps=[multiprocessing.get_context('fork').Process(target=runner,args=(k,)) for k in range(4)]
  watcher_ok=[True]
  [p.start() for p in ps]
  import time as _t
  end=_t.time()+15
  while any(p.is_alive() for p in ps) and _t.time()<end:
   f=e2/'worker-unit-start.json'
   if f.exists():
    try:json.loads(f.read_text())
    except Exception:watcher_ok[0]=False
  [p.join(20) for p in ps]
  self.assertTrue(watcher_ok[0]);self.assertEqual(bad.value,0);self.assertEqual([p.exitcode for p in ps],[0]*4)
  self.assertEqual(json.loads((e2/'worker-unit-start.json').read_text()),du.worker_record('1000',ent,'eng-00000001'))
  self.assertEqual(sorted(p.name for p in e2.iterdir()),['worker-unit-start.json'])
 def test_watchdog_categories_from_unit_record(self):
  saved=(du.REQUIRE_UNITS,du.await_units,du.verify_units,du.decision)
  def run(vu,dec):
   for n in ('watchdog-identity.json','watchdog-events.jsonl','watchdog-result.json','STOP_WATCHDOG','WATCH_READY','heartbeat.json'):(self.f/n).unlink(missing_ok=True)
   rec=[];du.REQUIRE_UNITS=True;du.await_units=lambda *a,**k:None;du.verify_units=vu;du.decision=lambda f,sp,st:dec
   du.watchdog(self.f,self.spec,recover=lambda f,sp:rec.append(1) or {'kind':'x'},poll=1)
   return json.loads((self.f/'watchdog-result.json').read_text()),rec
  def ret(status,code):
   return lambda f,r,s:{'_worker_status':status,'_worker_exit':code}
  def lost(f,r,s):raise du.UnitRecordLost('x')
  try:
   res,rec=run(lost,'completed');self.assertEqual(res['action'],'terminal-gc-observed-report-only');self.assertTrue(res['report_only']);self.assertEqual(rec,[])   # GC observed: never completed, never rearm
   res,rec=run(lost,'interrupted-rearm-permitted');self.assertEqual((res['action'],rec),('terminal-gc-observed-report-only',[]))
   self.assertEqual(run(ret('exited',0),'completed')[0]['action'],'completed')
   for st,code in (('exited',3),('failed',None)):self.assertEqual(run(ret(st,code),'completed')[0]['action'],'completed-unit-result-mismatch-report-only')
   res,rec=run(ret('active',None),'interrupted-rearm-permitted');self.assertEqual((res['action'],rec),('identity-unknown-report-only',[]))   # worker unit still running: no rearm
   res,rec=run(ret('failed',None),'interrupted-rearm-permitted');self.assertEqual((res['action'],rec),('interrupted-rearm-permitted',[1]))
   # race: result written before process exit => completed + active waits (non-terminal), then retained exited 0 completes; kill/unknown during the wait is report-only
   seq=[ret('active',None),ret('active',None),ret('exited',0)];n=[0]
   def vs(f,r,s):v=seq[min(n[0],len(seq)-1)];n[0]+=1;return v(f,r,s)
   res,rec=run(vs,'completed');self.assertEqual(res['action'],'completed');self.assertGreaterEqual(n[0],3)
   seq=[ret('active',None),lost];n[0]=0;res,rec=run(vs,'completed');self.assertEqual(res['action'],'terminal-gc-observed-report-only')
   def bad(f,r,s):raise ValueError('unknown')
   seq=[ret('active',None),bad];n[0]=0;res,rec=run(vs,'completed');self.assertEqual(res['action'],'identity-unknown-report-only')
   seq=[ret('active',None),ret('failed',None)];n[0]=0;res,rec=run(vs,'completed');self.assertEqual(res['action'],'completed-unit-result-mismatch-report-only')
   seq=[ret('active',None),ret('exited',5)];n[0]=0;res,rec=run(vs,'completed');self.assertEqual(res['action'],'completed-unit-result-mismatch-report-only')
   du.END_WAIT=0.0;seq=[ret('active',None)];n[0]=0;res,rec=run(vs,'completed');self.assertEqual(res['action'],'completed-worker-end-timeout-report-only');self.assertTrue(res['report_only'])
  finally:du.REQUIRE_UNITS,du.await_units,du.verify_units,du.decision=saved;du.END_WAIT=120.0
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
     return {'_worker_status':'exited','_worker_exit':1}
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
   s=' '.join(x);self.assertIn('RuntimeMaxSec=infinity',s);self.assertIn('Restart=no',s);self.assertEqual('RemainAfterExit=yes' in s,'-worker.service' in s);self.assertNotIn('BindsTo',s);self.assertNotIn('PartOf',s);self.assertIn('StandardOutput=append:/f/',s)
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
