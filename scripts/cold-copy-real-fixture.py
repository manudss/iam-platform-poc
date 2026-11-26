#!/usr/bin/env python3
"""Disposable REAL cold 3-store backup -> restore -> isolated replay fixture.
GitHub-hosted runner only. No production, no E5, no real provider.
Owner of this file: fixture only. It never edits deploy/oci modules.

Flow: seed real Dolt (app image), real Postgres, real file-backed Bao (non-dev,
initialised once, key JSON root 0600) -> stop cleanly -> cold tar archives (native
uid/gid) -> hash baseline -> actual cold-three-store-copy.Isolated.qualify() with
actual normal-runtime/normal-lifecycle/witness/qualification.py/isolated-capture.
Output: allowlisted JSON only (/tmp/cold-copy-real-proof.json). Never prints or
stores Bao keys/token/env/PG logs. Seeds are fictional.
Status of this file when written: NOT RUN. Syntax checked and helper units tested
without Docker only; the real proof is the GHA run.
"""
import ctypes,re,fcntl,hashlib,importlib.util,json,os,secrets,shutil,subprocess,sys,tarfile,threading,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path

IMAGE='ghcr.io/manudss/iam-platform-poc@sha256:81aeb18f91f8413d44508866ef7e06becbe4816aa2478869fbff0d33bdef0904'
SHA='276d32d3162c940d7744eca9432e8b914976539f'
DIGEST='sha256:81aeb18f91f8413d44508866ef7e06becbe4816aa2478869fbff0d33bdef0904'
PG_IMAGE='postgres@sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73'
BAO_IMAGE='openbao/openbao@sha256:71156a1c6623a5fa3f5e61b0c6a8ead0faf0df29a778339188443551995d1315'
COPIES=Path('/opt/lyam-qualification/copies')
FRONT_PORT=18089
APP_PORT=18088
BAO_HCL='ui = false\nstorage "pebbledb" {\n  path = "/bao/file"\n}\nlistener "tcp" {\n  address = "0.0.0.0:8200"\n  tls_disable = 1\n}\napi_addr = "http://127.0.0.1:8200"\n'
# Runs in a companion's network namespace through host Python (no tool needed in image).
HTTP_SRC=("import json,sys,time,urllib.request,urllib.error\n"
"a=json.loads(sys.stdin.buffer.read());h={'Content-Type':'application/json'}\n"
"if a.get('token'):h['X-Vault-Token']=a['token']\n"
"r=urllib.request.Request('http://127.0.0.1:8200'+a['path'],data=(json.dumps(a['body']).encode() if a.get('body') is not None else None),headers=h,method=a['method'])\n"
"out={'_status':0,'_err':'none'}\n"
"for i in range(60):\n"
" try:\n"
"  with urllib.request.urlopen(r,timeout=5) as x:\n"
"   raw=x.read().decode() or '{}';out={'_status':x.status,'data':json.loads(raw)};break\n"
" except urllib.error.HTTPError as e:\n"
"  out={'_status':e.code,'_err':'http'};break\n"
" except OSError as e:\n"
"  out={'_status':0,'_err':type(e).__name__}\n"
"  time.sleep(.5)\n"
"print(json.dumps(out))\n")

