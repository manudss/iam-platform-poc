#!/usr/bin/python3
import importlib.util,json,unittest,types
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('helper',str(__import__('pathlib').Path(__file__).with_name('closed-recovery-helper.py')));h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
class LaunchTests(unittest.TestCase):
 def go(self,fail=None):
  trace=[];rules={'iptables':[],'ip6tables':[]};pol={'iptables':'ACCEPT','ip6tables':'ACCEPT'};counts={'iptables':0,'ip6tables':0};probecount={};stopped=[];released=[];ipv6reads=[]
  c={'imageID':'imgid','network':'net','gateway':'172.21.0.1','hostProbePort':443,'externalProbeIP':'198.18.0.1','ipv6ProbeIP':'fd00::1'}
  a=types.SimpleNamespace(image='image',container='candidate',port=18080,data_dir='/data',env_file='/tmp/env')
  info={'Id':'cid','State':{'Running':True,'Pid':123},'HostConfig':{'RestartPolicy':{'Name':'no'},'CapAdd':None,'Privileged':False},'NetworkSettings':{'Networks':{'net':{'IPAddress':'172.21.0.4'}}}}
  def fake(args,**kwargs):
   trace.append(args)
   if args[:2]==['docker','run']:
    info.update(Image='imgid',Config={'Image':'image','Entrypoint':['sh'],'Cmd':['-c',args[-1]],'User':''},Mounts=[{'Destination':'/data','Source':'/data','RW':True}]);info['HostConfig'].update(CapDrop=['ALL'],SecurityOpt=['no-new-privileges:true'],PortBindings={'8080/tcp':[{'HostIp':'127.0.0.1','HostPort':'18080'}]});
    if fail=='identity':info['Image']='changed'
    return 'cid\n'
   if args[:2]==['docker','stop']:stopped.append(True);return ''
   if args[0]=='nsenter':
    tool=args[4]
    if tool=='/usr/bin/python3':counts['iptables']+=1;return ''
    op=args[5];rs=rules[tool]
    if op=='-P':pol[tool]=args[7];return ''
    if op=='-A':rs.append(args[7:]);return ''
    if op=='-I':rs.insert(0,args[8:]);return ''
    if op=='-D':rs.remove(args[7:]);return ''
    if op=='-S':
     if fail=='readback' and pol[tool]=='DROP':raise RuntimeError('bad readback')
     return '-P INPUT ACCEPT\n-P FORWARD ACCEPT\n-P OUTPUT '+pol[tool]+'\n'+''.join('-A OUTPUT '+' '.join(r)+'\n' for r in rs)
    if op=='-nvx':
     out=str(counts[tool])+' 0 REJECT all anywhere anywhere\n'
     for r in rs:
      if '--comment' in r:out+=str(probecount.get(r[r.index('--comment')+1],0))+' 0 all /* '+r[r.index('--comment')+1]+' */\n'
     return out
   if args[:3]==['docker','exec','cid']:
    if args[3]=='sh':released.append(True);return ''
    code=args[5]
    if 'ipv6/conf' in code:
     ipv6reads.append(True)
     return json.dumps({'interfaces':[{'name':'eth0','disabled':'0'}],'addresses':'','routes':'changed route' if fail=='ipv6-drift' and len(ipv6reads)>3 else ''})
    if 'CapEff' in code:return 'CapEff: 0000000000000000\nCapBnd: 0000000000000000\nNoNewPrivs: '+('0' if fail=='caps' else '1')+'\n'
    if 'createServer' in code:
     if fail!='own-counter':counts['iptables']+=1
     return json.dumps({'connected':fail=='own-connect'})
    tests=json.loads(args[6]);out={}
    for name,host,port in tests:
     allowed=name in ['pg','bao'];out[name]=allowed
     if name==fail:out[name]=not allowed
     if not allowed:
      tool='ip6tables' if name=='ipv6' else 'iptables';counts[tool]+=1
      if fail!='counter':probecount['lyam-probe-'+name]=probecount.get('lyam-probe-'+name,0)+1
    return json.dumps(out)
   if args[0]=='iptables-save' or args[0]=='ip6tables-save':return 'save'
   # nsenter iptables-save has no operation argument.
   raise AssertionError(args)
  def fake2(args,**kw):
   if args[0]=='nsenter' and args[4].endswith('-save'):
    trace.append(args);return 'save'
   return fake(args,**kw)
  try:
   with patch.object(h.time,'sleep'),patch.object(h,'preflight',return_value={'ok':True}),patch.object(h,'companions',return_value={'pg':('172.21.0.3',5432),'bao':('172.21.0.2',8200)}),patch.object(h,'inspect_exists',return_value=False),patch.object(h,'inspect',return_value=info),patch.object(h.os,'stat',return_value=types.SimpleNamespace(st_ino=111)),patch.object(h,'call',side_effect=fake2),patch.object(h.pathlib.Path,'is_file',return_value=True),patch.object(h,'envfile'):
    result=h.launch(a,c)
   if fail:self.fail('expected launch refusal for '+fail)
   return trace,stopped,released,result
  except AssertionError:raise
  except Exception as error:
   if fail=='ipv6-drift':self.assertEqual(str(error),'IPv6 state changed before release')
   if fail:
    self.assertTrue(stopped);self.assertFalse(released);return
   raise
 def test_ipv6_inactive_conditions(self):
  base={'interfaces':[{'name':'eth0','disabled':'1'}],'addresses':'addr lo','routes':'route lo'};self.assertTrue(h.ipv6_inactive(base))
  for change in [{'interfaces':[]},{'interfaces':[{'name':'eth0','disabled':'0'}]},{'addresses':'addr eth0'},{'routes':'route eth0'}]:self.assertFalse(h.ipv6_inactive({**base,**change}))
 def test_success_order_and_flags(self):
  trace,stop,release,result=self.go();self.assertFalse(stop);self.assertTrue(release)
  run=next(x for x in trace if x[:2]==['docker','run'])
  for flag in ['--restart','--cap-drop','--security-opt','--add-host']:self.assertIn(flag,run)
  self.assertIn('no',run);self.assertIn('ALL',run);self.assertIn('no-new-privileges:true',run)
  releaseidx=next(i for i,x in enumerate(trace) if x[:4]==['docker','exec','cid','sh'])
  self.assertTrue(all(i<releaseidx for i,x in enumerate(trace) if x[0]=='nsenter'))
 def test_positive_pg_failure(self):self.go('pg')
 def test_positive_bao_failure(self):self.go('bao')
 def test_external_allowed_failure(self):self.go('external')
 def test_caps_failure(self):self.go('caps')
 def test_readback_failure(self):self.go('readback')
 def test_identity_failure(self):self.go('identity')
 def test_counter_failure(self):self.go('counter')
 def test_own_connect_failure(self):self.go('own-connect')
 def test_own_counter_failure(self):self.go('own-counter')
 def test_ipv6_drift_before_release(self):self.go('ipv6-drift')
if __name__=='__main__':unittest.main()
