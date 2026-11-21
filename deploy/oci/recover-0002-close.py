#!/usr/bin/env python3
"""Reviewed EXCEPTIONAL gate lift + queue journal repair for the migration-0002
incident. This is the ONLY mutating step, and it runs exclusively after the
coordinated owner approval of the exceptional reopening. It is not the nominal
update path: it never deploys, restores, deletes evidence, or rewrites history.

Sequence (every step fail-closed, nothing is skipped):
  1. fresh proof required: a recover-0002-proof report, PASS, at most
     --max-proof-age-minutes old, tied to the reviewed verifier bytes, the current
     policy file, the same evidence pair, the same queue state hash and the same
     runner hashes as RIGHT NOW (frozen runners: anything changed = abort);
  2. locks: queue and updater locks acquired for the whole operation;
  3. preconditions re-checked live: exact barrier token (identity, dead owner),
     503 on every policy origin, candidate container running the verified image,
     queue state still exactly the reviewed failed pending entry;
  4. incident archive: hash copies of the queue state (with pending+failed), the
     proof report and every linked file BEFORE any change - the failure is never
     forgotten;
  5. lift: remove the marker, then prove 200 on EVERY policy origin and re-run the
     controller's immutable smoke (real OIDC login) on the served app; ANY failure
     re-arms the gate with the same archived token and aborts with NO journal
     change (pending/failed kept);
  6. only then, journal repair under the queue lock: history appends exactly the
     reviewed entry (same SHA, parent and digest; existing entries untouched),
     pending/failed removed from the live state (preserved in the archive), atomic
     fsynced write, plus a separate private incident trace linking failure, proofs,
     approval reference and every hash.
"""
import argparse
import calendar
import fcntl
import re
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

SHA_118 = 'bc38aaee81bfd3dd644d6bf4bba94c79fa09a710'
SHA_PARENT = '0744782c075b4cd2b694088d7a3ac99af7914bc2'
NEW_DIGEST = 'sha256:7c5ce38f03b378afbb060e6092706a03503c47eac58c2cbca943d15d0d652201'
OLD_DIGEST = 'sha256:accbd340a59db8a87762f9cdb338a6aca70f92f99a5a5c9e5ba2425f8f3eb3de'
NEW_IMAGE = 'ghcr.io/manudss/iam-platform-poc@' + NEW_DIGEST
REVIEWED_VERIFIER_SHA256 = '54f2f29fc072e3cdf5dc03fac1c7685f9059d8a54a818a4582686b682e6b40ba'
RUNNER_FILES = ['update.sh', 'ordered-queue.py', 'qualification.py', 'qualification-container.mjs', 'verify-0002-account-blocks.py']


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


def wait_front(origins, expected, attempts, delay):
    for _ in range(attempts):
        if all(http_status(origin + '/healthz') == expected for origin in origins):
            return True
        time.sleep(delay)
    return False


