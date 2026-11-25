#!/usr/bin/env python3
"""Pre/post preservation checks. Private files remain local; reports contain only hashes.
Requires a reviewed independent policy and a candidate-specific transform verifier for
any intended business/schema change. No successful default for unknown state.
"""
import urllib.parse
import argparse,collections,hashlib,json,os,re,ssl,subprocess,sys,time,urllib.request,urllib.error
from pathlib import Path

STAGE='init'
CHILD_STAGE=None
CAPTURE_LOCK_FDS=()
DIAGNOSTIC_RE=re.compile(r'^QUALIFICATION_DIAG_V1:([a-z][a-z0-9-]{0,47})$',re.M)
CHILD_STAGES={'capture-dolt','capture-bao','smoke-hold','smoke-health','smoke-workflows-before','smoke-auth-input','smoke-oidc-form','smoke-oidc-login','smoke-oidc-token','smoke-oidc-session','smoke-activations','smoke-activations-parse','smoke-activations-validation','smoke-negative-redirect','smoke-workflows-after','smoke-ledger','init'}
def stage(value):
    global STAGE,CHILD_STAGE
    STAGE=value;CHILD_STAGE=None
def cmd(args, input=None):
    r=subprocess.run(args,input=input,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=180,pass_fds=CAPTURE_LOCK_FDS)
    if r.returncode:
        global CHILD_STAGE
        matches=DIAGNOSTIC_RE.findall(r.stderr) if args[-1:] in (['smoke'],['capture']) else []
        CHILD_STAGE=matches[-1] if matches and matches[-1] in CHILD_STAGES else None
        codes=re.findall(r'^DOLT_TRANSFORMATION_REFUSED ([a-z][a-z-]{0,63})$',r.stderr,re.M)
        allowed={'evidence-missing','evidence-malformed','evidence-duplicate','change-categories','branch-set-changed','target-branch-absent','other-database-or-branch-changed','target-head-changed','no-target-change','schema-objects-changed','working-status-changed','table-already-present','table-set-changed','existing-table-changed','new-table-not-empty','new-table-columns','new-table-keys','new-table-column-attributes','new-table-collation','new-table-primary-key','new-table-indexes','ddl-not-calibrated','new-table-ddl','usage','unreadable-evidence'}
        for code in codes[-1:]:
            if code in allowed:print('TRANSFORM_DIAG_V1 '+code,file=sys.stderr)
        for raw in re.findall(r'^DOLT_STATUS_DIAG_V1 (\{[^\n]{1,400}\})$',r.stderr,re.M)[-1:]:
            try:
                v=json.loads(raw)
                if set(v)=={'before','after'} and all(isinstance(v[k],list) and len(v[k])==20 and all(type(n) is int and 0<=n<=1000000 for n in v[k]) for k in v):print('DOLT_STATUS_DIAG_V1 '+json.dumps(v,separators=(',',':')),file=sys.stderr)
            except (ValueError,TypeError):pass
        raise ValueError('command failed, private diagnostic inspection required')
    return r.stdout.strip()
def digest(data):return hashlib.sha256(data).hexdigest()
def private_json(path,value):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:json.dump(value,f,sort_keys=True);f.flush();os.fsync(f.fileno())
def query(policy,sql):
    value=cmd(['docker','exec',policy['pgContainer'],'psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-U',policy['pgUser'],'-d',policy['pgDatabase'],'-c',sql])
    return json.loads(value)
