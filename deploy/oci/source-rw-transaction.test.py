import importlib.util,tempfile,unittest,copy
from pathlib import Path
s=importlib.util.spec_from_file_location('tx',Path(__file__).with_name('source-rw-transaction.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def plan():
 binding={'path':'/protected/file','sha256':'a'*64}
 p={'format':1,'kind':'source-rw-normal-transaction','engagement':'normal-e001','baseline':binding.copy(),'target':{'sha':'b'*40,'digest':'sha256:'+'c'*64},'old':{},'new':{},'stores':{r:'/protected/'+r for r in ('dolt','pg','bao')},'env':binding.copy(),'policy':binding.copy(),'runtime':binding.copy(),'code':{'module.py':'d'*64}}
 for i,(generation,role) in enumerate((g,r) for g in ('old','new') for r in ('app','pg','bao')):
  p[generation][role]={'name':generation+'-'+role,'id':str(i+1)*64,'image_id':'sha256:'+'e'*64}
 p['updater']={'container':p['new']['app']['name'],'runtime':p['runtime'],'target':p['target']}
 return p
class Journal:
 def __init__(self):self.events=[]
 def create(self,e):
  if self.events:raise ValueError('already exists')
  self.events.append(e)
 def append(self,e):self.events.append(e)
class Adapter:
 def __init__(self,j):self.j=j;self.calls=[]
 def __getattr__(self,name):
  def call(*a):self.calls.append(name)
  return call
 def permit(self,p,role):
  assert any(e.get('source_effects_committed') for e in self.j.events)
  assert self.j.events[-1]['phase']=='permit-intent'
  assert self.j.events[0]['plan']['new']['app']['id']
  self.calls.append('permit-'+role)
class Tests(unittest.TestCase):
 def test_all_ids_bound_before_companion_effect_and_order(self):
  j=Journal();a=Adapter(j);r=m.commit(plan(),a,j)
  self.assertTrue(r['requires_normal_qualification']);self.assertEqual([c for c in a.calls if c.startswith('permit-')],['permit-pg','permit-bao','permit-app'])
 def test_write_failure_never_permits(self):
  j=Journal();a=Adapter(j);j.append=lambda e:(_ for _ in ()).throw(OSError('fsync refused'))
  with self.assertRaises(OSError):m.commit(plan(),a,j)
  self.assertFalse(any(c.startswith('permit-') for c in a.calls));self.assertIn('close_on_failure',a.calls)
 def test_plan_change_refuses(self):
  j=Journal();a=Adapter(j);p=plan()
  def mutate(*args):p['new']['app']['id']='f'*64
  a.inspect_prepared=mutate
  with self.assertRaises(ValueError):m.commit(p,a,j)
  self.assertFalse(any(c.startswith('permit-') for c in a.calls))
 def test_permit_failure_does_not_retry_or_launch_app(self):
  j=Journal();a=Adapter(j)
  def fail(p,role):a.calls.append('failed-'+role);raise RuntimeError('ambiguous')
  a.permit=fail
  with self.assertRaises(RuntimeError):m.commit(plan(),a,j)
  self.assertEqual(a.calls.count('failed-pg'),1);self.assertNotIn('failed-bao',a.calls);self.assertNotIn('failed-app',a.calls)
 def test_each_role_check_immediately_precedes_intent_and_permit(self):
  j=Journal();a=Adapter(j);checks=[]
  a.check_permit=lambda p,r:checks.append((r,len(j.events)))
  m.commit(plan(),a,j)
  self.assertEqual([r for r,n in checks],['pg','bao','app'])
  self.assertTrue(all(j.events[n]['role']==r and j.events[n]['phase']=='permit-intent' for r,n in checks))
if __name__=='__main__':unittest.main()
