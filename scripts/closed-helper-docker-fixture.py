#!/usr/bin/env python3
"""Real Docker CI fixture. ROOT, disposable runner only. Never invoke on production.
Requires exact pushed GHCR digest, helper and both wrappers as input files.
Creates only prefixed disposable containers/network and private synthetic bind data.
Runs complete unmodified helper, then checks real AppModule held and policy stable.
"""
import argparse,ast,hashlib,ipaddress,json,os,pathlib,re,shutil,subprocess,tempfile,time

COMMAND_DIAGNOSTIC={}
HELPER_ERRORS=set()
def failure_code(stderr):
 # Only exact exception literals from the reviewed helper source may be emitted.
 for line in reversed(stderr.splitlines()):
  if line in HELPER_ERRORS:return line
 return 'unclassified-subprocess-failure'

def failure_details(stderr):
 # Traceback paths, source text, arguments and exception messages remain private.
 # Only line numbers for this known helper basename and a fixed type can leave.
 frames=[int(n) for n in re.findall(r'File "[^"\n]*/closed-recovery-helper\.py", line ([0-9]{1,6}), in [A-Za-z_][A-Za-z_0-9]*',stderr)]
 types=re.findall(r'^(ValueError|RuntimeError|TimeoutExpired|FileNotFoundError|PermissionError|KeyError|IndexError|TypeError|AttributeError|JSONDecodeError|subprocess\.TimeoutExpired):',stderr,re.M)
 result={'reason':failure_code(stderr),'helperLineNumbers':frames[-12:],'exceptionType':types[-1].split('.')[-1] if types else 'unclassified'}
 code=re.search(r'^RuntimeError: HELPER_COMMAND_FAILURE (OTHER|DOCKER_EXEC|DOCKER_OTHER|NS_IPTABLES|NS_IP6TABLES|NS_IPTABLES_SAVE|NS_IP6TABLES_SAVE|NS_PYTHON|NS_OTHER) (-?[0-9]{1,4}) (UNCLASSIFIED|PERMISSION|MISSING_MATCH|UNKNOWN_OPTION|NO_ROUTE|NO_DEVICE)$',stderr,re.M)
 if code:result['commandFailure']={'category':code[1],'returnCode':int(code[2]),'reason':code[3]}
 return result

def a_delivery_command(args):
 return len(args)>1 and args[0]=='python3' and pathlib.Path(args[1]).name=='delivery-docker-integration.py'

def call(args,check=True):
 p=subprocess.run(args,text=True,capture_output=True,timeout=1200 if a_delivery_command(args) else 300)
 if check and p.returncode:
  COMMAND_DIAGNOSTIC.update(returnCode=p.returncode,**failure_details(p.stderr))
  raise RuntimeError('fixture command failed: '+args[0]+' '+args[1]+' (private output withheld)')
 return p

def d(*args):return call(['docker',*args]).stdout

