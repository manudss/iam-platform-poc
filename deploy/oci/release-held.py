#!/usr/bin/env python3
"""Reviewed held-to-normal release journal. No rollback after normal startup.
The host adapter is a separately hash-bound installed controller, never user code.
"""
import copy, datetime, hashlib, json, os, re, stat
from pathlib import Path

PHASES = ('prepared', 'closing', 'env-installing', 'closed', 'env-installed', 'normal-start-committed', 'normal-verified', 'opening', 'failed-closed', 'failed-access-unknown')

def validate_state(s):
    if s.get('format') != 4: return
    history=s.get('history',[])
    if not history or len({e.get('sha') for e in history})!=len(history) or any(not re.fullmatch(r'sha256:[a-f0-9]{64}',e.get('digest','')) for e in history):raise ValueError('unique digest-bound history required')
    if s.get('delivery_mode') not in ('release-pending', 'normal'): raise ValueError('format 4 mode invalid')
    i = s.get('release_intent')
    if i is not None:
        if not isinstance(i, dict) or i.get('phase') not in PHASES or not isinstance(i.get('manifest'), dict) or not isinstance(i.get('queue'), dict): raise ValueError('invalid release intent')
        expected=i.get('expected')
        if not isinstance(expected,dict) or not isinstance(i.get('normal_start_committed'),bool) or not isinstance(i.get('events'),list):raise ValueError('release expected state or commit marker invalid')
        if s.get('resume_required') is not True or s['delivery_mode'] != 'release-pending': raise ValueError('release barrier absent')
    else:
        a = s.get('releases', [])
        if not a or s['delivery_mode'] != 'normal' or s.get('resume_required') is not False: raise ValueError('completed release audit required')
        if a[-1].get('target',{}).get('sha') != s.get('recovery_fence') or a[-1].get('target') not in [{k:e[k] for k in ('sha','digest')} for e in s['history']]: raise ValueError('release fence differs')
        observation=a[-1].get('observed_running', {})
        if any(observation.get(k)!=a[-1]['target'].get(k) for k in ('sha','digest')) or observation.get('held') is not False or observation.get('settingPresent') is not False:raise ValueError('release observation differs')
        if not s.get('resumptions') or s['resumptions'][-1].get('observed_running')!=observation:raise ValueError('release/resumption audit differs')


def preconditions(q, state, manifest, pause, container, observe):
    if state.get('format') not in (3,5) or state.get('resume_required') is not True or not pause: raise ValueError('resolved paused held state required')
    if any(state.get(k) for k in ('pending','failed','opening_intent','release_intent')): raise ValueError('another operation unresolved')
    last = state['history'][-1]
    if last.get('mode') not in ('ui-open-automation-held','restored-automation-held') or last.get('automation_held') is not True or state.get('recovery_fence') != last['sha']: raise ValueError('held fence required')
    q.checked_manifest(state, manifest, 'reviewed-release-held')
    if not re.fullmatch(r'[A-Za-z0-9._-]{8,64}', str(manifest.get('engagement_id',''))): raise ValueError('release engagement required')
    if set(manifest.get('target',{})) != {'sha','digest'} or any(manifest['target'][k] != last[k] for k in ('sha','digest')): raise ValueError('same-image release only')
    target=copy.deepcopy(manifest['target'])
    observed=observe(container,target)
    if any(observed.get(k)!=target[k] for k in ('sha','digest')) or observed.get('held') is not True or observed.get('running') is not True:raise ValueError('live runtime/journal divergence or non-held runtime')
    return target


