#!/usr/bin/env python3
"""Closed recovery helper. Preparation artifact, not installed or qualified on Docker.
Config: root-owned mode0600 JSON, passed as LYAM_CLOSED_CONFIG.
Modes selected by basename containing preflight, or --mode preflight/launch.
Preflight never starts an image. Launch never starts app until namespace probes pass.
"""
from urllib.parse import urlsplit
import argparse, hashlib, ipaddress, json, os, pathlib, re, shutil, stat, subprocess, tempfile, time

def assert_ownip_denied(result,before,after):
    if result!={'connected':False} or after<=before:raise ValueError('ownIP denial not established')

def command_failure(args,rc,stderr):
    # Finite diagnostic vocabulary only. Never echo arguments, endpoints or output.
    category='OTHER'
    if args[:2]==['docker','exec']:category='DOCKER_EXEC'
    elif args and args[0]=='nsenter':
        category={'iptables':'NS_IPTABLES','ip6tables':'NS_IP6TABLES','iptables-save':'NS_IPTABLES_SAVE','ip6tables-save':'NS_IP6TABLES_SAVE','/usr/bin/python3':'NS_PYTHON'}.get(args[4] if len(args)>4 else '', 'NS_OTHER')
    elif args and args[0]=='docker':category='DOCKER_OTHER'
    reason='UNCLASSIFIED'
    for needle,code in [('Permission denied','PERMISSION'),('Operation not permitted','PERMISSION'),('No chain/target/match','MISSING_MATCH'),('unknown option','UNKNOWN_OPTION'),('No route to host','NO_ROUTE'),('Network is unreachable','NO_ROUTE'),('Cannot find device','NO_DEVICE')]:
        if needle.lower() in stderr.lower():reason=code;break
    return 'HELPER_COMMAND_FAILURE '+category+' '+str(rc)+' '+reason

def call(args, *, data=None):
    p=subprocess.run(args,input=data,text=True,capture_output=True,timeout=60)
    if p.returncode: raise RuntimeError(command_failure(args,p.returncode,p.stderr))
    return p.stdout

def digest(data):return hashlib.sha256(data).hexdigest()
def secure_code(path):
    p=pathlib.Path(path).resolve(strict=True)
    for q in [p]+list(p.parents):
        st=q.stat()
        if st.st_uid!=0 or st.st_mode&0o022:raise ValueError('helper or ancestor is not root-owned immutable to non-root')
    return p

def secure(path):
    p=pathlib.Path(path);s=p.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_mode&0o077:raise ValueError('configuration must be root-owned private regular file')
    return p

def inspect(name):return json.loads(call(['docker','inspect',name]))[0]
def image_inspect(name):return json.loads(call(['docker','image','inspect',name]))[0]
def envfile(path):
    result={}
    for line in secure(path).read_text().splitlines():
        if not line or line.startswith('#'):continue
        k,sep,v=line.partition('=')
        if not sep or k in result:raise ValueError('malformed or duplicate environment field')
        result[k]=v
    if result.get('IAM_AUTOMATION_HOLD')!='1' or result.get('IAM_DEMO_SEED_MODE')!='never':raise ValueError('persistent explicit hold1/seednever required')
    if 'NODE_TLS_REJECT_UNAUTHORIZED' in result:raise ValueError('TLS override must be absent')
    return result

def companions(c):
    out={}
    for role,port in [('pg',5432),('bao',8200)]:
        x=inspect(c[role+'Container']);net=x['NetworkSettings']['Networks'][c['network']]
        ip=net['IPAddress'];ipaddress.IPv4Address(ip)
        if not x['State']['Running'] or ip!=c[role+'IP']:raise ValueError('companion identity/address changed')
        out[role]=(ip,port)
    return out

def image_files(image,paths):
    cid=call(['docker','create','--network','none','--entrypoint','/bin/true',image]).strip()
    try:
        result={}
        with tempfile.TemporaryDirectory(prefix='lyam-offline-') as d:
            os.chmod(d,0o700)
            for n,p in enumerate(paths):
                dest=pathlib.Path(d)/str(n);call(['docker','cp',cid+':'+p,str(dest)])
                if not dest.is_file() or dest.is_symlink():raise ValueError('offline image file not regular')
                result[p]=dest.read_bytes()
        return result
    finally:call(['docker','rm',cid])

