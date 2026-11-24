#!/usr/bin/env python3
"""Harness-only reset of one already-bound failed transient worker. Never production."""
import hashlib,json,os,stat,subprocess,time
from pathlib import Path

SCENARIO='one-lasttick-record-loss'
def reset_worker(folder,wk,wd,du,bindings,props,rt,atomic_proof,state):
 if folder.name!='sup-'+SCENARIO:raise RuntimeError('record-loss-scenario-required')
 b=bindings['worker'];w=bindings['watchdog'];eng=wk.engagement
 if not isinstance(eng,str) or not __import__('re').fullmatch(r'[A-Za-z0-9._-]{8,64}',eng):raise RuntimeError('record-loss-engagement-invalid')
 if bindings.get('kind')!='held-update' or set(bindings)!={'kind','engagementID','worker','watchdog'} or bindings['engagementID']!=eng:raise RuntimeError('record-loss-bindings-required')
 for role,h,e in [('worker',wk,b),('watchdog',wd,w)]:
  if e!={'unit':h.unit,'invocationID':e.get('invocationID'),'pid':h.pid,'starttime':h.identity['starttime'],'boot_id':h.identity['boot_id'],'controlGroup':h.cgroup} or not e['invocationID']:raise RuntimeError('record-loss-identity-binding-required')
  if h.unit!='lyam-durable-held-'+eng+'-'+role+'.service' or h.cgroup!='/system.slice/'+h.unit:raise RuntimeError('record-loss-exact-unit-required')
 if props['InvocationID']!=b['invocationID'] or props['MainPID']!='0' or props['ControlGroup']!='' or props['ExecMainPID']!=str(wk.pid) or (props['ActiveState'],props['SubState'])!=('failed','failed'):raise RuntimeError('record-loss-retained-worker-required')
 if props['Result'] not in du.FAILED_TUPLES or props['ExecMainCode']!=du.FAILED_TUPLES[props['Result']][0] or not props['ExecMainStatus'].isdigit() or not 1<=int(props['ExecMainStatus'])<=du.FAILED_TUPLES[props['Result']][1]:raise RuntimeError('record-loss-terminal-tuple-required')
 record=json.loads((folder/'worker-unit-start.json').read_text())
 if not du.temporal_ok(folder,props,b,eng) or record!=du.worker_record(props['ExecMainStartTimestampMonotonic'],b,eng):raise RuntimeError('record-loss-start-record-required')
 if du.state_of(wk.identity)!='absent' or rt.independent_cgroup_state(wk.cgroup)!='gone':raise RuntimeError('record-loss-old-worker-not-gone')
 before=rt.final_cleanup_manager(wk.unit)
 if before!={k:props[k] for k in before if k!='LoadState'}|{'LoadState':'loaded'}:raise RuntimeError('record-loss-manager-before-differs')
 pre={'scenario':SCENARIO,'engagementID':eng,'worker':b,'watchdog':w,'workerStartRecord':record,'before':before,'queueSHA256':hashlib.sha256(state).hexdigest()}
 atomic_proof(folder/'record-loss-before-reset.json',pre)
 # Last instant checks, after persisting the pre-reset evidence.
 watchprops=du.unit_properties(wd.unit)
 if du.state_of(wd.identity)!='alive' or watchprops['InvocationID']!=w['invocationID'] or watchprops['MainPID']!=str(wd.pid) or watchprops['ControlGroup']!=wd.cgroup or Path('/proc/%d/stat'%wd.pid).read_text().split(') ',1)[1].split()[0] not in ('T','t'):raise RuntimeError('record-loss-watchdog-not-stopped-exact')
 if du.unit_properties(wk.unit)!=props or du.state_of(wk.identity)!='absent' or rt.independent_cgroup_state(wk.cgroup)!='gone':raise RuntimeError('record-loss-lastcheck-worker-drift')
 if (folder/'rearm-attempt.json').exists() or (folder/'watchdog-result.json').exists():raise RuntimeError('record-loss-window-missed')
 r=subprocess.run(['systemctl','reset-failed',wk.unit],capture_output=True,text=True,timeout=30)
 if r.returncode or r.stdout or r.stderr:raise RuntimeError('record-loss-reset-refused')
 end=time.monotonic()+3
 while True:
  after=rt.final_cleanup_manager(wk.unit)
  if after=={'LoadState':'not-found','ActiveState':'inactive','SubState':'dead','MainPID':'0','InvocationID':'','ControlGroup':''}:break
  if time.monotonic()>=end:raise RuntimeError('record-loss-manager-not-gone')
  time.sleep(.02)
 if du.state_of(wk.identity)!='absent' or rt.independent_cgroup_state(wk.cgroup)!='gone':raise RuntimeError('record-loss-old-worker-returned')
 proof={**pre,'after':after,'resetRC':0,'resetOutputEmpty':True,'oldPIDState':'absent','oldCgroupState':'gone'}
 path=folder/'record-loss-reset-proof.json';atomic_proof(path,proof)
 # Only this caller's successful reset opens the in-memory cleanup route. A file alone cannot.
 wk.fixture_reset={'scenario':SCENARIO,'proof':proof,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
 return proof

def cleanup_reset_noop(unit,old,before,preproof,postproof,stop,final,binding,token,folder):
 if not token or token.get('scenario')!=SCENARIO or folder is None or Path(folder).name!='sup-'+SCENARIO:return False
 p=token.get('proof') or {};eng=old.get('engagement');ident=old.get('identity') or {};cg=old.get('cgroup')
 if old.get('role')!='worker' or not isinstance(eng,str) or not __import__('re').fullmatch(r'[A-Za-z0-9._-]{8,64}',eng):return False
 if unit!='lyam-durable-held-'+eng+'-worker.service' or cg!='/system.slice/'+unit:return False
 if set(ident)!={'pid','starttime','boot_id'} or type(ident['pid']) is not int or ident['pid']<=0 or not ident['starttime'] or not ident['boot_id']:return False
 if not binding or binding!={**ident,'unit':unit,'controlGroup':cg,'invocationID':binding.get('invocationID')} or not binding['invocationID']:return False
 if p.get('scenario')!=SCENARIO or p.get('engagementID')!=eng or p.get('worker')!=binding or p.get('resetRC')!=0 or p.get('resetOutputEmpty') is not True or p.get('oldPIDState')!='absent' or p.get('oldCgroupState')!='gone':return False
 expected={'LoadState':'not-found','ActiveState':'inactive','SubState':'dead','MainPID':'0','InvocationID':'','ControlGroup':''}
 if p.get('after')!=expected or final!=expected or {k:before.get(k) for k in expected if k!='LoadState'}!={k:v for k,v in expected.items() if k!='LoadState'}:return False
 b=p.get('before') or {};rec=p.get('workerStartRecord') or {};watch=p.get('watchdog') or {}
 if b!={'LoadState':'loaded','ActiveState':'failed','SubState':'failed','MainPID':'0','InvocationID':binding['invocationID'],'ControlGroup':''}:return False
 if rec!={**binding,'engagementID':eng,'start':rec.get('start')} or type(rec['start']) is not int or rec['start']<=0:return False
 if watch.get('unit')!='lyam-durable-held-'+eng+'-watchdog.service' or watch.get('controlGroup')!='/system.slice/'+watch['unit'] or not watch.get('invocationID') or not watch.get('pid') or not watch.get('starttime') or not watch.get('boot_id'):return False
 if not __import__('re').fullmatch(r'[a-f0-9]{64}',p.get('queueSHA256','')):return False
 if preproof!={'originalMainState':'absent','originalCgroupState':'gone'} or postproof!={'originalMainState':'absent','originalCgroupState':'gone'}:return False
 if stop.get('returnCode')!=5 or stop.get('exactUnitNotLoaded') is not True or stop.get('stdoutEmpty') is not True:return False
 try:
  path=Path(folder)/'record-loss-reset-proof.json';st=path.lstat()
  if not stat.S_ISREG(st.st_mode) or stat.S_IMODE(st.st_mode)!=0o600 or st.st_nlink!=1:return False
  raw=path.read_bytes()
  if hashlib.sha256(raw).hexdigest()!=token.get('sha256') or json.loads(raw)!=p:return False
  bindings=json.loads((Path(folder)/'unit-bindings.json').read_text())
  if bindings!={'kind':'held-update','engagementID':eng,'worker':binding,'watchdog':watch}:return False
 except Exception:return False
 return True