def close(args):
    proof = json.loads(Path(args.proof).read_text())
    if proof.get('format') != 1 or proof.get('kind') != 'recover-0002-proof' or proof.get('result') != 'PASS':
        fail('proof report is not a PASS recover-0002 proof')
    created = calendar.timegm(time.strptime(proof['createdAt'], '%Y-%m-%dT%H:%M:%SZ'))
    if time.time() - created > args.max_proof_age_minutes * 60:
        fail('proof report is stale; re-run the proof collector')
    if proof.get('verifierSha256') != REVIEWED_VERIFIER_SHA256:
        fail('proof was produced by unreviewed verifier bytes')

    bin_dir = Path(args.bin_dir)
    for name in RUNNER_FILES:
        current = sha256_file(bin_dir / name)
        if proof.get('runnerSha256', {}).get(name) != current:
            fail('a runner changed since the proof: frozen-runners violation')
    policy_path = args.policy
    if proof.get('policySha256') != sha256_file(policy_path):
        fail('policy changed since the proof')
    for key, path in (('beforeSha256', args.before), ('afterSha256', args.after)):
        if proof.get(key) != sha256_file(path):
            fail('evidence file changed since the proof')
    if proof.get('queueStateSha256') != sha256_file(args.queue_state):
        fail('queue state changed since the proof')

    controller_path = bin_dir / 'qualification.py'
    import importlib.util
    spec = importlib.util.spec_from_file_location('qualification_controller', controller_path)
    controller = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(controller)
    policy = controller.policy_load(policy_path)
    qspec = importlib.util.spec_from_file_location('ordered_queue', bin_dir / 'ordered-queue.py')
    queue = importlib.util.module_from_spec(qspec)
    qspec.loader.exec_module(queue)

    # Locks held for the whole operation (released at process exit on every path).
    for lock_path, label in ((args.queue_state + '.lock', 'queue'), (getconf(args.env_file, 'LYAM_LOCK_FILE') or '/opt/lyam/.update.lock', 'updater')):
        if not Path(lock_path).is_file():
            fail(label + ' lock file missing: unknown runner state')
        fd = os.open(lock_path, os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            fail(label + ' lock busy: a run is in flight')

    # Preconditions, live, identical to what the proof covered.
    barrier = proof.get('barrier') or {}
    barrier_file = barrier.get('file') or getconf(args.env_file, 'LYAM_FRONT_BARRIER_FILE') or '/var/lib/lyam-front-gate/MAINTENANCE'
    token = Path(barrier_file).read_text().strip() if Path(barrier_file).is_file() else ''
    if not token or token != barrier.get('token'):
        fail('maintenance marker changed since the proof')
    match = re.fullmatch(r'lyam-update:(\d+):(\d{8}T\d{6}Z)', token)
    if not match or pid_alive(int(match.group(1))):
        fail('maintenance marker identity check failed')
    if not wait_front(policy['origins'], 503, args.front_wait_attempts, args.front_wait_delay):
        fail('an origin is not behind maintenance')
    container = getconf(args.env_file, 'LYAM_CONTAINER') or 'lyam'
    inspect = json.loads(run(['docker', 'inspect', container]))[0]
    if inspect.get('Config', {}).get('Image') != NEW_IMAGE or not inspect.get('State', {}).get('Running'):
        fail('candidate is not the verified image running')

    state = json.loads(Path(args.queue_state).read_text())
    if state['history'][-1].get('sha') != SHA_PARENT or state['history'][-1].get('digest') != OLD_DIGEST:
        fail('queue history tip changed')
    pending = state.get('pending') or {}
    if pending.get('sha') != SHA_118 or pending.get('parent') != SHA_PARENT or pending.get('digest') != NEW_DIGEST:
        fail('queue pending entry changed')
    if (state.get('failed') or {}).get('exit') != 4 or state['failed'].get('sha') != SHA_118:
        fail('queue failed record changed')

    # Incident archive BEFORE any change: failure evidence is never forgotten.
    incident = Path(args.incident_dir)
    incident.mkdir(mode=0o700, parents=False, exist_ok=False)
    private_json(incident / 'queue-state-archived.json', state)
    private_json(incident / 'proof-archived.json', proof)
    private_json(incident / 'manifest.json', {
        'queueStateSha256': sha256_file(args.queue_state),
        'proofSha256': sha256_file(args.proof),
        'beforeSha256': proof['beforeSha256'],
        'afterSha256': proof['afterSha256'],
        'policySha256': proof['policySha256'],
        'verifierSha256': proof['verifierSha256'],
        'runnerSha256': proof['runnerSha256'],
        'approvalRef': args.approval_ref,
        'images': proof['images'],
    })

    # Lift, then prove the front on every origin and a real OIDC login on the served app.
    lifted = False
    try:
        os.unlink(barrier_file)
        lifted = True
        if not wait_front(policy['origins'], 200, args.front_wait_attempts, args.front_wait_delay):
            fail('front did not answer 200 on every origin after lift')
        source = (bin_dir / 'qualification-container.mjs').read_text()
        auth = json.loads(Path(policy['authFile']).read_text())
        smoke = json.loads(run(['docker', 'exec', '-i', container, 'node', '--input-type=module', '-e', source, 'smoke'],
                               input_text=json.dumps({**policy, 'auth': auth, 'reviewedLegacyRollback': False})))
        if not isinstance(smoke.get('journal'), dict) or not isinstance(smoke.get('ledger'), list):
            fail('post-lift smoke result incomplete')
    except Exception:
        if lifted:
            try:
                fd = os.open(barrier_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
                with os.fdopen(fd, 'w') as f:
                    f.write(token + '\n')
                    f.flush()
                    os.fsync(f.fileno())
            except Exception:
                print('CRITICAL: could not re-arm the maintenance gate at ' + barrier_file, file=sys.stderr)
        raise

    # Journal repair, last, under the queue lock: append only, nothing rewritten.
    repaired = json.loads(Path(args.queue_state).read_text())
    if repaired != state:
        fail('queue state changed during the lift')
    repaired['history'].append({'sha': SHA_118, 'parent': SHA_PARENT, 'digest': NEW_DIGEST,
                                'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
    del repaired['pending']
    del repaired['failed']
    queue.atomic(Path(args.queue_state), repaired)
    private_json(incident / 'incident-trace.json', {
        'format': 1,
        'kind': 'recover-0002-trace',
        'approvalRef': args.approval_ref,
        'failure': {'sha': SHA_118, 'exit': 4, 'cause': 'missing digest-specific transformation verifier (policy gap)'},
        'proofSha256': sha256_file(args.proof),
        'liftedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'front': {origin: 200 for origin in policy['origins']},
        'postLiftSmoke': {'journal': smoke.get('journal'), 'ledger': smoke.get('ledger')},
        'historyAppended': {'sha': SHA_118, 'parent': SHA_PARENT, 'digest': NEW_DIGEST},
        'pendingFailedPreservedIn': 'queue-state-archived.json',
    })
    return {'history': len(repaired['history']), 'incident': str(incident)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--approval-ref', required=True,
                        help='Reference of the coordinated owner approval for this exceptional lift (required, recorded)')
    parser.add_argument('--proof', required=True)
    parser.add_argument('--before', required=True)
    parser.add_argument('--after', required=True)
    parser.add_argument('--incident-dir', required=True)
    parser.add_argument('--policy', default='/opt/lyam/qualification.json')
    parser.add_argument('--queue-state', default='/opt/lyam/deploy-queue/state.json')
    parser.add_argument('--env-file', default='/opt/lyam/lyam.env')
    parser.add_argument('--bin-dir', default='/opt/lyam/bin')
    parser.add_argument('--max-proof-age-minutes', type=int, default=30)
    parser.add_argument('--front-wait-attempts', type=int, default=30)
    parser.add_argument('--front-wait-delay', type=float, default=2)
    args = parser.parse_args()
    try:
        result = close(args)
    except Exception:
        print('Exceptional closure failed or UNKNOWN. Gate kept/re-armed; no journal repair unless already proven.', file=sys.stderr)
        return 1
    print('Exceptional closure complete: ' + json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