def preflight(a,c):
    for key,family in [('gateway',4),('externalProbeIP',4),('ipv6ProbeIP',6)]:
        if ipaddress.ip_address(c[key]).version!=family:raise ValueError('probe address family differs from reviewed contract')
    settings=envfile(a.env_file);companions(c)
    for key,host,port in [('IAM_PG_URL','pg',5432),('IAM_BAO_ADDR','bao',8200)]:
        u=urlsplit(settings.get(key,''))
        if u.hostname!=host or u.port!=port:raise ValueError('application companion host/port differs from pinned hosts')
    if settings.get('LYAM_DOCKER_NETWORK')!=c['network']:raise ValueError('network differs from updater environment')
    implementation=secure_code(__file__)
    if digest(implementation.read_bytes())!=c['implementationSHA256']:raise ValueError('implementation digest differs from review')
    for key in ['LYAM_CLOSED_PREFLIGHT','LYAM_CLOSED_LAUNCHER']:
        code=secure_code(settings[key])
        if digest(code.read_bytes())!=c['helperSHA256'][key]:raise ValueError('helper digest differs from reviewed configuration')
    if not c.get('offlineFileSHA256') or not re.fullmatch(r'[0-9a-f]{64}',c.get('manifestSHA256','')):raise ValueError('reviewed offline inventory missing')
    im=image_inspect(a.image)
    if not re.fullmatch(r'ghcr\.io/manudss/iam-platform-poc@sha256:[0-9a-f]{64}',a.image) or a.image!=c['image'] or im['Id']!=c['imageID']:raise ValueError('exact reviewed image identity required')
    if 'never' not in im['Config'].get('Labels',{}).get('io.lyam.seed-modes','').split():raise ValueError('image lacks seednever label')
    ledger=pathlib.Path(a.data_dir)/'migrations/journal.json';raw=ledger.read_bytes()
    if digest(raw)!=c['ledgerSHA256']:raise ValueError('ledger changed from reviewed source')
    manifest_path='/app/migration-source/data/migrations/manifest.json'
    files=image_files(a.image,[manifest_path]+list(c['offlineFileSHA256']))
    if digest(files[manifest_path])!=c['manifestSHA256']:raise ValueError('manifest differs from reviewed exact image')
    manifest=json.loads(files[manifest_path]);journal=json.loads(raw)
    if manifest.get('format')!=1 or journal.get('format')!=1 or journal.get('pending'):raise ValueError('invalid format or pending migration')
    versions=manifest['versions'];entries=journal['entries']
    source_paths=['/app/migration-source/'+p for v in versions for p in v['files']]
    sources=image_files(a.image,source_paths)
    for v in versions:
        for p,h in v['files'].items():
            if p.startswith('/') or '..' in pathlib.PurePosixPath(p).parts or digest(sources['/app/migration-source/'+p])!=h:raise ValueError('migration source checksum mismatch')
        if digest(json.dumps(v['files'],separators=(',',':'),ensure_ascii=False).encode())!=v['checksum']:raise ValueError('manifest aggregate checksum mismatch')
    if [(v['id'],v['checksum']) for v in versions]!=[(e['id'],e['checksum']) for e in entries]:raise ValueError('pending/reordered/checksum-changed migrations prohibited')
    if any(e['disposition'] not in ['adopted','applied'] for e in entries):raise ValueError('migration disposition not final')
    for p,h in c['offlineFileSHA256'].items():
        if digest(files[p])!=h:raise ValueError('offline reviewed bundle/file differs')
    return {'preflight':True,'image':a.image,'imageID':im['Id'],'ledgerSHA256':digest(raw),'manifestSHA256':digest(files[manifest_path]),'helperSHA256':c['helperSHA256'],'implementationSHA256':c['implementationSHA256']}

PROBE="""const net=require('net');(async()=>{const r={};for(const [name,host,port]of JSON.parse(process.argv[1])){r[name]=await new Promise(resolve=>{const s=net.connect({host,port});s.setTimeout(1200);s.once('connect',()=>{s.destroy();resolve(true)});s.once('error',()=>resolve(false));s.once('timeout',()=>{s.destroy();resolve(false)})})}console.log(JSON.stringify(r))})().catch(()=>process.exit(1))"""
def ipv6_inactive(ipv6state):
    return bool(ipv6state['interfaces']) and all(x['disabled']=='1' for x in ipv6state['interfaces']) and all(l.split()[-1]=='lo' for l in ipv6state['addresses'].splitlines() if l.strip()) and all(l.split()[-1]=='lo' for l in ipv6state['routes'].splitlines() if l.strip())

def ipv6_shape(x):
    return {'interfaces':x['interfaces'],'addresses':sorted(x['addresses'].splitlines()),'routes':sorted(' '.join(l.split()[:5]+l.split()[-1:]) for l in x['routes'].splitlines())}

