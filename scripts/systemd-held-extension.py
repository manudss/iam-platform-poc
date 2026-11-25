#!/usr/bin/env python3
"""Isolated systemd qualification adapter. Reuses unchanged delivery setup, selects only the systemd scenario implementation."""
import importlib.util
from pathlib import Path
source=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('real_delivery',source/'scripts/delivery-docker-integration.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
original=m.load_module
def load(path,name):
 if Path(path).name=='held-update-scenario.py':path=source/'scripts/systemd-held-scenario.py'
 return original(path,name)
m.load_module=load
try:m.main()
except Exception as error:
 import json,sys,traceback
 allowed={'systemd-fixture-command-refused','real-systemd-pid1-required','real-cgroup-v2-required','fixture-private-mount-required','real-unit-contract-required','mount-owner-not-live-exact','systemd-main-not-alive','postexec-invocation-mismatch','systemd-cgroup-mismatch','systemd-output-fd-mismatch','unexpected-unit-coupling','systemd-mount-namespace-mismatch','mount-owner-not-live-before-return','supervision-not-ready','watchdog-timeout','origin-not-503-after-rearm'}
 reason=str(error) if str(error) in allowed else 'unclassified'
 frames=[f.lineno for f in traceback.extract_tb(error.__traceback__) if Path(f.filename).name in {'systemd-held-runtime.py','systemd-held-scenario.py'}][-10:]
 out=Path(__import__('json').loads(Path(sys.argv[1]).read_text())['out'])
 (out/'systemd-failure.json').write_text(json.dumps({'exceptionType':type(error).__name__ if type(error).__name__ in {'RuntimeError','ValueError','TimeoutExpired','FileNotFoundError','PermissionError','KeyError','TypeError'} else 'Other','reason':reason,'sourceLines':frames}))
 raise
