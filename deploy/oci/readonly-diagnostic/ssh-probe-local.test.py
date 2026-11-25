"""Real OpenSSH loopback only. No external hosts or account credentials. Fail rather than skip missing sshd."""
import getpass,os,socket,subprocess,tempfile,time,unittest
from pathlib import Path
HERE=Path(__file__).parent.resolve()
class LocalSSH(unittest.TestCase):
 def test_real_transport(self):
  with tempfile.TemporaryDirectory() as td:
   d=Path(td);home=d/'home';ssh=home/'.ssh';ssh.mkdir(parents=True);bin=d/'bin';bin.mkdir()
   for key in [d/'host',ssh/'oci_diag',d/'wrong']:
    subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(key)],check=True)
   pub=(ssh/'oci_diag.pub').read_text();(d/'authorized').write_text(pub)
   with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
   cfg=d/'sshd_config';cfg.write_text(f'Port {port}\nListenAddress 127.0.0.1\nHostKey {d}/host\nPidFile {d}/pid\nAuthorizedKeysFile {d}/authorized\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nPermitRootLogin yes\nLogLevel ERROR\n')
   hostpub=(d/'host.pub').read_text().split();known=ssh/'known_hosts_oci_diag';known.write_text(f'[127.0.0.1]:{port} {hostpub[0]} {hostpub[1]}\n')
   # Adapter adds only the random loopback port, preserving all production wrapper options and command.
   (bin/'ssh').write_text(f'#!/bin/sh\n/usr/bin/ssh -p {port} "$@" 2>"$LOCAL_TRACE"\nrc=$?\ncat "$LOCAL_TRACE" >&2\nexit $rc\n');(bin/'ssh').chmod(0o700)
   env={**os.environ,'HOME':str(home),'PATH':str(bin)+':'+os.environ['PATH'],'OCI_SSH_HOST':'127.0.0.1','OCI_SSH_USER':getpass.getuser(),'LOCAL_TRACE':str(d/'raw')}
   daemon=subprocess.Popen(['/usr/sbin/sshd','-D','-e','-f',str(cfg)],stderr=subprocess.PIPE)
   try:
    for _ in range(60):
     if daemon.poll() is not None:self.fail('loopback sshd startup failed: '+daemon.stderr.read().decode())
     try:
      with socket.create_connection(('127.0.0.1',port),timeout=.1):break
     except OSError:time.sleep(.05)
    def probe():
     r=subprocess.run(['bash',str(HERE/'ssh-probe.sh')],env=env,capture_output=True,text=True,timeout=15)
     self.assertEqual(r.stderr,'');self.assertNotIn('127.0.0.1',r.stdout);self.assertNotIn(hostpub[1],r.stdout)
     return r,dict(line.split('=',1) for line in r.stdout.splitlines())
    r,v=probe();self.assertIn(b'\r\n',(d/'raw').read_bytes());self.assertEqual(r.returncode,0,r.stdout);self.assertEqual(v['ssh_probe.command_succeeded'],'true')
    for stage in ['connection_established','server_identification','host_key_accepted','authentication_accepted','channel_open_confirmed','exec_accepted','exit_status_received']:
     self.assertEqual(v['ssh_probe.'+stage],'true',stage)
    # Forced-command nonzero: authentication/exec still succeed, remote exit does not.
    (d/'authorized').write_text('command="/usr/bin/false" '+pub)
    r,v=probe();self.assertEqual(r.returncode,1);self.assertEqual(v['ssh_probe.authentication_accepted'],'true');self.assertEqual(v['ssh_probe.exec_accepted'],'true');self.assertEqual(v['ssh_probe.remote_exit_status'],'1');self.assertEqual(v['ssh_probe.command_succeeded'],'false')
    (d/'authorized').write_text((d/'wrong.pub').read_text())
    r,v=probe();self.assertEqual(r.returncode,1);self.assertEqual(v['ssh_probe.connection_established'],'true');self.assertEqual(v['ssh_probe.authentication_accepted'],'false');self.assertEqual(v['ssh_probe.remote_exit_status'],'unknown')
    wrong=(d/'wrong.pub').read_text().split();known.write_text(f'[127.0.0.1]:{port} {wrong[0]} {wrong[1]}\n')
    r,v=probe();self.assertEqual(r.returncode,1);self.assertEqual(v['ssh_probe.host_key_accepted'],'false');self.assertEqual(v['ssh_probe.authentication_accepted'],'false')
   finally:daemon.terminate();daemon.wait(timeout=5);daemon.stderr.close()
if __name__=='__main__':unittest.main()