def verify_live(proof,c,a):
    x=inspect(a.container);pid=x['State']['Pid']
    if x['Id']!=proof['containerID'] or not x['State']['Running'] or os.stat('/proc/'+str(pid)+'/ns/net').st_ino!=proof['namespaceInode'] or x['Image']!=c['imageID']:raise ValueError('live identity changed')
    def ns(*args):return call(['nsenter','-t',str(pid),'-n',*args])
    if ns('iptables','-S')!=proof['policy4Exact'] or ns('ip6tables','-S')!=proof['policy6Exact']:raise ValueError('live policy changed')
    status=pathlib.Path('/proc/'+str(pid)+'/status').read_text()
    if not re.search(r'CapEff:\s+0+\b',status) or not re.search(r'CapBnd:\s+0+\b',status) or not re.search(r'NoNewPrivs:\s+1\b',status):raise ValueError('live PID1 capabilities changed')
    state=json.loads(call(['docker','exec',x['Id'],'node','-e',"const f=require('fs');const dirs=f.readdirSync('/proc/sys/net/ipv6/conf').filter(x=>!['all','default','lo'].includes(x));console.log(JSON.stringify({interfaces:dirs.map(name=>({name,disabled:f.readFileSync('/proc/sys/net/ipv6/conf/'+name+'/disable_ipv6','utf8').trim()})),addresses:f.readFileSync('/proc/net/if_inet6','utf8'),routes:f.readFileSync('/proc/net/ipv6_route','utf8')}))"]))
    if ipv6_shape(state)!=ipv6_shape(proof['ipv6State']) or ipv6_inactive(state)!=proof['ipv6DisabledProved']:raise ValueError('live IPv6 state changed')
    if inspect(a.container)['State']['Pid']!=pid:raise ValueError('live PID changed during verification')
    return {'liveVerified':True,'containerID':x['Id'],'namespaceInode':proof['namespaceInode'],'ipv6DisabledProved':proof['ipv6DisabledProved']}

def assert_probe_result(result):
    if result!={'pg':True,'bao':True,'host':False,'external':False,'dns':False,'ipv6':False}:raise ValueError('network probe mismatch')

