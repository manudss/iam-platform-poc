import copy,importlib.util,json,tempfile,unittest
from pathlib import Path
HERE=Path(__file__).parent

def load(name):
 s=importlib.util.spec_from_file_location(name,HERE/(name+'.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
m=load('dolt-migration-evidence');fixtures=load('qualification-dolt-piece-storage-verifier.test')
class Tests(unittest.TestCase):
 def pair(self):
  b=fixtures.snap();a=fixtures.good_after()
  return [{'format':1,'kind':'dolt-only-tables-v3','running':run,'dolt':s['dolt']} for run,s in [(False,b),(True,a)]]
 def anchors(self,x):return [{k:r[k] for k in ('database','branch','head','root')} for r in x['dolt']]
 def test_actual_verifier_consumes_adapter_files(self):
  b,a=self.pair();seen=[]
  def verify(bp,ap,c):
   self.assertEqual(bp.stat().st_mode&0o777,0o600);self.assertEqual(bp.parent.stat().st_mode&0o777,0o700);seen.append(bp);fixtures.v.verify(bp,ap,c)
  result=m.evaluate(b,a,self.anchors(b),self.anchors(a),verify)
  self.assertTrue(result['migration_only_verified']);self.assertFalse(result['restoration_admissible']);self.assertFalse(seen[0].exists())
 def test_mode_ref_and_duplicate_ref_refuse_before_verifier(self):
  b,a=self.pair()
  for mode in ('mode','anchor','duplicate'):
   bb=copy.deepcopy(b);anchor=self.anchors(b)
   if mode=='mode':bb['running']=True
   if mode=='anchor':anchor[0]['root']='wrong'
   if mode=='duplicate':anchor.append(anchor[0])
   with self.assertRaises(ValueError):m.evaluate(bb,a,anchor,self.anchors(a),lambda *args:self.fail('must not verify'))
 def test_real_verifier_refuses_non_migration_change(self):
  b,a=self.pair();a['dolt'][0]['tables'][0]['rows']+=1
  with self.assertRaises(fixtures.v.Refuse):m.evaluate(b,a,self.anchors(b),self.anchors(a),fixtures.v.verify)
if __name__=='__main__':unittest.main()
