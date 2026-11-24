#!/usr/bin/env python3
import importlib.util,json,tempfile,pathlib,unittest,hashlib
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('h',str(__import__('pathlib').Path(__file__).with_name('closed-recovery-helper.py')));h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
class Tests(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory();self.addCleanup(self.t.cleanup);self.home=pathlib.Path(self.t.name);(self.home/'migrations').mkdir()
  self.files={'a.ts':h.digest(b'source')};checksum=h.digest(json.dumps(self.files,separators=(',',':')).encode())
  self.manifest=json.dumps({'format':1,'versions':[{'id':'0001','checksum':checksum,'files':self.files}]}).encode()
  self.ledger={'format':1,'entries':[{'id':'0001','checksum':checksum,'disposition':'adopted'}]}
  self.path=self.home/'migrations/journal.json';self.path.write_text(json.dumps(self.ledger))
  self.config={'image':'ghcr.io/manudss/iam-platform-poc@sha256:'+'a'*64,'imageID':'sha256:'+'b'*64,'ledgerSHA256':h.digest(self.path.read_bytes()),'manifestSHA256':h.digest(self.manifest),'offlineFileSHA256':{'/bundle':h.digest(b'good')},'implementationSHA256':'h','network':'test','helperSHA256':{'LYAM_CLOSED_PREFLIGHT':'h','LYAM_CLOSED_LAUNCHER':'h'}}
  self.args=type('A',(),{'image':self.config['image'],'env_file':'unused','data_dir':str(self.home)})()
  self.original={'/app/migration-source/data/migrations/manifest.json':self.manifest,'/bundle':b'good','/app/migration-source/a.ts':b'source'}
 def invoke(self):
  with patch.object(h,'envfile',return_value={'IAM_PG_URL':'postgres://user@pg:5432/db','IAM_BAO_ADDR':'http://bao:8200','LYAM_DOCKER_NETWORK':'test','LYAM_CLOSED_PREFLIGHT':'p','LYAM_CLOSED_LAUNCHER':'l'}),patch.object(h,'secure_code',return_value=type('C',(),{'read_bytes':lambda self:b'h'})()),patch.object(h,'digest',side_effect=lambda d:'h' if d==b'h' else hashlib.sha256(d).hexdigest()),patch.object(h,'companions'),patch.object(h,'image_inspect',return_value={'Id':'sha256:'+'b'*64,'Config':{'Labels':{'io.lyam.seed-modes':'auto never'}}}),patch.object(h,'image_files',side_effect=lambda image,paths:{p:self.original[p] for p in paths}):
   return h.preflight(self.args,self.config)
 def test_probe_positive_failures(self):
  expected={'pg':True,'bao':True,'host':False,'external':False,'dns':False,'ipv6':False}
  h.assert_probe_result(expected)
  for key in expected:
   bad={**expected,key:not expected[key]};self.assertRaises(ValueError,h.assert_probe_result,bad)
 def test_command_failure_sanitized(self):
  self.assertEqual(h.command_failure(['nsenter','-t','123','-n','ip6tables','private'],2,'private unknown option private'),'HELPER_COMMAND_FAILURE NS_IP6TABLES 2 UNKNOWN_OPTION')
  self.assertEqual(h.command_failure(['docker','exec','private'],1,'private'),'HELPER_COMMAND_FAILURE DOCKER_EXEC 1 UNCLASSIFIED')
 def test_matching(self):self.assertTrue(self.invoke()['preflight'])
 def test_changed_ledger(self):self.path.write_text(json.dumps(self.ledger,indent=2));self.assertRaises(ValueError,self.invoke)
 def test_changed_manifest(self):self.config['manifestSHA256']='0'*64;self.assertRaises(ValueError,self.invoke)
 def test_changed_image(self):self.config['imageID']='wrong';self.assertRaises(ValueError,self.invoke)
 def test_changed_bundle(self):self.original['/bundle']=b'bad';self.assertRaises(ValueError,self.invoke)
 def test_changed_migration_source(self):self.original['/app/migration-source/a.ts']=b'bad';self.assertRaises(ValueError,self.invoke)
 def test_wrong_format(self):
  self.ledger['format']=2;self.path.write_text(json.dumps(self.ledger));self.config['ledgerSHA256']=h.digest(self.path.read_bytes());self.assertRaises(ValueError,self.invoke)
 def test_pending(self):
  self.ledger['pending']={'id':'0002'};self.path.write_text(json.dumps(self.ledger));self.config['ledgerSHA256']=h.digest(self.path.read_bytes());self.assertRaises(ValueError,self.invoke)
 def test_unreviewed_inventory(self):self.config['offlineFileSHA256']={};self.assertRaises(ValueError,self.invoke)
 def test_migration_not_final(self):
  self.ledger['entries'][0]['disposition']='pending';self.path.write_text(json.dumps(self.ledger));self.config['ledgerSHA256']=h.digest(self.path.read_bytes());self.assertRaises(ValueError,self.invoke)
if __name__=='__main__':unittest.main()
