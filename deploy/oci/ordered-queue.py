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
        if not SHA.fullmatch(e.get('sha','')) or e['sha'] in seen or e.get('parent') != parent or not DIGEST.fullmatch(e.get('digest','')):
            raise ValueError('gap, duplicate, unqualified image or invalid plan')
        seen.add(e['sha']); parent=e['sha']
    return entries

def deploy(path, plan, updater, runner=subprocess.run):
    entries=validate(plan); state=load(path)
    if state.get('pending') or state.get('failed'): raise ValueError('prior deployment unresolved, operator review required')
    confirmed=[e['sha'] for e in state['history']]
    if plan['base'] not in confirmed: raise ValueError('unknown baseline, no implicit adoption/rewind')
    offset=confirmed.index(plan['base'])+1
    overlap=min(len(entries),len(confirmed)-offset)
    for i in range(overlap):
        old=state['history'][offset+i]
        if old['sha']!=entries[i]['sha'] or old.get('digest')!=entries[i]['digest']:
            raise ValueError('deployment history divergence')
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
        plan=json.load(sys.stdin);deploy(path,plan,a.updater)
        print('ordered deployment plan confirmed')

if __name__=='__main__':
    try: main()
    except Exception as e: print('OCI ordered queue refused: '+str(e),file=sys.stderr);sys.exit(1)
