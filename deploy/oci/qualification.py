#!/usr/bin/env python3
"""Pre/post preservation checks. Private files remain local; reports contain only hashes.
Requires a reviewed independent policy and a candidate-specific transform verifier for
any intended business/schema change. No successful default for unknown state.
"""
import urllib.parse
import argparse,collections,hashlib,json,os,re,ssl,subprocess,sys,time,urllib.request,urllib.error
from pathlib import Path

# Failure-stage instrumentation at the exception boundary: a failure reports ONLY a
# closed-enum stage token (never exception content), so a masked UNKNOWN is still
# attributable to a zone: policy/barrier/evidence/capture(dolt,bao)/files/permissions.
PY_STAGES={'POLICY','BARRIER','EVIDENCE_DIR','APP_STOPPED','AFTER_IMAGE','AFTER_STABILITY','CAPTURE','SMOKE','LEDGER','CREDENTIALS','POSTGRES','COVERAGE','VERIFIER','EVIDENCE_WRITE'}
CHILD_STAGES={'INPUT','MODE','OUTPUT','DOLT_COPY','DOLT_QUERY','BAO_HEALTH','BAO_WALK','SMOKE_HEALTH','SMOKE_LOGIN','SMOKE_TOKEN','SMOKE_SESSION','SMOKE_JOURNAL','SMOKE_NEGATIVE','SMOKE_LEDGER'}
class StageFailure(Exception):
    def __init__(self,stage):super().__init__('stage='+stage);self.stage=stage
_state={'stage':'POLICY'}
def mark(s):
    if s not in PY_STAGES:raise ValueError('unknown stage token')
    _state['stage']=s
def current_stage():return _state['stage']
_CHILD_RE=re.compile(r'\(stage=([A-Z_]+)\)')
def child_stage(stderr):
    found=[t for t in _CHILD_RE.findall(stderr or '') if t in CHILD_STAGES]
    return found[-1] if found else None

