#!/usr/bin/env python3
"""Read-only proof collector for the reviewed exceptional reopening after the failed
migration-0002 deployment (queue entry bc38aae / image ...7c5ce38f, failed exit 4).

This is NOT the nominal qualification path and does not replace it: the nominal
controller keeps refusing this mid-update policy situation. This collector gathers,
WITHOUT ANY BUSINESS-DATA MUTATION, every proof an owner-approved exceptional gate
lift needs. Honest scope: the audited OIDC logins below create ordinary session and
audit events (as any login does), and the report files are created; no user, policy
or application data is read out or changed, and the gate, queue and runners are
never touched:

  1. the reviewed digest-specific verifier (sibling verify-0002-account-blocks.py)
     passes on the preserved historical evidence pair - which already includes a
     complete fresh recapture (Dolt/Bao/PG/credentials/ledger) tied to live state;
  2. the controller's own immutable smoke (real OIDC password login with PKCE/state
     on every policy origin, negative redirect, session, activation journal schema,
     migration ledger vs manifest) passes RIGHT NOW on the gated candidate;
  3. the maintenance gate still answers 503 on every policy origin (nothing was
     exposed while proving);
  4. the front marker still carries the exact failed run's ownership token and that
     run's process is dead (the gate is orphaned, not someone else's live work);
  5. both updater locks are free (no runner in flight) and the queue state still
     shows exactly the failed pending entry this proof covers.

It writes ONE private append-only report (new directory, mode 0700, files O_EXCL
0600, fsynced) containing hashes only: no secrets, no row values. Any failure or
unknown is nonzero exit; the report is only written on full PASS.
"""
import argparse
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

QUEUE_STATE = '/opt/lyam/deploy-queue/state.json'
ENV_FILE = '/opt/lyam/lyam.env'
BIN_DIR = '/opt/lyam/bin'
SHA_118 = 'bc38aaee81bfd3dd644d6bf4bba94c79fa09a710'
SHA_PARENT = '0744782c075b4cd2b694088d7a3ac99af7914bc2'
NEW_DIGEST = 'sha256:7c5ce38f03b378afbb060e6092706a03503c47eac58c2cbca943d15d0d652201'
OLD_DIGEST = 'sha256:accbd340a59db8a87762f9cdb338a6aca70f92f99a5a5c9e5ba2425f8f3eb3de'
NEW_IMAGE = 'ghcr.io/manudss/iam-platform-poc@' + NEW_DIGEST
OLD_IMAGE = 'ghcr.io/manudss/iam-platform-poc@' + OLD_DIGEST
# sha256 of the reviewed sibling verifier file; a repo test pins this constant to the
# reviewed bytes. Any change to the verifier requires a new review and a new pin.
REVIEWED_VERIFIER_SHA256 = '7f2991e21b183979ac6735586e03c70e26b7615aeae356a3e6afe7b48b94fd0f'
RUNNER_FILES = ['update.sh', 'qualification.py', 'qualification-container.mjs', 'verify-0002-account-blocks.py']
# The queue runner is hashed at its REAL installed path, not a staging copy.
QUEUE_RUNNER = '/usr/local/libexec/lyam-queue/ordered-queue.py'


def effective_env(env_file):
    """The effective runtime configuration, frozen into the report for the closure."""
    return {'barrierFile': getconf(env_file, 'LYAM_FRONT_BARRIER_FILE') or '/var/lib/lyam-front-gate/MAINTENANCE',
            'updateLock': getconf(env_file, 'LYAM_LOCK_FILE') or '/opt/lyam/.update.lock',
            'container': getconf(env_file, 'LYAM_CONTAINER') or 'lyam'}


def runner_paths(bin_dir, queue_runner):
    paths = {name: str(Path(bin_dir) / name) for name in RUNNER_FILES}
    paths['ordered-queue.py'] = queue_runner
    return paths


def fail(message):
    raise ValueError(message)


def run(args, input_text=None):
    result = subprocess.run(args, input=input_text, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    if result.returncode:
        fail('command failed, private diagnostic inspection required')
    return result.stdout.strip()


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def http_status(url):
    try:
        return urllib.request.urlopen(url, timeout=15).status
    except urllib.error.HTTPError as e:
        return e.code


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def load_sibling(bin_dir, name, module_name):
    import importlib.util
    path = Path(bin_dir) / name
    if not path.is_file():
        fail('required sibling not installed next to this script: ' + name)
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def getconf(env_file, key):
    value = ''
    if Path(env_file).is_file():
        for line in Path(env_file).read_text().splitlines():
            if line.startswith(key + '='):
                value = line[len(key) + 1:]
    return value


def private_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())


def lock_free(path):
    """Read-only probe: a missing lock file is free; a shared probe fails only while a writer holds it."""
    if not Path(path).is_file():
        return True
    fd = os.open(path, os.O_RDONLY)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except OSError:
            return False
        fcntl.flock(fd, fcntl.LOCK_UN)
        return True
    finally:
        os.close(fd)


