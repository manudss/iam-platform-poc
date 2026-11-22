#!/usr/bin/env python3
"""Durable ordered deployment journal. Root-owned, preinstalled operator trust boundary.
Never fetched from an unqualified commit by an automatic deploy. No network credentials.
"""
import argparse, fcntl, json, os, re, subprocess, sys, tempfile, datetime
from pathlib import Path
SHA = re.compile(r'^[a-f0-9]{40}$')
DIGEST = re.compile(r'^sha256:[a-f0-9]{64}$')
PIN = re.compile(r'^[a-f0-9]{64}$')
PREFLIGHT_TIMEOUT = 120  # seconds; a hung preflight fails closed like a refusal
PREFLIGHT_CONFIG = Path('/opt/lyam/deploy-preflight.json')
PLAN_KEYS = {'sha', 'parent', 'digest'}  # the SSH guard's strict stdin schema: no other key

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
    if state.get('format') != 1 or not isinstance(state.get('history'), list) or not state['history']:
        raise ValueError('uninitialized or corrupt deployment history')
    if any(not SHA.fullmatch(e.get('sha','')) for e in state['history']): raise ValueError('invalid history')
    return state

def validate(plan):
    if plan.get('format') != 1 or not SHA.fullmatch(plan.get('base','')): raise ValueError('invalid plan')
    entries = plan.get('entries')
    if not isinstance(entries,list) or len(entries)>256: raise ValueError('invalid/bounded queue')
    parent = plan['base']; seen = {parent}
    for e in entries:
        if not isinstance(e,dict) or set(e) != PLAN_KEYS: raise ValueError('invalid plan entry schema')
        if not SHA.fullmatch(e.get('sha','')) or e['sha'] in seen or e.get('parent') != parent or not DIGEST.fullmatch(e.get('digest','')):
            raise ValueError('gap, duplicate, unqualified image or invalid plan')
        seen.add(e['sha']); parent=e['sha']
    return entries

def load_preflight_config(path):
    """Operator-side preflight wiring, OUTSIDE the CI channel: the SSH guard accepts only
    the constant argv `drain`, so the preflight binding cannot arrive as flags or plan
    fields. An ABSENT config file means byte-exact prior behavior (no preflight). A
    PRESENT one must be private to the executor and fully valid, or the drain refuses
    closed before any state write: the protection can never be silently half-armed.
    Schema (format 1): preflight (absolute path of the reviewed, installed
    update-preflight.py, owned by the executor, mode 0700), policy (absolute path of
    the controller's own live policy file), verifierPins (target image digest ->
    reviewed sha256 of its transformation verifier, installed from the guard-linted
    repo file deploy/oci/transformation-verifiers.json, never from a plan author)."""
    if path is None or not path.is_file():
        return None
    st = path.stat()
    if st.st_uid != os.geteuid() or (st.st_mode & 0o777) != 0o600:
        raise ValueError('preflight config must be owned by the executor with mode 0600')
    cfg = json.loads(path.read_text())
    if cfg.get('format') != 1: raise ValueError('invalid preflight config')
    preflight, policy, pins = cfg.get('preflight'), cfg.get('policy'), cfg.get('verifierPins')
    if not isinstance(preflight,str) or not Path(preflight).is_absolute() or not isinstance(policy,str) or not Path(policy).is_absolute():
        raise ValueError('preflight config requires absolute preflight/policy paths')
    pf = Path(preflight)
    if not pf.is_file() or not os.access(str(pf), os.X_OK):
        raise ValueError('qualified preflight must be preinstalled and executable')
    pst = pf.stat()
    if pst.st_uid != os.geteuid() or (pst.st_mode & 0o777) != 0o700:
        raise ValueError('preflight must be owned by the executor with mode 0700')
    if not isinstance(pins,dict) or any(not isinstance(k,str) or not DIGEST.fullmatch(k) or not isinstance(v,str) or not PIN.fullmatch(v) for k,v in pins.items()):
        raise ValueError('invalid verifier pin in preflight config')
    no_transform = cfg.get('noTransform',[])
    if not isinstance(no_transform,list) or any(not isinstance(d,str) or not DIGEST.fullmatch(d) for d in no_transform):
        raise ValueError('invalid noTransform digest in preflight config')
    if set(no_transform) & set(pins): raise ValueError('a digest cannot be both pinned and declared no-transform')
    return {'preflight': preflight, 'policy': policy, 'pins': pins, 'noTransform': set(no_transform)}

