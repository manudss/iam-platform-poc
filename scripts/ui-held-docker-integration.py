#!/usr/bin/env python3
"""Synthetic disposable runner extension. No production account, host or data.
Execute the actual queue/controller and qualifier, with real Docker + native TLS Caddy.
"""
import os,sys,json,shutil,hashlib,subprocess,time,signal,ctypes,ctypes.util,platform,importlib.util
from pathlib import Path

def command(args,ok=True,**kwargs):
 r=subprocess.run(args,capture_output=True,text=True,timeout=300,**kwargs)
 if ok and r.returncode:raise RuntimeError('fixed fixture command failure')
 return r

def digest(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def spec(p):return {'path':str(p),'sha256':digest(p)}
def docker(*args):return command(['docker',*args]).stdout.strip()
def module(path,name):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def trace_and_kill(args,manifest,gate,when):
 # Linux x86_64 ptrace observes the real controller's unlink syscall return.
 # No monkeypatch or replacement controller, no change to reviewed source.
 # Trace controller process and children because qualifier subprocesses also run.
 if platform.machine()!='x86_64':raise RuntimeError('x86_64 fixture required')
 libc=ctypes.CDLL(ctypes.util.find_library('c'),use_errno=True)
 libc.ptrace.restype=ctypes.c_long
 class Regs(ctypes.Structure):
  _fields_=[(n,ctypes.c_ulonglong) for n in ['r15','r14','r13','r12','rbp','rbx','r11','r10','r9','r8','rax','rcx','rdx','rsi','rdi','orig_rax','rip','cs','eflags','rsp','ss','fs_base','gs_base','ds','es','fs','gs']]
 def ptrace(req,pid,addr=0,data=0):
  ctypes.set_errno(0)
  val=libc.ptrace(req,pid,ctypes.c_void_p(addr),ctypes.c_void_p(data))
  if val==-1 and ctypes.get_errno():raise RuntimeError('ptrace fixture failure')
  return val
 # Queue runs in this root subprocess; forked tracer child starts stopped before exec.
 readfd,writefd=os.pipe();pid=os.fork()
 if pid==0:
  os.close(writefd);os.dup2(readfd,0);os.close(readfd)
  dev=os.open('/dev/null',os.O_WRONLY);os.dup2(dev,1);os.dup2(dev,2)
  libc.ptrace(0,0,0,0);os.kill(os.getpid(),signal.SIGSTOP);os.execvp(args[0],args)
 os.close(readfd);os.write(writefd,json.dumps(manifest).encode());os.close(writefd)
 os.waitpid(pid,0);ptrace(0x4200,pid,0,1) # TRACESYSGOOD; do not trace children or capture their inputs.
 stopped=False;entry=True;selected=False;deleted=0
 try:
  while True:
   ptrace(24,pid,0,0) # PTRACE_SYSCALL
   _,status=os.waitpid(pid,0)
   if os.WIFEXITED(status) or os.WIFSIGNALED(status):break
   if os.WSTOPSIG(status)!=(signal.SIGTRAP|0x80):continue
   regs=Regs();ptrace(12,pid,0,ctypes.addressof(regs))
   entry=regs.rax==((1<<64)-38) # x86 syscall-entry ENOSYS sentinel
   if entry:
    selected=False
    if regs.orig_rax in [87,263]: # unlink / unlinkat
     addr=regs.rdi if regs.orig_rax==87 else regs.rsi
     raw=bytearray()
     for off in range(0,4096,8):
      v=ptrace(2,pid,addr+off,0)&((1<<64)-1);part=v.to_bytes(8,'little');raw.extend(part)
      if 0 in part:break
     path=bytes(raw).split(b'\0')[0].decode()
     selected=path in gate
   else:
    if selected and regs.rax==0:
     deleted+=1
     if deleted==when:
      os.kill(pid,signal.SIGKILL);os.waitpid(pid,0);stopped=True;break
 finally:
  if not stopped:
   try:os.kill(pid,signal.SIGKILL);os.waitpid(pid,0)
   except ProcessLookupError:pass
 if not stopped:raise RuntimeError('actual controller crash point not reached')
 return {'actualControllerSIGKILL':True,'unlinkCompleted':when,'accessUntilManualRearmPossible':when==2}

def main():
 if os.geteuid()!=0 or os.environ.get('GITHUB_ACTIONS')!='true' or os.environ.get('RUNNER_ENVIRONMENT')!='github-hosted':raise RuntimeError('disposable root runner only')
 c=json.loads(Path(sys.argv[1]).read_text());root=Path(c['root']);out=Path(c['out']);src=Path(__file__).resolve().parents[1]
 if Path('/opt/lyam').exists():raise RuntimeError('production path exists')
 owned=Path('/opt/lyam');owned.mkdir(mode=0o700);gates=root/'gates';gates.mkdir(mode=0o755);binroot=root/'bin';binroot.mkdir(mode=0o700)
 caddy='ui-held-caddy-'+str(os.getpid());certroot=root/'tls';certroot.mkdir();stage='setup';result={'passed':False,'image':c['image'],'scope':'synthetic exact-image integration only','limitations':['not production qualification','SIGKILL can leave access open until manual rearm','no automatic retry or intent reset']}
 try:
  for name in ['ordered-queue.py','reviewed-ui-held.py','closed-recovery-integrity.py','closed-recovery-call.py','update.sh','qualification.py','qualification-container.mjs']:
   shutil.copyfile(src/'deploy/oci'/name,binroot/name);(binroot/name).chmod(0o700)
  expected={'ordered-queue.py': 'fd99588bc2570e676ac31c9f49c578fab50c2163c31b88c7c9adef7464235ea1', 'reviewed-ui-held.py': '9585a236b8a1f2097841f16140daed044ef27ee19c5ef55b2b49c4c4276dd441', 'qualification.py': 'b7d5a4c3f10b20aa263bdb9cf4fe2077588b3e25f52fb9969d86940685945a90', 'qualification-container.mjs': 'b5fbe294eba1f2d77545fdeac27600b32bfa8cf371f209e025587bfdc962de27', 'update.sh': '239cb278d9549f3e4eeda23fd8b575e40755e0a674327b35696112436078c887', 'closed-recovery-helper.py': '53331b2c6cebc24c95fe25621ae5ec5f9421cf7f4eba075e7b9d584bfcf50ca0', 'closed-preflight.sh': 'e8653def79e375b0e9ebb587d5ff7ddf35c37ea3b5daa23167bbf5c5ef536d91', 'closed-launcher.sh': '5018ef5fdc3efe6758107ce7e664e317f400ec2141268f27c12034d9259a8401', 'closed-recovery-integrity.py': '87f3807890763d4945c857f2ef016a101b1df930289b6fe25e9595364b2ea95d', 'closed-recovery-call.py': 'ad9778bf1f141bfec0c74a0ba49a3c819d999d9470b8c97b5c21048b73c0ee17'}
  for name in ['ordered-queue.py','reviewed-ui-held.py','qualification.py','qualification-container.mjs','update.sh','closed-recovery-integrity.py','closed-recovery-call.py']:
   if digest(binroot/name)!=expected[name]:raise RuntimeError('immutable controller source hash mismatch')
  # This assembly's source refs are separately pinned in the workflow and artifact.
  command(['git','config','--global','--add','safe.directory',str(src)])
  q=module(binroot/'ordered-queue.py','queue');u=module(binroot/'reviewed-ui-held.py','opening')
  hosts=['held-a.localhost','held-b.localhost','held-c.localhost'];origins=['https://'+h+':18443' for h in hosts]
  with open('/etc/hosts','a') as f:f.write('\n127.0.0.1 '+' '.join(hosts)+'\n')
  cert=certroot/'cert.pem';key=certroot/'key.pem'
  command(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-days','1','-subj','/CN=held-a.localhost','-addext','subjectAltName='+','.join('DNS:'+h for h in hosts)])
  os.environ['SSL_CERT_FILE']=str(cert)
  shutil.copyfile(cert,'/usr/local/share/ca-certificates/ui-held-fixture.crt');command(['update-ca-certificates'])
  # Chromium uses the NSS database for this root runner. No TLS-ignore flags.
  command(['mkdir','-p','/root/.pki/nssdb']);command(['certutil','-N','--empty-password','-d','sql:/root/.pki/nssdb'],False)
  command(['certutil','-A','-d','sql:/root/.pki/nssdb','-n','ui-held-fixture','-t','C,,','-i',str(cert)])
  gate=gates/'MAINTENANCE';ops=gates/'OPS-MAINTENANCE'
  for p in [gate,ops]:p.write_text('synthetic fixture gate\n');p.chmod(0o644)
  caddyfile=root/'Caddyfile';caddyfile.write_text('''{\n admin 127.0.0.1:12019\n auto_https off\n}\n'''+', '.join(origins)+''' {\n tls /tls/cert.pem /tls/key.pem\n @closed file {\n root /gates\n try_files /MAINTENANCE /OPS-MAINTENANCE\n }\n respond @closed "Maintenance" 503\n @badui {\n path /login\n file {\n root /gates\n try_files /INVALID_UI\n }\n }\n respond @badui "Not an application" 200\n reverse_proxy 127.0.0.1:18089\n}\n''')
  docker('run','-d','--name',caddy,'--network','host','-v',str(caddyfile)+':/etc/caddy/Caddyfile:ro','-v',str(certroot)+':/tls:ro','-v',str(gates)+':/gates:ro','caddy:2.10.2-alpine')
  for _ in range(30):
   try:u.check_origins(origins,503);break
   except Exception:time.sleep(1)
  else:raise RuntimeError('Caddy native TLS503 unavailable')
  import urllib.request
  active=json.load(urllib.request.urlopen('http://127.0.0.1:12019/config/'))
  (out/'synthetic-active-caddy.json').write_text(json.dumps(active,sort_keys=True))
  result['activeCaddySHA256']=digest(out/'synthetic-active-caddy.json')
  # Establish actual OR semantics before candidate is exposed, application held throughout.
  gate.unlink();u.check_origins(origins,503);gate.write_text('synthetic fixture gate\n');gate.chmod(0o644)
  ops.unlink();u.check_origins(origins,503);ops.write_text('synthetic fixture gate\n');ops.chmod(0o644)
  result['eachGateIndependentlyReturns503']=True
  # Configure exact image's real issuer/origins before restarting it through reviewed helper.
  env=Path(c['env']);e={line.split('=',1)[0]:line.split('=',1)[1] for line in env.read_text().splitlines() if '=' in line}
  e['IAM_PUBLIC_ORIGIN']=origins[0];e['IAM_PUBLIC_ORIGIN_EXTRA']=','.join(origins[1:]);e.update({'LYAM_POST_UPDATE_CHECK':str(binroot/'qualification.py'),'LYAM_FRONT_BARRIER_FILE':str(gate),'LYAM_OPS_BARRIER_FILE':str(ops),'LYAM_PAUSE_FILE':str(root/'PAUSE'),'LYAM_LOCK_FILE':str(root/'update.lock'),'LYAM_DATA_DIR':c['data'],'LYAM_BACKUP_DIR':str(root),'LYAM_CONTAINER':c['app']})
  (root/'PAUSE').touch();(root/'update.lock').touch();env.write_text(''.join(k+'='+v+'\n' for k,v in e.items()));env.chmod(0o600)
  # Ensure Bao inventory has one real synthetic KV metadata record.
  docker('exec','-e','BAO_ADDR=http://127.0.0.1:8200','-e','BAO_TOKEN=synthetic-ci-only',c['bao'],'bao','kv','put','secret/iam/ui-held-fixture','value=synthetic')
  token=root/'bao-token';token.write_text('synthetic-ci-only');token.chmod(0o600)
  auth=root/'auth.json';auth.write_text(json.dumps({'username':'demo-alice','password':'demo-only-not-a-secret'}));auth.chmod(0o600)
  policy={'format':1,'requireAutomationHold':True,'origins':origins,'issuer':origins[0]+'/core','tenant':'acme-demo','network':c['network'],'pgContainer':c['pg'],'pgUser':'lyam','pgDatabase':'lyam','baoAddress':'http://'+json.loads(Path(c['config']).read_text())['baoIP']+':8200','baoTokenFile':str(token),'baoMetadataRoots':['secret/metadata/iam'],'authFile':str(auth),'credentialFiles':['core-state/credentials.json','core-state/iam-poc-account-blocks.json','core-state/iam-poc-authn-enrollments.json','core-state/iam-poc-password-history.json'],'appendOnlyTables':['public.activations','public.decision_audit'],'transformationVerifiers':{}}
  # Bao host access uses docker published port? Fixture container has no host port.
  # Qualifier Bao fetch executes inside helper/app container on the allowed peer address.
  pol=owned/'qualification.json';pol.write_text(json.dumps(policy));pol.chmod(0o600)
  config=json.loads(Path(c['config']).read_text());config['qualificationSHA256']={str(p):digest(p) for p in [binroot/'qualification.py',binroot/'qualification-container.mjs',pol]};config['controllerSHA256']={n:digest(binroot/n) for n in ['update.sh','closed-recovery-integrity.py','closed-recovery-call.py']};Path(c['config']).write_text(json.dumps(config))
  args=['--image',c['image'],'--container',c['app'],'--env-file',str(env),'--data-dir',c['data'],'--port','18089']
  docker('stop',c['app']);docker('rm',c['app'])
  launch=json.loads(command([c['wrappers']['launcher'],*args]).stdout);Path(c['proof']).write_text(json.dumps(launch))
  for _ in range(120):
   if command(['docker','exec',c['app'],'node','-e',"fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],False).returncode==0:break
   time.sleep(2)
  else:raise RuntimeError('held app health timeout')
  # API readiness precedes SSR and edge startup; wait for the actual smoke entrypoint.
  stage='synthetic-edge-readiness'
  for _ in range(120):
   if command(['docker','exec',c['app'],'node','-e',"fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],False).returncode==0:break
   time.sleep(2)
  else:raise RuntimeError('synthetic edge health timeout')
  # The public activation GET may create its SQL schema on first access. Warm the
  # complete real synthetic smoke before baseline, never ignore schema differences.
  stage='synthetic-prebaseline-warm-smoke'
  warm=subprocess.run(['docker','exec','-i',c['app'],'node','--input-type=module','-e',(binroot/'qualification-container.mjs').read_text(),'smoke'],input=json.dumps({**policy,'auth':json.loads(auth.read_text())}),capture_output=True,text=True,timeout=180)
  if warm.returncode:
   import re
   allowed=module(binroot/'qualification.py','warm_diagnostic').CHILD_STAGES
   codes=re.findall(r'^QUALIFICATION_DIAG_V1:([a-z][a-z0-9-]{0,47})$',warm.stderr,re.M)
   result['warmSmokeFixedStage']=codes[-1] if codes and codes[-1] in allowed else 'unclassified'
   raise RuntimeError('prebaseline synthetic smoke refused')
  # Establish cold baseline with same exact image and current synthetic PG/Bao.
  stage='qualification-before';docker('stop',c['app'])
  evidence=root/'evidence'
  qualargs=['--container',c['app'],'--image',c['image'],'--env-file',str(env),'--data-dir',c['data'],'--backup-dir',str(root),'--barrier-file',str(gate),'--target-image',c['image'],'--evidence-dir',str(evidence),'--policy',str(pol),'--require-automation-hold']
  command([str(binroot/'qualification.py'),'--phase','before',*qualargs])
  docker('rm',c['app']);launch=json.loads(command([c['wrappers']['launcher'],*args]).stdout);Path(c['proof']).write_text(json.dumps(launch))
  for _ in range(120):
   if command(['docker','exec',c['app'],'node','-e',"fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],False).returncode==0:break
   time.sleep(2)
  else:raise RuntimeError('held app health timeout')
  stage='qualification-after';command([str(binroot/'qualification.py'),'--phase','after',*qualargs])
  stage='collect-after-evidence'
  after=next(evidence.glob('after-*'));smoke=next(evidence.glob('smoke-*'))
  stage='integrity-binding'
  # Report only fixed roles and numeric metadata, never the actual paths or bytes.
  ancestry=[]
  audited={'env':env,'config':Path(c['config']),'policy':pol,'implementation':Path(e['LYAM_CLOSED_IMPLEMENTATION']),'preflight':Path(e['LYAM_CLOSED_PREFLIGHT']),'launcher':Path(e['LYAM_CLOSED_LAUNCHER'])}
  audited.update({'controller-'+name:binroot/name for name in ['update.sh','closed-recovery-integrity.py','closed-recovery-call.py']})
  audited.update({'qualifier-'+name:binroot/name for name in ['qualification.py','qualification-container.mjs']})
  for role,path in audited.items():
   for depth,item in enumerate([path]+list(path.parents)):
    st=item.lstat()
    if st.st_uid!=0 or st.st_gid!=0 or st.st_mode&0o022 or item.is_symlink():ancestry.append({'role':role,'depth':depth,'uid':st.st_uid,'gid':st.st_gid,'mode':oct(st.st_mode&0o777),'symlink':item.is_symlink()})
  result['integrityUnprotectedRoles']=ancestry
  integrity=module(binroot/'closed-recovery-integrity.py','integrity').verify(str(env))
  receipt=root/'receipt';fields={**integrity,'state':'CLOSED_QUALIFIED','held':'true','public_status':'503','image':c['image'],'launch_proof':c['proof'],'launch_proof_sha256':digest(c['proof']),'gate_sha256':digest(gate),'ops_sha256':digest(ops)};receipt.write_text(''.join(k+'='+v+'\n' for k,v in fields.items()));receipt.chmod(0o600)
  opening={k:spec(p) for k,p in {'env':env,'closed_receipt':receipt,'integrity':binroot/'closed-recovery-integrity.py','launch_proof':Path(c['proof']),'policy':pol,'qualifier':binroot/'qualification.py','before':evidence/'before.json','after':after,'smoke':smoke}.items()}
  # Real queue provenance: source main target07dbc and its real first-parent base.
  targetsha='07dbc9ba49c4a1a2b02fa53bb04eb50a5f68e441';base=command(['git','-C',str(src),'rev-parse',targetsha+'^1']).stdout.strip();target={'sha':targetsha,'digest':c['image'].split('@')[1]}
  history={'format':2,'history':[{'sha':base,'digest':'sha256:'+'1'*64}],'recoveries':[{'target':{'sha':base}}],'recovery_fence':base,'resume_required':True,'syntheticFixture':True}
  def manifest(state):return {'format':1,'kind':'reviewed-ui-held-after-fence','state_fingerprint':q.fingerprint(state),'expected_delivered':state['history'][-1],'authorization_ref':'synthetic fixture only, no operational authorization','evidence_refs':['disposable synthetic evidence'],'target':target,'chain':[{'sha':targetsha,'parent':base,'outcome':'ui-open-automation-held'}],'opening_controller':spec(binroot/'reviewed-ui-held.py'),'opening':opening}
  def queueargs(state,verb):return ['python3',str(binroot/'ordered-queue.py'),verb,'--state',str(state),'--repository',str(src),'--container',c['app'],'--pause-file',str(root/'PAUSE'),'--update-lock',str(root/'update.lock')]
  stage='successful-real-opening';state=root/'queue-success.json';q.atomic(state,history);m=manifest(history)
  command(queueargs(state,'open-reviewed-ui-held'),input=json.dumps(m));s=q.load(state)
  if s['history'][-1].get('mode')!='ui-open-automation-held' or not s['resume_required'] or gate.exists() or ops.exists():raise RuntimeError('held UI result not distinct')
  result['success']={'actualQueueAndController':True,'tlsOrigins':len(origins),'htmlLogin':True,'held':True,'pauseRetained':(root/'PAUSE').exists(),'resumeRequired':s['resume_required']}
  stage='ui-document-negative-transport'
  import http.server,ssl,threading
  negative={'mode':'missing-root'}
  class BadDocument(http.server.BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_GET(self):
    mode=negative['mode'];body=b'<title>Sign in</title><app-root></app-root>'
    if mode=='missing-root':body=b'<title>Sign in</title>'
    if mode=='oversize':body+=b'x'*(2*1024*1024)
    self.send_response(302 if mode=='redirect' else 200)
    self.send_header('Content-Type','text/plain' if mode=='content-type' else 'text/html')
    if mode=='redirect':self.send_header('Location',origins[0]+'/login')
    self.end_headers()
    try:self.wfile.write(body)
    except (BrokenPipeError,ConnectionResetError):pass
  server=http.server.HTTPServer(('127.0.0.1',18444),BadDocument);tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);tls.load_cert_chain(cert,key);server.socket=tls.wrap_socket(server.socket,server_side=True)
  thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
  try:
   for mode in ['missing-root','content-type','redirect','oversize']:
    negative['mode']=mode
    try:u.ui_document('https://held-a.localhost:18444')
    except Exception:pass
    else:raise RuntimeError('invalid UI document accepted')
  finally:server.shutdown();server.server_close()
  result['realTLSInvalidUIDocumentsRefused']=['missing-root','content-type','redirect','oversize']
  # Real browser on exact image. Only synthetic test credentials, never save tokens.
  stage='render-auth-exact-image';browserout=out/'ui';browserout.mkdir(exist_ok=True)
  command(['node',str(src/'scripts/ui-held-browser-proof.cjs'),origins[0],str(browserout),str(cert)])
  result['renderedAuthenticatedExactImage']=True
  stage='caught-real-ui-failure-rearms'
  for p in [gate,ops]:p.write_text('synthetic fixture gate\n');p.chmod(0o644)
  badui=gates/'INVALID_UI';badui.write_text('fixture invalid UI');badui.chmod(0o644)
  failedstate=root/'queue-caught-failure.json';q.atomic(failedstate,history)
  attempt=command(queueargs(failedstate,'open-reviewed-ui-held'),False,input=json.dumps(manifest(history)))
  failed=q.load(failedstate)
  if not attempt.returncode or failed['history']!=history['history'] or failed.get('opening_intent',{}).get('phase')!='failed-access-rearmed':raise RuntimeError('caught failure not safely rearmed')
  if any(p.read_text()!='synthetic fixture gate\n' or p.stat().st_mode&0o777!=0o644 or p.stat().st_uid!=0 or p.stat().st_gid!=0 for p in [gate,ops]):raise RuntimeError('caught failure gate bytes/mode')
  u.check_origins(origins,503);badui.unlink();result['caughtFailureAutomaticRearm']=True
  # Fresh fixture queue state per crash scenario; do not clear an interrupted intent.
  result['interruptions']=[]
  for when in [1,2]:
   for p in [gate,ops]:p.write_text('synthetic fixture gate\n');p.chmod(0o644)
   stage='real-controller-sigkill-'+str(when);state=root/('queue-kill-'+str(when)+'.json');q.atomic(state,history)
   crash=trace_and_kill(queueargs(state,'open-reviewed-ui-held'),manifest(history),[str(gate),str(ops)],when)
   saved=q.load(state)
   if not saved.get('opening_intent') or saved['history']!=history['history'] or sum(not p.exists() for p in [gate,ops])!=when:raise RuntimeError('crash evidence mismatch')
   command(queueargs(state,'rearm-interrupted-opening'))
   if q.load(state)['opening_intent']['phase']!='interrupted-access-rearmed' or any(p.read_text()!='synthetic fixture gate\n' or p.stat().st_mode&0o777!=0o644 or p.stat().st_uid!=0 or p.stat().st_gid!=0 for p in [gate,ops]):raise RuntimeError('real rearm failed')
   u.check_origins(origins,503);crash['manualRearmVerified503']=True;result['interruptions'].append(crash)
  result['passed']=True;result['controllerSHA256']=digest(binroot/'reviewed-ui-held.py');result['qualifierSHA256']=digest(binroot/'qualification.py');result['qualifierContainerSHA256']=digest(binroot/'qualification-container.mjs')
  if result['controllerSHA256']!=expected['reviewed-ui-held.py'] or result['qualifierSHA256']!=expected['qualification.py'] or result['qualifierContainerSHA256']!=expected['qualification-container.mjs']:raise RuntimeError('result source hash mismatch')
 except Exception as error:
  result['stage']=stage;result['errorType']=type(error).__name__
  reasons={'malformed/duplicate environment':'INTEGRITY_ENV_FORMAT','absolute regular non-symlink required':'INTEGRITY_REGULAR_FILE','root-owned protected code ancestry required':'INTEGRITY_ANCESTRY','private configuration required':'INTEGRITY_PRIVATE_MODE','controller hash differs from review':'INTEGRITY_CONTROLLER_HASH','qualification hash differs from review':'INTEGRITY_QUALIFIER_HASH','qualification entrypoint not reviewed':'INTEGRITY_ENTRYPOINT','qualification source and default policy must both be reviewed':'INTEGRITY_POLICY_INVENTORY','helper hash differs from review':'INTEGRITY_WRAPPER_HASH','implementation hash differs from review':'INTEGRITY_IMPLEMENTATION_HASH'}
  if stage=='integrity-binding':result['fixedReason']=reasons.get(str(error),'UNCLASSIFIED_INTEGRITY_FAILURE')
  # Never publish exception strings, subprocess output, env, tokens, data or raw receipts.
  raise RuntimeError('isolated held UI integration failed at fixed stage') from None
 finally:
  (out/'ui-held-integration-result.json').write_text(json.dumps(result,indent=2))
  command(['docker','rm','-f',caddy],False);shutil.rmtree(owned)
if __name__=='__main__':main()
