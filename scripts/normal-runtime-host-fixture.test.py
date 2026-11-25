import argparse,hashlib,importlib.util,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
s=importlib.util.spec_from_file_location('hf',ROOT/'scripts/normal-runtime-host-fixture.py');h=importlib.util.module_from_spec(s);s.loader.exec_module(h)
class Tests(unittest.TestCase):
 def test_preflight_no_pull_no_writes_and_refuses_overlap_memory_or_inventory(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'spec';names=['scripts/normal-runtime-host-fixture.py','scripts/normal-runtime-docker-fixture.py','deploy/oci/normal-runtime.py'];spec={'format':1,'kind':'reviewed-host-pre-fifo-fixture','image':h.IMAGE,'source_sha':h.SOURCE,'files':{n:hashlib.sha256((ROOT/n).read_bytes()).hexdigest() for n in names},'out':'/root/normal-host-proof-0123456789abcdef.json'};p.write_text(json.dumps(spec));p.chmod(0o600);calls=[];overlap=[False]
   def docker(args,**kwargs):
    calls.append(args)
    self.assertNotIn('pull',args)
    if args[1]=='info':return json.dumps({'OSType':'linux','MemoryLimit':True,'PidsLimit':True})
    if args[1:3]==['network','ls']:return 'fixture-network\n'
    if args[1:3]==['network','inspect']:return json.dumps([{'IPAM':{'Config':[{'Subnet':'172.29.0.0/24' if overlap[0] else '172.18.0.0/16'}]}}])
    if args[1:3]==['image','inspect']:return json.dumps([{'RepoDigests':[h.IMAGE],'Config':{'Labels':{'org.opencontainers.image.revision':h.SOURCE}}}])
    raise AssertionError(args)
   real=Path.read_text;real_exists=Path.exists
   def read(path,*a,**kw):return 'MemAvailable: 2097152 kB\n' if str(path)=='/proc/meminfo' else real(path,*a,**kw)
   with patch.object(h,'protected',side_effect=lambda p:Path(p)),patch.object(h.os,'geteuid',return_value=0),patch.object(h.shutil,'disk_usage',return_value=type('Disk',(),{'free':3*1024**3})()),patch.object(h.subprocess,'check_output',side_effect=docker),patch.object(Path,'read_text',read),patch.object(Path,'exists',side_effect=None,autospec=True) as exists:
    exists.side_effect=lambda p:False if str(p).startswith('/root/normal-host-proof-') else real_exists(p)
    self.assertEqual(h.preflight(p)['image'],h.IMAGE)
    overlap[0]=True
    with self.assertRaisesRegex(ValueError,'overlap'):h.preflight(p)
    overlap[0]=False;spec['files']['deploy/oci/normal-runtime.py']='0'*64;p.write_text(json.dumps(spec))
    with self.assertRaisesRegex(ValueError,'code changed'):h.preflight(p)
 def test_github_guard_cannot_be_disabled_by_env_on_normal_entry(self):
  s=importlib.util.spec_from_file_location('fixture',ROOT/'scripts/normal-runtime-docker-fixture.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
  with patch.object(m.os,'geteuid',return_value=0),patch.dict(os.environ,{'GITHUB_ACTIONS':'false'}):
   with self.assertRaisesRegex(ValueError,'disposable hosted'):m.execute(argparse.Namespace())
if __name__=='__main__':unittest.main()
