import importlib.util,os,subprocess,tempfile,unittest
from pathlib import Path
HERE=Path(__file__).parent.resolve();sp=importlib.util.spec_from_file_location('probe',HERE/'ssh-probe-filter.py');p=importlib.util.module_from_spec(sp);sp.loader.exec_module(p)
TRACE='''debug1: Connection established.
debug1: Remote protocol version 2.0, remote software version OpenSSH_9.6p1
debug1: Host 'private-host' is known and matches the ED25519 host key.
Authenticated to private-host ([192.0.2.3]:22) using "publickey".
debug2: channel 0: open confirm rwindow 0 rmax 32768
debug2: exec request accepted on channel 0
debug1: client_input_channel_req: channel 0 rtype exit-status reply 0
debug1: Exit status 0
'''
class Tests(unittest.TestCase):
 def test_real_shapes_and_silence(self):
  s=p.stages(TRACE);self.assertTrue(all(v is True for k,v in s.items() if k not in ['exec_refused','remote_exit_status']));self.assertEqual(s['remote_exit_status'],0);self.assertFalse(s['exec_refused'])
  self.assertFalse(any(v is True for v in p.stages('').values()));self.assertEqual(p.stages('')['remote_exit_status'],'unknown')
 def test_refusal_and_nonzero(self):
  s=p.stages(TRACE.replace('debug2: exec request accepted on channel 0','exec request failed on channel 0').replace('Exit status 0','Exit status 1'));self.assertTrue(s['exec_refused']);self.assertFalse(s['exec_accepted']);self.assertEqual(s['remote_exit_status'],1)
 def test_end_to_end_fixed_command_and_no_trace_disclosure(self):
  for rc in [0,1,255]:
   with self.subTest(rc=rc),tempfile.TemporaryDirectory() as d:
    d=Path(d);bin=d/'bin';bin.mkdir();(bin/'timeout').write_text('#!/bin/sh\nshift;exec "$@"\n');(bin/'ssh').write_text('#!/bin/bash\nprintf "%s\\n" "$@" > "$ARGS"\ncat > "$STDIN"\ncat "$TRACE" >&2\necho PRIVATE-DATA >&2\necho PRIVATE-DATA\nexit '+str(rc)+'\n')
    for f in bin.iterdir():f.chmod(0o700)
    trace=d/'trace';trace.write_text(TRACE);args=d/'args';stdin=d/'stdin';r=subprocess.run(['bash',str(HERE/'ssh-probe.sh')],env={**os.environ,'PATH':str(bin)+':'+os.environ['PATH'],'HOME':str(d),'OCI_SSH_USER':'private-user','OCI_SSH_HOST':'private-host','ARGS':str(args),'STDIN':str(stdin),'TRACE':str(trace)},text=True,capture_output=True)
    self.assertEqual(args.read_text().splitlines()[-1],'/usr/bin/true');self.assertEqual(stdin.read_bytes(),b'');self.assertNotIn('PRIVATE-DATA',r.stdout+r.stderr);self.assertNotIn('private-host',r.stdout+r.stderr);self.assertNotIn('192.0.2.3',r.stdout+r.stderr);self.assertEqual(r.returncode,0 if rc==0 else 1)
 def test_oversize_trace_stops_without_disclosure(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'trace';p.write_bytes(b'PRIVATE-TRACE-'*(1024*1024//14+2));out=Path(d)/'out';out.touch()
   r=subprocess.run(['python3',str(HERE/'ssh-probe-filter.py'),str(p),str(out),'0'],text=True,capture_output=True)
   self.assertNotEqual(r.returncode,0);self.assertIn('trace_complete=false',r.stdout);self.assertNotIn('command_succeeded=true',r.stdout);self.assertNotIn('PRIVATE-TRACE',r.stdout+r.stderr)
 def test_manual_workflow_is_bounded_and_separate(self):
  text=(HERE.parents[2]/'.github/workflows/oci-ssh-stage-probe.yml').read_text()
  self.assertIn('  workflow_dispatch:',text);self.assertNotIn('  pull_request:',text);self.assertNotIn('  push:',text);self.assertNotIn('inputs:',text);self.assertIn('timeout-minutes: 3',text);self.assertIn("github.ref == 'refs/heads/main'",text);self.assertEqual(text.count('run: bash deploy/oci/readonly-diagnostic/ssh-probe.sh'),1)
  for bad in ['host.sh','inventory.cjs','upload-artifact','ordered-queue','drain','StrictHostKeyChecking=no']:self.assertNotIn(bad,text)
if __name__=='__main__':unittest.main()
