import importlib.util,json,tempfile,unittest,hashlib,tarfile,fcntl,subprocess,sys
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('host',Path(__file__).with_name('current-baseline-host.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_capture_stops_bound_ids_and_durable_checkpoints_no_restart(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);backup=p/'backups';backup.mkdir();calls=[];running={r:True for r in ('app','pg','bao')}
   spec={'engagement_id':'test-e1','target':{'sha':'a'*40,'digest':'sha256:'+'b'*64},'identities':{r:{'id':r+'-full-id','name':'different-'+r,'image_id':r+'-image'} for r in running},'stores':{r:{'path':str(p/r)} for r in ('dolt','pg','bao')},'files':[]}
   for r in ('dolt','pg','bao'):(p/r).mkdir()
   host=m.Host(spec,{});host.backup=backup;host.locks=lambda:None;host.close_access=lambda:None;host.assert_single_writer_sources=lambda *a,**k:None
   def inspect(cid):
    role=cid.split('-')[0];return {'Id':role+'-full-id','Image':role+'-image','State':{'Running':running[role],'OOMKilled':False,'ExitCode':0}}
   def command(args):
    calls.append(args)
    if args[:2]==['docker','stop']:
     role=args[-1].split('-')[0]
     event=backup/'current-baseline-test-e1/checkpoints'/(role+'-stop-intent.json')
     self.assertTrue(event.is_file());self.assertTrue(running[role]);running[role]=False
    elif args[0]=='tar' and '-czf' in args:
     self.assertFalse(any(running.values()))
     with tarfile.open(args[args.index('-czf')+1],'w:gz') as t:t.add(Path(args[args.index('-C')+1])/args[-1],arcname=args[-1])
    return ''
   host.inspect=inspect;host.command=command;result=host.capture_current_baseline(spec)
   self.assertTrue(result['coherent_three_store_backup']);self.assertFalse(any(running.values()))
   self.assertEqual([a[-1] for a in calls if a[:2]==['docker','stop']],['app-full-id','pg-full-id','bao-full-id'])
   self.assertFalse(any(a[:2] in (['docker','start'],['docker','rm'],['docker','rename']) for a in calls))
   self.assertEqual(len(list((backup/'current-baseline-test-e1/checkpoints').glob('*.json'))),6)
 def test_failure_keeps_stopped_closed_without_automatic_restart(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);host=m.Host({},{});host.backup=p;host.locks=lambda:None;host.close_access=lambda:None;host.assert_single_writer_sources=lambda *a,**k:None
   spec={'engagement_id':'test-e2','stores':{r:{'path':str(p/r)} for r in ('dolt','pg','bao')},'identities':{r:{'id':r,'image_id':r} for r in ('app','pg','bao')}}
   host.inspect=lambda cid:{'Id':cid,'Image':cid,'State':{'Running':True}}
   trace=[]
   def fail(a):trace.append(a);raise ValueError('stop failed')
   host.command=fail
   with self.assertRaises(ValueError):host.capture_current_baseline(spec)
   self.assertEqual(len(trace),1);self.assertEqual(trace[0][-1],'app')

class SourceExclusion(unittest.TestCase):
 def case(self,d):
  root=Path(d);stores={r:{'path':str(root/r)} for r in ('dolt','pg','bao')}
  for v in stores.values():Path(v['path']).mkdir()
  spec={'stores':stores,'identities':{r:{'id':(str(i)*64)} for i,r in enumerate(('app','pg','bao'),1)}}
  h=m.Host(spec,{});running={}
  old={v['id']:{'Id':v['id'],'State':{'Running':False},'HostConfig':{'RestartPolicy':{'Name':'no'}},'Mounts':[]} for v in spec['identities'].values()}
  h.inspect=lambda cid:{**old,**running}[cid]
  h.command=lambda a:'\n'.join(running)
  return h,spec,running
 def test_parent_child_and_symlink_mounts_refuse(self):
  with tempfile.TemporaryDirectory() as d:
   h,s,r=self.case(d);child=Path(s['stores']['dolt']['path'])/'child';child.mkdir();link=Path(d)/'alias';link.symlink_to(child)
   for path in (d,str(child),str(link)):
    cid='f'*64;r[cid]={'Id':cid,'Mounts':[{'Source':path,'RW':True}]}
    with self.assertRaisesRegex(ValueError,'overlapping'):h.assert_single_writer_sources(s)
 def test_readonly_overlap_allowed_but_old_restart_forbidden(self):
  with tempfile.TemporaryDirectory() as d:
   h,s,r=self.case(d);cid='f'*64;r[cid]={'Id':cid,'Mounts':[{'Source':d,'RW':False}]};h.assert_single_writer_sources(s)
   old=h.inspect(s['identities']['app']['id']);old['HostConfig']['RestartPolicy']['Name']='always'
   with self.assertRaisesRegex(ValueError,'restart'):h.assert_single_writer_sources(s)



class CompensatingClosure(unittest.TestCase):
 def test_missing_gates_recreated_then_tls_verified(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);h=m.Host({},{});observed=[]
   h.verify_closed_tls=lambda:observed.append(all((root/n).read_bytes() for n in ('MAINTENANCE','OPS-MAINTENANCE')))
   with patch.object(m,'GATE_ROOT',root),patch.object(m,'protected',side_effect=lambda p,*a:p),patch.object(m.os,'fchown'):
    h.close_access();(root/'MAINTENANCE').unlink();(root/'OPS-MAINTENANCE').unlink();h.close_access()
   self.assertEqual(observed,[True,True])
   self.assertTrue(all((root/n).stat().st_mode & 0o777==0o600 for n in ('MAINTENANCE','OPS-MAINTENANCE')))
 def test_tls_probe_requires_both_503_and_verify0(self):
  h=m.Host({},{});h.command=lambda a:'503 0';h.verify_closed_tls()
  for response in ('200 0','503 20','000 0'):
   h.command=lambda a:response
   with self.assertRaises(ValueError):h.verify_closed_tls()



class ArchiveEvidence(unittest.TestCase):
 def test_source_archive_exact_and_tamper_refuses(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);src=root/'data';src.mkdir();(src/'row').write_bytes(b'fictional-row');expected=m.inventory(src);archive=root/'archive.tar.gz'
   with tarfile.open(archive,'w:gz') as t:t.add(src,arcname='data')
   m.verify_archive(archive,expected);(src/'row').write_bytes(b'changed')
   with self.assertRaises(ValueError):m.verify_archive(archive,m.inventory(src))
 def test_each_capture_command_failure_never_starts_old_ids(self):
  for fail_at in range(1,13):
   with self.subTest(fail_at=fail_at),tempfile.TemporaryDirectory() as d:
    root=Path(d);backup=root/'backups';backup.mkdir();stores={r:{'path':str(root/r)} for r in ('dolt','pg','bao')}
    for v in stores.values():Path(v['path']).mkdir()
    spec={'engagement_id':'failure-tests','target':{},'stores':stores,'files':[],'identities':{r:{'id':r,'image_id':r} for r in ('app','pg','bao')}}
    h=m.Host(spec,{});h.backup=backup;h.locks=lambda:None;h.close_access=lambda:None;h.assert_single_writer_sources=lambda *a,**k:None
    running={r:True for r in ('app','pg','bao')};calls=[]
    h.inspect=lambda cid:{'Id':cid,'Image':cid,'State':{'Running':running[cid],'ExitCode':0,'OOMKilled':False}}
    def command(a):
     calls.append(a)
     if len(calls)==fail_at:raise TimeoutError('injected')
     if a[:2]==['docker','stop']:running[a[-1]]=False
     if a[0]=='tar' and '-czf' in a:
      with tarfile.open(a[a.index('-czf')+1],'w:gz') as t:t.add(Path(a[a.index('-C')+1])/a[-1],arcname=a[-1])
     return ''
    h.command=command
    with self.assertRaises(TimeoutError):h.capture_current_baseline(spec)
    self.assertFalse(any(a[:2]==['docker','start'] for a in calls))



class LockOwnership(unittest.TestCase):
 def test_actual_exclusive_descriptor_and_foreign_owner(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'lock';p.touch();owner=p.open('rb');fcntl.flock(owner,fcntl.LOCK_EX|fcntl.LOCK_NB)
   h=m.Host({}, {'journal':(str(p),owner.fileno()),'updater':(str(p),owner.fileno())})
   with patch.object(m,'protected',side_effect=lambda p,*a:Path(p)):h.locks()
   # A different fd referencing the same inode is not ownership proof.
   other=p.open('rb');h.lock_bindings={'journal':(str(p),other.fileno()),'updater':(str(p),other.fileno())}
   with patch.object(m,'protected',side_effect=lambda p,*a:Path(p)):
    with self.assertRaises(BlockingIOError):h.locks()
   other.close();owner.close()

class BoundedArchives(unittest.TestCase):
 def test_streaming_hash_never_unbounded_read(self):
  class Stream:
   def __init__(self):self.left=3000000
   def read(self,n):
    if n<=0 or n>1048576:raise AssertionError('unbounded read')
    take=min(n,self.left);self.left-=take;return b'x'*take
  self.assertEqual(m.stream_sha(Stream()),hashlib.sha256(b'x'*3000000).hexdigest())
 def test_archive_timeout_is_closed_error(self):
  with patch.object(m.subprocess,'run',side_effect=m.subprocess.TimeoutExpired(['tar'],3600)):
   with self.assertRaisesRegex(ValueError,'deadline'):m.run(['tar','-czf','private.partial','source'])
 def test_gate_source_binding_refused_before_gate_write(self):
  h=m.Host({},{});h.locks=lambda:None;h.close_access=lambda:self.fail('must refuse before replacing gate')
  with self.assertRaisesRegex(ValueError,'separate'):
   h.capture_current_baseline({'files':[{'path':str(m.GATE_ROOT/'MAINTENANCE')}]})

if __name__=='__main__':unittest.main()
