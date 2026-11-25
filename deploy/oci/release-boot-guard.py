#!/usr/bin/env python3
"""Read-only, fail-closed boot guard. Never starts, stops or changes a container."""
import json, re, sys
from pathlib import Path

def check(path):
    p=Path(path)
    if not p.exists(): return
    if p.is_symlink() or not p.is_file() or p.stat().st_size>16*1024*1024: raise ValueError('unsafe release state')
    s=json.loads(p.read_text())
    if s.get('format') not in (1,2,3,4) or s.get('release_intent') or s.get('release_finalize_required'): raise ValueError('release pending or unknown format')
    if s['format']==4:
        if s.get('delivery_mode')!='normal' or s.get('resume_required') is not False or not s.get('releases') or not s.get('resumptions'):raise ValueError('release not committed')
        a=s['releases'][-1];target=a.get('target',{})
        history=s.get('history',[])
        if not history or len({e.get('sha') for e in history})!=len(history) or target not in [{k:e.get(k) for k in ('sha','digest')} for e in history]:raise ValueError('release history differs')
        obs=a.get('observed_running',{})
        if not re.fullmatch('sha256:[a-f0-9]{64}',target.get('digest','')) or any(obs.get(k)!=target.get(k) for k in ('sha','digest')) or obs.get('held') is not False or obs.get('settingPresent') is not False or s['resumptions'][-1].get('observed_running')!=obs:raise ValueError('normal release evidence differs')
        if not re.fullmatch('[a-f0-9]{40}',target.get('sha','')) or target.get('sha')!=s.get('recovery_fence') or a.get('observed_running',{}).get('sha')!=target['sha'] or s['resumptions'][-1].get('observed_running',{}).get('sha')!=target['sha']:raise ValueError('release audit differs')

if __name__=='__main__':
    try:check(sys.argv[1])
    except Exception:
        print('Release boot guard refused unattended start',file=sys.stderr);sys.exit(1)
