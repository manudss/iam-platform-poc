"""Execute the real epoch orchestrator with fixed-module/IO doubles, no host/app."""
import copy,hashlib,importlib.util,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
s=importlib.util.spec_from_file_location('epochflow',Path(__file__).with_name('restored-epoch-qualifier.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_actual_orchestrator_fresh_files_fixed_direct_check_and_no_admission(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);data=root/'data';data.mkdir();(data/'migrations').mkdir();(data/'migrations/journal.json').write_text('[1]');env=root/'env';env.write_text('LYAM_DATA_DIR='+str(data)+'\n');policy=root/'policy';auth=root/'auth';token=root/'token';source=root/'capture';auth.write_text('{}');token.write_text('fixture');source.write_text('synthetic capture');policy.write_text(json.dumps({'authFile':str(auth),'baoTokenFile':str(token),'appendOnlyTables':['public.decision_audit']}))
   runtime_path=Path(m.__file__).with_name('restored-runtime-check.py').absolute();capture_binding={'path':str(source),'sha256':hashlib.sha256(source.read_bytes()).hexdigest()}
   spec={'format':1,'kind':'fresh-restored-held-epoch','runtime_controller':{'path':str(runtime_path),'sha256':hashlib.sha256(runtime_path.read_bytes()).hexdigest()},'qualifier':{'path':str(source),'sha256':'a'*64},'capture':capture_binding,'auth':{'path':str(auth),'sha256':'fixture'},'bao_token':{'path':str(token),'sha256':'fixture'},'runtime':{'env':{'path':str(env)},'policy':{'path':str(policy)},'container':'held','target':{'sha':'a'*40,'digest':'sha256:'+'b'*64},'expected_container_id':'actual'},'evidence_dir':str(root/'evidence')}
   pg={'rows':{'public.activations':{'a':1},'public.decision_audit':{'b':1}},'schema':{},'sequences':{},'sequenceDefinitions':[]};calls=[];observed=[]
   class R:
    def read(self,b):p=Path(b['path']);return p,p.read_bytes()
    def locks(self,b):calls.append('locks')
    def verify(self,r,b):observed.append('direct');return {'container_id':'actual','local_tls':'checked'}
   class Q:
    CAPTURE_LOCK_FDS=()
    def held_running_baseline(self,container,image,evidence,policy_path,data_dir,locks,closed,binding,transport_coverage):
     closed();evidence.mkdir();prior={'dolt':[],'bao':{},'credentials':{},'postgres':copy.deepcopy(pg),'migrationLedger':[1],'image':image,'policyHash':hashlib.sha256(policy.read_bytes()).hexdigest(),'transportCoverage':transport_coverage,'kind':'held-running-baseline','epoch':'postrotation-current','originalPreservationReplaced':False};(evidence/'held-running-baseline.json').write_text(json.dumps(prior));closed()
    def cmd(self,args,stdin):
     calls.append(args[-1]);self_outer.assertEqual(self.CAPTURE_LOCK_FDS,(8,9))
     if args[-1]=='smoke':return json.dumps({'journal':{},'ledger':[1]})
     return json.dumps({'dolt':[],'bao':{}})
    def credential_hashes(self,*a):return {}
    def postgres(self,*a):return copy.deepcopy(pg)
    def exact_held_activations(self,b,a):self_outer.assertEqual(b['postgres']['rows']['public.activations'],a['postgres']['rows']['public.activations'])
    def compare(self,b,a,p):return []
    def private_json(self,p,v):p.write_text(json.dumps(v))
   self_outer=self;r=R();q=Q();actual=Path.lstat
   def ls(p):
    x=actual(p);return type('Stat',(),{'st_uid':0,'st_gid':0,'st_mode':x.st_mode&~0o022})()
   class Loader:
    def exec_module(self,module):module.read=r.read;module.locks=r.locks;module.verify=r.verify
   fake=type('Spec',(),{'loader':Loader()})()
   with patch.object(Path,'lstat',ls),patch.object(m.importlib.util,'spec_from_file_location',return_value=fake),patch.object(m.importlib.util,'module_from_spec',return_value=type('Runtime',(),{})()),patch.object(m,'load_fixed',return_value=q):
    result=m.execute(spec,{'journal':('j',8),'updater':('u',9)})
   self.assertEqual(calls.count('smoke'),1);self.assertEqual(calls.count('capture'),1);self.assertEqual(len(observed),3);self.assertFalse(result['restoration_admissible']);self.assertTrue(result['historical_tls_baseline_missing']);self.assertEqual(q.CAPTURE_LOCK_FDS,())
   self.assertTrue((root/'evidence/epoch-result.json').is_file());self.assertFalse((root/'evidence/before.json').exists())
if __name__=='__main__':unittest.main()