def collect(before_path, after_path, evidence_out, policy_path, queue_state, env_file, bin_dir,
            queue_runner=QUEUE_RUNNER):
    controller = load_sibling(bin_dir, 'qualification.py', 'qualification_controller')
    verifier = load_sibling(bin_dir, 'verify-0002-account-blocks.py', 'reviewed_verifier')
    policy = controller.policy_load(policy_path)

    verifier_hash = sha256_file(Path(bin_dir) / 'verify-0002-account-blocks.py')
    if verifier_hash != REVIEWED_VERIFIER_SHA256:
        fail('installed verifier is not the reviewed bytes')

    # 1. Full verifier proof on the historical pair (includes its own fresh recapture).
    verifier.verify(before_path, after_path, policy_path)

    # 2. Controller's immutable smoke, right now, on the gated candidate.
    container = verifier.find_container(NEW_IMAGE)
    source = (Path(bin_dir) / 'qualification-container.mjs').read_text()
    auth = json.loads(Path(policy['authFile']).read_text())
    smoke = json.loads(run(['docker', 'exec', '-i', container, 'node', '--input-type=module', '-e', source, 'smoke'],
                           input_text=json.dumps({**policy, 'auth': auth, 'reviewedLegacyRollback': False})))
    ledger = smoke.get('ledger')
    if not isinstance(ledger, list) or [e.get('id') for e in ledger] != ['0001', '0002']:
        fail('smoke migration ledger unexpected')

    # 3. Gate still armed everywhere.
    for origin in policy['origins']:
        if http_status(origin + '/healthz') != 503:
            fail('an origin is not behind maintenance while proving')

    # 4. Marker identity: exact failed-run token, dead owner process.
    env_eff = effective_env(env_file)
    barrier_file = env_eff['barrierFile']
    token = Path(barrier_file).read_text().strip() if Path(barrier_file).is_file() else ''
    match = re.fullmatch(r'lyam-update:(\d+):(\d{8}T\d{6}Z)', token)
    if not match:
        fail('maintenance marker is absent or not an updater ownership token')
    if pid_alive(int(match.group(1))):
        fail('the maintenance owner process is still alive: not ours to take')

    # 5. Locks free, queue state exactly the failed entry this proof covers.
    if not lock_free(env_eff['updateLock']) or not lock_free(queue_state + '.lock'):
        fail('an updater or queue run is in flight')
    state = json.loads(Path(queue_state).read_text())
    history = state.get('history', [])
    if state.get('format') != 1 or not history:
        fail('queue history unknown')
    if history[-1].get('sha') != SHA_PARENT or history[-1].get('digest') != OLD_DIGEST:
        fail('queue history tip is not the reviewed baseline')
    pending = state.get('pending') or {}
    if pending.get('sha') != SHA_118 or pending.get('parent') != SHA_PARENT or pending.get('digest') != NEW_DIGEST:
        fail('queue pending entry is not the reviewed commit/image')
    if (state.get('failed') or {}).get('exit') != 4 or state['failed'].get('sha') != SHA_118:
        fail('queue failed record is not the reviewed failure')

    report = {
        'format': 1,
        'kind': 'recover-0002-proof',
        'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'result': 'PASS',
        'images': {'previous': OLD_IMAGE, 'candidate': NEW_IMAGE},
        'queue': {'sha': SHA_118, 'parent': SHA_PARENT, 'failedExit': 4},
        'verifierSha256': verifier_hash,
        'policySha256': sha256_file(policy_path),
        'beforeSha256': sha256_file(before_path),
        'afterSha256': sha256_file(after_path),
        'queueStateSha256': sha256_file(queue_state),
        'runnerSha256': {name: sha256_file(path) for name, path in runner_paths(bin_dir, queue_runner).items()},
        'envEffective': env_eff,
        'barrier': {'file': barrier_file, 'token': token},
        'gate': {origin: 503 for origin in policy['origins']},
        'smoke': {'journal': smoke.get('journal'), 'ledger': ledger},
    }
    out = Path(evidence_out)
    out.mkdir(mode=0o700, parents=False, exist_ok=False)
    private_json(out / 'proof.json', report)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--before', required=True)
    parser.add_argument('--after', required=True)
    parser.add_argument('--evidence-out', required=True)
    parser.add_argument('--policy', default='/opt/lyam/qualification.json')
    parser.add_argument('--queue-state', default=QUEUE_STATE)
    parser.add_argument('--env-file', default=ENV_FILE)
    parser.add_argument('--bin-dir', default=BIN_DIR)
    parser.add_argument('--queue-runner', default=QUEUE_RUNNER,
                        help='REAL installed path of the queue runner (hashed, never a copy)')
    args = parser.parse_args()
    try:
        report = collect(args.before, args.after, args.evidence_out, args.policy, args.queue_state, args.env_file, args.bin_dir, args.queue_runner)
    except Exception:
        print('Recovery proof failed or UNKNOWN. No lift, no journal change; keep maintenance armed.', file=sys.stderr)
        return 1
    print('Recovery proof PASS: ' + json.dumps({'report': str(Path(args.evidence_out) / 'proof.json'), 'queue': report['queue']}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
