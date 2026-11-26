#!/usr/bin/env python3
"""Synthetic explicit isolated-copy profile. No production data or secrets."""
import os,runpy
from pathlib import Path
os.environ['LYAM_SYNTHETIC_ISOLATED_COPY']='1'
runpy.run_path(str(Path(__file__).with_name('normal-lifecycle-real-fixture.py')),run_name='__main__')