def ident(s):return '"'+s.replace('"','""')+'"'
def lit(s):return "'"+s.replace("'","''")+"'"
def postgres(p):
    tables=query(p,"SELECT coalesce(json_agg(x ORDER BY schemaname,tablename),'[]') FROM (SELECT schemaname,tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')) x")
    rows={}
    for table in tables:
        name=table['schemaname']+'.'+table['tablename'];qualified=ident(table['schemaname'])+'.'+ident(table['tablename'])
        rows[name]=query(p,"SELECT coalesce(json_object_agg(h,n),'{}') FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') h,count(*) n FROM "+qualified+" t GROUP BY 1) s")
    schema=query(p,"SELECT json_build_object('columns',(SELECT coalesce(json_agg(c ORDER BY table_schema,table_name,ordinal_position),'[]') FROM information_schema.columns c WHERE table_schema NOT IN ('pg_catalog','information_schema')), 'indexes',(SELECT coalesce(json_agg(i ORDER BY schemaname,tablename,indexname),'[]') FROM pg_indexes i WHERE schemaname NOT IN ('pg_catalog','information_schema')), 'views',(SELECT coalesce(json_agg(v ORDER BY schemaname,viewname),'[]') FROM pg_views v WHERE schemaname NOT IN ('pg_catalog','information_schema')), 'functions',(SELECT coalesce(json_agg(f ORDER BY schema,name,args),'[]') FROM (SELECT n.nspname schema,p.proname name,pg_get_function_identity_arguments(p.oid) args,pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prokind IN ('f','p')) f), 'constraints',(SELECT coalesce(json_agg(c ORDER BY nspname,relname,conname),'[]') FROM (SELECT n.nspname,r.relname,c.conname,pg_get_constraintdef(c.oid) definition FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema')) c))")
    seqs=query(p,"SELECT coalesce(json_agg(s ORDER BY sequence_schema,sequence_name),'[]') FROM information_schema.sequences s WHERE sequence_schema NOT IN ('pg_catalog','information_schema')")
    sequences={}
    for s in seqs:
        name=s['sequence_schema']+'.'+s['sequence_name'];q=ident(s['sequence_schema'])+'.'+ident(s['sequence_name'])
        sequences[name]=query(p,'SELECT row_to_json(s) FROM (SELECT last_value,is_called FROM '+q+') s')
    return {'rows':rows,'schema':schema,'sequences':sequences,'sequenceDefinitions':seqs}
def credential_hashes(data,p):
    result={}
    for rel in p['credentialFiles']:
        if Path(rel).is_absolute() or '..' in Path(rel).parts:raise ValueError('credential path')
        file=data/rel
        result[rel]=digest(file.read_bytes()) if file.exists() else None
    if not result or not any(result.values()):raise ValueError('credential coverage empty')
    return result

def compare(before,after,p):
    changes=[]
    for key in ['dolt','bao','credentials']:
        if before[key]!=after[key]:changes.append(key)
    b,a=before['postgres'],after['postgres']
    if b['schema']!=a['schema'] or b['sequenceDefinitions']!=a['sequenceDefinitions']:changes.append('postgres-schema')
    if set(b['rows'])!=set(a['rows']):changes.append('postgres-tables')
    for name,rows in b['rows'].items():
        current=a['rows'].get(name,{})
        if name in p['appendOnlyTables']:
            if any(current.get(h,0)<count for h,count in rows.items()):changes.append('postgres-append-preservation:'+name)
        elif rows!=current:changes.append('postgres-rows:'+name)
    if set(b['sequences'])!=set(a['sequences']):changes.append('postgres-sequences')
    for name,seq in b['sequences'].items():
        current=a['sequences'].get(name)
        if not current or current['last_value']<seq['last_value'] or seq['is_called'] and not current['is_called']:changes.append('postgres-sequence-rewind:'+name)
    return changes

def policy_load(path, isolated_loopback=False):
    p=json.loads(Path(path).read_text())
    required=['origins','issuer','tenant','pgContainer','pgUser','pgDatabase','network','authFile','baoMetadataRoots','baoAddress','baoTokenFile','credentialFiles','appendOnlyTables']
    if p.get('format')!=1 or any(k not in p for k in required):raise ValueError('incomplete independent qualification policy')
    if not p['origins']:raise ValueError('empty origins')
    for origin in p['origins']:
        parsed=urllib.parse.urlsplit(origin)
        if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:raise ValueError('invalid expected origin')
        if parsed.scheme=='https' and re.fullmatch(r'https://[a-zA-Z0-9.-]+(?::[0-9]+)?',origin):continue
        if isolated_loopback and p.get('isolatedLoopbackTest') is True and parsed.scheme=='http' and parsed.hostname in ['127.0.0.1','localhost','::1']:continue
        raise ValueError('TLS required outside explicit isolated loopback test')
    if len(p['origins'])!=len(set(p['origins'])):raise ValueError('duplicate origins')
    if not all(isinstance(p[k],list) for k in ['baoMetadataRoots','credentialFiles','appendOnlyTables']):raise ValueError('policy coverage invalid')
    return p

def exact_held_activations(before,after):
    prior=before['postgres']['rows'].get('public.activations')
    current=after['postgres']['rows'].get('public.activations')
    if prior is None or current is None or prior!=current:raise ValueError('closed recovery activation journal changed or unknown')