def deploy(path, plan, updater, runner=subprocess.run, preflight_config=None):
    entries=validate(plan); state=load(path)
    if state.get('pending') or state.get('failed'): raise ValueError('prior deployment unresolved, operator review required')
    confirmed=[e['sha'] for e in state['history']]
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
    todo=entries[overlap:]
    # Cold-refusal boundary: an entry whose target digest the operator config pins is
    # preflighted for its exact image BEFORE the updater arms the front gate or touches
    # application state (the #118 failure class surfaced only at the after-check, with
    # the site already behind maintenance). Entries with no pin deploy exactly as
    # before: a no-drift deploy must not require a transformation verifier. A present
    # but invalid config refuses the whole plan before any state write.
    wiring = load_preflight_config(preflight_config)
    if wiring:
        # Explicit coverage, fail closed BEFORE any state write: with the wiring armed,
        # every entry's digest must be declared - pinned (migrating deploy, cold
        # preflight) or explicitly 'noTransform' (operator declaration that this target
        # introduces no data transformation; the controller remains the mid-cycle closed
        # backstop). An undeclared digest would silently skip the cold check and keep
        # the late-detection class alive, so it refuses the whole plan here.
        undeclared=[e['digest'] for e in todo if e['digest'] not in wiring['pins'] and e['digest'] not in wiring['noTransform']]
        if undeclared: raise ValueError('preflight config declares no disposition (pin or noTransform) for '+str(len(undeclared))+' plan entr(y/ies): refusing rather than silently skipping the cold check')
    for entry in todo:
        state['pending']=entry; atomic(path,state)
        pin = wiring and wiring['pins'].get(entry['digest'])
        if pin:
            try:
                pre=runner([wiring['preflight'],'--image','ghcr.io/manudss/iam-platform-poc@'+entry['digest'],'--policy',wiring['policy'],'--verifier-sha256',pin],check=False,timeout=PREFLIGHT_TIMEOUT)
            except subprocess.TimeoutExpired:
                pre=None
            if pre is None or pre.returncode:
                state['failed']={'sha':entry['sha'],'exit':124 if pre is None else pre.returncode,'phase':'preflight','at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
                atomic(path,state)
                raise RuntimeError('preflight refused the entry before the updater ran: no gate armed, no application state touched; queue blocked')
        result=runner([updater,'--image','ghcr.io/manudss/iam-platform-poc@'+entry['digest'],'--require-qualification'],check=False)
        if result.returncode:
            state['failed']={'sha':entry['sha'],'exit':result.returncode,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
            atomic(path,state)
            raise RuntimeError('deployment failed; queue blocked, no later commit attempted')
        state['history'].append({**entry,'at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
        del state['pending']; atomic(path,state)
    return state

def main():
    p=argparse.ArgumentParser();p.add_argument('command',choices=['status','initialize-reviewed','drain'])
    p.add_argument('--state',default='/opt/lyam/deploy-queue/state.json');p.add_argument('--sha');p.add_argument('--digest')
    p.add_argument('--updater',default='/opt/lyam/bin/update.sh');a=p.parse_args();path=Path(a.state)
    if not path.parent.is_dir(): raise ValueError('operator must create private queue directory first')
    with open(str(path)+'.lock','a') as lock:
        os.chmod(lock.name,0o600);fcntl.flock(lock,fcntl.LOCK_EX)
        if a.command=='status':
            s=load(path)
            if s.get('pending') or s.get('failed'): raise ValueError('deployment queue blocked')
            print(s['history'][-1]['sha']);return
        if a.command=='initialize-reviewed':
            if path.exists() or not SHA.fullmatch(a.sha or '') or not DIGEST.fullmatch(a.digest or ''): raise ValueError('explicit verified initial SHA/digest required, never overwrite')
            atomic(path,{'format':1,'history':[{'sha':a.sha,'digest':a.digest}]});return
        if not os.path.isfile(a.updater) or not os.access(a.updater,os.X_OK): raise ValueError('qualified updater must be preinstalled')
        plan=json.load(sys.stdin);deploy(path,plan,a.updater,preflight_config=PREFLIGHT_CONFIG)
        print('ordered deployment plan confirmed')

if __name__=='__main__':
    try: main()
    except Exception as e: print('OCI ordered queue refused: '+str(e),file=sys.stderr);sys.exit(1)