def launch(a,c):
    proof=preflight(a,c);peers=companions(c)
    if inspect_exists(a.container):raise ValueError('candidate name must be absent; helper never removes previous container')
    # FIFO is recreated on EVERY container start, so docker stop/start cannot replay a release.
    gate='/tmp/lyam-closed-start.fifo'
    guard='set -eu; rm -f '+gate+'; mkfifo -m 600 '+gate+'; read -r permit < '+gate+'; [ "$permit" = start-held ]; rm -f '+gate+'; exec sh /app/demo/start.sh'
    cmd=['docker','run','-d','--name',a.container,'--restart','no','--cap-drop','ALL','--security-opt','no-new-privileges:true','--network',c['network'],'-p','127.0.0.1:'+str(a.port)+':8080','-v',a.data_dir+':/data','--env-file',a.env_file,'-e','IAM_AUTOMATION_HOLD=1','-e','IAM_DEMO_SEED_MODE=never','--entrypoint','sh']
    for role,(ip,_) in peers.items():cmd+=['--add-host',role+':'+ip]
    cmd += [a.image,'-c',guard]
    cid=call(cmd).strip()
    try:
        x=inspect(cid);pid=x['State']['Pid'];ns=os.stat('/proc/'+str(pid)+'/ns/net').st_ino
        def identity():
            now=inspect(cid)
            if now['Id']!=cid or now['State']['Pid']!=pid or not now['State']['Running'] or os.stat('/proc/'+str(pid)+'/ns/net').st_ino!=ns:raise ValueError('candidate namespace identity changed')
            hc=now['HostConfig'];cfg=now['Config']
            if now.get('Image')!=c['imageID'] or cfg.get('Image')!=a.image or cfg.get('Entrypoint')!=['sh'] or cfg.get('Cmd')!=['-c',guard] or cfg.get('User') not in ['', 'root','0']:raise ValueError('candidate image/command/user differs')
            if set(hc.get('CapDrop') or [])!={'ALL'} or not any(x in ['no-new-privileges','no-new-privileges:true'] for x in hc.get('SecurityOpt') or []):raise ValueError('runtime security differs')
            mounts=now.get('Mounts') or []
            if len(mounts)!=1 or mounts[0].get('Destination')!='/data' or mounts[0].get('Source')!=str(pathlib.Path(a.data_dir).resolve()) or not mounts[0].get('RW'):raise ValueError('candidate data mount differs')
            bindings=hc.get('PortBindings') or {}
            if bindings!={'8080/tcp':[{'HostIp':'127.0.0.1','HostPort':str(a.port)}]}:raise ValueError('candidate published ports differ')
            if now['HostConfig']['RestartPolicy']['Name']!='no' or now['HostConfig'].get('CapAdd') or now['HostConfig']['Privileged']:raise ValueError('unsafe runtime configuration')
        def nscmd(*args):identity();return call(['nsenter','-t',str(pid),'-n',*args])
        # Candidate is still only a FIFO reader. No application initialization has run.
        for tool in ['iptables','ip6tables']:
            if nscmd(tool,'-S').strip()!='-P INPUT ACCEPT\n-P FORWARD ACCEPT\n-P OUTPUT ACCEPT':raise ValueError('unexpected preexisting filter policy')
            nscmd(tool,'-P','OUTPUT','DROP')
            nscmd(tool,'-A','OUTPUT','-m','conntrack','--ctstate','ESTABLISHED','--ctdir','REPLY','-j','ACCEPT')
        nscmd('iptables','-A','OUTPUT','-o','lo','-d','127.0.0.1/32','-j','ACCEPT')
        nscmd('ip6tables','-A','OUTPUT','-o','lo','-d','::1/128','-j','ACCEPT')
        for ip,port in peers.values():nscmd('iptables','-A','OUTPUT','-d',ip,'-p','tcp','--dport',str(port),'-j','ACCEPT')
        for tool in ['iptables','ip6tables']:nscmd(tool,'-A','OUTPUT','-j','REJECT')
        rules4=nscmd('iptables-save');rules6=nscmd('ip6tables-save')
        exact4=nscmd('iptables','-S');exact6=nscmd('ip6tables','-S')
        status=call(['docker','exec',cid,'node','-e',"console.log(require('fs').readFileSync('/proc/1/status','utf8').split('\\n').filter(x=>/^(CapEff|CapBnd|NoNewPrivs):/.test(x)).join('\\n'))"])
        if not re.search(r'CapEff:\s+0+\b',status) or not re.search(r'CapBnd:\s+0+\b',status) or not re.search(r'NoNewPrivs:\s+1\b',status):raise ValueError('capability confinement missing')
        tests=[['pg','pg',5432],['bao','bao',8200],['host',c['gateway'],c['hostProbePort']],['external',c['externalProbeIP'],443],['dns','127.0.0.11',53],['ipv6',c['ipv6ProbeIP'],443]]
        # Counters prove denies were produced by OUR final REJECT, not absent destinations.
        def rejects(tool):
            raw=nscmd(tool,'-nvx','-L','OUTPUT');rows=[l.split() for l in raw.splitlines() if ' REJECT ' in l]
            if len(rows)!=1:raise ValueError('final REJECT counter ambiguous')
            return int(rows[0][0])
        def dedicated_probe(test):
            name,host,port=test;tool='ip6tables' if name=='ipv6' else 'iptables'
            rule=['-p','tcp','-m','conntrack','--ctorigdst',host,'--ctorigdstport',str(port),'-m','comment','--comment','lyam-probe-'+name]
            nscmd(tool,'-I','OUTPUT','1',*rule)
            try:
                before=rejects(tool)
                one=json.loads(call(['docker','exec',cid,'node','-e',PROBE,json.dumps([test])]))
                rows=[l.split() for l in nscmd(tool,'-nvx','-L','OUTPUT').splitlines() if 'lyam-probe-'+name in l]
                if len(rows)!=1 or int(rows[0][0])<1 or rejects(tool)<=before:raise ValueError('dedicated negative probe has no policy evidence')
                return one
            finally:nscmd(tool,'-D','OUTPUT',*rule)
        ipv6state=json.loads(call(['docker','exec',cid,'node','-e',"const f=require('fs');const dirs=f.readdirSync('/proc/sys/net/ipv6/conf').filter(x=>!['all','default','lo'].includes(x));console.log(JSON.stringify({interfaces:dirs.map(name=>({name,disabled:f.readFileSync('/proc/sys/net/ipv6/conf/'+name+'/disable_ipv6','utf8').trim()})),addresses:f.readFileSync('/proc/net/if_inet6','utf8'),routes:f.readFileSync('/proc/net/ipv6_route','utf8')}))"]))
        ipv6disabled=ipv6_inactive(ipv6state)
        for generation in range(3):
            result={}
            for test in tests:
                if test[0]=='ipv6' and ipv6disabled:
                    result['ipv6']=False;continue
                one=json.loads(call(['docker','exec',cid,'node','-e',PROBE,json.dumps([test])])) if test[0] in ['pg','bao'] else dedicated_probe(test)
                result.update(one)
            assert_probe_result(result)
        ownip=x['NetworkSettings']['Networks'][c['network']]['IPAddress']
        owncode="const n=require('net');let done=false,c;function finish(connected){if(done)return;done=true;if(c)c.destroy();s.close(()=>{console.log(JSON.stringify({connected}))})}let s=n.createServer(x=>x.destroy());s.on('error',()=>process.exit(3));s.listen(0,'0.0.0.0',()=>{c=n.connect(s.address().port,process.argv[1]);c.setTimeout(1000);c.on('connect',()=>finish(true));c.on('error',()=>finish(false));c.on('timeout',()=>finish(false))})"
        b=rejects('iptables');ownresult=json.loads(call(['docker','exec',cid,'node','-e',owncode,ownip]))
        assert_ownip_denied(ownresult,b,rejects('iptables'))
        socketprobe="import socket,sys; s=socket.socket(socket.AF_INET,int(sys.argv[1]),int(sys.argv[2])); payload=bytes.fromhex('0800f7fd00010001') if sys.argv[2]=='1' else b'fixture'; s.sendto(payload,(sys.argv[3],53))"
        for typ,proto in [('2','17'),('3','1')]:
            b=rejects('iptables')
            try:nscmd('/usr/bin/python3','-c',socketprobe,typ,proto,c['externalProbeIP'])
            except RuntimeError:pass
            if rejects('iptables')<=b:raise ValueError('UDP/ICMP rejection not established')
        identity()
        if not pathlib.Path(a.env_file).is_file():raise ValueError('environment disappeared')
        envfile(a.env_file)
        # Recheck companions and policy before authorizing the first application instruction.
        companions(c)
        if nscmd('iptables','-S')!=exact4 or nscmd('ip6tables','-S')!=exact6:raise ValueError('policy changed before release')
        call(['docker','exec',cid,'sh','-c','test -p '+gate+' && printf "%s\\n" start-held > '+gate])
        return {**proof,'launchedHeldCandidate':True,'containerID':cid,'namespaceInode':ns,'policy4':rules4,'policy6':rules6,'policy4Exact':exact4,'policy6Exact':exact6,'capabilityStatus':status,'ipv6DisabledProved':ipv6disabled,'ipv6State':ipv6state,'probes':result,'limitation':'Caller MUST verify real API held, TLS env and postcheck before closedqualified. No opening authorized.'}
    except BaseException:
        call(['docker','stop',cid]);raise

