import importlib.util,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('dispatch',Path(__file__).with_name('ci-dispatch.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_only_two_exact_commands(self):
  for cmd in ('','status','lyam-status;id','lyam-drain --state /tmp/x',' lyam-status','lyam-drain\n'):
   with self.assertRaises(ValueError):m.plan(cmd)
 def test_all_operational_paths_and_env_propagate(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'bin').mkdir();(root/'deploy-queue').mkdir()
   paths=Path(__file__).with_name('release-paths.py');(root/'bin/release-paths.py').write_bytes(paths.read_bytes())
   ps=importlib.util.spec_from_file_location('paths',paths);p=importlib.util.module_from_spec(ps);ps.loader.exec_module(p)
   env=p.plan(str(root),'app',str(root/'backups'),'/var/lib/fixture/MAINT','/var/lib/fixture/OPS')
   (root/'lyam.env').write_text(''.join(k+'='+v+'\n' for k,v in env.items()));(root/'lyam.env').chmod(0o600)
   for path in ('bin/ordered-queue.py','bin/update.sh','deploy-queue/state.json','.update.lock'):(root/path).touch()
   with patch.object(m,'protected',side_effect=lambda p:p):
    for command in ('lyam-status','lyam-drain'):
     args=m.plan(command,root);self.assertIn(str(root/'lyam.env'),args);self.assertIn(str(root/'bin/update.sh'),args);self.assertIn(str(root/'deploy-queue/state.json'),args)
    (root/'lyam.env').write_text((root/'lyam.env').read_text()+'LYAM_CONTAINER=duplicate\n')
    with self.assertRaises(ValueError):m.plan('lyam-drain',root)
 def test_forced_route_preserves_stdin_stdout_exit_and_cleans_environment(self):
  import os,sys,subprocess
  with tempfile.TemporaryDirectory() as d:
   script=Path(d)/'queue.py'
   script.write_text("import os,sys;data=sys.stdin.read();assert data=='qualified-plan\\n';assert os.environ.get('PATH')=='/usr/sbin:/usr/bin:/sbin:/bin';assert 'POISON' not in os.environ;print('exact-status-json');raise SystemExit(10)\n")
   with patch.dict(os.environ,{'SSH_ORIGINAL_COMMAND':'lyam-drain','POISON':'untrusted'}),patch.object(m.os,'geteuid',return_value=0),patch.object(m,'plan',return_value=[sys.executable,str(script)]),patch.object(m.subprocess,'run',wraps=subprocess.run) as called:
    # A real child receives the caller stdin unchanged. No text eval or shell.
    original=m.subprocess.run
    def execute(args,**kw):return subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=kw['env'],text=True)
    # Test the real subprocess contract directly and assert main does not override stdin.
    result=original([sys.executable,str(script)],input='qualified-plan\n',text=True,capture_output=True,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','HOME':'/root','LANG':'C.UTF-8'})
    self.assertEqual(result.returncode,10);self.assertEqual(result.stdout,'exact-status-json\n')
   with patch.dict(os.environ,{'SSH_ORIGINAL_COMMAND':'lyam-status'}),patch.object(m.os,'geteuid',return_value=0),patch.object(m,'plan',return_value=['python3','queue','status']) as planned,patch.object(m.subprocess,'run',return_value=type('R',(),{'returncode':10})()) as run:
    self.assertEqual(m.main(),10);planned.assert_called_once_with('lyam-status')
    self.assertNotIn('stdin',run.call_args.kwargs);self.assertNotIn('stdout',run.call_args.kwargs);self.assertNotIn('shell',run.call_args.kwargs)
 def test_nonroot_and_arbitrary_original_command_refuse(self):
  import os
  with patch.object(m.os,'geteuid',return_value=1000):
   with self.assertRaises(ValueError):m.main()
  with patch.object(m.os,'geteuid',return_value=0),patch.dict(os.environ,{'SSH_ORIGINAL_COMMAND':'id'}):
   with self.assertRaises(ValueError):m.main()
 def test_dispatch_plan_runs_real_packaged_queue_cli_status_and_malformed_drain(self):
  import subprocess,sys,json
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'bin').mkdir();(root/'deploy-queue').mkdir()
   for name in ['release-paths.py','ordered-queue.py']:(root/'bin'/name).write_bytes(Path(__file__).with_name(name).read_bytes())
   ps=importlib.util.spec_from_file_location('paths_real',root/'bin/release-paths.py');paths=importlib.util.module_from_spec(ps);ps.loader.exec_module(paths)
   env=paths.plan(str(root),'app',str(root/'backups'),'/var/lib/fixture/MAINT','/var/lib/fixture/OPS')
   (root/'lyam.env').write_text(''.join(k+'='+v+'\n' for k,v in env.items()));(root/'lyam.env').chmod(0o600)
   state=root/'deploy-queue/state.json';raw=json.dumps({'format':1,'history':[{'sha':'a'*40,'digest':'sha256:'+'b'*64}]});state.write_text(raw)
   (root/'.update.lock').touch();updater=root/'bin/update.sh';updater.write_text('#!/bin/sh\nexit 99\n');updater.chmod(0o700)
   with patch.object(m,'protected',side_effect=lambda p:p):
    result=subprocess.run(m.plan('lyam-status',root),capture_output=True,text=True)
    self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(result.stdout,'a'*40+'\n')
    result=subprocess.run(m.plan('lyam-drain',root),input='{}',capture_output=True,text=True)
    self.assertEqual(result.returncode,1,result.stderr);self.assertNotIn('unrecognized arguments',result.stderr);self.assertEqual(state.read_text(),raw)
    # A valid successor reaches the real queue deploy path and the fixed child.
    # Deliberate updater99 exercises refusal without claiming a real deployment.
    updater.write_text('#!/usr/bin/python3\nimport sys\nassert sys.argv[-2:]==["--env-file",'+repr(str(root/'lyam.env'))+']\nraise SystemExit(99)\n')
    successor={'format':1,'base':'a'*40,'entries':[{'parent':'a'*40,'sha':'c'*40,'digest':'sha256:'+'d'*64}]}
    result=subprocess.run(m.plan('lyam-drain',root),input=json.dumps(successor),capture_output=True,text=True)
    self.assertEqual(result.returncode,1,result.stderr)
    failed=json.loads(state.read_text());self.assertEqual(failed['failed']['exit'],99);self.assertEqual(len(failed['history']),1)
if __name__=='__main__':unittest.main()
