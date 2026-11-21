#!/usr/bin/env python3
"""No data migration without its reviewed digest-specific verifier - STRUCTURAL lint.

The qualification controller (deploy/oci/qualification.py) fails closed when an
update changes preserved state and the live policy lists no reviewed verifier for
the exact target image - that is what put the demo under maintenance after the
migration-0002 deployment, and it is the protection working, not a defect. This
guard moves that failure from the host to the PR.

GUARANTEE BOUNDARY - read before relying on it. This is a STRUCTURAL lint only.
For EVERY version in data/migrations/manifest.json except the initial baseline
(versions[0], adopted before this mechanism existed), whether added by this PR or
already released, it requires: (a) a NON-EMPTY deploy/oci/verify-<id>-*.py; (b) a
NON-EMPTY deploy/oci/verify-<id>-*.test.py that references the verifier module;
(c) the discovered test suite EXECUTED by this guard and reporting a non-zero
number of passing tests; (d) a TEXT HEURISTIC finding that test file inside a
ci.yml 'run:' block - full-line/trailing comments stripped, a literal 'if: false'
step excluded, but 'run: echo <path>', 'if: ${{ false }}' or a disabled JOB are
NOT detected; the suite is executed separately by this guard (c), the heuristic
never proves CI ran it; (e) no previously shipped verify-* file deleted versus
--base. It proves NOTHING semantic: not that a verifier actually
proves its migration, not the image/policy binding, not review quality. The
independent review, the sha256 pin and the live-policy entry installed BEFORE the
before-phase remain the semantic gates. An unresolvable --base ref is UNKNOWN and
fails closed; only a base commit that genuinely has no manifest yet passes.

Usage (CI): migration-verifier-guard.py --base origin/main
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


def git(root, *args):
    result = subprocess.run(['git', '-C', str(root), *args], text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return result.stdout if result.returncode == 0 else None


def base_versions(root, ref):
    """None = ref unresolvable (UNKNOWN, fail closed); [] = base commit has no manifest yet."""
    if git(root, 'rev-parse', '--verify', '--quiet', ref + '^{commit}') is None:
        return None
    if git(root, 'cat-file', '-e', ref + ':data/migrations/manifest.json') is None:
        return []
    return [entry['id'] for entry in json.loads(git(root, 'show', ref + ':data/migrations/manifest.json')).get('versions', [])]


def strip_comment(line):
    """Naive YAML comment strip (structural heuristic, documented as such)."""
    if line.lstrip().startswith('#'):
        return ''
    return re.sub(r'\s+#.*$', '', line)


def ci_runs_test(root, migration_id):
    """Heuristic presence of the verifier test file in a ci.yml 'run:' block.
    Line-based structural heuristic only: full-line and trailing comments are
    stripped; a step carrying a literal 'if: false' does not count. 'run: echo
    <path>', 'if: ${{ false }}' and a disabled JOB are NOT detected. The suite
    is executed separately by this guard (run_suite); this check never proves
    CI ran it."""
    ci = Path(root, '.github/workflows/ci.yml')
    if not ci.is_file():
        return False
    needle = 'deploy/oci/verify-' + migration_id + '-'
    lines = ci.read_text().splitlines()
    steps, current = [], []
    for line in lines:
        if re.match(r'\s*- \S', line) and current:
            steps.append(current)
            current = []
        current.append(line)
    steps.append(current)
    for step in steps:
        code = [strip_comment(line) for line in step]
        text = '\n'.join(code)
        if needle not in text:
            continue
        if re.search(r'^\s*if:\s*[\'"]?false[\'"]?\s*$', text, re.M):
            continue
        in_run, run_indent = False, None
        for line in code:
            if not line.strip():
                continue
            indent = len(line) - len(line.lstrip())
            match = re.match(r'\s*-?\s*run:\s*(.*)$', line)
            if match:
                in_run, run_indent = True, indent
                body = match.group(1)
                if body and body not in ('|', '>', '|-', '>-') and needle in body:
                    return True
                continue
            if in_run and indent > run_indent and needle in line:
                return True
            if indent <= (run_indent or 0):
                in_run = False
    return False


def run_suite(root, test_file):
    """Execute the discovered counter-test suite: it must pass and report a
    non-zero number of tests - an empty or non-running suite is UNKNOWN."""
    result = subprocess.run([sys.executable, str(test_file)], cwd=str(root), text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=300)
    match = re.search(r'Ran (\d+) test', result.stdout)
    return result.returncode == 0 and match is not None and int(match.group(1)) > 0


def missing_for(root, migration_id):
    missing = []
    found = sorted(Path(root, 'deploy/oci').glob('verify-' + migration_id + '-*.py'))
    scripts = [path for path in found if not path.name.endswith('.test.py')]
    tests = [path for path in found if path.name.endswith('.test.py')]
    if not scripts or not any(path.stat().st_size > 0 for path in scripts):
        missing.append('deploy/oci/verify-' + migration_id + '-*.py (non-empty reviewed verifier)')
    if not tests or not any(path.stat().st_size > 0 for path in tests):
        missing.append('deploy/oci/verify-' + migration_id + '-*.test.py (non-empty counter-tests)')
    elif scripts and not any(script.stem in test.read_text() for test in tests for script in scripts):
        missing.append('deploy/oci/verify-' + migration_id + '-*.test.py (must reference the verifier module)')
    elif not any(run_suite(root, test) for test in tests):
        missing.append('deploy/oci/verify-' + migration_id + '-*.test.py (suite must execute and report a non-zero number of passing tests)')
    if not ci_runs_test(root, migration_id):
        missing.append('.github/workflows/ci.yml (heuristic presence of the verifier test file in a run block, not a comment; the suite is executed separately by this guard)')
    return missing


def deleted_verifiers(root, base):
    out = git(root, 'diff', '--name-only', '--diff-filter=D', base, '--', 'deploy/oci')
    if out is None:
        return ['<deletion check unverifiable: UNKNOWN>']
    return [name for name in out.split() if re.search(r'verify-\d{4}-.*\.py$', name)]


def guard(root, base):
    known = base_versions(root, base)
    if known is None:
        return ['base ref ' + base + ' unresolvable: UNKNOWN, not a pass']
    versions = json.loads(Path(root, 'data/migrations/manifest.json').read_text()).get('versions', [])
    missing = []
    for entry in versions[1:]:  # versions[0] is the adopted baseline, predating this mechanism
        missing.extend(missing_for(root, entry['id']))
    missing.extend('deleted previously shipped verifier: ' + name for name in deleted_verifiers(root, base))
    return missing


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', required=True, help='git ref of the target branch (e.g. origin/main)')
    parser.add_argument('--root', default=str(Path(__file__).resolve().parents[2]))
    args = parser.parse_args()
    missing = guard(args.root, args.base)
    if missing:
        for item in missing:
            print('MISSING: ' + item, file=sys.stderr)
        print('Structural lint failed: a data migration without its reviewed digest-specific '
              'verifier would fail the host qualification closed at deploy time. This lint proves '
              'structure only - independent review, sha256 pin and the live-policy entry installed '
              'before the before-phase remain the semantic gates.', file=sys.stderr)
        return 1
    print('Structure OK: every non-baseline data migration ships its verifier, a counter-test '
          'suite this guard executes with a non-zero test count, and the ci.yml run-block '
          'presence heuristic (structural lint only).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
