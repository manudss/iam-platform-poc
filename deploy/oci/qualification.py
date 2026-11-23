#!/usr/bin/env python3
"""Pre/post preservation checks. Private files remain local; reports contain only hashes.
Requires a reviewed independent policy and a candidate-specific transform verifier for
any intended business/schema change. No successful default for unknown state.
"""
import urllib.parse
import argparse,collections,hashlib,json,os,re,ssl,subprocess,sys,time,urllib.request,urllib.error
from pathlib import Path

def cmd(args, input=None):
    r=subprocess.run(args,input=input,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=180)
    if r.returncode: raise ValueError('command failed, private diagnostic inspection required')
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

def activation_journal(p):
    # Independent privileged read uses the already-required PostgreSQL qualification account.
    # It does not grant a low-assurance web session access to the administrator journal.
    rows=query(p,"SELECT coalesce(json_agg(x ORDER BY seq),'[]') FROM (SELECT a.*,commit_hash AS \"commit\",request_id AS \"requestId\" FROM public.activations a WHERE tenant="+lit(p['tenant'])+") x")
    if not isinstance(rows,list):raise ValueError('activation journal unknown')
    last=0
    for r in rows:
        if not isinstance(r,dict) or r.get('tenant')!=p['tenant'] or type(r.get('seq')) is not int or r['seq']<=last or not isinstance(r.get('commit'),str) or not r['commit'].strip() or r.get('state') not in ['pending','recorded','applied','failed'] or any(r.get(k) is not None and not isinstance(r[k],str) for k in ['error','requestId']):raise ValueError('activation journal schema unknown')
        last=r['seq']
    return rows

def journal_projection(rows):return [{'seq':r['seq'],'commit':r['commit']} for r in rows]

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--phase',choices=['before','after'],required=True)
    for name in ['container','image','env-file','data-dir','backup-dir','barrier-file','target-image','evidence-dir']:parser.add_argument('--'+name,required=True)
    parser.add_argument('--receipt-file')
    parser.add_argument('--isolated-loopback-test',action='store_true')
    parser.add_argument('--policy',default='/opt/lyam/qualification.json');a=parser.parse_args();p=policy_load(a.policy,a.isolated_loopback_test)
    if not Path(a.barrier_file).is_file():raise ValueError('maintenance barrier absent')
    for origin in p['origins']:
        try: response=urllib.request.urlopen(origin+'/healthz',timeout=15);status=response.status
        except urllib.error.HTTPError as e:status=e.code
        if status!=503:raise ValueError('TLS/host is not protected by maintenance')
    evidence=Path(a.evidence_dir)
    if a.phase=='before':evidence.mkdir(mode=0o700,parents=False,exist_ok=False)
    elif not evidence.is_dir():raise ValueError('preservation evidence missing')
    source=Path(__file__).with_name('qualification-container.mjs').read_text()
    if a.phase=='before':
        if cmd(['docker','inspect','-f','{{.State.Running}}',a.container])!='false':raise ValueError('application must be stopped for initial preservation capture')
        node=['docker','run','--rm','-i','--network',p['network'],'--env-file',a.env_file,'-v',a.data_dir+':/data:ro','--entrypoint','node',a.image,'--input-type=module','-e',source,'capture']
    else:
        inspect=json.loads(cmd(['docker','inspect',a.container]))[0]
        if inspect['Config']['Image']!=a.image or not inspect['State']['Running']:raise ValueError('image identity/running mismatch')
        restarts=inspect['RestartCount'];time.sleep(30)
        stable=json.loads(cmd(['docker','inspect',a.container]))[0]
        if stable['RestartCount']!=restarts or not stable['State']['Running']:raise ValueError('candidate is restarting')
        node=['docker','exec','-i',a.container,'node','--input-type=module','-e',source,'capture']
    if a.phase=='after':
        prior=json.loads((evidence/'before.json').read_text())
        legacy_rollback=prior['image']==a.image and prior.get('migrationLedger') is None
        smoke=['docker','exec','-i',a.container,'node','--input-type=module','-e',source,'smoke']
        journal_before=activation_journal(p)
        auth=json.loads(Path(p['authFile']).read_text())
        smoke_result=json.loads(cmd(smoke,json.dumps({**p,'auth':auth,'reviewedLegacyRollback':legacy_rollback,'expectedActivationRows':journal_projection(journal_before),'expectedActivationChecksum':digest(json.dumps(journal_before,sort_keys=True,separators=(',',':')).encode())})))
    if a.phase=='after' and activation_journal(p)!=journal_before:raise ValueError('activation journal changed during smoke, repeat qualification after reconciliation')
    state=json.loads(cmd(node,json.dumps({**p,'running':a.phase=='after','baoToken':Path(p['baoTokenFile']).read_text().strip()})))
    ledger=Path(a.data_dir)/'migrations/journal.json'
    state['migrationLedger']=json.loads(ledger.read_text()) if ledger.exists() else None
    state['credentials']=credential_hashes(Path(a.data_dir),p);state['postgres']=postgres(p)
    state['transportCoverage']='ISOLATED_LOOPBACK_NO_PUBLIC_TLS_PROOF' if a.isolated_loopback_test else 'TLS_EXPECTED_ORIGINS';state['image']=a.image;state['policyHash']=digest(Path(a.policy).read_bytes())
    if a.phase=='before':private_json(evidence/'before.json',state);print('Preservation snapshot captured privately; maintenance remains armed');return
    before=json.loads((evidence/'before.json').read_text())
    if before['transportCoverage']!=state['transportCoverage']:raise ValueError('qualification coverage changed mid-update')
    if before['policyHash']!=state['policyHash']:raise ValueError('qualification policy changed mid-update')
    after_file=evidence/('after-'+digest(a.image.encode())[:16]+'-'+str(time.time_ns())+'.json')
    private_json(after_file,state)
    smoke_file=evidence/('smoke-'+digest(a.image.encode())[:16]+'-'+str(time.time_ns())+'.json')
    private_json(smoke_file,smoke_result)
    changes=compare(before,state,p)
    if changes:
        # Each target digest needs a separate reviewed verifier. It receives hash-only snapshots,
        # and must prove ALL declared transformations, including non-target preservation.
        verifier=p.get('transformationVerifiers',{}).get(a.image)
        if not verifier or not Path(verifier).is_file() or not os.access(verifier,os.X_OK):raise ValueError('unexpected preservation changes; no digest-specific reviewed verifier')
        cmd([verifier,str(evidence/'before.json'),str(after_file)])
    private_json(Path(a.receipt_file) if a.receipt_file else evidence/('qualified-'+digest(a.image.encode())[:16]+'-'+str(time.time_ns())+'.json'),{'before_path':str(evidence/'before.json'),'after_path':str(after_file),'smoke_path':str(smoke_file),'format':1,'result':'qualified','image':a.image,'policyHash':state['policyHash'],'before_sha256':digest((evidence/'before.json').read_bytes()),'after_sha256':digest(after_file.read_bytes()),'smoke_sha256':digest(smoke_file.read_bytes()),'transportCoverage':state['transportCoverage']})
    print('ISOLATED LOOPBACK ONLY: preservation/OIDC/journal checks passed, NO public TLS qualification, keep production paused' if a.isolated_loopback_test else 'Pre-opening preservation, migration, OIDC, journal and TLS checks passed; caller still owns barrier')
if __name__=='__main__':
    try:main()
    except Exception:print('Qualification failed or UNKNOWN. Keep maintenance armed and inspect private evidence.',file=sys.stderr);sys.exit(1)
