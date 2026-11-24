#!/usr/bin/env python3
"""Durable ordered deployment journal. Root-owned, preinstalled operator trust boundary.
Never fetched from an unqualified commit by an automatic deploy. No network credentials.
"""
import time, hashlib, argparse, fcntl, json, os, re, subprocess, sys, tempfile, datetime
from pathlib import Path
SHA = re.compile(r'^[a-f0-9]{40}$')
DIGEST = re.compile(r'^sha256:[a-f0-9]{64}$')

def atomic(path, value):
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.state-', text=True)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out, indent=2); out.write('\n'); out.flush(); os.fsync(out.fileno())
        os.replace(tmp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def load(path):
    state = json.loads(path.read_text())
    if state.get('format') not in [1,2,3] or not isinstance(state.get('history'), list) or not state['history']:
        raise ValueError('uninitialized or corrupt deployment history')
    if any(not SHA.fullmatch(e.get('sha','')) for e in state['history']): raise ValueError('invalid history')
    if state['format'] in [2,3]:
        fence=state.get('recovery_fence','');recoveries=state.get('recoveries')
        if not SHA.fullmatch(fence) or type(state.get('resume_required')) is not bool or not isinstance(recoveries,list) or not recoveries:
            raise ValueError('corrupt recovery fence/barrier/audit')
        if recoveries[-1].get('target',{}).get('sha')!=fence or fence not in [e['sha'] for e in state['history']]:
            raise ValueError('recovery audit/history divergence')
        if not state['resume_required'] and (not state.get('resumptions') or state['resumptions'][-1].get('observed_running',{}).get('sha')!=fence):
            raise ValueError('resume barrier removed without matching audit')
    return state

def validate(plan):
    if plan.get('format') != 1 or not SHA.fullmatch(plan.get('base','')): raise ValueError('invalid plan')
    entries = plan.get('entries')
    if not isinstance(entries,list) or len(entries)>256: raise ValueError('invalid/bounded queue')
    parent = plan['base']; seen = {parent}
    for e in entries:
        if not SHA.fullmatch(e.get('sha','')) or e['sha'] in seen or e.get('parent') != parent or not DIGEST.fullmatch(e.get('digest','')):
            raise ValueError('gap, duplicate, unqualified image or invalid plan')
        seen.add(e['sha']); parent=e['sha']
    return entries

def deploy(path, plan, updater, runner=subprocess.run):
    entries=validate(plan); state=load(path)
    if state.get('opening_intent') or state.get('pending') or state.get('failed') or state.get('resume_required'): raise ValueError('prior deployment unresolved, operator review required')
    confirmed=[e['sha'] for e in state['history']]
    if state.get('recovery_fence') and (plan['base'] not in confirmed or confirmed.index(plan['base'])<confirmed.index(state['recovery_fence'])):
        raise ValueError('plan predates reviewed recovery fence; recover a fresh plan')
    if plan['base'] not in confirmed: raise ValueError('unknown baseline, no implicit adoption/rewind')
    offset=confirmed.index(plan['base'])+1
    overlap=min(len(entries),len(confirmed)-offset)
    for i in range(overlap):
        old=state['history'][offset+i]
        if old['sha']!=entries[i]['sha']:
            raise ValueError('deployment history divergence')
        # An overlapping qualified workflow may rebuild the same source SHA with
        # different generated build-time signing keys. Its digest is NOT deployed,
        # substituted, or written over the already-confirmed historical digest.
    if offset+overlap<len(confirmed):
        if overlap==len(entries): return state  # older runner completed after a newer runner
        raise ValueError('noncontiguous plan')
    for entry in entries[overlap:]:
        state['pending']=entry; atomic(path,state)
        result=runner([updater,'--image','ghcr.io/manudss/iam-platform-poc@'+entry['digest'],'--require-qualification'],check=False)
        if result.returncode:
            state['failed']={'sha':entry['sha'],'digest':entry['digest'],'exit':result.returncode,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
            atomic(path,state)
            raise RuntimeError('deployment failed; queue blocked, no later commit attempted')
        state['history'].append({**entry,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
        del state['pending']; atomic(path,state)
    return state

# Format 2 is intentional: an old preinstalled queue executable must refuse the
# recovered journal rather than ignore the recovery fence/resume barrier.
def fingerprint(state):
    import hashlib
    return hashlib.sha256(json.dumps(state,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def reference(value):
    if not isinstance(value,str) or not value.strip() or len(value)>2048:
        raise ValueError('bounded operator approval/evidence reference required')
    return value

def references(value):
    if not isinstance(value,list) or not 1<=len(value)<=20: raise ValueError('evidence references required')
    return [reference(v) for v in value]

def checked_manifest(state, manifest, kind):
    if manifest.get('format')!=1 or manifest.get('kind')!=kind: raise ValueError('wrong reviewed manifest kind/format')
    if manifest.get('state_fingerprint')!=fingerprint(state): raise ValueError('stale reviewed state fingerprint')
    expected=manifest.get('expected_delivered',{})
    if not SHA.fullmatch(expected.get('sha','')) or not DIGEST.fullmatch(expected.get('digest','')):
        raise ValueError('exact last delivered source/digest required')
    if any(expected[k]!=state['history'][-1].get(k) for k in ['sha','digest']): raise ValueError('delivered cursor changed')
    reference(manifest.get('authorization_ref'))
    references(manifest.get('evidence_refs'))
    # References are operator attestations, never authentication or proof of consent.

def command_output(args):
    result=subprocess.run(args,check=True,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
    return result.stdout.strip()

def verify_source_chain(repository, base, chain):
    target=chain[-1]['sha']
    actual=command_output(['git','-C',str(repository),'rev-list','--first-parent','--parents','--reverse',base+'..'+target])
    rows=[line.split() for line in actual.splitlines()]
    if len(rows)!=len(chain) or any(len(row)<2 or row[0]!=entry['sha'] or row[1]!=entry['parent'] for row,entry in zip(rows,chain)):
        raise ValueError('reviewed chain is not the exact first-parent source chain')
    mainline=command_output(['git','-C',str(repository),'rev-list','--first-parent','refs/remotes/origin/main']).splitlines()
    if target not in mainline: raise ValueError('recovery target is not on reviewed origin/main first-parent history')

def observe_running(container, target):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}',container or ''): raise ValueError('explicit container name required')
    ref='ghcr.io/manudss/iam-platform-poc@'+target['digest']
    containers=json.loads(command_output(['docker','inspect','--type','container',container]))
    images=json.loads(command_output(['docker','image','inspect',ref]))
    if len(containers)!=1 or len(images)!=1: raise ValueError('ambiguous running image observation')
    running,image=containers[0],images[0]
    if running.get('State',{}).get('Running') is not True or running.get('Config',{}).get('Image')!=ref:
        raise ValueError('recovery target is not actually running by exact digest')
    if running.get('Image')!=image.get('Id') or ref not in image.get('RepoDigests',[]):
        raise ValueError('running container image ID/digest mismatch')
    if image.get('Config',{}).get('Labels',{}).get('org.opencontainers.image.revision')!=target['sha']:
        raise ValueError('running image source revision mismatch')
    return {'sha':target['sha'],'digest':target['digest'],'image_id':image['Id'],'container':container,'running':True}

def record_reviewed_recovery(path,manifest,repository,container,verify=verify_source_chain,observe=observe_running,*,_in_place=False):
    import copy
    state=load(path);checked_manifest(state,manifest,'reviewed-in-place' if _in_place else 'reviewed-recovery')
    if state.get('opening_intent'):raise ValueError('interrupted opening blocks incident adoption')
    pending,failed=state.get('pending'),state.get('failed')
    if not pending or not failed or state.get('resume_required'): raise ValueError('exact pending+failed incident required, not an unreviewed resume')
    if failed.get('sha')!=pending.get('sha') or pending.get('parent')!=state['history'][-1]['sha'] or not DIGEST.fullmatch(pending.get('digest','')):
        raise ValueError('inconsistent unresolved incident')
    chain=manifest.get('chain')
    if not isinstance(chain,list) or not (len(chain)==1 if _in_place else 2<=len(chain)<=256): raise ValueError('bounded reviewed chain including failed entry and observed target required')
    parent=state['history'][-1]['sha'];seen={parent}
    for i,entry in enumerate(chain):
        if not isinstance(entry,dict) or not SHA.fullmatch(entry.get('sha','')) or entry['sha'] in seen or entry.get('parent')!=parent:
            raise ValueError('gap, duplicate or invalid recovery chain')
        outcome=entry.get('outcome')
        if (i<len(chain)-1 and outcome not in ['replaced','abandoned']) or (i==len(chain)-1 and outcome!='delivered'):
            raise ValueError('every non-target source needs an explicit not-delivered outcome')
        seen.add(entry['sha']);parent=entry['sha']
    if chain[0]['sha']!=pending['sha']: raise ValueError('chain does not start with the actual failed source')
    target=manifest.get('target',{})
    if target.get('sha')!=chain[-1]['sha'] or not DIGEST.fullmatch(target.get('digest','')): raise ValueError('exact corrected target source/digest required')
    in_place=_in_place
    if in_place and any(target.get(k)!=pending.get(k) for k in ['sha','digest']):
        raise ValueError('in-place qualification must use exact original pending source and digest')
    if in_place:
        if manifest.get('original_unresolved')!={'pending':pending,'failed':failed}:raise ValueError('exact original incident required')
        if failed.get('digest',pending['digest'])!=pending['digest']:raise ValueError('failed/pending digest divergence')
        verify_qualification_receipt(manifest.get('qualification_receipt'),target)
    qualification=manifest.get('qualification',{})
    if any(qualification.get(k)!=target[k] for k in ['sha','digest']): raise ValueError('qualification attestation must bind exact target')
    references(qualification.get('evidence_refs'))
    verify(repository,state['history'][-1]['sha'],chain)
    observation=observe(container,target)
    now=datetime.datetime.now(datetime.timezone.utc).isoformat()
    audit={'kind':'reviewed-in-place' if in_place else 'reviewed-recovery','recovery_mode':'qualified-in-place' if in_place else 'replacement-chain','at':now,'state_fingerprint':fingerprint(state),
           'authorization_ref':manifest['authorization_ref'],'evidence_refs':manifest['evidence_refs'],
           'original_unresolved':{'pending':copy.deepcopy(pending),'failed':copy.deepcopy(failed)},
           'chain':copy.deepcopy(chain),'target':copy.deepcopy(target),'qualification_attestation':copy.deepcopy(qualification),
           'observed_running':observation,**({'qualification_receipt':copy.deepcopy(manifest['qualification_receipt'])} if in_place else {})}
    state.setdefault('recoveries',[]).append(audit)
    state['history'].append({**target,'at':now,'mode':'observed-reviewed-recovery'})
    del state['pending'];del state['failed']
    state.update(format=2,recovery_fence=target['sha'],resume_required=True)
    atomic(path,state)
    return state

def verify_qualification_receipt(proof,target):
    if not isinstance(proof,dict) or set(proof)!={'receipt','before','after','smoke'}:raise ValueError('complete private qualification receipt required')
    values={}
    for key,spec in proof.items():
        if not isinstance(spec,dict) or set(spec)!={'path','sha256'} or not re.fullmatch('[a-f0-9]{64}',spec.get('sha256','')):raise ValueError('invalid evidence hash')
        path=Path(spec.get('path',''))
        if not path.is_absolute() or not path.is_file() or path.stat().st_size>64*1024*1024:raise ValueError('private evidence file absent or oversized')
        raw=path.read_bytes()
        if hashlib.sha256(raw).hexdigest()!=spec['sha256']:raise ValueError('qualification evidence hash mismatch')
        values[key]=json.loads(raw)
    receipt=values['receipt'];image='ghcr.io/manudss/iam-platform-poc@'+target['digest']
    if receipt.get('format')!=1 or receipt.get('result')!='qualified' or receipt.get('image')!=image or receipt.get('transportCoverage')!='TLS_EXPECTED_ORIGINS':raise ValueError('exact successful qualification receipt required')
    for key in ['before','after','smoke']:
        if receipt.get(key+'_sha256')!=proof[key]['sha256']:raise ValueError('qualification receipt evidence divergence')
    if values['after'].get('image')!=image or values['before'].get('policyHash')!=values['after'].get('policyHash') or receipt.get('policyHash')!=values['after'].get('policyHash'):raise ValueError('qualification image or policy mismatch')
    if not isinstance(values['smoke'].get('journal'),dict) or not values['smoke'].get('ledger'):raise ValueError('smoke coverage absent')

def record_reviewed_in_place(path,manifest,repository,container,verify=verify_source_chain,observe=observe_running):
    return record_reviewed_recovery(path,manifest,repository,container,verify,observe,_in_place=True)

def resume_reviewed(path,manifest,container,observe=observe_running):
    state=load(path);checked_manifest(state,manifest,'reviewed-resume')
    if state.get('opening_intent') or state['history'][-1].get('mode')=='ui-open-automation-held': raise ValueError('held UI is not full automation delivery; generic resume forbidden')
    if state.get('pending') or state.get('failed') or state.get('resume_required') is not True:
        raise ValueError('only a resolved incident awaiting explicit resume can resume')
    if state.get('recovery_fence')!=state['history'][-1]['sha']: raise ValueError('recovery fence/cursor mismatch')
    observation=observe(container,state['history'][-1])
    state.setdefault('resumptions',[]).append({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'state_fingerprint':fingerprint(state),'authorization_ref':manifest['authorization_ref'],
        'evidence_refs':manifest['evidence_refs'],'observed_running':observation})
    state['resume_required']=False
    atomic(path,state)
    return state

def opening_controller(manifest):
    import importlib.util
    path=Path(__file__).with_name('reviewed-ui-held.py').absolute()
    spec=manifest.get('opening_controller',{})
    if not isinstance(spec,dict) or set(spec)!={'path','sha256'}:raise ValueError('opening controller binding required')
    for parent in [path]+list(path.parents):
        st=parent.lstat()
        if parent.is_symlink() or st.st_uid or st.st_gid or st.st_mode&0o022:raise ValueError('protected installed controller required')
    if hashlib.sha256(path.read_bytes()).hexdigest()!=spec['sha256']:raise ValueError('opening controller changed')
    if spec.get('path')!=str(path):raise ValueError('fixed installed opening controller required')
    module_spec=importlib.util.spec_from_file_location('reviewed_ui',path)
    module=importlib.util.module_from_spec(module_spec);module_spec.loader.exec_module(module)
    module.read_spec(spec)
    return module

def open_reviewed_ui_held(path,manifest,repository,container,verify=verify_source_chain,observe=observe_running,controller=None):
    import copy
    state=load(path);checked_manifest(state,manifest,'reviewed-ui-held-after-fence')
    if state.get('opening_intent') or state.get('pending') or state.get('failed') or state.get('resume_required') is not True:
        raise ValueError('resolved fenced state with resume barrier required')
    base=state['history'][-1]['sha']
    if state.get('recovery_fence')!=base:raise ValueError('fence/cursor mismatch')
    chain=manifest.get('chain');target=manifest.get('target',{})
    if not isinstance(chain,list) or len(chain)!=1 or chain[0]!={'sha':target.get('sha'),'parent':base,'outcome':'ui-open-automation-held'}:
        raise ValueError('exact single first-parent successor required')
    if not SHA.fullmatch(target.get('sha','')) or target['sha']==base or not DIGEST.fullmatch(target.get('digest','')):raise ValueError('exact new target required')
    verify(repository,base,chain);observe(container,target)
    c=controller or opening_controller(manifest)
    env,fields=c.verify(manifest,container,target)
    gates=[]
    for key in ['LYAM_FRONT_BARRIER_FILE','LYAM_OPS_BARRIER_FILE']:
        p=Path(env[key]);st=p.stat();gates.append({'path':str(p),'bytes_hex':p.read_bytes().hex(),'mode':st.st_mode&0o777,'uid':st.st_uid,'gid':st.st_gid})
    original_state=copy.deepcopy(state)
    intent={'phase':'opening','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'manifest':copy.deepcopy(manifest),'gates':gates,'container':container,'target':copy.deepcopy(target),'original_fingerprint':fingerprint(state)}
    state['opening_intent']=intent;state['format']=3;atomic(path,state)
    try:
        result=c.open_gates(manifest,container,target)
        if result.get('mode')!='ui-open-automation-held' or result.get('public_status')!=200 or result.get('automation_held') is not True or result.get('pause_retained') is not True:raise ValueError('held UI opening proof incomplete')
        observation=observe(container,target)
        now=datetime.datetime.now(datetime.timezone.utc).isoformat()
        audit={'kind':'reviewed-ui-held-after-fence','at':now,'target':copy.deepcopy(target),'chain':copy.deepcopy(chain),'opening':copy.deepcopy(result),'observed_running':observation,'manifest':copy.deepcopy(manifest),'prior_fingerprint':intent['original_fingerprint']}
        state.setdefault('recoveries',[]).append(audit)
        state['history'].append({**target,'at':now,'mode':'ui-open-automation-held','automation_held':True})
        state.update(recovery_fence=target['sha'],resume_required=True)
        state.setdefault('opening_audits',[]).append({**intent,'phase':'ui-open-automation-held','proof':result})
        del state['opening_intent'];atomic(path,state)
        return state
    except BaseException:
        # Access closure only, never rollback of writes made during exposure.
        try:
            c.close_gates(intent)
            if hasattr(c,'verify_closed_access'):c.verify_closed_access(manifest)
            intent['phase']='failed-access-rearmed'
        except BaseException:
            intent['phase']='failed-access-unknown'
            if hasattr(c,'stop_candidate'):c.stop_candidate(container)
        state=original_state;state['format']=3
        state['opening_intent']=intent;atomic(path,state)
        raise

def check_held_update(state,manifest,*,pause_present):
    """Pure preconditions + exact N-commit first-parent chain for a held->held update.
    Does not execute anything. authorization_ref is an operator attestation only."""
    if state.get('format')!=3 or state['history'][-1].get('mode')!='ui-open-automation-held' or state['history'][-1].get('automation_held') is not True:
        raise ValueError('format 3 held UI state required')
    if state.get('opening_intent') or state.get('pending') or state.get('failed') or state.get('resume_required') is not True or not pause_present:
        raise ValueError('resolved held state with pause and resume barrier required')
    base=state['history'][-1]['sha']
    if state.get('recovery_fence')!=base: raise ValueError('fence/cursor mismatch')
    checked_manifest(state,manifest,'reviewed-held-update')
    chain=manifest.get('chain')
    if not isinstance(chain,list) or not 1<=len(chain)<=256: raise ValueError('bounded held update chain required')
    parent=base;seen={base};confirmed={e['sha'] for e in state['history']}
    for e in chain:
        if not {'sha','parent','digest'}<=set(e)<={'sha','parent','digest','qualification'} or not SHA.fullmatch(e['sha']) or not DIGEST.fullmatch(e['digest']) or e['parent']!=parent or e['sha'] in seen|confirmed:
            raise ValueError('gap, duplicate or unqualified held update chain')
        seen.add(e['sha']);parent=e['sha']
    if manifest.get('target')!=chain[-1]: raise ValueError('target must be the last chain entry')
    return chain

PROTECTED=lambda st:not(st.st_uid or st.st_gid or st.st_mode&0o022)  # tests may replace; production keeps root-only

def bound_module(spec,filename,name):
    import importlib.util
    path=Path(__file__).with_name(filename).absolute()
    if not isinstance(spec,dict) or set(spec)!={'path','sha256'}:raise ValueError(name+' binding required')
    for parent in [path]+list(path.parents):
        st=parent.lstat()
        if parent.is_symlink() or not PROTECTED(st):raise ValueError('protected installed '+name+' required')
    if hashlib.sha256(path.read_bytes()).hexdigest()!=spec['sha256'] or spec.get('path')!=str(path):raise ValueError(name+' changed or not at fixed installed path')
    module_spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(module_spec);module_spec.loader.exec_module(module)
    return module

HOOK_PHASES=re.compile(r'closed-step-\d{1,3}-(running|qualified|updater-spawned)|ops-gate-created|opening')
HOOK_PROTECT=lambda st:not(st.st_uid or st.st_gid or st.st_mode&0o022)   # isolated runner dir must be root-owned, not group/world writable; tests may replace
PRODUCTION_STATE='/opt/lyam/deploy-queue/state.json'
def phase_hook_from(manifest,state_path):
    """Test-only deterministic suspension point, inert by default. Narrow claim: it is enabled ONLY by a 'phase_hook' key in the reviewed,
    hash-bound manifest (never environment or argv), refuses any alias of the production state file (resolved path AND device/inode), and
    requires a hook directory whose WHOLE ancestry is real and protected. It does NOT prove the host is disposable; the isolation of the
    runner stays an external fact. Handshake is fresh: before any intent, no reached/release trace may exist for the configured phases.
    After a phase is durably persisted it writes <dir>/<phase>.reached (exclusive, no-follow; pid, phase, engagement, random nonce) and waits
    for <dir>/<phase>.release, a protected regular file whose content equals the reached text exactly. Timeout RAISES. Returns a callable or None."""
    cfg=manifest.get('phase_hook')
    if cfg is None:return None
    if not isinstance(cfg,dict) or set(cfg)!={'dir','phases','timeout'} or type(cfg['timeout']) not in (int,float) or not 1<=cfg['timeout']<=120 or not isinstance(cfg['phases'],list) or not cfg['phases'] or not all(isinstance(x,str) and HOOK_PHASES.fullmatch(x) for x in cfg['phases']) or len(set(cfg['phases']))!=len(cfg['phases']):
        raise ValueError('invalid phase_hook')
    sp=Path(state_path).absolute();prod=Path(PRODUCTION_STATE)
    if '..' in sp.parts or str(sp.resolve())==PRODUCTION_STATE or str(sp)==PRODUCTION_STATE:raise ValueError('phase_hook refused on the production state path')
    if prod.exists() and sp.exists() and os.path.samefile(sp,prod):raise ValueError('phase_hook refused on an alias of the production state file')
    if any(str(x).startswith(PRODUCTION_STATE.rsplit('/',1)[0]) for x in (sp,sp.resolve())):raise ValueError('phase_hook refused inside the production queue directory')
    d=Path(cfg['dir'])
    if not d.is_absolute() or '..' in d.parts:raise ValueError('phase_hook directory must be absolute without dot segments')
    for anc in [d]+list(d.parents):
        st=anc.lstat()
        if anc.is_symlink() or not anc.is_dir() or not HOOK_PROTECT(st):raise ValueError('phase_hook directory ancestry must be real and protected')
    sent=d/'ISOLATED_HARNESS'
    want=hashlib.sha256(('%s\n%s'%(sp,manifest.get('engagement_id'))).encode()).hexdigest()
    if sent.is_symlink() or not sent.is_file() or not HOOK_PROTECT(sent.lstat()) or sent.read_text().strip()!=want:raise ValueError('phase_hook sentinel must bind this state path and engagement')
    phases=set(cfg['phases']);timeout=float(cfg['timeout'])
    for ph in phases:
        for suffix in ('.reached','.release'):
            if os.path.lexists(d/(ph+suffix)):raise ValueError('stale phase_hook trace refused before any intent: '+ph+suffix)
    engagement=manifest.get('engagement_id')
    def hook(phase):
        if phase not in phases:return
        flag=d/(phase+'.reached');text=json.dumps({'pid':os.getpid(),'phase':phase,'engagement_id':engagement,'nonce':os.urandom(16).hex()},sort_keys=True)
        fd=os.open(flag,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'w') as f:f.write(text);f.flush();os.fsync(f.fileno())
        end=time.monotonic()+timeout;rel=d/(phase+'.release')
        while True:
            if os.path.lexists(rel):
                if rel.is_symlink() or not rel.is_file() or not HOOK_PROTECT(rel.lstat()) or rel.read_text()!=text:raise ValueError('phase_hook release is not the fresh protected echo of the reached marker')
                return
            if time.monotonic()>end:raise ValueError('phase_hook release timeout at '+phase)
            time.sleep(.05)
    return hook

def held_update(path,manifest,repository,container,make_host,lock_fd,verify=verify_source_chain,observe=observe_running,controller=None,qualify=verify_qualification_receipt,hook=None):
    """Sequential closed steps (one successor each, backup/qualification per step), accesses stay
    closed between steps, then ONE reviewed UIHELD opening. History records each successor with its
    true mode. Interruption or failure retains the intent; nothing is replayed or rolled back."""
    import copy
    if not isinstance(manifest.get('engagement_id'),str) or not re.fullmatch(r'[A-Za-z0-9._-]{8,64}',manifest['engagement_id']):raise ValueError('bounded engagement_id required in the reviewed manifest')
    state=load(path);chain=check_held_update(state,manifest,pause_present=True)
    base=state['history'][-1]['sha'];verify(repository,base,chain)
    for e in chain:qualify(e.get('qualification'),e)  # prior CI qualification of EACH commit; distinct from the real closed qualification per step
    hook=hook or phase_hook_from(manifest,path)   # configuration refusals happen BEFORE any intent or gate exists
    host=make_host(manifest);host.preflight(container,state['history'][-1])
    c=controller or opening_controller(manifest)
    original_state=copy.deepcopy(state)
    at=datetime.datetime.now(datetime.timezone.utc).isoformat()
    planned=host.plan_ops_gate('lyam-held-update-ops:%d:%s'%(os.getpid(),at))  # closure plan exists from the very first intent
    intent={'queue':queue_identity(),'phase':'held-update-prepared','at':at,'manifest':copy.deepcopy(manifest),'gates':[planned],'container':container,'target':copy.deepcopy(chain[-1]),'steps':[],'original_fingerprint':fingerprint(state)}
    state['opening_intent']=intent;state['format']=3;atomic(path,state)
    def spawned(i,measure):
        """Called by the host right after the updater child exists and before waiting for it: durable identity plus the measured state."""
        intent['updater_child']={'identity':measure.get('identity'),'step':i,'measured':{'state':measure.get('state'),'fd8_is_lock':measure.get('fd8_is_lock')}}
        persist('closed-step-%d-updater-spawned'%i)
    if hasattr(host,'on_spawn'):host.on_spawn=spawned
    def persist(phase):
        intent['phase']=phase;intent['gates']=host.snapshot_gates();atomic(path,state)
        if hook:hook(phase)   # after durable persistence; inert unless the reviewed manifest enables it in an isolated context
    try:
        intent['phase']='ops-gate-planned';atomic(path,state)  # exact bytes durable BEFORE creation
        host.create_ops_gate();persist('ops-gate-created')
        adopt=None
        for i,entry in enumerate(chain):
            persist('closed-step-%d-running'%i)
            fields,receipt_path=(host.closed_step(entry,adopt,i,lock_fd,len(chain)) if getattr(host,'step_configs',None) is not None else host.closed_step(entry,adopt,i,lock_fd))
            obs=observe(container,entry)
            intent['steps'].append({'sha':entry['sha'],'parent':entry['parent'],'digest':entry['digest'],'receipt':fields,'receipt_path':receipt_path,'observed_running':obs,'config':(host.installed_configs[-1] if getattr(host,'step_configs',None) is not None else None)})
            adopt=(fields,receipt_path);intent['updater_child']=None;persist('closed-step-%d-qualified'%i)
        persist('opening')
        last=intent['steps'][-1]
        final=host.opening_manifest(manifest,last['receipt'],last['receipt_path'],intent['steps'][0]['receipt'])
        target=chain[-1]
        result=c.open_gates(final,container,target)
        if result.get('mode')!='ui-open-automation-held' or result.get('public_status')!=200 or result.get('automation_held') is not True or result.get('pause_retained') is not True:raise ValueError('held UI opening proof incomplete')
        observation=observe(container,target)
        now=datetime.datetime.now(datetime.timezone.utc).isoformat()
        for i,st in enumerate(intent['steps']):
            entry=chain[i];final_step=i==len(chain)-1
            state['history'].append({'sha':entry['sha'],'digest':entry['digest'],'at':now,'automation_held':True,
                'mode':'ui-open-automation-held' if final_step else 'closed-qualified-held','access':'open-ui-held' if final_step else 'closed'})
        state.setdefault('recoveries',[]).append({'kind':'reviewed-held-update','at':now,'target':copy.deepcopy(target),'chain':copy.deepcopy(chain),'steps':copy.deepcopy(intent['steps']),'opening':copy.deepcopy(result),'observed_running':observation,'manifest':copy.deepcopy(manifest),'prior_fingerprint':intent['original_fingerprint']})
        state.update(recovery_fence=target['sha'],resume_required=True)
        state.setdefault('opening_audits',[]).append({**intent,'phase':'ui-open-automation-held','proof':result})
        del state['opening_intent'];atomic(path,state)
        return state
    except BaseException:
        try:
            intent['gates']=intent['gates'] or host.snapshot_gates()
            c.close_gates(intent)
            if hasattr(c,'verify_closed_access'):c.verify_closed_access({'opening':manifest.get('opening_static')})
            intent['phase']='failed-access-rearmed'
        except BaseException:
            intent['phase']='failed-access-unknown'
            try:
                if hasattr(c,'stop_candidate'):c.stop_candidate(container)
            except BaseException:intent['stop_candidate_failed']=True
        state=original_state;state['format']=3
        state['opening_intent']=intent;atomic(path,state)
        raise

def queue_identity(pid=None):
    pid=pid or os.getpid()
    stat=Path('/proc/%d/stat'%pid).read_text()
    rest=stat[stat.rindex(')')+2:].split()
    return {'pid':pid,'starttime':rest[19],'boot_id':Path('/proc/sys/kernel/random/boot_id').read_text().strip()}

def queue_state(identity):
    """'alive' | 'absent' | 'unknown'. Only certain absence is 'absent': a different kernel boot, ENOENT for the
    pid, or the exact identity as a zombie. A reused pid, a bad schema or any read error is 'unknown'."""
    if not isinstance(identity,dict) or set(identity)!={'pid','starttime','boot_id'} or type(identity['pid']) is not int or identity['pid']<2 \
       or not isinstance(identity['starttime'],str) or not identity['starttime'].isdigit() or not isinstance(identity['boot_id'],str) or not identity['boot_id']:
        return 'unknown'
    try:boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    except OSError:return 'unknown'
    if boot!=identity['boot_id']:return 'unknown'  # other boot = other identity, not inferred dead
    try:stat=Path('/proc/%d/stat'%identity['pid']).read_text()
    except FileNotFoundError:return 'absent'
    except OSError:return 'unknown'
    try:rest=stat[stat.rindex(')')+2:].split();state,start=rest[0],rest[19]
    except (ValueError,IndexError):return 'unknown'
    if start!=identity['starttime']:return 'unknown'
    return 'absent' if state in ('Z','X') else 'alive'

def queue_alive(identity):return queue_state(identity)=='alive'

HELD_PHASES=('held-update-prepared','ops-gate-planned','ops-gate-created','closed-step-','opening')

def rearm_held_update(path,controller=None,state_of=queue_state):
    """Close access after an interrupted held-update. Proceeds only if the recorded queue identity is
    CERTAINLY absent (pid+starttime+boot id); alive/unknown refuse. Called under both locks, state and
    phase are re-read before mutation. Closure AND its measurement (503 on every reviewed origin) are one
    guarded unit with a durable outcome; any failure is recorded as failed-access-unknown."""
    state=load(path);intent=state.get('opening_intent')
    if not intent or not str(intent.get('phase','')).startswith(HELD_PHASES):raise ValueError('no interrupted held-update intent')
    if state_of(intent.get('queue'))!='absent':raise ValueError('queue identity alive or not certainly absent; no rearm')
    uc=intent.get('updater_child')
    if uc is not None and state_of((uc or {}).get('identity') if isinstance(uc,dict) else None)!='absent':raise ValueError('updater child alive or not certainly absent; no rearm')
    c=controller or opening_controller(intent['manifest'])
    view=intent.get('closing_view') or {'opening':intent['manifest']['opening_static']}
    again=load(path)
    if again!=state or state_of(intent.get('queue'))!='absent':raise ValueError('state or queue identity changed before rearm')
    try:
        c.close_gates(intent)
        if hasattr(c,'verify_closed_access'):c.verify_closed_access(view)
    except BaseException as error:
        intent['phase']='failed-access-unknown';intent['rearm_error']=type(error).__name__
        try:
            if hasattr(c,'stop_candidate'):c.stop_candidate(intent['container'])
        except BaseException:
            intent['rearm_stop_failed']=True
        atomic(path,state)
        raise
    intent['phase']='interrupted-access-rearmed';atomic(path,state)
    return state

def rearm_interrupted_opening(path):
    state=load(path);intent=state.get('opening_intent')
    if not intent:raise ValueError('no interrupted opening')
    c=opening_controller(intent['manifest']);c.close_gates(intent)
    if hasattr(c,'verify_closed_access'):c.verify_closed_access(intent['manifest'])
    intent['phase']='interrupted-access-rearmed';atomic(path,state)
    return state

def main():
    p=argparse.ArgumentParser();p.add_argument('command',choices=['status','inspect-reviewed-state','initialize-reviewed','drain','record-reviewed-recovery','record-reviewed-in-place','resume-reviewed','open-reviewed-ui-held','held-update-reviewed','rearm-held-update','rearm-interrupted-opening'])
    p.add_argument('--state',default='/opt/lyam/deploy-queue/state.json');p.add_argument('--sha');p.add_argument('--digest')
    p.add_argument('--pause-file',default='/opt/lyam/UPDATE_PAUSED');p.add_argument('--update-lock',default='/opt/lyam/.update.lock')
    p.add_argument('--repository');p.add_argument('--container')
    p.add_argument('--updater',default='/opt/lyam/bin/update.sh');a=p.parse_args();path=Path(a.state);pause=Path(a.pause_file)
    if not path.parent.is_dir(): raise ValueError('operator must create private queue directory first')
    with open(str(path)+'.lock','a') as lock:
        os.chmod(lock.name,0o600);fcntl.flock(lock,fcntl.LOCK_EX)
        if a.command=='inspect-reviewed-state':
            s=load(path)
            print(json.dumps({'format':s['format'],'state_fingerprint':fingerprint(s),'last_delivered':s['history'][-1],
                'pending':s.get('pending'),'failed':s.get('failed'),'resume_required':s.get('resume_required',False),
                'recovery_fence':s.get('recovery_fence'),'pause_present':pause.exists(),'opening_intent':s.get('opening_intent'),'delivery_mode':s['history'][-1].get('mode')}));return
        if a.command=='status':
            s=load(path)
            if pause.exists() or s.get('pending') or s.get('failed') or s.get('resume_required'): raise ValueError('deployment queue blocked or paused')
            print(s['history'][-1]['sha']);return
        if a.command=='initialize-reviewed':
            if path.exists() or not SHA.fullmatch(a.sha or '') or not DIGEST.fullmatch(a.digest or ''): raise ValueError('explicit verified initial SHA/digest required, never overwrite')
            atomic(path,{'format':1,'history':[{'sha':a.sha,'digest':a.digest}]});return
        if a.command in ['record-reviewed-recovery','record-reviewed-in-place','resume-reviewed','open-reviewed-ui-held','held-update-reviewed','rearm-held-update','rearm-interrupted-opening']:
            if not pause.is_file(): raise ValueError('operator must retain the deployment pause during journal review')
            if not Path(a.update_lock).is_file(): raise ValueError('existing configured updater lock required')
            manifest={} if a.command in ['rearm-interrupted-opening','rearm-held-update'] else json.load(sys.stdin)
            with open(a.update_lock,'a') as updater_lock:
                fcntl.flock(updater_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                if a.command in ['record-reviewed-recovery','record-reviewed-in-place']:
                    if not a.repository: raise ValueError('reviewed local source repository required')
                    (record_reviewed_in_place if a.command=='record-reviewed-in-place' else record_reviewed_recovery)(path,manifest,a.repository,a.container)
                    print('Observed corrected target journaled; incident retained; explicit resume still required; pause unchanged')
                elif a.command=='open-reviewed-ui-held':
                    if not a.repository:raise ValueError('reviewed repository required')
                    controller=opening_controller(manifest)
                    env=controller.settings(manifest)
                    if Path(env.get('LYAM_LOCK_FILE','/opt/lyam/.update.lock'))!=Path(a.update_lock) or Path(env.get('LYAM_PAUSE_FILE','/opt/lyam/UPDATE_PAUSED'))!=pause:raise ValueError('configured lock/pause mismatch')
                    open_reviewed_ui_held(path,manifest,a.repository,a.container,controller=controller)
                    print('UI open, automation held; pause and explicit resume barrier retained; not full delivery')
                elif a.command=='held-update-reviewed':
                    if not a.repository:raise ValueError('reviewed repository required')
                    controller=opening_controller(manifest);env=controller.settings({'opening':manifest['opening_static']})
                    if Path(env.get('LYAM_LOCK_FILE','/opt/lyam/.update.lock'))!=Path(a.update_lock) or Path(env.get('LYAM_PAUSE_FILE','/opt/lyam/UPDATE_PAUSED'))!=pause:raise ValueError('configured lock/pause mismatch')
                    if manifest.get('updater',{}).get('path')!=str(Path(a.updater).absolute()):raise ValueError('updater path must equal the reviewed updater binding')
                    hm=bound_module(manifest.get('held_host'),'held-update-host.py','held host')
                    held_update(path,manifest,a.repository,a.container,lambda m:hm.Host(m['opening_static']['env']['path'],a.updater,m['receipt_dir'],a.update_lock,updater_sha256=m.get('updater',{}).get('sha256'),step_configs=m.get('step_configs')),updater_lock.fileno(),controller=controller)
                    print('Held update journaled: all successors qualified closed, one UI-held opening; pause, resume barrier and hold retained')
                elif a.command=='rearm-held-update':
                    rearm_held_update(path)
                    print('Access rearmed and measured closed; uncertain writes not reversed; review remains required')
                elif a.command=='rearm-interrupted-opening':
                    rearm_interrupted_opening(path)
                    print('Access rearmed; uncertain writes not reversed; review remains required')
                else:
                    resume_reviewed(path,manifest,a.container)
                    print('Reviewed queue resume journaled; deployment pause unchanged; no deployment performed')
            return
        if pause.exists(): raise ValueError('deployment paused; no pending entry written')
        if not os.path.isfile(a.updater) or not os.access(a.updater,os.X_OK): raise ValueError('qualified updater must be preinstalled')
        plan=json.load(sys.stdin);deploy(path,plan,a.updater)
        print('ordered deployment plan confirmed')

if __name__=='__main__':
    try: main()
    except Exception as e: print('OCI ordered queue refused: '+str(e),file=sys.stderr);sys.exit(1)