def sha(b):return hashlib.sha256(b).hexdigest()
def inspect(name):return json.loads(d('inspect',name))[0]
def wait(name,port,path,seconds=220):
 for _ in range(seconds//2):
  p=call(['docker','exec',name,'node','-e',"fetch('http://127.0.0.1:"+str(port)+path+"').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],False)
  if p.returncode==0:return
  if not inspect(name)['State']['Running']:raise RuntimeError('fixture process died')
  time.sleep(2)
 raise RuntimeError('fixture health timeout')
def node_app_process(argv):
 return bool(argv) and pathlib.PurePosixPath(argv[0]).name=='node' and any(x in ['dist/main.js','/app/api/dist/main.js'] for x in argv[1:])

def ipv4_gateway(ipam):
 gateways=[x['Gateway'] for x in ipam if x.get('Gateway') and ipaddress.ip_address(x['Gateway']).version==4]
 if len(gateways)!=1:raise ValueError('fixture requires exactly one IPv4 gateway')
 return gateways[0]

def assert_fixture_ancestry(root):
 for path in [root]+list(root.parents):
  st=path.stat()
  if st.st_uid!=0 or st.st_mode&0o022:raise ValueError('fixture root ancestry must already be root-owned and non-writable to non-root')

def companions_ready(pg,bao,diagnostics=None):
 # Dev server listens without TLS. Never let the CLI default select HTTPS.
 pgcheck=call(['docker','exec',pg,'pg_isready','-U','lyam'],False)
 baocheck=call(['docker','exec','-e','BAO_ADDR=http://127.0.0.1:8200',bao,'bao','status'],False)
 if diagnostics is not None:diagnostics.update(pgIsReadyRC=pgcheck.returncode,baoStatusRC=baocheck.returncode)
 return pgcheck.returncode==0 and baocheck.returncode==0

def assert_postapp(r4,r6,launch,summary):
 if r4!=launch['policy4Exact'] or r6!=launch['policy6Exact']:raise ValueError('policy changed after AppModule startup')
 status='\n'.join(summary['pid1Status'])
 if not re.search(r'CapEff:\s+0+\b',status) or not re.search(r'CapBnd:\s+0+\b',status) or not re.search(r'NoNewPrivs:\s+1\b',status):raise ValueError('postApp PID1 capabilities escaped')

def main():
 p=argparse.ArgumentParser()
 for arg in ['image','helper','preflight','launcher','out']:p.add_argument('--'+arg,required=True)
 p.add_argument('--delivery-extension')
 p.add_argument('--delivery-scenario', choices=['fresh','upgrade'])
 p.add_argument('--baseline-image')
 p.add_argument('--pg-image',default='postgres@sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73')
 p.add_argument('--bao-image',default='openbao/openbao@sha256:71156a1c6623a5fa3f5e61b0c6a8ead0faf0df29a778339188443551995d1315')
 p.add_argument('--ipv6-mode',choices=['active','inactive'],default='active')
 a=p.parse_args()
 HELPER_ERRORS.update(n.exc.func.id+': '+n.exc.args[0].value for n in ast.walk(ast.parse(pathlib.Path(a.helper).read_text())) if isinstance(n,ast.Raise) and isinstance(n.exc,ast.Call) and isinstance(n.exc.func,ast.Name) and n.exc.func.id in ['ValueError','RuntimeError'] and len(n.exc.args)==1 and isinstance(n.exc.args[0],ast.Constant) and isinstance(n.exc.args[0].value,str))
 if os.geteuid()!=0 or os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_ENVIRONMENT')!='github-hosted' or not os.environ.get('GITHUB_RUN_ID','').isdigit():raise ValueError('disposable GitHub hosted Actions root runner required')
 if pathlib.Path('/opt/lyam').exists() or 'lyam-net' in d('network','ls','--format','{{.Name}}').splitlines() or any(x.startswith('lyam') for x in d('ps','-a','--format','{{.Names}}').splitlines()):raise ValueError('production marker present; fixture forbidden')
 if not re.fullmatch(r'ghcr\.io/manudss/iam-platform-poc@sha256:[0-9a-f]{64}',a.image):raise ValueError('pushed exact digest required, never local tag alias')
 if a.baseline_image and not re.fullmatch(r'ghcr\.io/manudss/iam-platform-poc@sha256:[0-9a-f]{64}',a.baseline_image):raise ValueError('exact baseline digest required')
 if bool(a.delivery_extension)!=bool(a.delivery_scenario):raise ValueError('delivery scenario and extension required together')
 if not re.fullmatch(r'postgres@sha256:[0-9a-f]{64}',a.pg_image) or not re.fullmatch(r'openbao/openbao@sha256:[0-9a-f]{64}',a.bao_image):raise ValueError('reviewed companion digests required')
 out=pathlib.Path(a.out).resolve();out.mkdir(parents=True,exist_ok=True)
 prefix='closed-ci-'+str(os.getpid());network=prefix+'-net';pg=prefix+'-pg';bao=prefix+'-bao';seed=prefix+'-seed';app=prefix+'-app'
 root=pathlib.Path('/root')/prefix
 assert_fixture_ancestry(root.parent) # Fail before creating resources; never repair shared ancestors.
 root.mkdir(mode=0o700);assert_fixture_ancestry(root);data=root/'data';data.mkdir(mode=0o700)
 containers=[];created_network=False;stage='setup';readiness={};negative={};gateway_family=None
 try:
  # Checked-in helper is copied, not changed. Wrappers are rebound only to this fixture root.
  impl=root/'closed-recovery-helper.py';shutil.copyfile(a.helper,impl);impl.chmod(0o700)
  wrappers={}
  for mode,source in [('preflight',a.preflight),('launcher',a.launcher)]:
   text=pathlib.Path(source).read_text().replace('/opt/lyam/bin/closed-recovery-helper.py',str(impl))
   dest=root/('closed-'+mode);dest.write_text(text);dest.chmod(0o700);wrappers[mode]=dest
  d('pull',a.image)
  if a.baseline_image:d('pull',a.baseline_image)
  if a.delivery_scenario:
   candidate=json.loads(d('image','inspect',a.image))[0]
   if candidate.get('Config',{}).get('Labels',{}).get('org.opencontainers.image.revision')!=os.environ.get('DELIVERY_SHA'):raise ValueError('candidate image source label mismatch')
  # Real disposable companions, no provider integrations, no public ports or persistent secrets.
  netargs=['network','create']
  if a.delivery_scenario:netargs+=['--internal']
  if a.ipv6_mode=='active':netargs+=['--ipv6','--subnet','fd42:6c79:'+format(os.getpid()%65535,'x')+'::/64']
  d(*netargs,network);created_network=True
  containers.append(pg);d('run','-d','--name',pg,'--network',network,'-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_USER=lyam','-e','POSTGRES_DB=lyam',a.pg_image)
  containers.append(bao);d('run','-d','--name',bao,'--network',network,'--cap-add','IPC_LOCK','-e','BAO_DEV_ROOT_TOKEN_ID=synthetic-ci-only',a.bao_image,'server','-dev','-dev-listen-address=0.0.0.0:8200')
  if a.delivery_scenario:
   # Replace only the fixture-owned dev Bao with a durable real server.
   d('rm','-f',bao)
   baostore=root/'bao-storage';baostore.mkdir(mode=0o777);baostore.chmod(0o777)
   baokeys=root/'bao-keys';baokeys.mkdir(mode=0o700)
   baoconfig=pathlib.Path(__file__).resolve().parents[1]/'deploy/oci/companions/bao.hcl'
   d('run','-d','--name',bao,'--network',network,'--cap-add','IPC_LOCK','-v',str(baostore)+':/bao/file','-v',str(baoconfig)+':/bao/config/bao.hcl:ro',a.bao_image,'server','-config=/bao/config/bao.hcl')
   for _ in range(60):
    status=call(['docker','exec','-e','BAO_ADDR=http://127.0.0.1:8200',bao,'bao','status'],False)
    if status.returncode in [0,2]:break
    time.sleep(1)
   else:raise RuntimeError('durable Bao listener unavailable')
   initialized=json.loads(d('exec','-e','BAO_ADDR=http://127.0.0.1:8200',bao,'bao','operator','init','-key-shares=1','-key-threshold=1','-format=json'))
   keyfile=baokeys/'init.json';keyfile.write_text(json.dumps(initialized));keyfile.chmod(0o600)
   d('exec','-e','BAO_ADDR=http://127.0.0.1:8200',bao,'bao','operator','unseal',initialized['unseal_keys_b64'][0])
   d('exec','-e','BAO_ADDR=http://127.0.0.1:8200','-e','BAO_TOKEN='+initialized['root_token'],bao,'bao','secrets','enable','-path=secret','-version=2','kv')
  stage='companion-readiness'
  for _ in range(60):
   if companions_ready(pg,bao,readiness):break
   time.sleep(1)
  else:raise RuntimeError('synthetic companions unavailable')
  stage='seed-and-offline-inventory'
  # Create fictional dataset with network none and hold, then stop cold. Never use production data.
  containers.append(seed);d('run','-d','--name',seed,'--network','none','-v',str(data)+':/data','-e','IAM_AUTOMATION_HOLD=1','-e','IAM_DEMO_SEED_MODE=auto',a.baseline_image or a.image)
  wait(seed,3000,'/health');d('stop',seed)
  im=json.loads(d('image','inspect',a.image))[0];pgip=inspect(pg)['NetworkSettings']['Networks'][network]['IPAddress'];baoip=inspect(bao)['NetworkSettings']['Networks'][network]['IPAddress'];gateway=ipv4_gateway(json.loads(d('network','inspect',network))[0]['IPAM']['Config'])
  gateway_family=ipaddress.ip_address(gateway).version
  cid=d('create','--network','none','--entrypoint','/bin/true',a.image).strip();containers.append(cid)
  paths=['/app/migration-source/data/migrations/manifest.json','/usr/local/bin/docker-entrypoint.sh','/app/demo/start.sh']
  hashes={}
  for i,path in enumerate(paths):
   dest=root/('offline-'+str(i));d('cp',cid+':'+path,str(dest));hashes[path]=sha(dest.read_bytes())
  config={'image':a.image,'imageID':im['Id'],'network':network,'pgContainer':pg,'pgIP':pgip,'baoContainer':bao,'baoIP':baoip,'gateway':gateway,'hostProbePort':443,'externalProbeIP':'1.1.1.1','ipv6ProbeIP':'2606:4700:4700::1111','ledgerSHA256':sha((data/'migrations/journal.json').read_bytes()),'manifestSHA256':hashes[paths[0]],'offlineFileSHA256':{p:h for p,h in hashes.items() if p!=paths[0]},'implementationSHA256':sha(impl.read_bytes()),'helperSHA256':{'LYAM_CLOSED_PREFLIGHT':sha(wrappers['preflight'].read_bytes()),'LYAM_CLOSED_LAUNCHER':sha(wrappers['launcher'].read_bytes())}}
  conf=root/'config.json';conf.write_text(json.dumps(config));conf.chmod(0o600)
  env=root/'app.env';env.write_text('\n'.join(['IAM_AUTOMATION_HOLD=1','IAM_DEMO_SEED_MODE=never','LYAM_DOCKER_NETWORK='+network,'LYAM_CLOSED_CONFIG='+str(conf),'LYAM_CLOSED_IMPLEMENTATION='+str(impl),'LYAM_CLOSED_PREFLIGHT='+str(wrappers['preflight']),'LYAM_CLOSED_LAUNCHER='+str(wrappers['launcher']),'IAM_PG_URL=postgres://lyam@pg:5432/lyam','IAM_BAO_ADDR=http://bao:8200','IAM_BAO_TOKEN='+(initialized['root_token'] if a.delivery_scenario else 'synthetic-ci-only'),'IAM_PUBLIC_ORIGIN=http://localhost:8080'])+'\n');env.chmod(0o600)
  args=['--image',a.image,'--container',app,'--env-file',str(env),'--data-dir',str(data),'--port','18089']
  if a.delivery_scenario=='upgrade':
   d('rename',seed,app);containers.remove(seed);containers.append(app)
   context={'scenario':'upgrade','root':str(root),'out':str(out),'config':str(conf),'env':str(env),'proof':str(root/'upgrade-proof.json'),'image':a.image,'baselineImage':a.baseline_image,'app':app,'pg':pg,'bao':bao,'network':network,'data':str(data),'wrappers':{k:str(v) for k,v in wrappers.items()}}
   context_path=root/'delivery-context.json';context_path.write_text(json.dumps(context));context_path.chmod(0o600)
   stage='real-delivery-upgrade';call(['python3',a.delivery_extension,str(context_path)])
   return
  stage='negative-ledger'
  goodconfig=conf.read_text();wrong={**config,'ledgerSHA256':'0'*64};conf.write_text(json.dumps(wrong))
  refused=call([str(wrappers['preflight']),*args],False)
  negative['ledger']={'returnCode':refused.returncode,**failure_details(refused.stderr)}
  if refused.returncode==0 or failure_code(refused.stderr)!='ValueError: ledger changed from reviewed source' or call(['docker','inspect',app],False).returncode==0:raise ValueError('bad ledger did not refuse before candidate creation')
  conf.write_text(goodconfig)
  stage='positive-preflight'
  pre=json.loads(call([str(wrappers['preflight']),*args]).stdout)
  containers.append(app)
  stage='negative-policy'
  original_impl=impl.read_text();needle="for ip,port in peers.values():nscmd('iptables','-A','OUTPUT','-d',ip,'-p','tcp','--dport',str(port),'-j','ACCEPT')"
  if needle not in original_impl:raise ValueError('policy mutation target changed; explicit review needed')
  impl.write_text(original_impl.replace(needle,'for ip,port in []:pass'));impl.chmod(0o700)
  config['implementationSHA256']=sha(impl.read_bytes());conf.write_text(json.dumps(config))
  badlaunch=call([str(wrappers['launcher']),*args],False)
  negative['policy']={'returnCode':badlaunch.returncode,**failure_details(badlaunch.stderr)}
  failed=inspect(app)
  if badlaunch.returncode==0 or failure_code(badlaunch.stderr)!='ValueError: network probe mismatch' or failed['State']['Running'] or failed['Config']['Entrypoint']!=['sh']:raise ValueError('incomplete policy did not stop before release')
  # Explicit fixture-owned failed candidate cleanup only, never a production retry policy.
  d('rm',app);impl.write_text(original_impl);impl.chmod(0o700);config['implementationSHA256']=sha(impl.read_bytes());conf.write_text(json.dumps(config))
  stage='complete-helper'
  launch=json.loads(call([str(wrappers['launcher']),*args]).stdout)
  proofpath=root/'launch-proof.json';proofpath.write_text(json.dumps(launch));proofpath.chmod(0o600)
  if launch['ipv6DisabledProved']!=(a.ipv6_mode=='inactive'):raise ValueError('wrong IPv6 branch exercised')
  stage='app-held-live-postcheck'
  wait(app,3000,'/health');wait(app,8080,'/healthz')
  pid=inspect(app)['State']['Pid']
  r4=call(['nsenter','-t',str(pid),'-n','iptables','-S']).stdout;r6=call(['nsenter','-t',str(pid),'-n','ip6tables','-S']).stdout
  summary=json.loads(d('exec',app,'node','-e',"const f=require('fs');let log=f.readFileSync('/data/api.log','utf8');let m=/automation hold: (\\{[^\\n]+\\})/.exec(log);if(!m||!JSON.parse(m[1]).held)process.exit(1);let p=f.readdirSync('/proc').filter(x=>/^\\d+$/.test(x)&&x!==String(process.pid)).find(x=>{try{return f.readFileSync('/proc/'+x+'/cmdline','utf8').includes('dist/main.js')}catch{return false}});if(!p)process.exit(2);let e=f.readFileSync('/proc/'+p+'/environ','utf8').split('\\0');if(!e.includes('IAM_AUTOMATION_HOLD=1')||e.some(x=>x.startsWith('NODE_TLS_REJECT_UNAUTHORIZED=')))process.exit(3);console.log(JSON.stringify({held:true,apiProcessPresent:true,tlsOverrideAbsent:true,pid1Status:f.readFileSync('/proc/1/status','utf8').split('\\n').filter(x=>/^(CapEff|CapBnd|NoNewPrivs):/.test(x))}))"))
  if not summary['held']:raise ValueError('API not held')
  assert_postapp(r4,r6,launch,summary)
  # Preserve synthetic evidence even if the mandatory live comparison refuses.
  (out/'intermediate-launch-and-app.json').write_text(json.dumps({'finalPassed':False,'launch':launch,'appModule':summary,'postAppRules4':r4,'postAppRules6':r6},indent=2))
  postipv6=json.loads(d('exec',app,'node','-e',"const f=require('fs');const dirs=f.readdirSync('/proc/sys/net/ipv6/conf').filter(x=>!['all','default','lo'].includes(x));console.log(JSON.stringify({interfaces:dirs.map(name=>({name,disabled:f.readFileSync('/proc/sys/net/ipv6/conf/'+name+'/disable_ipv6','utf8').trim()})),addresses:f.readFileSync('/proc/net/if_inet6','utf8'),routes:f.readFileSync('/proc/net/ipv6_route','utf8')}))"))
  (out/'synthetic-ipv6-before-after.json').write_text(json.dumps({'before':launch['ipv6State'],'after':postipv6},indent=2))
  live=json.loads(call([str(impl),'--mode','postcheck','--proof-file',str(proofpath),*args]).stdout)
  def ipv6shape(x):return {'interfaces':x['interfaces'],'addresses':sorted(x['addresses'].splitlines()),'routes':sorted(' '.join(l.split()[:5]+l.split()[-1:]) for l in x['routes'].splitlines())}
  if ipv6shape(postipv6)!=ipv6shape(launch['ipv6State']):raise ValueError('IPv6 state changed after AppModule')
  if a.delivery_extension:
   context={'scenario':'fresh','root':str(root),'out':str(out),'config':str(conf),'env':str(env),'proof':str(proofpath),'image':a.image,'app':app,'pg':pg,'bao':bao,'network':network,'data':str(data),'wrappers':{k:str(v) for k,v in wrappers.items()}}
   context_path=root/'delivery-context.json';context_path.write_text(json.dumps(context));context_path.chmod(0o600)
   call(['python3',a.delivery_extension,str(context_path)])
   return
  # Restart must return to inert FIFO, never run app or retain a release signal.
  stage='restart-inert'
  d('stop',app);d('start',app);time.sleep(2)
  inert=call(['docker','exec',app,'node','-e',"const f=require('fs');let fifo=false;try{fifo=f.statSync('/tmp/lyam-closed-start.fifo').isFIFO()}catch{}const processes=f.readdirSync('/proc').filter(p=>/^[0-9]+$/.test(p)&&p!==String(process.pid)).flatMap(p=>{try{const raw=f.readFileSync('/proc/'+p+'/cmdline','utf8');const a=raw.split('\\0');const node=a[0].split('/').pop()==='node';const app=node&&a.slice(1).some(x=>['dist/main.js','/app/api/dist/main.js'].includes(x));const old=raw.includes('dist/main.js');const state=/^State:\\s+(\\w)/m.exec(f.readFileSync('/proc/'+p+'/status','utf8'))?.[1]||'unknown';return [{pid:Number(p),node,app,oldSubstringMatch:old,inline:node&&a.includes('-e'),shell:['sh','bash'].includes(a[0].split('/').pop()),state}]}catch(e){return e.code==='ENOENT'?[]:[{pid:Number(p),readError:true}]}});const live=processes.some(p=>p.app||p.oldSubstringMatch);const uncertain=processes.some(p=>p.readError);console.log(JSON.stringify({fifo,processes,live,uncertain}));process.exit(!fifo?1:uncertain?3:live?2:0)"],False)
  restart={'returnCode':inert.returncode,'passed':inert.returncode==0}
  if inert.stdout.strip():restart['inspection']=json.loads(inert.stdout)
  (out/'restart-inert-result.json').write_text(json.dumps(restart,indent=2))
  if inert.returncode:raise ValueError('restart did not fail closed')
  result={'passed':True,'scope':'real Docker helper, Linux policy, real synthetic PG/Bao and real AppModule, no production data','image':a.image,'imageID':im['Id'],'preflight':pre,'launch':launch,'appModule':summary,'liveVerification':live,'postAppRules4':r4,'postAppRules6':r6,'restartInert':True,'badLedgerRefusedBeforeCandidate':True,'incompletePolicyRefusedBeforeReleaseAndStopped':True,'ipv6Mode':a.ipv6_mode,'fixtureConfigAutoExtracted':True,'fixtureWrappersReboundToPrivatePrefix':True,'syntheticFreshLedgerNotHostLedger':True,'companionImages':[a.pg_image,a.bao_image],'limitations':['Does not exercise provider calls or production queue','Offline bundle TLS inventory is a separate exact-image gate','Not production qualification']}
  (out/'closed-helper-docker-result.json').write_text(json.dumps(result,indent=2));print('PASS real Docker closed-helper fixture')
 except Exception as error:
  # Always retain a bounded, sanitized failure artifact before cleanup. No env,
  # logs, credentials, or raw docker-inspect payloads are uploaded.
  states=[]
  for name in containers:
   try:
    state=inspect(name)['State']
    states.append({'running':state['Running'],'exitCode':state['ExitCode'],'status':state['Status'],'oomKilled':state.get('OOMKilled')})
   except Exception:states.append({'unavailable':True})
  (out/'closed-helper-fixture-failure.json').write_text(json.dumps({'passed':False,'stage':stage,'errorType':type(error).__name__,'ipv6Mode':a.ipv6_mode,'gatewayFamily':gateway_family,'readiness':readiness,'command':COMMAND_DIAGNOSTIC,'negativeCases':negative,'syntheticContainerStates':states},indent=2))
  raise
 finally:
  for name in reversed(containers):call(['docker','rm','-f',name],False)
  if created_network:call(['docker','network','rm',network],False)
  if a.delivery_scenario:
   cleanup={'containersAbsent':all(call(['docker','inspect',n],False).returncode!=0 for n in containers),'networkAbsent':call(['docker','network','inspect',network],False).returncode!=0}
   intermediate=out/'delivery-intermediate.json'
   record=json.loads(intermediate.read_text()) if intermediate.exists() else {'format':1,'scenario':a.delivery_scenario,'passed':False,'sha':os.environ.get('DELIVERY_SHA',''),'digest':a.image.split('@')[1],'checks':{},'evidence':{}}
   record['cleanup']=cleanup
   clean=all(cleanup.values()) and record.get('frontCleanup') is True
   record['checks']['cleanup']=clean
   record['passed']=record.get('passed') is True and clean
   if intermediate.exists():
    record['privateEvidenceHashes']=record.pop('evidence',{})
    public=out/'execution-evidence.json'
    public.write_text(json.dumps({k:v for k,v in record.items() if k not in ['evidence']},sort_keys=True,indent=2))
    record['evidence']={public.name:sha(public.read_bytes()),'candidate-script-hashes.json':sha((out/'candidate-script-hashes.json').read_bytes())}
   (out/'delivery-receipt.json').write_text(json.dumps(record,indent=2))
   if not clean:raise RuntimeError('delivery fixture cleanup incomplete')
  shutil.rmtree(root)
if __name__=='__main__':main()
