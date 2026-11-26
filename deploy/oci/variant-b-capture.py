#!/usr/bin/env python3
"""Fixed DEV B experiment adapter. Not installed production capture.
General clean-stop is not changed. Productors interrupted, not drained.
"""
import ctypes,fcntl,hashlib,json,os,re,shutil,tarfile,time
from pathlib import Path

def quiesce_archive(result,codedir,root,src,arch,eng,pg,bao,dolt,SHA,DIGEST,IMAGE,PG_IMAGE,BAO_IMAGE,iid,write_new,sha,load,docker,run):
 if os.geteuid()!=0 or os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_ENVIRONMENT')!='github-hosted' or Path('/opt/lyam-recovery').exists():raise ValueError('DEV runner only')
 # DEV-only exit-observation experiment, deliberately no backup claim.
 result['stage']='dev-process-exit-experiment'
 original_inspect=json.loads(docker('inspect',dolt))[0]
 if original_inspect['HostConfig']['RestartPolicy']['Name']!='no':raise ValueError('restart policy must be no before any signal')
 original_restart_count=original_inspect['RestartCount']
 probe=load(codedir/'dev-process-exit-probe.py','dev_exit_probe')
 probe_events=[]
 evidence=root/'dev-exit-events';evidence.mkdir(mode=0o700)
 def checkpoint(event):
     write_new(evidence/('%03d.json'%len(probe_events)),event);probe_events.append(event)
 try:
     current=json.loads(docker('inspect',dolt))[0]
     result['dev_exit_probe']=probe.experiment(current['State']['Pid'],checkpoint)
     # Independent network observation in the same app namespace.
     network_probe="""import json;from pathlib import Path
out={}
for name in ('tcp','tcp6'):
 rows=[v.split() for v in Path('/proc/net/'+name).read_text().splitlines()[1:]];out[name]={'established':sum(v[3]=='01' for v in rows),'listeners':[int(v[1].split(':')[1],16) for v in rows if v[3]=='0A']}
print(json.dumps(out,sort_keys=True))"""
     network=json.loads(run(['nsenter','-t',str(current['State']['Pid']),'-n','/usr/bin/python3','-c',network_probe]))
     result['dev_network_after_store_exits']=network
     if any(v['established'] or any(port in (3000,4000,3307,4222,8081) for port in v['listeners']) for v in network.values()):raise ValueError('active store connection/listener remains')
     # Bind every residual TCP listener: exact edge8080 or embedded
     # Docker DNS address whose translated port is visible in NAT.
     nat=run(['nsenter','-t',str(current['State']['Pid']),'-n','iptables','-t','nat','-S'])
     listeners=[]
     for line in Path('/proc',str(current['State']['Pid']),'net/tcp').read_text().splitlines()[1:]:
         fields=line.split()
         if fields[3]!='0A':continue
         address,port=fields[1].split(':');port=int(port,16)
         if port==8080 and address=='00000000':listeners.append({'role':'frozen-edge','port':port});continue
         if address=='0B00007F' and ('--to-destination 127.0.0.11:'+str(port)) in nat:listeners.append({'role':'docker-embedded-dns-nat-bound','port':port});continue
         raise ValueError('unbound residual listener')
     if Path('/proc',str(current['State']['Pid']),'net/tcp6').read_text().count(' 0A '):raise ValueError('unexpected IPv6 listener')
     result['dev_residual_listeners_bound']=listeners
     checkpoint({'phase':'dev-network-store-quiet','observation':network,'residual_listeners':listeners})
     clients=int(docker('exec',pg,'psql','-X','-A','-t','-U','lyam','-d','lyam','-c',"SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend' AND client_addr IS NOT NULL"))
     result['dev_pg_remaining_remote_clients']=clients
     if clients:raise ValueError('PG remote client remains')
     checkpoint({'phase':'dev-pg-no-app-clients','count':clients})
     nats_log=(src/'data/nats.log').read_text()
     result['dev_nats_shutdown_log_confirmed']='Server Exiting' in nats_log
     if not result['dev_nats_shutdown_log_confirmed']:raise ValueError('NATS shutdown marker absent')
     result['dev_companion_clean_exits']={}
     for role,name in [('pg',pg),('bao',bao)]:
         checkpoint({'phase':'dev-companion-stop-intent','role':role,'id':json.loads(docker('inspect',name))[0]['Id']})
         docker('stop','-t','60',name)
         state=json.loads(docker('inspect',name))[0]['State']
         value={k:state[k] for k in ('Running','ExitCode','OOMKilled')};result['dev_companion_clean_exits'][role]=value
         if value!={'Running':False,'ExitCode':0,'OOMKilled':False}:raise ValueError('DEV companion clean exit refused')
         checkpoint({'phase':'dev-companion-clean-exit','role':role,'state':value})
     result['dev_all_store_processes_exited']=True
     checkpoint({'phase':'dev-all-store-processes-exited','application_drain_claimed':False,'inflight_business_operations':'unknown','envelope_terminated':False})
 except BaseException as error:
     result['dev_exit_error_type']=type(error).__name__
     if str(error).startswith('unknown process in external-bao-v1: '):
         result['dev_exit_unknown_identity']=json.loads(str(error).split(': ',1)[1])
     result['dev_exit_error_categories']=[v for v in ('unknown process','roles absent','parent','changed','deadline','not zero','cgroup','count') if v in str(error)]
     result['dev_exit_events']=probe_events
     raise
 # Explicit DEV variant B: all checks precede any envelope termination.
 result['stage']='dev-variant-b-envelope'
 hostmod=load(codedir/'current-baseline-host.py','capture_host')
 original_records=result['dev_exit_probe']['records']
 def final_process_check():
     current_ids=set()
     group=Path('/proc',str(current['State']['Pid']),'cgroup').read_text().splitlines()
     path=[v.split(':',2)[2] for v in group if v.startswith('0::')][0]
     cg=Path('/sys/fs/cgroup')/path.lstrip('/')
     for f in [cg/'cgroup.procs',*cg.rglob('cgroup.procs')]:current_ids.update(int(v) for v in f.read_text().split())
     # Linux cgroup.procs may omit zombies, but no unbound live task may appear.
     if not current_ids.issubset(set(original_records)):raise ValueError('new process before envelope intent')
     for pid,record in original_records.items():
         now=probe.stat(pid)
         expected='T' if record['role'] in ('edge','supervisor') else 'Z'
         if now['start']!=record['start'] or now['state']!=expected:raise ValueError('process identity/state changed before envelope')
     return {'live_cgroup_ids':sorted(current_ids),'records':original_records,'cgroup_path':str(cg)}
 scan_a=final_process_check();time.sleep(.1);scan_b=final_process_check()
 if scan_a!=scan_b:raise ValueError('no fixed final process set')
 # Flush each mounted filesystem, no claim of business multi-store atomicity.
 libc=ctypes.CDLL(None,use_errno=True)
 for directory in (src/'data',src/'pg-data',src/'bao-storage'):
     fd=os.open(directory,os.O_RDONLY)
     try:
         if libc.syncfs(fd)!=0:raise OSError(ctypes.get_errno(),'syncfs refused')
     finally:os.close(fd)
 app_before=hostmod.inventory(src/'data')
 receipt={'code_commit':os.environ.get('GITHUB_SHA'),'probe_module_sha256':sha(codedir/'dev-process-exit-probe.py'),'host_module_sha256':sha(codedir/'current-baseline-host.py'),'module_sha256':LOADED_SHA256,'restart_policy':'no','restart_count':original_restart_count,'app_home':str(src/'data'),'kind':'DEV-writers-stopped-before-envelope','container_id':current['Id'],'image_id':current['Image'],'processes':scan_b,'exits':result['dev_exit_probe']['events'],'network':network,'pg_remote_clients':clients,'companion_exits':result['dev_companion_clean_exits'],'app_home_inventory_sha256':hashlib.sha256(json.dumps(app_before,sort_keys=True).encode()).hexdigest(),'inflight_unknown':True,'application_drain_claimed':False,'clean_exit_zero':False,'writers_quiesced':True,'at':time.time()}
 result['dev_variant_b_receipt']=receipt
 receipt_path=root/'dev-before-envelope.json';receipt_sha=write_new(receipt_path,receipt)
 if receipt_path.read_bytes()!=json.dumps(receipt,sort_keys=True).encode() or sha(receipt_path)!=receipt_sha:raise ValueError('durable receipt reread differs')
 final_process_check()
 latest=json.loads(docker('inspect',dolt))[0]
 if latest['Id']!=original_inspect['Id'] or latest['HostConfig']['RestartPolicy']['Name']!='no' or latest['RestartCount']!=original_restart_count:raise ValueError('restart identity moved before envelope')
 checkpoint({'phase':'dev-envelope-kill-intent','id':current['Id'],'receipt_sha256':receipt_sha})
 docker('kill','--signal','KILL',current['Id'])
 envelope=json.loads(docker('inspect',current['Id']))[0]['State']
 result['dev_restart_count_after_envelope']=json.loads(docker('inspect',current['Id']))[0]['RestartCount']
 if result['dev_restart_count_after_envelope']!=original_restart_count:raise ValueError('restart count changed after envelope')
 result['dev_envelope_exit']={k:envelope[k] for k in ('Running','ExitCode','OOMKilled')}
 if result['dev_envelope_exit']!={'Running':False,'ExitCode':137,'OOMKilled':False}:raise ValueError('unexpected envelope exit')
 if any(int(v) for f in Path(scan_b['cgroup_path']).rglob('cgroup.procs') for v in f.read_text().split()):raise ValueError('cgroup not empty after envelope')
 app_after=hostmod.inventory(src/'data')
 result['dev_app_home_identical_after_envelope']=app_before==app_after
 if app_before!=app_after:raise ValueError('app home bytes changed after envelope')
 lock_path=src/'data/.boot.lock';lock_stat=lock_path.stat();boot_lock=lock_path.open('rb');fcntl.flock(boot_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 if (os.fstat(boot_lock.fileno()).st_dev,os.fstat(boot_lock.fileno()).st_ino)!=(lock_stat.st_dev,lock_stat.st_ino):raise ValueError('boot lock inode changed')
 result['dev_variant_b_receipt_sha256']=receipt_sha
 result['dev_boot_lock_same_inode_held']=True

 # Execute the HOST capture adapter itself on actual fictional stores.
 # Locks are real; fixed host TLS/gates are NOT tested on this runner.
 result['stage']='host-capture'
 dolt_stat=(src/'data').lstat()
 ids={n:json.loads(docker('inspect',n))[0]['Id'] for n in (pg,bao,dolt)}
 hostmod=load(codedir/'current-baseline-host.py','capture_host')
 capture_spec={'engagement_id':eng,'target':{'sha':SHA,'digest':DIGEST},'identities':{
   role:{'id':json.loads(docker('inspect',name))[0]['Id'],'name':name,'image_id':iid[role]} for role,name in [('app',dolt),('pg',pg),('bao',bao)]},
   'stores':{'dolt':{'path':str(src/'data')},'pg':{'path':str(src/'pg-data')},'bao':{'path':str(src/'bao-storage')}},'files':[]}
 handles=[];bindings={}
 for role in ('journal','updater'):
     lp=Path('/root')/(eng+'-'+role+'.lock');lp.touch(mode=0o600);fh=lp.open('rb');fcntl.flock(fh,fcntl.LOCK_EX|fcntl.LOCK_NB);handles.append(fh);bindings[role]=(str(lp),fh.fileno())
 capture=hostmod.Host(capture_spec,bindings);capture.backup=arch
 capture.close_access=lambda:None  # NOT proof of production TLS/gates.
 try:
     capture.assert_single_writer_sources(capture_spec)
     folder=arch/('current-baseline-'+eng);folder.mkdir(mode=0o700)
     checkpoints=folder/'checkpoints';checkpoints.mkdir(mode=0o700)
     baseline=capture.archive_stopped_sources(capture_spec,folder,checkpoints)
 except BaseException as error:
     result['host_capture_error_type']=type(error).__name__
     result['host_capture_error_categories']=[v for v in ('lock','stop cleanly','overlapping','restart','space','archive','source changed','permission') if v in str(error)]
     result['seed_stopped_states']={role:{k:v for k,v in json.loads(docker('inspect',name))[0]['State'].items() if k in ('Running','ExitCode','OOMKilled','Status')} for role,name in [('app',dolt),('pg',pg),('bao',bao)]}
     raise
 finally:
     for fh in handles:fh.close()
     boot_lock.close()
 result['host_archive_stage_actual']=True;result['host_capture_actual']=False;result['host_gates_tested']=False;result['dev_variant_b_capture_actual']=True
 result['host_capture_checkpoint']=bool(list(arch.glob('current-baseline-*/capture-complete.json')))
 ledger=src/'data'/'migrations'/'journal.json'
 ledger_binding={'present':ledger.is_file(),'sha256':(sha(ledger) if ledger.is_file() else None)}
 result['migration_ledger_present']=ledger_binding['present']
 archives=baseline['archives']
 # Verify PG clean cluster state from an independent archive extraction,
 # never run pg_controldata or Dolt tools on original source directories.
 pg_control_root=root/'pg-control-copy';pg_control_root.mkdir(mode=0o700)
 with tarfile.open(archives['pg']['path'],'r:gz') as t:t.extractall(pg_control_root,filter='data')
 control=docker('run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--entrypoint','pg_controldata','-v',str(pg_control_root/'pg-data')+':/verify:ro',PG_IMAGE,'/verify')
 result['dev_pg_copy_control_shut_down']=bool(re.search(r'Database cluster state:\s+shut down\s*$',control,re.M))
 if not result['dev_pg_copy_control_shut_down']:raise ValueError('PG copy control not shut down')
 shutil.rmtree(pg_control_root)


 return baseline,ledger_binding,archives
