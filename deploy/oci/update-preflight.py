#!/usr/bin/env python3
"""Read-only nominal preflight BEFORE any update cycle touches the VM.

Run by the operator BETWEEN cycles, before update.sh --image <ref> starts its
before-phase. It never writes anything. It proves, for the exact target image
string the updater will pass:

  1. the policy parses (format 1) and lists transformationVerifiers[<exact image>]
     - the qualification controller fails closed without it, which is what put
       the demo under maintenance after #118. Near-miss keys (same repository,
     different digest) are reported explicitly: a verifier for ANOTHER digest is
     not coverage;
  2. the verifier path is absolute, an existing file, owned by root, with no
     group/other permissions (the reviewed installation is root 0700);
  3. the file's sha256 equals the reviewed pin passed as --verifier-sha256.

GUARANTEE BOUNDARY: this is a STRUCTURAL preflight and an OPERATOR CHECKLIST
TOOL - it is NOT integrated into update.sh or the ordered queue and locks
nothing automatically. It does not prove the verifier is correct (independent
review does), does not run the controller's full policy_load, does not verify
the authorized origin of the pin, parent-directory immutability or symlinks, and
does not prove the verifier functionally succeeds. It never writes, and must run
BEFORE the before-phase because the policy hash is captured into before.json -
changing the policy mid-cycle fails closed by design.

Usage: update-preflight.py --image ghcr.io/...@sha256:... --policy /opt/lyam/qualification.json \
         --verifier-sha256 <reviewed pin>
"""
import argparse
import hashlib
import json
import os
import stat
import sys
from pathlib import Path


def policy_load(path):
    return json.loads(Path(path).read_text())


def owner_uid(path):
    return os.stat(path).st_uid


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def preflight(image, policy_path, verifier_sha256):
    failures = []
    try:
        policy = policy_load(policy_path)
    except Exception:
        return ['policy unreadable or not JSON: UNKNOWN']
    if policy.get('format') != 1:
        failures.append('policy format is not 1')
    verifiers = policy.get('transformationVerifiers')
    if not isinstance(verifiers, dict):
        failures.append('policy has no transformationVerifiers object')
        return failures
    verifier = verifiers.get(image)
    if verifier is None:
        near = [key for key in verifiers if key.split('@sha256:')[0] == image.split('@sha256:')[0]]
        failures.append('no verifier listed for the exact target image')
        for key in near:
            failures.append('near-miss: a verifier IS listed for the same repository at a different digest: ' + key)
        return failures
    path = Path(verifier)
    if not path.is_absolute():
        failures.append('verifier path is not absolute')
    if not path.is_file():
        failures.append('verifier file does not exist')
        return failures
    if owner_uid(path) != 0:
        failures.append('verifier is not owned by root')
    mode = stat.S_IMODE(os.stat(path).st_mode)
    if mode & 0o077 or not mode & 0o100:
        failures.append('verifier permissions are not the reviewed root-only executable (0700)')
    if sha256_file(path) != verifier_sha256:
        failures.append('verifier bytes differ from the reviewed pin')
    return failures


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True, help='exact target image string the updater will pass')
    parser.add_argument('--policy', default='/opt/lyam/qualification.json')
    parser.add_argument('--verifier-sha256', required=True, help='reviewed sha256 pin of the verifier file')
    args = parser.parse_args()
    failures = preflight(args.image, args.policy, args.verifier_sha256)
    if failures:
        for failure in failures:
            print('PREFLIGHT FAILED: ' + failure, file=sys.stderr)
        print('Do NOT start the update cycle. Install the reviewed verifier root 0700 and list the '
              'exact image key in the policy BETWEEN cycles, then re-run this preflight.', file=sys.stderr)
        return 1
    print('Preflight OK: exact image key listed, verifier root-owned 0700 and pinned to the reviewed bytes.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