def extract_rules(saved):
    # iptables-save uses chain declarations; -S has policy statements. Normalize without counters/comments.
    lines=[]
    for l in saved.splitlines():
        if l.startswith(':'):
            name,policy,*_=l[1:].split();lines.append('-P '+name+' '+policy)
        elif l.startswith('-A '):lines.append(l)
    return '\n'.join(lines)+'\n'
def inspect_exists(name):return subprocess.run(['docker','inspect',name],stdout=subprocess.PIPE,stderr=subprocess.PIPE).returncode==0

def main():
    p=argparse.ArgumentParser();p.add_argument('--mode',choices=['preflight','launch','postcheck'],default='preflight' if 'preflight' in pathlib.Path(__file__).name else 'launch')
    for k in ['image','container','env-file','data-dir','port']:p.add_argument('--'+k,required=k not in ['container','port'])
    p.add_argument('--proof-file')
    a=p.parse_args()
    if os.geteuid()!=0:raise ValueError('root required')
    settings=envfile(a.env_file)
    configpath=os.environ.get('LYAM_CLOSED_CONFIG') or settings.get('LYAM_CLOSED_CONFIG')
    if not configpath:raise ValueError('LYAM_CLOSED_CONFIG required')
    c=json.loads(secure(configpath).read_text())
    if a.mode in ['launch','postcheck'] and (not a.container or not str(a.port).isdigit() or not 1024<=int(a.port)<=65535):raise ValueError('bad container/port')
    if not pathlib.Path(a.data_dir).is_absolute():raise ValueError('absolute data path required')
    if a.mode=='postcheck':
        if not a.proof_file:raise ValueError('private launch proof required')
        result=verify_live(json.loads(secure(a.proof_file).read_text()),c,a)
    else:result=preflight(a,c) if a.mode=='preflight' else launch(a,c)
    print(json.dumps(result,sort_keys=True))
if __name__=='__main__':main()
