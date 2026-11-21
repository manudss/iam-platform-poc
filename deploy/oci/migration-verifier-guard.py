#!/usr/bin/env python3
"""No data migration without its reviewed digest-specific verifier.

The qualification controller (deploy/oci/qualification.py) fails closed when an
update changes preserved state and the live policy lists no reviewed verifier for
the exact target image - that is what put the demo under maintenance after the
migration-0002 deployment, and it is the protection working, not a defect. This
guard moves that failure from the host to the PR: when a PR adds a version to
data/migrations/manifest.json, it must also add, in the same change:

  deploy/oci/verify-<id>-*.py        the reviewed digest-specific verifier
  deploy/oci/verify-<id>-*.test.py   its counter-test suite
  .github/workflows/ci.yml           a step running that test file

Usage (CI): migration-verifier-guard.py --base origin/main
Exit 1 with the explicit missing list; exit 0 when no migration was added or every
new migration is covered. A base without any manifest (initial release) passes.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path


def git(root, *args):
    result = subprocess.run(['git', '-C', str(root), *args], text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        return None
    return result.stdout


def manifest_at(root, ref):
    out = git(root, 'show', ref + ':data/migrations/manifest.json') if ref else Path(root, 'data/migrations/manifest.json').read_text()
    if out is None:
        return None
    return json.loads(out)


def missing_for(root, migration_id):
    missing = []
    verifiers = sorted(Path(root, 'deploy/oci').glob('verify-' + migration_id + '-*.py'))
    if not any(path.name.endswith('.test.py') is False for path in verifiers):
        missing.append('deploy/oci/verify-' + migration_id + '-*.py (reviewed verifier)')
    if not any(path.name.endswith('.test.py') for path in verifiers):
        missing.append('deploy/oci/verify-' + migration_id + '-*.test.py (counter-tests)')
    ci = Path(root, '.github/workflows/ci.yml')
    if not ci.is_file() or ('deploy/oci/verify-' + migration_id + '-') not in ci.read_text():
        missing.append('.github/workflows/ci.yml (a step running the verifier tests)')
    return missing


def guard(root, base):
    before = manifest_at(root, base)
    after = manifest_at(root, None)
    if before is None:
        return []  # initial release: no prior manifest to diff against
    known = {entry['id'] for entry in before.get('versions', [])}
    missing = []
    for entry in after.get('versions', []):
        if entry['id'] not in known:
            missing.extend(missing_for(root, entry['id']))
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
        print('A data migration was added without its reviewed digest-specific verifier: the '
              'qualification controller would fail closed at deploy time. Add the verifier, its '
              'counter-tests and the CI step in this PR.', file=sys.stderr)
        return 1
    print('Every new data migration ships its reviewed verifier, counter-tests and CI step.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