def closed_runtime(inspect):
    env=inspect['Config'].get('Env',[]);host=inspect['HostConfig']
    if 'IAM_AUTOMATION_HOLD=1' not in env or 'IAM_DEMO_SEED_MODE=never' not in env or host['RestartPolicy']['Name'] not in ['no','none']:raise ValueError('closed recovery hold/seed/restart mismatch')
    if 'ALL' not in (host.get('CapDrop') or []) or host.get('CapAdd') or host.get('Privileged') or not any(x.startswith('no-new-privileges') for x in host.get('SecurityOpt',[])):raise ValueError('closed recovery capabilities mismatch')

def held_running_baseline(container,image,evidence,policy_path,data_dir,lock_bindings,prove_closed,capture_binding,transport_coverage='UNVERIFIED_CAPTURE_TRANSPORT'):
    global CAPTURE_LOCK_FDS
    if CAPTURE_LOCK_FDS:raise ValueError('nested held baseline forbidden')
    if not isinstance(lock_bindings,dict) or set(lock_bindings)!={'journal','updater'}:raise ValueError('both actual held locks required')
    try:
        CAPTURE_LOCK_FDS=tuple(fd for path,fd in lock_bindings.values())
        return _held_running_baseline(container,image,evidence,policy_path,data_dir,lock_bindings,prove_closed,capture_binding,transport_coverage)
    finally:CAPTURE_LOCK_FDS=()


def _held_running_baseline(container,image,evidence,policy_path,data_dir,lock_bindings,prove_closed,capture_binding,transport_coverage='UNVERIFIED_CAPTURE_TRANSPORT'):
    """Fresh current-epoch baseline only, never a substitute for original preservation.
    Caller supplies the fixed closed-runtime verifier, both actual held locks and
    a new evidence directory. No stop/start, smoke, auth or environment mutation.
    """
    import fcntl,stat
    def locks():
        if not isinstance(lock_bindings,dict) or set(lock_bindings)!={'journal','updater'}:raise ValueError('both actual held locks required')
        for path,fd in lock_bindings.values():
            a=os.fstat(fd);p=Path(path);b=p.lstat()
            if p.is_symlink() or not stat.S_ISREG(a.st_mode) or (a.st_dev,a.st_ino)!=(b.st_dev,b.st_ino):raise ValueError('held baseline lock inode differs')
            with p.open('a') as other:
                try:fcntl.flock(other,fcntl.LOCK_EX|fcntl.LOCK_NB)
                except BlockingIOError:pass
                else:raise ValueError('held baseline exclusive lock absent')
    locks();p=policy_load(policy_path)
    if p.get('requireAutomationHold') is not True:raise ValueError('held baseline policy required')
    policy_raw=Path(policy_path).read_bytes();evidence=Path(evidence)
    if evidence.exists():raise ValueError('new held baseline directory required')
    prove_closed()
    def identity():
        x=json.loads(cmd(['docker','inspect',container]))[0];closed_runtime(x)
        if x['Config']['Image']!=image or x['State'].get('Running') is not True or not x.get('Id'):raise ValueError('held baseline exact running image required')
        return {k:x[k] for k in ('Id','RestartCount')}
    source_path=Path(__file__).with_name('qualification-container.mjs').absolute()
    if not isinstance(capture_binding,dict) or set(capture_binding)!={'path','sha256'} or capture_binding['path']!=str(source_path):raise ValueError('fixed capture source binding required')
    source_raw=source_path.read_bytes()
    if digest(source_raw)!=capture_binding['sha256']:raise ValueError('capture source changed')
    first=identity();source=source_raw.decode()
    def capture():
        state=json.loads(cmd(['docker','exec','-i',container,'node','--input-type=module','-e',source,'capture'],json.dumps({**p,'running':True,'baoToken':Path(p['baoTokenFile']).read_text().strip()})))
        ledger=Path(data_dir)/'migrations/journal.json'
        state.update(migrationLedger=json.loads(ledger.read_text()) if ledger.exists() else None,credentials=credential_hashes(Path(data_dir),p),postgres=postgres(p),transportCoverage=transport_coverage,image=image,policyHash=digest(policy_raw))
        return state
    before=capture();after=capture()
    if before!=after or identity()!=first:raise ValueError('held baseline stores or runtime moving')
    prove_closed();locks()
    if source_path.read_bytes()!=source_raw:raise ValueError('capture source changed')
    if Path(policy_path).read_bytes()!=policy_raw:raise ValueError('held baseline policy changed')
    evidence.mkdir(mode=0o700,parents=False,exist_ok=False)
    before.update(kind='held-running-baseline',epoch='postrotation-current',originalPreservationReplaced=False)
    private_json(evidence/'held-running-baseline.json',before)
    proof={'kind':'held-running-current-epoch','container':first,'policyHash':digest(policy_raw),'beforeSHA256':digest((evidence/'held-running-baseline.json').read_bytes()),'originalPreservationReplaced':False,'smokeExecuted':False,'requiresSeparateOriginalPreservationBridge':True}
    private_json(evidence/'baseline-proof.json',proof)
    return proof


