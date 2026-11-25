import os,subprocess,tempfile,unittest
from pathlib import Path
HERE=Path(__file__).parent.resolve();SECRET='DO-NOT-PUBLISH-secret-783'
class Tests(unittest.TestCase):
 def invoke(self,mode):
  with tempfile.TemporaryDirectory() as d:
   d=Path(d);bin=d/'bin';bin.mkdir()
   # Execute exactly the real remote command as a local shell, preserving real stdin.
   ssh='#!/bin/bash\nwhile [ "$#" -gt 1 ]; do shift; done\nexec sh -c "$1"\n'
   sudo='#!/bin/sh\n[ "$1" = -n ] || exit 9\nshift\nexec "$@"\n'
   if mode=='denied':sudo='#!/bin/sh\necho "sudo: a password is required '+SECRET+'" >&2\nexit 1\n'
   if mode=='silent':ssh='#!/bin/sh\ncat >/dev/null\nexit 1\n'
   if mode=='hostile':ssh='#!/bin/sh\ncat >/dev/null\necho "'+SECRET+'"\necho "'+SECRET+'" >&2\nexit 1\n'
   # timeout wrapper stands in for remote payload, consumes host.sh via stdin.
   timeout='#!/bin/sh\nif [ "$1" = 60 ]; then shift; exec "$@"; fi\ncat > "${CAPTURE}"\nprintf "transport.host_enter=true\\ndiag.version=2\\ndiag.complete=true\\ndiag.problem_lines=0\\n"\n'
   if mode=='payloadfail':timeout=timeout.replace('printf "transport.host_enter', 'exit 1\nprintf "diag.version')
   if mode=='timeout':timeout=timeout.replace('cat >', 'exit 124\ncat >')
   for name,text in [('ssh',ssh),('sudo',sudo),('timeout',timeout)]:p=bin/name;p.write_text(text);p.chmod(0o700)
   cap=d/'capture';r=subprocess.run(['bash',str(HERE/'transport.sh'),'host'],env={**os.environ,'HOME':str(d),'PATH':str(bin)+':'+os.environ['PATH'],'OCI_SSH_USER':'fixture','OCI_SSH_HOST':'fixture','CAPTURE':str(cap)},text=True,capture_output=True)
   self.assertNotIn(SECRET,r.stdout+r.stderr)
   if mode=='ok':self.assertEqual(cap.read_bytes(),(HERE/'host.sh').read_bytes())
   return r
 def test_real_stdin_and_distinct_stages(self):
  r=self.invoke('ok');self.assertEqual(r.returncode,0,r.stdout+r.stderr)
  for token in ['remote_enter=true','sudo_enter=true','payload_exit=0','sudo_exit=0','complete=true']:self.assertIn(token,r.stdout)
 def test_failures_are_filtered_and_classified(self):
  for mode,token in [('denied','sudo_password_required'),('silent','transport.ssh_exit=1'),('payloadfail','payload_exit=1'),('timeout','payload_exit=124'),('hostile','filtered_lines=1')]:
   with self.subTest(mode=mode):r=self.invoke(mode);self.assertNotEqual(r.returncode,0);self.assertIn(token,r.stdout)
 def test_filter_rejects_untrusted_keys_and_values(self):
  for body in ['{"complete":true,"private":"'+SECRET+'"}', '{"complete":true,"dolt":{"unknown":"'+SECRET+'"}}']:
   with tempfile.TemporaryDirectory() as d:
    p=Path(d)/'out';p.write_text('transport.remote_enter=true\ntransport.sudo_enter=true\n'+body+'\ntransport.payload_exit=0\n');e=Path(d)/'err';e.touch()
    r=subprocess.run(['python3',str(HERE/'filter.py'),'inventory',str(p),str(e),'0'],text=True,capture_output=True);self.assertNotEqual(r.returncode,0);self.assertNotIn(SECRET,r.stdout+r.stderr)
 def test_host_public_schema(self):
  text='transport.remote_enter=true\ntransport.sudo_enter=true\ntransport.host_enter=true\ndiag.version=2\nhost.utc=2026-11-25T08:00:00Z\ncontainer.hold_env=1\ncontainer.api_hold_log=held=true,settingPresent=true\nfile..update.lock.present=true mtime=1795593600\njournal.last_delivered_digest=sha256:'+('a'*64)+'\n--- runtime\nnote.gate_paths=default (LYAM_FRONT_BARRIER_FILE/LYAM_OPS_BARRIER_FILE overrides not read)\ndiag.complete=true\ntransport.payload_exit=0\n'
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'out';p.write_text(text);e=Path(d)/'err';e.touch()
   r=subprocess.run(['python3',str(HERE/'filter.py'),'host',str(p),str(e),'0'],text=True,capture_output=True);self.assertEqual(r.returncode,0,r.stdout+r.stderr);self.assertIn('host_enter=true',r.stdout)
 def test_real_host_output_passes_filter_without_losing_parse_unknown(self):
  # Actual payload on this isolated local test host, no external connection.
  host=subprocess.run(['sh',str(HERE/'host.sh')],text=True,capture_output=True)
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'out';p.write_text('transport.remote_enter=true\ntransport.sudo_enter=true\n'+host.stdout+'\ntransport.payload_exit='+str(host.returncode)+'\n');e=Path(d)/'err';e.write_text(host.stderr)
   r=subprocess.run(['python3',str(HERE/'filter.py'),'host',str(p),str(e),str(host.returncode)],text=True,capture_output=True)
   self.assertIn('transport.filtered_lines=0',r.stdout,r.stdout+r.stderr)
   if 'journal.parse=unknown' in host.stdout:self.assertIn('journal.parse=unknown',r.stdout)
 def test_rejected_known_key_is_counted_without_value(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'out';p.write_text('container.running='+SECRET+'\n'+SECRET+'=private\n');e=Path(d)/'err';e.touch()
   r=subprocess.run(['python3',str(HERE/'filter.py'),'host',str(p),str(e),'1'],text=True,capture_output=True)
   self.assertNotIn(SECRET,r.stdout+r.stderr);self.assertIn('transport.rejected_key.container.running=1',r.stdout);self.assertIn('transport.rejected_key.other=1',r.stdout)
 def test_nested_inventory_schema(self):
  import json
  value={'inventory_version':3,'complete':True,'dolt':{'runs_by_status_test':{'waiting|test=false':2},'tasks_by_status_kind':{'open|kind=approval':1},'active_definitions_main_branch':{'rows':2,'graphs_with_block_category':{'mail':1},'trigger_kind':{'event':2},'note':'not published'}},'nats':{'consumers':{'by_plugin_allowlist':{'workflows-engine-base':{'consumers':1,'pending':0}},'totals':{'num_pending':0}}}}
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'out';p.write_text('transport.remote_enter=true\ntransport.sudo_enter=true\n'+json.dumps(value)+'\ntransport.payload_exit=0\n');e=Path(d)/'err';e.touch()
   r=subprocess.run(['python3',str(HERE/'filter.py'),'inventory',str(p),str(e),'0'],text=True,capture_output=True);self.assertEqual(r.returncode,0,r.stdout+r.stderr);self.assertNotIn('not published',r.stdout)
if __name__=='__main__' :unittest.main()
