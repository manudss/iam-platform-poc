#!/usr/bin/env python3
"""Isolated systemd fixture entry. Same disposable fixture and bounds, recognizes its separate extension filename."""
import importlib.util
from pathlib import Path
p=Path(__file__).with_name('closed-helper-docker-fixture.py')
s=importlib.util.spec_from_file_location('fixture',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.a_delivery_command=lambda args:len(args)>1 and args[0]=='python3' and Path(args[1]).name=='systemd-held-extension.py'
m.main()