def main():
    stage('policy-load');parser=argparse.ArgumentParser();parser.add_argument('--phase',choices=['before','after'],required=True)
    for name in ['container','image','env-file','data-dir','backup-dir','barrier-file','target-image','evidence-dir']:parser.add_argument('--'+name,required=True)
    parser.add_argument('--isolated-loopback-test',action='store_true')
    parser.add_argument('--require-automation-hold',action='store_true')
    parser.add_argument('--policy',default=os.environ.get('LYAM_QUALIFICATION_POLICY','/opt/lyam/qualification.json'));a=parser.parse_args();p=policy_load(a.policy,a.isolated_loopback_test)
    if a.require_automation_hold:
        p['requireAutomationHold']=True
    stage('tls-barriers')
    if not Path(a.barrier_file).is_file():raise ValueError('maintenance barrier absent')
    for origin in p['origins']:
        try: response=urllib.request.urlopen(origin+'/healthz',timeout=15);status=response.status
        except urllib.error.HTTPError as e:status=e.code
        if status!=503:raise ValueError('TLS/host is not protected by maintenance')
    stage('evidence-setup');evidence=Path(a.evidence_dir)
    if a.phase=='before':evidence.mkdir(mode=0o700,parents=False,exist_ok=False)
    elif not evidence.is_dir():raise ValueError('preservation evidence missing')
    source=Path(__file__).with_name('qualification-container.mjs').read_text()
    if a.phase=='before':
        if cmd(['docker','inspect','-f','{{.State.Running}}',a.container])!='false':raise ValueError('application must be stopped for initial preservation capture')
        node=['docker','run','--rm','-i','--network',p['network'],'--env-file',a.env_file,'-v',a.data_dir+':/data:ro','--entrypoint','node',a.image,'--input-type=module','-e',source,'capture']
    else:
        stage('runtime-identity');inspect=json.loads(cmd(['docker','inspect',a.container]))[0]
        if inspect['Config']['Image']!=a.image or not inspect['State']['Running']:raise ValueError('image identity/running mismatch')
        if p.get('requireAutomationHold') is True:
            closed_runtime(inspect)
        stage('runtime-stability');restarts=inspect['RestartCount'];time.sleep(30)
        stable=json.loads(cmd(['docker','inspect',a.container]))[0]
        if stable['RestartCount']!=restarts or not stable['State']['Running']:raise ValueError('candidate is restarting')
        node=['docker','exec','-i',a.container,'node','--input-type=module','-e',source,'capture']
    if a.phase=='after':
        prior=json.loads((evidence/'before.json').read_text())
        legacy_rollback=prior['image']==a.image and prior.get('migrationLedger') is None
        smoke=['docker','exec','-i',a.container,'node','--input-type=module','-e',source,'smoke']
        stage('auth-load');auth=json.loads(Path(p['authFile']).read_text())
        stage('smoke');smoke_result=json.loads(cmd(smoke,json.dumps({**p,'auth':auth,'reviewedLegacyRollback':legacy_rollback})))
    stage('capture');capture_input=json.dumps({**p,'running':a.phase=='after','baoToken':Path(p['baoTokenFile']).read_text().strip()})
    if a.phase=='before' and p.get('isolatedCopy') is True:
        if not a.isolated_loopback_test or p.get('isolatedLoopbackTest') is not True:raise ValueError('copy helper only in explicit loopback qualification')
        import importlib.util
        helper=Path(__file__).with_name('isolated-capture.py');hs=importlib.util.spec_from_file_location('isolated_capture',helper);hm=importlib.util.module_from_spec(hs);hs.loader.exec_module(hm)
        state=json.loads(hm.capture(cmd,a.image,a.env_file,a.data_dir,p['network'],source,capture_input))
    else:state=json.loads(cmd(node,capture_input))
    stage('ledger-load');ledger=Path(a.data_dir)/'migrations/journal.json'
    state['migrationLedger']=json.loads(ledger.read_text()) if ledger.exists() else None
    stage('credentials');state['credentials']=credential_hashes(Path(a.data_dir),p)
    stage('postgres');state['postgres']=postgres(p)
    state['transportCoverage']='ISOLATED_LOOPBACK_NO_PUBLIC_TLS_PROOF' if a.isolated_loopback_test else 'TLS_EXPECTED_ORIGINS';state['image']=a.image;state['policyHash']=digest(Path(a.policy).read_bytes())
    if a.phase=='before':private_json(evidence/'before.json',state);print('Preservation snapshot captured privately; maintenance remains armed');return
    stage('policy-consistency');before=json.loads((evidence/'before.json').read_text())
    if before['transportCoverage']!=state['transportCoverage']:raise ValueError('qualification coverage changed mid-update')
    if before['policyHash']!=state['policyHash']:raise ValueError('qualification policy changed mid-update')
    stage('evidence-write');after_file=evidence/('after-'+digest(a.image.encode())[:16]+'-'+str(time.time_ns())+'.json')
    private_json(after_file,state)
    private_json(evidence/('smoke-'+digest(a.image.encode())[:16]+'-'+str(time.time_ns())+'.json'),smoke_result)
    stage('held-activations')
    if p.get('requireAutomationHold') is True:exact_held_activations(before,state)
    stage('preservation-compare');changes=compare(before,state,p)
    if changes:
        # Each target digest needs a separate reviewed verifier. It receives hash-only snapshots,
        # and must prove ALL declared transformations, including non-target preservation.
        entry=p.get('transformationVerifiers',{}).get(a.image)
        # Versioned verifier interface. A plain string is the LEGACY interface (exactly: BEFORE AFTER), unchanged for verify-0002-*.
        # An object {"path":...,"interface":"categories-v1"} additionally receives the exact change categories as a third argument.
        if isinstance(entry,str):verifier,extra=entry,None
        elif isinstance(entry,dict) and set(entry)=={'path','interface'} and entry['interface']=='categories-v1' and isinstance(entry['path'],str):verifier,extra=entry['path'],','.join(sorted({c.split(':',1)[0] for c in changes}))
        else:verifier,extra=None,None
        if not verifier or not Path(verifier).is_file() or not os.access(verifier,os.X_OK):
            kinds=sorted({c.split(':',1)[0] for c in changes})
            print('PRESERVATION_DIAG_V1 '+json.dumps({'categories':kinds},sort_keys=True),file=sys.stderr)
            raise ValueError('unexpected preservation changes; no digest-specific reviewed verifier')
        stage('transformation-verifier');cmd([verifier,str(evidence/'before.json'),str(after_file)]+([extra] if extra is not None else []))
    print('ISOLATED LOOPBACK ONLY: preservation/OIDC/journal checks passed, NO public TLS qualification, keep production paused' if a.isolated_loopback_test else 'Pre-opening preservation, migration, OIDC, journal and TLS checks passed; caller still owns barrier')
if __name__=='__main__':
    try:main()
    except Exception as error:
        print('QUALIFICATION_DIAG_V1:'+STAGE+(('/'+CHILD_STAGE) if CHILD_STAGE else ''),file=sys.stderr)
        import traceback
        # Diagnostic enums and source line numbers only. Private messages and subprocess output never leave.
        frames=traceback.extract_tb(error.__traceback__)
        lines=[f.lineno for f in frames if Path(f.filename).name=='qualification.py'][-8:]
        kind=type(error).__name__
        if kind not in {'ValueError','RuntimeError','TimeoutExpired','FileNotFoundError','PermissionError','KeyError','TypeError','JSONDecodeError'}:kind='Other'
        print('QUALIFICATION_DIAG_V1 '+json.dumps({'exceptionType':kind,'sourceLines':lines},sort_keys=True),file=sys.stderr)
        print('Qualification failed or UNKNOWN. Keep maintenance armed and inspect private evidence.',file=sys.stderr);sys.exit(1)
