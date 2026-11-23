import importlib.util,unittest,copy
from pathlib import Path
s=importlib.util.spec_from_file_location('v',Path(__file__).with_name('verify-activation161.py'));v=importlib.util.module_from_spec(s);s.loader.exec_module(v)
H=lambda n:format(n,'064x')
class Verify(unittest.TestCase):
 def setUp(self):
  self.b={'image':'old','policyHash':H(9),'dolt':['same'],'bao':{'key':'same'},'credentials':{'key':'same'},'postgres':{'schema':{'columns':[{'table_schema':'public','table_name':'activations','column_name':'error','ordinal_position':7,'data_type':'text','udt_name':'text','is_nullable':'YES','column_default':None,'datetime_precision':None}],'indexes':[],'constraints':[]},'rows':{'public.activations':{H(1):2,H(2):1},'public.other':{H(3):1}},'sequenceDefinitions':[],'sequences':{'public.seq':{'last_value':3,'is_called':True}}}}
  self.a=copy.deepcopy(self.b);self.a['image']=v.IMAGE;self.a['postgres']['rows']['public.activations']={H(4):2,H(5):1}
  for i,(name,typ)in enumerate(v.ADDED.items(),8):
   c=copy.deepcopy(self.b['postgres']['schema']['columns'][0]);c.update(column_name=name,ordinal_position=i,data_type=typ,udt_name='timestamptz' if name=='applied_at' else 'text',datetime_precision=6 if name=='applied_at' else None);self.a['postgres']['schema']['columns'].append(c)
  self.pin={'format':1,'image':v.IMAGE,'policyHash':H(9),'before_sha256':H(6),'after_sha256':H(7),'projection_sha256':H(8),'appendOnlyTables':['public.activations']}
  self.p={'format':1,'image':v.IMAGE,'before_sha256':H(6),'after_sha256':H(7),'removed_columns':list(v.ADDED),'legacy_projection':{H(1):2,H(2):1},'whole_rows':{H(4):2,H(5):1},'row_count':3,'nonnull_new_columns':0,'appendOnlyTables':['public.activations']}
 def check(self):return v.verify(self.b,self.a,self.p,self.pin,H(6),H(7),H(8))
 def test_exact_addition_and_multiplicities(self):self.assertTrue(self.check())
 def test_rejects_all_other_changes(self):
  cases=[lambda:self.a['postgres']['schema']['columns'].append({'extra':1}),lambda:self.a['postgres']['schema']['columns'][1].update(data_type='integer'),lambda:self.a['postgres']['schema']['columns'][1].update(is_nullable='NO'),lambda:self.a['postgres']['schema']['columns'][1].update(column_default='x'),lambda:self.p.update(nonnull_new_columns=1),lambda:self.p['legacy_projection'].update({H(1):1}),lambda:self.p['legacy_projection'].update({H(99):1}),lambda:self.a['postgres']['rows']['public.other'].update({H(99):1}),lambda:self.a['postgres']['sequences']['public.seq'].update(last_value=1),lambda:self.a.update(image='other'),lambda:self.pin.pop('before_sha256'),lambda:self.p.update(row_count=4),lambda:self.p['whole_rows'].update({H(4):1}),lambda:self.a['postgres']['schema']['constraints'].append({'new':1}),lambda:self.a.update(dolt=['changed']),lambda:self.a.update(bao={}),lambda:self.a.update(credentials={})]
  for mutate in cases:
   self.setUp();mutate()
   with self.subTest(mutation=mutate),self.assertRaises((ValueError,KeyError)):self.check()
 def test_no_pin_cannot_execute(self):
  import subprocess,sys,os
  env={k:x for k,x in os.environ.items() if k!='LYAM_ACTIVATION161_REVIEWED_PIN'};r=subprocess.run([sys.executable,str(Path(__file__).with_name('verify-activation161.py')),'none','none'],env=env,capture_output=True,text=True);self.assertEqual(r.returncode,1);self.assertNotIn('Traceback',r.stderr)
if __name__=='__main__':unittest.main()
