#!/usr/bin/env python3
"""deploy/oci/isolated/diagnose-containers.py <ISO_WORK> [run-exit-code]  (stdout: JSON)

Whitelist failure diagnostics for the isolated harness. One FIXED-SCHEMA document:

- run: the LAST cycle step the orchestrator marked (closed enum, written to
  ISO_WORK/cycle-step as it went) and the run's own exit code - so a failure
  localizes to a stage with NO free text. A missing file reads 'absent', content
  outside the enum reads 'invalid': the raw content is NEVER exported.
- containers: per container, docker State status, restart count, exit code,
  inspect/logs read status (fixed enums), log tail line count, and counters of a
  FIXED list of diagnostic patterns.

Raw log lines are read into memory, counted against the fixed patterns, and
DISCARDED. No original line, no value, no secret (known, unknown or short) and no
error text is ever exported: nothing from any stream or file content is copied
out. A read failure is reported as a fixed enum plus the container NAME on
stderr - never the error message.

Exit codes: 0 = every container read; 2 = JSON complete but at least one read
failed (marked in the document); 1 = the document could not be produced.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

SCHEMA = 'isolated-container-diagnostics/2'
CONTAINERS = ['pg-iso', 'bao-iso', 'caddy-iso', 'api-iso']
TAIL = 200

# Closed cycle-step enum, kept IDENTICAL to STEPS_ALL in run-isolated-cycle.sh
# (a test pins both copies). Anything else in the step file is 'invalid'.
STEPS = {'BOOT', 'RENDER_CONFIG', 'PRECHECKS', 'INSTALL_VERIFIER',
         'S1_PREPARE', 'S1_COMPOSE', 'S1_PG_WAIT', 'S1_BAO_BOOTSTRAP', 'S1_API_RUN',
         'S1_API_HEALTH', 'S1_FRONT', 'BARRIER_CHECK', 'PRECONDITIONS', 'PREFLIGHT',
         'UPDATE_POSITIVE', 'VERIFY_POSITIVE', 'S1_TEARDOWN',
         'S2_PREPARE', 'S2_COMPOSE', 'S2_PG_WAIT', 'S2_BAO_BOOTSTRAP', 'S2_API_RUN',
         'S2_API_HEALTH', 'S2_FRONT', 'UPDATE_NEGATIVE', 'VERIFY_NEGATIVE',
         'NEGATIVE_CAUSE', 'EXPORT_EVIDENCE', 'HASH_SUMS', 'CLEANUP', 'DONE'}

# Closed output domain: status is a fixed docker enum, every counter is a bounded
# non-negative integer. Anything outside is a read error, never a value to export.
STATUSES = {'created', 'restarting', 'running', 'removing', 'paused', 'exited', 'dead'}
MAX_RESTARTS = 1000000
MAX_EXIT_CODE = 255
MAX_PATTERN_COUNT = 10000

# FIXED diagnostic signatures. Labels and regexes are part of the schema; only
# COUNTS are exported, never matched text. Additions are a reviewed schema change.
PATTERNS = [
    ('permission_denied', re.compile(r'permission denied', re.I)),
    ('address_in_use', re.compile(r'address already in use', re.I)),
    ('connection_refused', re.compile(r'connection refused', re.I)),
    ('no_such_file', re.compile(r'no such file or directory', re.I)),
    ('storage_init_error', re.compile(r'(error|failed)[^\n]*(storage|/bao/file)', re.I)),
    ('auth_failure', re.compile(r'(auth|token|unseal)[^\n]*(fail|invalid|denied|forbidden)', re.I)),
    ('fatal', re.compile(r'\bFATAL\b')),
    ('panic', re.compile(r'\bpanic\b', re.I)),
    ('out_of_memory', re.compile(r'out of memory|oomkill', re.I)),
    ('no_space', re.compile(r'no space left', re.I)),
]


def inspect_state(name):
    try:
        out = subprocess.run(
            ['docker', 'inspect', '--format',
             '{{.State.Status}} {{.RestartCount}} {{.State.ExitCode}}', name],
            capture_output=True, text=True, errors='replace', timeout=30)
    except Exception:
        return None
    if out.returncode != 0:
        return None
    parts = out.stdout.split()
    if len(parts) != 3:
        return None
    status, restarts, exit_code = parts
    if status not in STATUSES:
        return None
    try:
        restarts = int(restarts)
        exit_code = int(exit_code)
    except ValueError:
        return None
    if not (0 <= restarts <= MAX_RESTARTS and 0 <= exit_code <= MAX_EXIT_CODE):
        return None
    return {'status': status, 'restart_count': restarts, 'exit_code': exit_code}


def log_counts(name):
    try:
        out = subprocess.run(['docker', 'logs', '--tail', str(TAIL), name],
                             capture_output=True, text=True, errors='replace', timeout=60)
    except Exception:
        return None
    if out.returncode != 0:
        return None
    data = out.stdout + '\n' + out.stderr
    counts = {label: min(len(pattern.findall(data)), MAX_PATTERN_COUNT)
              for label, pattern in PATTERNS}
    return {'log_tail_lines': min(data.count('\n'), 2 * TAIL + 1), 'patterns': counts}


def diagnose(name):
    entry = {'container': name}
    state = inspect_state(name)
    if state is None:
        entry['inspect'] = 'error'
        entry.update({'status': None, 'restart_count': None, 'exit_code': None})
    else:
        entry['inspect'] = 'ok'
        entry.update(state)
    logs = log_counts(name)
    if logs is None:
        entry['logs'] = 'error'
        entry.update({'log_tail_lines': None, 'patterns': None})
    else:
        entry['logs'] = 'ok'
        entry.update(logs)
    return entry


def run_block(work, raw_exit_code):
    block = {}
    step_file = work / 'cycle-step'
    if not step_file.is_file():
        block.update({'step': None, 'step_read': 'absent'})
    else:
        try:
            content = step_file.read_text().strip()
        except Exception:
            content = None
        if content in STEPS:
            block.update({'step': content, 'step_read': 'ok'})
        else:
            # outside the closed enum (corrupt, truncated or hostile): never exported
            block.update({'step': None, 'step_read': 'invalid'})
    if raw_exit_code is None or raw_exit_code == '':
        block.update({'exit_code': None, 'exit_code_read': 'absent'})
    else:
        try:
            code = int(raw_exit_code)
        except ValueError:
            code = -1
        if 0 <= code <= 255:
            block.update({'exit_code': code, 'exit_code_read': 'ok'})
        else:
            block.update({'exit_code': None, 'exit_code_read': 'invalid'})
    return block


def main():
    work = Path(sys.argv[1])
    raw_exit_code = sys.argv[2] if len(sys.argv) > 2 else None
    entries = [diagnose(name) for name in CONTAINERS]
    bad = [e['container'] for e in entries if e['inspect'] == 'error' or e['logs'] == 'error']
    json.dump({'schema': SCHEMA, 'run': run_block(work, raw_exit_code), 'containers': entries},
              sys.stdout, indent=2)
    sys.stdout.write('\n')
    for name in bad:
        print('diagnostics: read failed for container ' + name, file=sys.stderr)
    return 2 if bad else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('diagnostics: could not produce the diagnostics document', file=sys.stderr)
        sys.exit(1)