def run(args,input_bytes=None,timeout=300):
    """Bound subprocess. Failure never carries stdout/stderr (secrets, logs)."""
    r=subprocess.run(args,input=(input_bytes.encode() if isinstance(input_bytes,str) else input_bytes),capture_output=True,timeout=timeout)
    if r.returncode:
        stage=re.findall(rb'(?:QUALIFICATION_DIAG_V1|QUALIFICATION_STAGE_V1|CAPTURE_STAGE_V1):([a-zA-Z0-9/-]+)',r.stderr)[-2:]
        lines=re.findall(rb'CAPTURE_LINES_V1:([0-9,]{0,100})',r.stderr)[-1:]
        diagnostics=re.findall(rb'^(DOLT_ERROR_MASK_V1|DOLT_THREAD_FAILURE_V1|DOLT_QUERY_KIND_V1|QUALIFICATION_REASON_V1):(-?[0-9]{1,4})$',r.stderr,re.M)[-4:]
        preservation=[]
        for raw in re.findall(rb'^PRESERVATION_DIAG_V1 (\{[^\n]{1,1000}\})$',r.stderr,re.M)[-1:]:
            try:
                value=json.loads(raw);allowed={'dolt','bao','credentials','postgres-schema','postgres-tables','postgres-append-preservation','postgres-rows','postgres-sequences','postgres-sequence-rewind'}
                preservation=[v for v in value.get('categories',[]) if v in allowed]
            except (ValueError,TypeError):pass
        raise ValueError('preservation='+','.join(preservation)+' capture-lines='+','.join(x.decode() for x in lines)+' node-enums='+','.join(k.decode()+':'+v.decode() for k,v in diagnostics)+' fixture command refused: '+' '.join(args[:3])+' stages='+','.join(x.decode() for x in stage))
    return r.stdout.decode().strip()

def docker(*a,inp=None):return run(['docker',*a],inp)

def write_new(path,value,mode=0o600):
    raw=value if isinstance(value,bytes) else json.dumps(value,sort_keys=True).encode()
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
    d=os.open(Path(path).parent,os.O_RDONLY)
    try:os.fsync(d)
    finally:os.close(d)
    return hashlib.sha256(raw).hexdigest()

def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()

def tar_cold(src_parent,top,out):
    """Cold archive keeping numeric uid/gid and modes; regular files and dirs only."""
    with tarfile.open(out,'w:gz') as t:t.add(Path(src_parent)/top,arcname=top)
    Path(out).chmod(0o600)
    with tarfile.open(out,'r:gz') as t:
        for m in t.getmembers():
            if not (m.isreg() or m.isdir()):raise ValueError('cold archive contains non-regular member')

def load(path,name):
    s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def image_user(image,user):
    """Native uid/gid from the image itself, never assumed."""
    uid=int(docker('run','--rm','--entrypoint','id',image,'-u',user));gid=int(docker('run','--rm','--entrypoint','id',image,'-g',user))
    return uid,gid

def bao_call(pid,method,path,body=None,token=None,phase='bao',diag=None):
    """Allowlisted diag only: phase, HTTP status code, error class name. Never bodies."""
    payload=json.dumps({'method':method,'path':path,'body':body,'token':token}).encode()
    try:out=json.loads(run(['nsenter','-t',str(pid),'-n','/usr/bin/python3','-c',HTTP_SRC],payload))
    except ValueError:
        if diag is not None:diag.append({'phase':phase,'status':'nsenter-refused'})
        raise ValueError('bao nsenter refused at '+phase)
    if diag is not None:diag.append({'phase':phase,'status':out['_status'],'err':out.get('_err')})
    if not 200<=out['_status']<300:raise ValueError('bao http %s at %s'%(out['_status'],phase))
    return out['data']

def log_class(name):
    """Booleans only, computed in memory from container logs; log text never stored or printed."""
    try:
        r=subprocess.run(['docker','logs',name],capture_output=True,timeout=30);s=(r.stdout+r.stderr).decode('utf-8','replace').lower()
    except Exception:return {'logs':'unreadable'}
    keys={'permission_denied':'permission denied','read_only_fs':'read-only file system','mlock':'mlock','listener':'listener','address_in_use':'address already in use','hcl_syntax':'error parsing config','config_not_found':'no such file','storage':'storage','unknown_flag':'flag provided but not defined','chown':'chown','setcap_or_cap':'operation not permitted','missing_config_dir':'/openbao/config','exec_format':'exec format','cluster_addr':'cluster_addr','api_addr':'api_addr','empty':''}
    c={k:(v in s) for k,v in keys.items() if k!='empty'};c['empty']=not s.strip();c['lines']=min(s.count('\n'),999)
    return c

