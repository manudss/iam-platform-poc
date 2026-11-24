#!/usr/bin/env python3
import importlib.util,unittest
from pathlib import Path
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('fixture',Path(__file__).with_name('closed-helper-docker-fixture.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Diagnostic(unittest.TestCase):
 def test_fixed_categories_only(self):
  cases={'DISK_FULL':'no space left on device /private/path','RATE_LIMIT':'toomanyrequests private endpoint','PULL_ACCESS_DENIED':'pull access denied for secret/private-image','NAME_CONFLICT':'name secret is already in use by container 123','DAEMON_UNAVAILABLE':'Cannot connect to the Docker daemon at secret.sock','NETWORK':'request secret.example: i/o timeout','UNCLASSIFIED':'unknown secret credential'}
  for want,text in cases.items():
   with self.subTest(want=want):
    p=SimpleNamespace(returncode=1,stderr=text,stdout='sensitive-name');r=m.docker_setup_failure(['docker','run','--env','secret'],p)
    self.assertEqual(r,{'category':'DOCKER_RUN_SETUP','reason':want,'returnCode':1,'stdoutPresent':True,'stderrPresent':True})
 def test_other_command_never_inspected(self):
  p=SimpleNamespace(returncode=1,stderr='no space left on device',stdout='')
  for args in [[],['docker'],['docker','exec','private'],['python3','private']]:self.assertIsNone(m.docker_setup_failure(args,p))
 def test_no_output_unknown_and_original_rc_preserved(self):
  r=m.docker_setup_failure(['docker','run'],SimpleNamespace(returncode=125,stderr='',stdout=''));self.assertEqual(r['reason'],'UNCLASSIFIED');self.assertEqual(r['returnCode'],125);self.assertFalse(r['stderrPresent']);self.assertFalse(r['stdoutPresent'])
if __name__=='__main__':unittest.main()
