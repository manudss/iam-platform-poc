#!/usr/bin/env python3
import ast,hashlib,importlib.util,json,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('v',Path(__file__).with_name('held-update-verdict.py'));v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
C={'sourceSHA':'a'*40,'runID':'123','attempt':'1'}
class Verdict(unittest.TestCase):
 def fixture(self,root):
  for shard,names in v.EXPECTED.items():
   f=Path(root)/('held-update-proof-'+shard);f.mkdir()
   e={'passed':True,'sha':'fixture-'+shard,'digest':'digest-'+shard,'heldUpdate':{'scenarioSelection':shard,'qualificationContext':C,'scenarios':{n:{} for n in names}}}
   (f/'execution-evidence.json').write_text(json.dumps(e))
   r={'passed':True,'sha':e['sha'],'digest':e['digest'],'scenario':'held-update','checks':{'heldUpdateChain':True},'cleanup':{'containersAbsent':True,'networkAbsent':True},'evidence':{'execution-evidence.json':hashlib.sha256((f/'execution-evidence.json').read_bytes()).hexdigest()}}
   (f/'delivery-receipt.json').write_text(json.dumps(r));(f/'held-progress.json').write_text(json.dumps({'scenario':sorted(names)[-1],'stage':'all-scenarios-complete','timeline':[{'stage':'after-child-wait','childState':'absent'}]}))
 def test_actual_scenario_partition_preserves_all_six_calls_and_assertions(self):
  source=Path(__file__).with_name('held-update-scenario.py').read_text();tree=ast.parse(source)
  assignment=next(n for n in ast.walk(tree) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='selections' for t in n.targets))
  selections=ast.literal_eval(assignment.value)
  for shard,names in v.EXPECTED.items():self.assertEqual({case[0] for case in selections[shard]},names)
  self.assertEqual(selections['clean'],[('one-clean',1),('three-clean',3)])
  self.assertEqual(selections['orphan'],[('one-orphan-updater',1,'closed-step-0-updater-spawned','orphan')])
  self.assertIn("if selected in {'all','interruptions'} and not any",source)
  self.assertIn("raise RuntimeError('no-measured-recovery')",source)
  workflow=Path(__file__).resolve().parents[1].joinpath('.github/workflows/held-update-harness.yml').read_text()
  self.assertIn('fail-fast: false',workflow);self.assertIn('shard: [clean, interruptions, orphan]',workflow)
  self.assertIn('if: always()',workflow);self.assertIn('HELD_JOBS_RESULT: ${{ needs.held_update_chain.result }}',workflow)
 def test_complete_independent_coverage(self):
  with tempfile.TemporaryDirectory() as t:self.fixture(t);self.assertTrue(v.verify(t,C,'success')['passed'])
 def test_missing_failed_skipped_cancelled_jobs_refused(self):
  for state in ('failure','skipped','cancelled',''):
   with self.subTest(state=state),tempfile.TemporaryDirectory() as t:self.fixture(t);self.assertFalse(v.verify(t,C,state)['passed'])
 def test_stale_context_missing_receipt_terminal_child_or_hash_refused(self):
  for mode in ('source','run','attempt','missing','terminal','child','hash','scenario','receipt-failed','cleanup'):
   with self.subTest(mode=mode),tempfile.TemporaryDirectory() as t:
    self.fixture(t);f=Path(t)/'held-update-proof-orphan';context=dict(C)
    if mode in ('source','run','attempt'):context[{'source':'sourceSHA','run':'runID','attempt':'attempt'}[mode]]='b'*40 if mode=='source' else '999'
    elif mode=='missing':(f/'delivery-receipt.json').unlink()
    elif mode in ('terminal','child'):
     p=f/'held-progress.json';d=json.loads(p.read_text());d['stage']='scenario-start' if mode=='terminal' else d['stage'];d['timeline']=[];p.write_text(json.dumps(d))
    elif mode in ('receipt-failed','cleanup'):
     p=f/'delivery-receipt.json';d=json.loads(p.read_text());d['passed']=False if mode=='receipt-failed' else True;d['cleanup']['containersAbsent']=False;p.write_text(json.dumps(d))
    else:
     p=f/'execution-evidence.json';d=json.loads(p.read_text());d['heldUpdate']['scenarios']={} if mode=='scenario' else d['heldUpdate']['scenarios'];p.write_text(json.dumps(d)+' ')
    self.assertFalse(v.verify(t,context,'success')['passed'])
if __name__=='__main__':unittest.main()