def cmd(args, input=None, child=False, timeout=180):
    r=subprocess.run(args,input=input,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
    if r.returncode:
        if child:raise StageFailure(child_stage(r.stderr) or current_stage())
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

def auth_probe(container, image, p, runner=None, timeout=90):
    """Pre-gate probe: prove the configured qualification credentials still complete the
    OIDC login the after-phase smoke needs, against the RUNNING current version, BEFORE
    the maintenance gate is armed (stale static credentials discovered only at the
    smoke phase are the recurring incident class). A probe failure leaves the gate and
    the running service untouched. Side-effect boundary: ONE real password login (first
    origin only; later origins get a form-only check) - issuer-side session/audit
    entries may be created and account lockout policies apply; the authorization code
    is never redeemed, and no application data, gate or deployment state changes.
    HONEST SCOPE: the image-identity check below is near-tautological (the caller just
    read that same image from the same container) and the probe says NOTHING about
    public reachability or TLS - it proves only that these credentials complete this
    login against this locally running container."""
    runner=runner or cmd
    mark('AFTER_IMAGE')
    inspect=json.loads(runner(['docker','inspect',container]))
    if inspect[0]['Config']['Image']!=image or not inspect[0]['State']['Running']:raise ValueError('auth probe target must be the running current image')
    mark('SMOKE')
    source=Path(__file__).with_name('qualification-container.mjs').read_text()
    auth=json.loads(Path(p['authFile']).read_text())
    # Whitelisted payload ONLY: the probe needs the expected origins and the credentials,
    # nothing else from the policy - a policy-derived redirect target (e.g. localBase)
    # must never reach the credential-bearing child.
    runner(['docker','exec','-i',container,'node','--input-type=module','-e',source,'authprobe'],json.dumps({'origins':p['origins'],'auth':auth}),child=True,timeout=timeout)
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--phase',choices=['before','after','authprobe'],required=True)
    for name in ['container','image','env-file','data-dir','backup-dir','barrier-file','target-image','evidence-dir']:parser.add_argument('--'+name,required=True)
    parser.add_argument('--isolated-loopback-test',action='store_true')
    parser.add_argument('--policy',default='/opt/lyam/qualification.json');a=parser.parse_args();p=policy_load(a.policy,a.isolated_loopback_test)
    if a.phase=='authprobe':
        _state['probe']=True
        auth_probe(a.container,a.image,p)
        print('Qualification auth probe passed: the configured credentials completed the OIDC login against the running current version; the maintenance gate was never armed (issuer-side session/audit entries may have been created)')
        return
    mark('BARRIER')
    if not Path(a.barrier_file).is_file():raise ValueError('maintenance barrier absent')
    for origin in p['origins']:
        try: response=urllib.request.urlopen(origin+'/healthz',timeout=15);status=response.status
        except urllib.error.HTTPError as e:status=e.code
        if status!=503:raise ValueError('TLS/host is not protected by maintenance')
    mark('EVIDENCE_DIR')
    evidence=Path(a.evidence_dir)
    if a.phase=='before':evidence.mkdir(mode=0o700,parents=False,exist_ok=False)
    elif not evidence.is_dir():raise ValueError('preservation evidence missing')
    source=Path(__file__).with_name('qualification-container.mjs').read_text()
    if a.phase=='before':
        mark('APP_STOPPED')
        if cmd(['docker','inspect','-f','{{.State.Running}}',a.container])!='false':raise ValueError('application must be stopped for initial preservation capture')
        mark('CAPTURE')
        node=['docker','run','--rm','-i','--network',p['network'],'--env-file',a.env_file,'-v',a.data_dir+':/data:ro','--entrypoint','node',a.image,'--input-type=module','-e',source,'capture']
    else:
        mark('AFTER_IMAGE')
        inspect=json.loads(cmd(['docker','inspect',a.container]))[0]
        if inspect['Config']['Image']!=a.image or not inspect['State']['Running']:raise ValueError('image identity/running mismatch')
        mark('AFTER_STABILITY')
        restarts=inspect['RestartCount'];time.sleep(30)
        stable=json.loads(cmd(['docker','inspect',a.container]))[0]
        if stable['RestartCount']!=restarts or not stable['State']['Running']:raise ValueError('candidate is restarting')
        node=['docker','exec','-i',a.container,'node','--input-type=module','-e',source,'capture']
    if a.phase=='after':
        prior=json.loads((evidence/'before.json').read_text())
        legacy_rollback=prior['image']==a.image and prior.get('migrationLedger') is None
        mark('SMOKE')
        smoke=['docker','exec','-i',a.container,'node','--input-type=module','-e',source,'smoke']
        auth=json.loads(Path(p['authFile']).read_text())
        smoke_result=json.loads(cmd(smoke,json.dumps({**p,'auth':auth,'reviewedLegacyRollback':legacy_rollback}),child=True))
    mark('CAPTURE')
    state=json.loads(cmd(node,json.dumps({**p,'running':a.phase=='after','baoToken':Path(p['baoTokenFile']).read_text().strip()}),child=True))
    mark('LEDGER')
    ledger=Path(a.data_dir)/'migrations/journal.json'
    state['migrationLedger']=json.loads(ledger.read_text()) if ledger.exists() else None
    mark('CREDENTIALS')
    state['credentials']=credential_hashes(Path(a.data_dir),p)
    mark('POSTGRES')
    state['postgres']=postgres(p)
    state['transportCoverage']='ISOLATED_LOOPBACK_NO_PUBLIC_TLS_PROOF' if a.isolated_loopback_test else 'TLS_EXPECTED_ORIGINS';state['image']=a.image;state['policyHash']=digest(Path(a.policy).read_bytes())
    if a.phase=='before':
        mark('EVIDENCE_WRITE');private_json(evidence/'before.json',state);print('Preservation snapshot captured privately; maintenance remains armed');return
    mark('COVERAGE')
    before=json.loads((evidence/'before.json').read_text())
    if before['transportCoverage']!=state['transportCoverage']:raise ValueError('qualification coverage changed mid-update')
    if before['policyHash']!=state['policyHash']:raise ValueError('qualification policy changed mid-update')
    mark('EVIDENCE_WRITE')
    after_file=evidence/('after-'+digest(a.image.encode())[:16]+'-'+str(time.time_ns())+'.json')
    private_json(after_file,state)
    private_json(evidence/('smoke-'+digest(a.image.encode())[:16]+'-'+str(time.time_ns())+'.json'),smoke_result)
    changes=compare(before,state,p)
    if changes:
        # Each target digest needs a separate reviewed verifier. It receives hash-only snapshots,
        # and must prove ALL declared transformations, including non-target preservation.
        mark('VERIFIER')
        verifier=p.get('transformationVerifiers',{}).get(a.image)
        if not verifier or not Path(verifier).is_file() or not os.access(verifier,os.X_OK):raise ValueError('unexpected preservation changes; no digest-specific reviewed verifier')
        cmd([verifier,str(evidence/'before.json'),str(after_file)])
    print('ISOLATED LOOPBACK ONLY: preservation/OIDC/journal checks passed, NO public TLS qualification, keep production paused' if a.isolated_loopback_test else 'Pre-opening preservation, migration, OIDC, journal and TLS checks passed; caller still owns barrier')
if __name__=='__main__':
    try:main();sys.exit(0)
    except StageFailure as e:stage=e.stage
    except Exception:stage=current_stage()
    if _state.get('probe'):
        print('Qualification auth probe failed or UNKNOWN (stage=%s). The maintenance gate was never armed; the running service is untouched (issuer-side session/audit entries may exist).'%stage,file=sys.stderr);sys.exit(1)
    print('Qualification failed or UNKNOWN (stage=%s). Keep maintenance armed and inspect private evidence.'%stage,file=sys.stderr);sys.exit(1)