def release(q, path, manifest, container, host, pause, hook=None):
    state = q.load(path,allow_restored=True)
    target = preconditions(q, state, manifest, Path(pause).is_file(), container, host.observe_held)
    # This MUST establish controllers/boot guard, live identities, exact config,
    # real backlog + isolated-copy evidence, absence of competing workers, gates.
    host.preflight(state, manifest, container, target)
    original = q.fingerprint(state)
    intent = {'phase':'prepared','queue':q.queue_identity(),'manifest':copy.deepcopy(manifest),'container':container,'target':target,'prior_fingerprint':original,'gates':host.plan_gates(),'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'expected':host.expected_state() if hasattr(host,'expected_state') else {},'normal_start_committed':False,'events':[]}
    state.update(format=4, delivery_mode='release-pending', release_intent=intent)
    def persist(phase):
        intent['phase']=phase;intent['events'].append({'phase':phase,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}); q.atomic(path,state)
        if hook: hook(phase)
    persist('prepared')
    if hasattr(host,'bind_intent'):host.bind_intent(intent,lambda:q.atomic(path,state))
    try:
        persist('closing');host.close_access(intent); persist('closed')
        persist('env-installing');host.install_normal_env(intent); persist('env-installed')
        # Commit marker is durable BEFORE startup. A crash here is ambiguous and
        # must never cause another automatic startup or an environment rollback.
        if hasattr(host,'before_commit'):host.before_commit(intent)
        intent['normal_start_committed']=True;persist('normal-start-committed')
        host.start_normal(intent)
        proof = host.verify_normal(intent)
        if proof.get('held') is not False or proof.get('settingPresent') is not False or proof.get('sha') != target['sha'] or proof.get('digest') != target['digest']: raise ValueError('normal runtime evidence incomplete')
        intent['observed_running']=proof; persist('normal-verified')
        persist('opening'); host.open_access(intent)
        # Single atomic journal commit. history remains a unique source chain.
        at=datetime.datetime.now(datetime.timezone.utc).isoformat()
        state.setdefault('releases',[]).append({'target':target,'at':at,'manifest':copy.deepcopy(manifest),'observed_running':proof,'prior_fingerprint':original,'expected':copy.deepcopy(intent['expected']),'gates':copy.deepcopy(intent['gates'])})
        state.setdefault('resumptions',[]).append({'at':at,'state_fingerprint':original,'manifest_claims':{'authorization_ref':manifest['authorization_ref'],'evidence_refs':manifest['evidence_refs'],'verified_authority':False},'observed_running':proof,'kind':'reviewed-release-held'})
        state.update(resume_required=False,delivery_mode='normal',release_finalize_required=True); del state['release_intent']
        validate_state(state); q.atomic(path,state)
        if hook: hook('journal-committed')
        # This removes ONLY the exact pause recorded before effects. Failure
        # leaves a fully audited normal runtime with automation deployment paused.
        host.finish_pause(intent)
        state['release_finalize_required']=False;q.atomic(path,state)
        return state
    except BaseException:
        # Do not rewrite a committed journal from an obsolete in-memory intent.
        if 'release_intent' not in state: raise
        intent['failed_from']=intent['phase']
        try: host.close_access(intent); intent['phase']='failed-closed'
        except BaseException: intent['phase']='failed-access-unknown'
        q.atomic(path,state)
        raise


def release_env_bytes(raw):
    """Remove exactly one HOLD=1 line, preserving every other byte and newline."""
    if len(raw)>1024*1024 or b'\x00' in raw: raise ValueError('invalid bounded environment')
    lines=raw.splitlines(keepends=True); seen=set(); index=None
    for i,line in enumerate(lines):
        value=line.rstrip(b'\r\n')
        if not value or value.startswith(b'#'): continue
        key,sep,val=value.partition(b'=')
        if not sep or not re.fullmatch(rb'[A-Za-z_][A-Za-z0-9_]*',key) or key in seen: raise ValueError('malformed or duplicate environment setting')
        seen.add(key)
        if key==b'IAM_AUTOMATION_HOLD':
            if val!=b'1': raise ValueError('hold must be exactly 1')
            index=i
    if index is None: raise ValueError('hold absent')
    return b''.join(line for i,line in enumerate(lines) if i!=index)


def install_env(path, expected, expected_uid=0, expected_gid=0, check_ancestry=True):
    path=Path(path)
    if not path.is_absolute() or '..' in path.parts:raise ValueError('absolute environment path required')
    for parent in (path.parents if check_ancestry else []):
        ps=parent.lstat()
        if parent.is_symlink() or ps.st_uid!=expected_uid or ps.st_mode&0o022:raise ValueError('environment ancestor not protected')
    st=path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or stat.S_IMODE(st.st_mode)!=0o600 or st.st_uid!=expected_uid or st.st_gid!=expected_gid: raise ValueError('private original environment metadata required')
    raw=path.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=expected: raise ValueError('environment bytes changed')
    out=release_env_bytes(raw)
    tmp=path.with_name(path.name+'.release-'+os.urandom(8).hex())
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        with os.fdopen(fd,'wb') as f:
            os.fchown(f.fileno(),st.st_uid,st.st_gid);f.write(out);f.flush();os.fsync(f.fileno())
        current=path.lstat()
        if (current.st_dev,current.st_ino)!=(st.st_dev,st.st_ino) or path.read_bytes()!=raw: raise ValueError('environment changed during preparation')
        os.replace(tmp,path);d=os.open(path.parent,os.O_RDONLY)
        try:os.fsync(d)
        finally:os.close(d)
    finally:
        if tmp.exists():tmp.unlink()
    return {'before_sha256':expected,'after_sha256':hashlib.sha256(out).hexdigest(),'uid':st.st_uid,'gid':st.st_gid,'mode':0o600}


def finalize(q,path,pause,host_factory):
    state=q.load(path)
    if state.get('format')!=4 or state.get('release_finalize_required') is not True or state.get('pending') or state.get('failed'):raise ValueError('committed release finalization required')
    audit=state['releases'][-1]
    if any(state['history'][-1][k]!=audit['target'][k] for k in ('sha','digest')):raise ValueError('later delivery forbids release finalization')
    host=host_factory(audit['manifest'])
    host.verify_finalization(audit,pause)
    if q.load(path)!=state:raise ValueError('journal changed during finalization')
    host.finish_finalization(audit)
    state['release_finalize_required']=False;q.atomic(path,state)
    return state
