#!/usr/bin/env python3
import ast,importlib.util,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('progress',Path(__file__).with_name('held-update-progress.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Progress(unittest.TestCase):
 def test_durable_bounded_progress_and_elapsed(self):
  with tempfile.TemporaryDirectory() as t:
   clock=iter([1,2,3,8]);p=m.Progress(t,lambda:next(clock));p.write('one-clean','scenario-start');p.write('one-clean','scenario-complete');v=p.write('one-orphan-updater','before-child-wait','alive','absent')
   self.assertEqual(v['elapsedSeconds'],7);self.assertEqual(v['scenarioElapsedSeconds'],6);self.assertEqual(v['sequence'],3)
   self.assertEqual(json.loads((Path(t)/'held-progress.json').read_text()),v);self.assertEqual(os.stat(Path(t)/'held-progress.json').st_mode&0o777,0o600);self.assertFalse((Path(t)/'held-progress.tmp').exists())
 def test_replace_failure_cleans_temp_and_next_publish_recovers(self):
  with tempfile.TemporaryDirectory() as t:
   p=m.Progress(t)
   with patch.object(m.os,'replace',side_effect=OSError('private')):p.safe('one-clean','scenario-start')
   self.assertFalse((Path(t)/'held-progress.tmp').exists())
   p.safe('one-clean','scenario-complete')
   self.assertEqual(json.loads((Path(t)/'held-progress.json').read_text())['diagnosticFailures'],1)
 def test_private_values_refused(self):
  with tempfile.TemporaryDirectory() as t:
   p=m.Progress(t)
   for args in [('private-path','scenario-start'),('one-clean','secret'),('one-clean','scenario-start','PID123'),('one-clean','scenario-start','alive','process-id')]:
    with self.assertRaises(ValueError):p.write(*args)
   self.assertFalse((Path(t)/'held-progress.json').exists())
 def test_actual_orphan_tail_continues_all_actions_at_each_write_failure(self):
  tree=ast.parse(Path(__file__).with_name('held-update-scenario.py').read_text())
  cases=[n for n in ast.walk(tree) if isinstance(n,ast.If) and isinstance(n.test,ast.Compare) and any(isinstance(x,ast.Constant) and x.value=='orphan' for x in n.test.comparators)]
  self.assertEqual(len(cases),1);body=cases[0].body
  start=next(i for i,n in enumerate(body) if isinstance(n,ast.Try));tail=body[start:]
  # Keep the actual finally plus subsequent waits and return, without replaying its main injection body.
  tail[0]=ast.Try(body=[ast.Pass()],handlers=[],orelse=[],finalbody=tail[0].finalbody)
  fn=ast.FunctionDef(name='tail',args=ast.arguments(posonlyargs=[],args=[],kwonlyargs=[],kw_defaults=[],defaults=[]),body=tail,decorator_list=[])
  code=compile(ast.fix_missing_locations(ast.Module(body=[fn],type_ignores=[])),'actual-orphan-tail','exec')
  stages=['before-continue','after-continue','before-worker-wait','after-worker-wait','before-child-wait','after-child-wait','scenario-complete']
  for bad in stages:
   with self.subTest(stage=bad),tempfile.TemporaryDirectory() as t:
    calls=[];p=m.Progress(t);original=p.write
    def writer(scenario,stage,*args):
     if stage==bad:raise OSError('write failed')
     return original(scenario,stage,*args)
    p.write=writer
    class DU:
     def state_of(self,ident):calls.append('child-scan');return 'absent' if 'continue' in calls else 'alive'
    class Worker:
     def wait(self,timeout):calls.append('worker-wait')
    class Stop:
     def set(self):calls.append('sampler-stop')
    class Sampler:
     stop=Stop()
     def join(self,timeout):calls.append('sampler-join')
    env={'progress':p,'name':'one-orphan-updater','du':DU(),'progress_du':type('PD',(),{'state_of':lambda self,i:'absent'})(),'progress_worker':{},'ident':{'pid':123},'os':type('OS',(),{'kill':lambda self,*args:calls.append('continue')})(),'signal':type('S',(),{'SIGCONT':18})(),'wk':Worker(),'time':type('T',(),{'monotonic':lambda self:0,'sleep':lambda self,t:None})(),'sampler':Sampler()}
    exec(code,env);env['tail']()
    self.assertIn('continue',calls);self.assertIn('worker-wait',calls);self.assertIn('sampler-stop',calls);self.assertIn('sampler-join',calls);self.assertGreaterEqual(calls.count('child-scan'),3);self.assertEqual(p.failures,1)
 def test_probe_failure_is_diagnostic_only_and_recorded_next_time(self):
  with tempfile.TemporaryDirectory() as t:
   p=m.Progress(t)
   def bad():raise OSError('private')
   p.safe('one-clean','scenario-start',bad)
   p.safe('one-clean','scenario-complete')
   self.assertEqual(json.loads((Path(t)/'held-progress.json').read_text())['diagnosticFailures'],1)
 def test_progress_is_whitelisted_for_always_artifact_upload(self):
  text=Path(__file__).resolve().parents[1].joinpath('.github/workflows/held-update-harness.yml').read_text()
  self.assertIn('if: always()',text);self.assertIn('/tmp/held-update-proof/held-progress.json',text)
if __name__=='__main__':unittest.main()
