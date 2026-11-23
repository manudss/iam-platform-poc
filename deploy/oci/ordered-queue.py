#!/usr/bin/env python3
"""Durable ordered deployment journal. Root-owned, preinstalled operator trust boundary.
Never fetched from an unqualified commit by an automatic deploy. No network credentials.
"""
import argparse, fcntl, json, os, re, subprocess, sys, tempfile, datetime
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
    if state.get('format') not in [1,2] or not isinstance(state.get('history'), list) or not state['history']:
        raise ValueError('uninitialized or corrupt deployment history')
    if any(not SHA.fullmatch(e.get('sha','')) for e in state['history']): raise ValueError('invalid history')
    if state['format']==2:
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
    if state.get('pending') or state.get('failed') or state.get('resume_required'): raise ValueError('prior deployment unresolved, operator review required')
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
            state['failed']={'sha':entry['sha'],'exit':result.returncode,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
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

def record_reviewed_recovery(path,manifest,repository,container,verify=verify_source_chain,observe=observe_running):
    import copy
    state=load(path);checked_manifest(state,manifest,'reviewed-recovery')
    pending,failed=state.get('pending'),state.get('failed')
    if not pending or not failed or state.get('resume_required'): raise ValueError('exact pending+failed incident required, not an unreviewed resume')
    if failed.get('sha')!=pending.get('sha') or pending.get('parent')!=state['history'][-1]['sha'] or not DIGEST.fullmatch(pending.get('digest','')):
        raise ValueError('inconsistent unresolved incident')
    chain=manifest.get('chain')
    if not isinstance(chain,list) or not 1<=len(chain)<=256: raise ValueError('bounded reviewed chain including failed entry and observed target required')
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
    in_place=len(chain)==1
    if in_place and any(target.get(k)!=pending.get(k) for k in ['sha','digest']):
        raise ValueError('in-place qualification must use exact original pending source and digest')
    qualification=manifest.get('qualification',{})
    if any(qualification.get(k)!=target[k] for k in ['sha','digest']): raise ValueError('qualification attestation must bind exact target')
    references(qualification.get('evidence_refs'))
    verify(repository,state['history'][-1]['sha'],chain)
    observation=observe(container,target)
    now=datetime.datetime.now(datetime.timezone.utc).isoformat()
    audit={'kind':'reviewed-recovery','recovery_mode':'qualified-in-place' if in_place else 'replacement-chain','at':now,'state_fingerprint':fingerprint(state),
           'authorization_ref':manifest['authorization_ref'],'evidence_refs':manifest['evidence_refs'],
           'original_unresolved':{'pending':copy.deepcopy(pending),'failed':copy.deepcopy(failed)},
           'chain':copy.deepcopy(chain),'target':copy.deepcopy(target),'qualification_attestation':copy.deepcopy(qualification),
           'observed_running':observation}
    state.setdefault('recoveries',[]).append(audit)
    state['history'].append({**target,'at':now,'mode':'observed-reviewed-recovery'})
    del state['pending'];del state['failed']
    state.update(format=2,recovery_fence=target['sha'],resume_required=True)
    atomic(path,state)
    return state

def resume_reviewed(path,manifest,container,observe=observe_running):
    state=load(path);checked_manifest(state,manifest,'reviewed-resume')
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

def main():
    p=argparse.ArgumentParser();p.add_argument('command',choices=['status','inspect-reviewed-state','initialize-reviewed','drain','record-reviewed-recovery','resume-reviewed'])
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
                'recovery_fence':s.get('recovery_fence'),'pause_present':pause.exists()}));return
        if a.command=='status':
            s=load(path)
            if pause.exists() or s.get('pending') or s.get('failed') or s.get('resume_required'): raise ValueError('deployment queue blocked or paused')
            print(s['history'][-1]['sha']);return
        if a.command=='initialize-reviewed':
            if path.exists() or not SHA.fullmatch(a.sha or '') or not DIGEST.fullmatch(a.digest or ''): raise ValueError('explicit verified initial SHA/digest required, never overwrite')
            atomic(path,{'format':1,'history':[{'sha':a.sha,'digest':a.digest}]});return
        if a.command in ['record-reviewed-recovery','resume-reviewed']:
            if not pause.is_file(): raise ValueError('operator must retain the deployment pause during journal review')
            if not Path(a.update_lock).is_file(): raise ValueError('existing configured updater lock required')
            manifest=json.load(sys.stdin)
            with open(a.update_lock,'a') as updater_lock:
                fcntl.flock(updater_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                if a.command=='record-reviewed-recovery':
                    if not a.repository: raise ValueError('reviewed local source repository required')
                    record_reviewed_recovery(path,manifest,a.repository,a.container)
                    print('Observed corrected target journaled; incident retained; explicit resume still required; pause unchanged')
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