def state_diag(name):
    """Container state fields only (no logs)."""
    try:
        s=json.loads(docker('inspect',name))[0]['State']
        return {k:s.get(k) for k in ('Status','Running','ExitCode','Error','OOMKilled','Pid')}
    except Exception:return {'inspect':'failed'}

class Front(BaseHTTPRequestHandler):
    """Loopback maintenance front: always 503 (qualifier requires it in both phases)."""
    def do_GET(self):self.send_response(503);self.end_headers()
    def log_message(self,*a):pass

def main():
    if os.geteuid()!=0 or os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_ENVIRONMENT')!='github-hosted' or Path('/opt/lyam').exists() or Path('/opt/lyam-recovery').exists():
        raise ValueError('disposable github-hosted runner only')
    repo=Path(__file__).resolve().parents[1];oci=repo/'deploy/oci'
    eng='cf-'+secrets.token_hex(6)
    root=COPIES/eng;src=Path('/opt/lyam-qualification/fixture-src')/eng;arch=Path('/root')/('cold-archives-'+eng);codedir=Path('/opt/lyam-qualification/code')/eng
    result={'kind':'cold-three-store-copy-real-fixture','production_data_used':False,'passed':False,'stage':'setup','engagement':eng,'e5':False}
    owned=[];nets=[];front=None;lockf=None
    try:
        for p in [Path('/opt'),Path('/opt/lyam-qualification'),COPIES,src.parent,codedir.parent]:
            p.mkdir(parents=True,exist_ok=True);os.chown(p,0,0);p.chmod(0o755 if p==Path('/opt') else 0o700)
        for d in [src,arch,codedir]:d.mkdir(mode=0o700)
        for f in oci.iterdir():
            if f.is_file():shutil.copyfile(f,codedir/f.name)
        shutil.copyfile(oci/'coldcopy-runtime.py',codedir/'normal-runtime.py')
        os.chmod(codedir,0o755)
        for image in [IMAGE,PG_IMAGE,BAO_IMAGE]:docker('pull',image)
        iid={k:json.loads(docker('image','inspect',v))[0]['Id'] for k,v in [('app',IMAGE),('pg',PG_IMAGE),('bao',BAO_IMAGE)]}
        pg_uid,pg_gid=image_user(PG_IMAGE,'postgres');bao_uid,bao_gid=image_user(BAO_IMAGE,'openbao')
        revision=json.loads(docker('image','inspect',IMAGE))[0]['Config']['Labels'].get('org.opencontainers.image.revision')
        if revision!=SHA:raise ValueError('app image revision differs from reviewed sha')

        # ---------- seed three real stores ----------
        result['stage']='seed-network'
        seednet='lq-seed-'+eng;docker('network','create','--internal','--subnet','172.31.0.0/24',seednet);nets.append(seednet)
        (src/'data').mkdir(mode=0o700);(src/'pg-data').mkdir(mode=0o700);(src/'bao-storage').mkdir(mode=0o700)
        os.chown(src/'pg-data',pg_uid,pg_gid);os.chown(src/'bao-storage',bao_uid,bao_gid)
        hcl_seed=src/'bao.hcl';hcl_seed.write_text(BAO_HCL);hcl_seed.chmod(0o644)
        pg='lq-seed-'+eng+'-pg';bao='lq-seed-'+eng+'-bao';dolt='lq-seed-'+eng+'-dolt'
        safety=['--cap-drop','ALL','--security-opt','no-new-privileges:true','--sysctl','net.ipv6.conf.all.disable_ipv6=1','--sysctl','net.ipv6.conf.default.disable_ipv6=1','--restart','no']
        result['stage']='seed-pg'
        owned.append(pg);docker('run','-d',*safety,'--user',f'{pg_uid}:{pg_gid}','--name',pg,'--network',seednet,'-v',f'{src/"pg-data"}:/var/lib/postgresql/data','--tmpfs',f'/var/run/postgresql:uid={pg_uid},gid={pg_gid},mode=0755','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_USER=lyam','-e','POSTGRES_DB=lyam',PG_IMAGE)
        for _ in range(90):
            if subprocess.run(['docker','exec',pg,'pg_isready','-U','lyam'],capture_output=True,timeout=10).returncode==0:break
            time.sleep(1)
        else:raise ValueError('seed pg never ready')
        # pg_isready can observe initdb's temporary server before the entrypoint
        # shuts it down. Wait for the final postgres PID1, then execute once.
        for _ in range(90):
            ready=subprocess.run(['docker','exec',pg,'sh','-c','test "$(cat /proc/1/comm)" = postgres && pg_isready -U lyam'],capture_output=True,timeout=10)
            if ready.returncode==0:break
            time.sleep(1)
        else:raise ValueError('final pg server never ready')
        docker('exec',pg,'psql','-U','lyam','-d','lyam','-v','ON_ERROR_STOP=1','-c',"CREATE TABLE cold_fixture(id int primary key,v text);INSERT INTO cold_fixture VALUES(1,'fictional-pg-row');")
        result['stage']='seed-bao'
        owned.append(bao);docker('run','-d',*safety,'--user',f'{bao_uid}:{bao_gid}','--name',bao,'--network',seednet,'-v',f'{src/"bao-storage"}:/bao/file','-v',f'{hcl_seed}:/bao/config/bao.hcl:ro',BAO_IMAGE,'server','-config=/bao/config/bao.hcl')
        result['bao_diag']=bd=[];result['bao_state_after_start']=state_diag(bao);time.sleep(2);result['bao_state_t2']=state_diag(bao);result['bao_log_class_t2']=log_class(bao)
        pid=json.loads(docker('inspect',bao))[0]['State']['Pid']
        if not pid:result['bao_state_at_failure']=state_diag(bao);result['bao_log_class']=log_class(bao);raise ValueError('bao not running after start')
        init=bao_call(pid,'PUT','/v1/sys/init',{'secret_shares':1,'secret_threshold':1},phase='init',diag=bd)
        keys=init['keys_base64'];token=init['root_token']
        bao_call(pid,'PUT','/v1/sys/unseal',{'key':keys[0]},phase='unseal',diag=bd)
        bao_call(pid,'POST','/v1/sys/mounts/secret',{'type':'kv','options':{'version':'2'}},token,phase='mount',diag=bd)
        bao_call(pid,'POST','/v1/secret/data/iam/qualification',{'data':{'value':'fictional-bao-row'}},token,phase='kv',diag=bd)
        # Operator-shaped key file, never printed. Fictional root token only in this disposable fixture.
        root.mkdir(mode=0o700)
        keyfile=root/'unseal-keys.json'
        write_new(keyfile,{'unseal_keys_b64':keys,'unseal_threshold':1,'root_token':token})
        tokenfile=root/'bao-token';write_new(tokenfile,token.encode())
        del keys,init
        result['stage']='seed-dolt'
        # Seed the same PG-backed app mode used on replay, so startup creates
        # its own native tables BEFORE the preservation baseline is archived.
        for _ in range(90):
            if subprocess.run(['docker','exec',pg,'pg_isready','-U','lyam'],capture_output=True,timeout=10).returncode==0:break
            time.sleep(1)
        else:raise ValueError('seed pg restart never ready')
        owned.append(dolt);docker('run','-d','--name',dolt,'--network',seednet,'-e','IAM_PG_URL=postgres://lyam@'+pg+':5432/lyam','-e','IAM_BAO_ADDR=http://'+bao+':8200','-e','IAM_BAO_TOKEN='+token,'-e','IAM_DEMO_LOCAL_BAO=0','--memory','2048m','--pids-limit','256','-v',f'{src/"data"}:/data','-e','IAM_AUTOMATION_HOLD=1','-e','IAM_DEMO_SEED_MODE=auto',IMAGE)
        for _ in range(100):
            if subprocess.run(['docker','exec',dolt,'node','-e',"fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],capture_output=True,timeout=10).returncode==0:break
            if not json.loads(docker('inspect',dolt))[0]['State']['Running']:raise ValueError('seed app died')
            time.sleep(2)
        else:raise ValueError('seed app health timeout')
        # These services create tables lazily, not on health/startup. Exercise
        # their native initializers against fictional seed PG BEFORE archiving.
        seed_native=("const {ActivationService}=await import('/app/api/dist/activation/activation.service.js');"
                     "const {AuditService}=await import('/app/api/dist/access/audit.service.js');"
                     "const a=new ActivationService();await a.list('acme-demo');"
                     "const b=new AuditService();await b.list('acme-demo');"
                     "await a.onModuleDestroy();await b.onModuleDestroy();")
        docker('exec',dolt,'node','--input-type=module','-e',seed_native)
        # API health alone precedes SSR/edge startup. Wait until PID1 execs edge.
        for _ in range(120):
            ready=docker('exec',dolt,'node','-e',"const f=require('fs');console.log(f.readFileSync('/proc/1/cmdline','utf8').includes('/app/demo/server.mjs')?'edge':'starting')")
            if ready=='edge':break
            time.sleep(1)
        else:raise ValueError('seed edge never reached steady PID1')
        # Safe actual-image evidence before any shutdown experiment.
        inspection="""const f=require('fs'),c=require('crypto');const out={sourceHashes:{},processes:[]};for(const path of ['/app/demo/start.sh','/app/demo/server.mjs'])out.sourceHashes[path]=c.createHash('sha256').update(f.readFileSync(path)).digest('hex');for(const n of f.readdirSync('/proc').filter(x=>/^[0-9]+$/.test(x))){try{const cmd=f.readFileSync('/proc/'+n+'/cmdline','utf8').split('\\0').filter(Boolean),stat=f.readFileSync('/proc/'+n+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');let role='unknown';if(cmd.includes('/app/demo/server.mjs'))role='edge';else if(cmd.includes('sql-server'))role='dolt';else if(cmd.some(x=>x.endsWith('nats-server')))role='nats';else if(cmd.includes('/app/iam-core'))role='core';else if(cmd.includes('dist/main.js'))role='api';else if(cmd.includes('/app/demo/secret-store.mjs'))role='local-bao';else if(cmd.some(x=>x.endsWith('/bao')))role='local-bao-server';else if(cmd.some(x=>x.endsWith('/web/server/server.mjs')))role='ssr';else if(cmd[0]==='sh'||cmd[0]==='/bin/sh')role='shell';else if(cmd[0]==='sleep')role='sleep';else if(cmd.includes('-e'))role='inspection';out.processes.push({pid:+n,ppid:+fields[1],state:fields[0],start:fields[19],role});}catch{}}console.log(JSON.stringify(out))"""
        result['seed_process_profile']='external-bao-v1'
        result['actual_image_inspection']=json.loads(docker('exec',dolt,'node','-e',inspection))
        result['actual_nats_version']=docker('exec',dolt,'nats-server','-v').strip()
        expected_hashes={'/app/demo/start.sh':'a3e24bcb8d4983b4ba5a86f819d917be358aec587bc0c12adc9a2caa8359429d','/app/demo/server.mjs':'1c502ba4616c43c69b397bd33ba467a10568f8b99412f5fb9e018ceed5932c36'}
        result['actual_image_source_equivalence']=result['actual_image_inspection']['sourceHashes']==expected_hashes
        if not result['actual_image_source_equivalence']:raise ValueError('image source bytes differ from Git revision')
        sentinel_paths=['core-state/.cold-proof-sentinel','nats-js/.cold-proof-sentinel','migrations/.cold-proof-sentinel']
        for rel in sentinel_paths:
            (src/'data'/rel).write_bytes(('fictional-sentinel:'+rel).encode());(src/'data'/rel).chmod(0o600)
        # DEV-only exit-observation experiment, deliberately no backup claim.
        result['stage']='dev-process-exit-experiment'
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
        receipt={'kind':'DEV-writers-stopped-before-envelope','container_id':current['Id'],'image_id':current['Image'],'processes':scan_b,'exits':result['dev_exit_probe']['events'],'network':network,'pg_remote_clients':clients,'companion_exits':result['dev_companion_clean_exits'],'app_home_inventory_sha256':hashlib.sha256(json.dumps(app_before,sort_keys=True).encode()).hexdigest(),'inflight_unknown':True,'application_drain_claimed':False,'clean_exit_zero':False,'writers_quiesced':True,'at':time.time()}
        receipt_path=root/'dev-before-envelope.json';receipt_sha=write_new(receipt_path,receipt)
        if receipt_path.read_bytes()!=json.dumps(receipt,sort_keys=True).encode() or sha(receipt_path)!=receipt_sha:raise ValueError('durable receipt reread differs')
        final_process_check()
        checkpoint({'phase':'dev-envelope-kill-intent','id':current['Id'],'receipt_sha256':receipt_sha})
        docker('kill','--signal','KILL',current['Id'])
        envelope=json.loads(docker('inspect',current['Id']))[0]['State']
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
            result['seed_stopped_states']={role:{k:v for k,v in state_diag(name).items() if k in ('Running','ExitCode','OOMKilled','Status')} for role,name in [('app',dolt),('pg',pg),('bao',bao)]}
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


        # ---------- copy engagement ----------
        result['stage']='copy-setup'
        for d in ['effects','evidence','backup','qual']:(root/d).mkdir(mode=0o700)
        (root/'barrier').write_text('armed\n');(root/'barrier').chmod(0o600)
        hcl=root/'qual/bao.hcl';write_new(hcl,BAO_HCL.encode())
        auth=root/'qual/auth.json';write_new(auth,{'username':'demo-alice','password':'demo-only-not-a-secret'})
        be={'name':'lq-'+eng+'-be','subnet':'172.29.0.0/24'};fe={'name':'lq-'+eng+'-fe','subnet':'172.30.0.0/24'};ips={'pg':'172.29.0.10','bao':'172.29.0.11'}
        policy={'format':1,'isolatedCopy':True,'isolatedLoopbackTest':True,'requireAutomationHold':False,'origins':[f'http://127.0.0.1:{FRONT_PORT}'],'issuer':f'http://127.0.0.1:{FRONT_PORT}/core','tenant':'acme-demo','network':be['name'],'pgContainer':'lq-'+eng+'-pg','baoContainer':'lq-'+eng+'-bao','pgUser':'lyam','pgDatabase':'lyam','baoAddress':'http://'+ips['bao']+':8200','baoTokenFile':str(tokenfile),'baoMetadataRoots':['secret/metadata/iam'],'authFile':str(auth),'credentialFiles':['core-state/credentials.json','core-state/iam-poc-account-blocks.json','core-state/iam-poc-authn-enrollments.json','core-state/iam-poc-password-history.json'],'appendOnlyTables':['public.activations','public.decision_audit'],'transformationVerifiers':{}}
        policy_path=root/'qual/qualification.json';policy_sha=write_new(policy_path,policy)
        envmod=load(codedir/'isolated-copy-env.py','copyenv')
        source_env=('IAM_DEMO_SEED_MODE=never\nIAM_PG_URL=postgres://lyam@pg:5432/lyam\nIAM_BAO_ADDR=http://bao:8200\nIAM_BAO_TOKEN='+tokenfile.read_text()+'\nIAM_PUBLIC_ORIGIN=http://127.0.0.1:%d\n'%FRONT_PORT).encode()
        env_raw,delta=envmod.prepare(source_env,{'IAM_PG_URL':'postgres://lyam@pg:5432/lyam','IAM_BAO_ADDR':'http://bao:8200','IAM_BAO_TOKEN':tokenfile.read_text(),'IAM_PUBLIC_ORIGIN':f'http://127.0.0.1:{FRONT_PORT}'})
        env_path=root/'qual/normal.env';write_new(env_path,env_raw)
        env_binding={'path':str(env_path),'sha256':sha(env_path)}
        result['env_delta']=delta
        spec={'engagement_id':eng,'target':{'sha':SHA,'digest':DIGEST},
         'stores':{'dolt':{'path':str(src/'data'),'uid':dolt_stat.st_uid,'gid':dolt_stat.st_gid},'pg':{'path':str(src/'pg-data'),'uid':pg_uid,'gid':pg_gid},'bao':{'path':str(src/'bao-storage'),'uid':bao_uid,'gid':bao_gid}},
         'identities':{'app':{'name':dolt,'id':ids[dolt],'restart_count':0,'image_id':iid['app'],'image':IMAGE,'uid':dolt_stat.st_uid,'gid':dolt_stat.st_gid},
                       'pg':{'name':pg,'id':ids[pg],'restart_count':0,'image_id':iid['pg'],'image':PG_IMAGE,'uid':pg_uid,'gid':pg_gid},
                       'bao':{'name':bao,'id':ids[bao],'restart_count':0,'image_id':iid['bao'],'image':BAO_IMAGE,'uid':bao_uid,'gid':bao_gid}},
         'copy':{'backend':be,'frontend':fe,'ips':ips,'bao_hcl_copy':str(hcl),'unseal_key_binding':{'path':str(keyfile),'sha256':sha(keyfile)},'policy_binding':{'path':str(policy_path),'sha256':policy_sha},'migration_ledger_binding':ledger_binding,'port':APP_PORT,'public_probe':'1.1.1.1','tls_probe':'example.com','resources':{'memory_bytes':2147483648,'pids':256,'nano_cpus':1000000000}}}
        # seed network/containers are not needed any more; remove before the copy run
        for n in reversed(owned):docker('rm','-f','-v',n)
        owned.clear();docker('network','rm',seednet);nets.clear()
        shutil.rmtree(src)  # live-lead source stores removed: copy must run from archives only
        # ---------- run the actual modules ----------
        result['stage']='modules'
        cold=load(codedir/'cold-three-store-copy.py','coldcopy');n=load(codedir/'normal-runtime.py','normalruntime');l=load(codedir/'normal-lifecycle.py','normallifecycle');w=load(codedir/'isolated-copy-witness.py','copywitness')
        lock=root/'qual/update.lock';lock.touch(mode=0o600);lockf=lock.open('rb');fcntl.flock(lockf,fcntl.LOCK_EX|fcntl.LOCK_NB)
        n.LOCK_FDS=(lockf.fileno(),);n.LOCK_PATHS=(str(lock),)
        front=ThreadingHTTPServer(('127.0.0.1',FRONT_PORT),Front);threading.Thread(target=front.serve_forever,daemon=True).start()
        seq=[0]
        def before_effects(event):
            seq[0]+=1;write_new(root/'effects'/('%03d-%s.json'%(seq[0],event['phase'])),{k:v for k,v in event.items()})  # durable, O_EXCL, fsync
        q=cold.Qualification(run,codedir/'qualification.py',sha(codedir/'qualification.py'),str(policy_path),str(env_path),str(root/'barrier'),str(root/'backup'),str(root/'evidence'/'preservation'),IMAGE)
        iso=cold.Isolated(run,w,n,None)
        try:out=iso.qualify(baseline,spec,env_binding,q,before_effects,l,str(root/'normal-attempt-1.json'))
        except BaseException as error:
            result['module_steps']=iso.steps
            stages=['witness','counter','cleanup','private','policy','restore','network','companion','FIFO','placeholder','ledger','unseal','launcher','command refused','capture','postgres','tls-barriers','credentials','ledger-load','evidence-setup','policy-load','smoke']
            chain=[];seen=set();current=error
            while current is not None and id(current) not in seen and len(chain)<8:
                seen.add(id(current));message=str(current)
                chain.append({'type':type(current).__name__,'categories':[x for x in stages if x.lower() in message.lower()],'counter_missing':'not counted' in message or 'not reachable' in message,'foreign':'foreign' in message,'firewall_changed':'firewall-changed' in message,'rule_remains':'own-rule-remains' in message,'denied_role':re.findall(r'copy initiated denied traffic after permit: (pg|bao|app)',message),'counter_delta':re.findall(r'counter-delta=(\{[0-9, :\[\]a-z\"{}-]{0,300}\})',message),'preservation':re.findall(r'preservation=([a-z,-]{0,200})',message),'stages':re.findall(r'stages=([a-zA-Z0-9/,-]{0,160})',message),'node_enums':re.findall(r'(DOLT_ERROR_MASK_V1|DOLT_THREAD_FAILURE_V1|DOLT_QUERY_KIND_V1|QUALIFICATION_REASON_V1):(-?[0-9]{1,4})',message),'capture_lines':re.findall(r'capture-lines=([0-9,]{0,100})',message),'witness_reasons':[x for x in ('delete-own-hook','foreign-reference-or-chain-content','delete-own-chain','own-rule-remains','protected-firewall-changed') if x in message]})
                current=current.__cause__ or current.__context__
            result['module_failure_chain']=chain
            raise

        result.update(stage='completed',direct_execution=out['direct_execution'],baseline_bound=out['baseline']==baseline,historical_preservation_claimed=out['historical_preservation_claimed'],cleanup=out['cleanup'],retained_private_copy=out['retained_private_copy'],steps=out['steps'],probe={k:out['probe'][k] for k in ('phases','evidence_sha256','transport')},restored_members={r:v['members'] for r,v in out['restored'].items()},launch_proof_sha256=out['launch_proof_sha256'],guard=out['guard'])
        restored_home=Path(out['restored']['dolt']['path'])
        result['dev_restored_app_home_sentinels']=all((restored_home/rel).read_bytes()==('fictional-sentinel:'+rel).encode() for rel in sentinel_paths)
        if not result['dev_restored_app_home_sentinels']:raise ValueError('app_home sentinel restore differs')
        result['passed']=out['direct_execution'] is True and out['baseline']==baseline and out['cleanup']==[]
    finally:
        failures=[]
        if not result['passed'] and result['stage'].startswith('seed'):
            for k,n in (('pg_state',locals().get('pg')),('bao_state',locals().get('bao')),('dolt_state',locals().get('dolt'))):
                if n:result[k+'_at_failure']=state_diag(n)
        try:
            if front:front.shutdown();front.server_close()
        except Exception:failures.append('front')
        try:
            names=docker('ps','-a','--format','{{.Names}}').splitlines()
            owned.extend(x for x in names if x.startswith('lq-') and eng in x and x not in owned)
        except Exception:failures.append('enumeration')
        for x in reversed(owned):
            p=subprocess.run(['docker','rm','-f','-v',x],capture_output=True,timeout=30)
            if p.returncode and subprocess.run(['docker','inspect',x],capture_output=True,timeout=10).returncode==0:failures.append('container')
        try:
            names=docker('network','ls','--format','{{.Name}}').splitlines()
            nets.extend(x for x in names if eng in x and x not in nets)
        except Exception:failures.append('network-enumeration')
        for x in reversed(nets):
            if subprocess.run(['docker','network','rm',x],capture_output=True,timeout=20).returncode:failures.append('network')
        if lockf:lockf.close()
        # Retained copy secrets (copied keys, token, auth) are DEV-only; purge and prove absence.
        for d in (root,src,arch,codedir):
            shutil.rmtree(d,ignore_errors=True)
            if d.exists():failures.append('purge:'+d.name)
        result['fixture_purged']=not any(x.startswith('purge') for x in failures)
        result['cleanup_failures']=failures
        if failures:result['passed']=False
        Path('/tmp/cold-copy-real-proof.json').write_text(json.dumps(result,sort_keys=True,default=str))
    if not result['passed']:raise ValueError('cold copy real fixture refused')

if __name__=='__main__':
    try:main()
    except Exception as e:
        print('COLD_COPY_FIXTURE_DIAG:'+type(e).__name__+':'+str(e)[:120],file=sys.stderr);sys.exit(1)
