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
m.main()
