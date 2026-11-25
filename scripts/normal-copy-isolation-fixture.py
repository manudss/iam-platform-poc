#!/usr/bin/env python3
"""Disposable synthetic copy, host egress fence callback before FIFO release.
Uses normal lifecycle fixture setup but only tests launcher callback/fence timing.
"""
import importlib.util,json,os,subprocess,sys
from pathlib import Path
p=Path(__file__).with_name('normal-lifecycle-real-fixture.py');s=importlib.util.spec_from_file_location('base_fixture',p);f=importlib.util.module_from_spec(s);s.loader.exec_module(f)
original_copy=f.shutil.copyfile
fences=[]

def copyfile(src,dst,*a,**kw):
 result=original_copy(src,dst,*a,**kw)
 if Path(src).name=='normal-lifecycle.py':
  # Fixture-only protected adapter: code written in disposable/root, not a source
  # replacement presented as the normal installed launcher. Callback is direct.
  with open(dst,'a') as out:out.write('''
_original_fixture_launch=launch
def launch(c,evidence,n):
 original=n.launch
 def fenced(config,callback):
  def close_before_effects(proof):
   x=__import__('json').loads(n.call(['docker','inspect',proof['container_id']]))[0]
   pid=str(x['State']['Pid'])
   # Explicit COPY-ONLY raw-table overlay blocks Docker embedded DNS before
   # Docker NAT can hand the query to its host-side resolver.
   for proto in ['udp','tcp']:
    n.call(['nsenter','-t',pid,'-n','iptables','-t','raw','-I','OUTPUT','1','-p',proto,'--dport','53','-j','DROP'])
   hosts="require('fs').appendFileSync('/etc/hosts',['','172.27.0.10 pg','172.27.0.11 bao',''].join(String.fromCharCode(10)))"
   n.call(['docker','exec',proof['container_id'],'node','-e',hosts])
   ips=[v['IPAddress'] for v in x['NetworkSettings']['Networks'].values()]
   for ip in ips:
    n.call(['iptables','-I','DOCKER-USER','1','-s',ip,'!','-d','172.27.0.0/24','-j','REJECT'])
    n.call(['iptables','-I','INPUT','1','-s',ip,'-j','REJECT'])
    __import__('sys').modules['__main__'].fences.append(ip)
   test="const n=require('net');let s=n.connect(443,'1.1.1.1');s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),2000)"
   n.call(['docker','exec',proof['container_id'],'node','-e',test])
   dns="require('dns').resolve4('fixture-blocked.example.com',e=>process.exit(e?0:1));setTimeout(()=>process.exit(0),2000)"
   n.call(['docker','exec',proof['container_id'],'node','-e',dns])
   raw=n.call(['nsenter','-t',pid,'-n','iptables','-t','raw','-nvx','-L','OUTPUT'])
   if not any(len(line.split())>2 and line.split()[2]=='DROP' and int(line.split()[0])>0 for line in raw.splitlines()):raise ValueError('DNS overlay counter missing')
   callback(proof)
  return original(config,close_before_effects)
 n.launch=fenced
 try:return _original_fixture_launch(c,evidence,n)
 finally:n.launch=original
''')
 return result
f.shutil.copyfile=copyfile
if __name__=='__main__':
 try:f.main()
 finally:
  for ip in fences:
   subprocess.run(['iptables','-D','DOCKER-USER','-s',ip,'!','-d','172.27.0.0/24','-j','REJECT'],check=True)
   subprocess.run(['iptables','-D','INPUT','-s',ip,'-j','REJECT'],check=True)
