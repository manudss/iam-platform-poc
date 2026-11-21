#!/usr/bin/env python3
"""Reviewed EXCEPTIONAL gate lift + queue journal repair for the migration-0002
incident. This is the ONLY mutating step, and it runs exclusively after the
coordinated owner approval of the exceptional reopening. --approval-ref RECORDS the
reference of that external approval; it is a trace field, never a permission check -
the permission itself is established outside this script by the owner. This is not
the nominal update path: it never deploys, restores, deletes evidence, or rewrites
history.

Sequence (nothing is skipped):
  1. fresh proof required: a recover-0002-proof report, PASS, dated at most
     --max-proof-age-minutes ago and NOT in the future (clock skew guard), tied to
     the reviewed verifier bytes, the current policy file, the same evidence pair,
     the same queue state hash, the same effective environment configuration and
     the same runner hashes as RIGHT NOW (frozen runners: the queue runner is
     hashed at its REAL installed path, anything changed = abort);
  2. locks: queue and updater locks acquired for the whole operation (released in
     a finally on every path);
  3. preconditions re-checked live: exact barrier token (identity, dead owner),
     503 on every policy origin, exactly ONE container of the verified image,
     running, not restarting, started at least 30s ago (crash-loop stability),
     queue state still exactly the reviewed failed pending entry;
  4. COMPLETE recapture under both locks, immediately before any lift: the full
     reviewed verifier pass (evidence + fresh complete recapture) must still hold
     right now - no reliance on successive probes;
  5. incident archive: private copies of the queue state (with pending+failed),
     the proof report and BOTH evidence files BEFORE any change - the failure is
     never forgotten;
  6. lift: remove the marker, prove 200 on EVERY policy origin, re-run the
     controller's immutable smoke (real OIDC login), then run a COMPLETE
     post-smoke recapture: strict equality with the historical after-capture
     everywhere except policy-declared append-only PostgreSQL surfaces, where
     every captured row must still be present and growth is bounded explicitly
     (the activation journal must stay exactly as captured; only declared audit
     tables may grow, counted and traced). Tolerances are NOT widened silently:
     anything unexplained is UNKNOWN and aborts;
  7. only then, journal repair under the queue lock: history appends exactly the
     reviewed entry (same SHA, parent and digest; existing entries untouched),
     pending/failed removed from the live state (preserved in the archive),
     atomic fsynced write, plus a separate private incident trace linking
     failure, proofs, approval reference and every hash.

Failure semantics (faithful reporting, distinct exit codes):
  - any failure BEFORE the lift: exit 1; the gate was never touched, no journal
    change;
  - any failure AFTER the lift and BEFORE the journal append: the script re-arms
    the gate with the archived token (overwriting marker content if needed - the
    updater lock is held, so no new run can own it) and then CONFIRMS 503 on every
    origin: exit 2 when re-arm is confirmed (no journal change), exit 3 when it is
    NOT confirmed (gate state unknown - operator must verify the origins NOW);
  - a failure of the incident trace AFTER the journal append is a partial commit:
    the journal already records the reviewed entry, so re-arming would contradict
    it; the verified front stays OPEN, exit 4, and the operator completes the
    trace from the private archive;
  - SIGTERM/SIGINT during the lifted window are caught and take the same re-arm
    path. NO in-process mechanism can survive SIGKILL, a power loss or an OOM kill
    between the lift and the re-arm: after ANY abnormal termination the operator
    MUST check every origin for 503 and re-arm manually with the archived token.
"""
import argparse
import calendar
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import signal
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
REVIEWED_VERIFIER_SHA256 = 'dda55ce199c16e6c25f75eb5fc1427eb9651e7e5b9f256c70c8c37f68b60b4d4'
RUNNER_FILES = ['update.sh', 'qualification.py', 'qualification-container.mjs', 'verify-0002-account-blocks.py']
# The queue runner is hashed at its REAL installed path, not a staging copy.
QUEUE_RUNNER = '/usr/local/libexec/lyam-queue/ordered-queue.py'
CONTAINER_STABILITY_SECONDS = 30
FUTURE_PROOF_TOLERANCE_SECONDS = 60


class CloseFailure(Exception):
    """A failure inside or after the lifted window, with the faithful end state."""

    def __init__(self, step, rearm_confirmed, journal_advanced, note=''):
        super().__init__(step)
        self.step = step
        self.rearm_confirmed = rearm_confirmed  # None when no re-arm was attempted
        self.journal_advanced = journal_advanced
        self.note = note


class _Signalled(BaseException):
    pass


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
    """HTTP status, or 0 for ANY transport error/timeout (unknown, never an escape):
    a network failure must degrade a probe to 'not the expected status', never
    propagate and corrupt the faithful end-state report."""
    try:
        return urllib.request.urlopen(url, timeout=15).status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return 0


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


def effective_env(env_file):
    """The effective runtime configuration, frozen once for the whole operation."""
    return {'barrierFile': getconf(env_file, 'LYAM_FRONT_BARRIER_FILE') or '/var/lib/lyam-front-gate/MAINTENANCE',
            'updateLock': getconf(env_file, 'LYAM_LOCK_FILE') or '/opt/lyam/.update.lock',
            'container': getconf(env_file, 'LYAM_CONTAINER') or 'lyam'}


def runner_paths(bin_dir, queue_runner):
    paths = {name: str(Path(bin_dir) / name) for name in RUNNER_FILES}
    paths['ordered-queue.py'] = queue_runner
    return paths


def load_module(path, module_name):
    spec = importlib.util.spec_from_file_location(module_name, str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def private_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())


def private_copy(src, dst):
    fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as out:
        out.write(Path(src).read_text())
        out.flush()
        os.fsync(out.fileno())


def wait_front(origins, expected, attempts, delay):
    for _ in range(attempts):
        if all(http_status(origin + '/healthz') == expected for origin in origins):
            return True
        time.sleep(delay)
    return False


def find_single_stable_container(name):
    """Exactly one running container of the verified image, stable for at least
    CONTAINER_STABILITY_SECONDS (no crash-loop between proof and lift)."""
    ids = [line.strip() for line in run(['docker', 'ps', '--filter', 'ancestor=' + NEW_IMAGE, '--format', '{{.ID}}']).splitlines() if line.strip()]
    if len(ids) != 1:
        fail('expected exactly one running container of the verified image')
    inspect = json.loads(run(['docker', 'inspect', name]))[0]
    state = inspect.get('State', {})
    if inspect.get('Config', {}).get('Image') != NEW_IMAGE or not state.get('Running'):
        fail('candidate is not the verified image running')
    if not str(inspect.get('Id', '')).startswith(ids[0]):
        fail('the named container is not the unique container of the verified image')
    if state.get('Restarting'):
        fail('candidate container is restarting')
    started = state.get('StartedAt', '')[:19]
    try:
        started_ts = calendar.timegm(time.strptime(started, '%Y-%m-%dT%H:%M:%S'))
    except ValueError:
        fail('candidate container start time unreadable: stability not proven')
    if time.time() - started_ts < CONTAINER_STABILITY_SECONDS:
        fail('candidate container started less than %ds ago: stability not proven' % CONTAINER_STABILITY_SECONDS)
    return name


def rearm(barrier_file, token, policy, args):
    """Best-effort re-arm with the archived token, then CONFIRM 503 on every origin.
    The updater lock is held, so no new run can legitimately own the marker: existing
    content is overwritten. Never raises; returns (503-confirmed, note)."""
    note = 'marker rewritten with the archived token'
    try:
        existing = Path(barrier_file).read_text().strip() if Path(barrier_file).is_file() else ''
        fd = os.open(barrier_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
        with os.fdopen(fd, 'w') as f:
            f.write(token + '\n')
            f.flush()
            os.fsync(f.fileno())
        if existing and existing != token:
            note = 'overwrote unexpected pre-existing marker content'
    except Exception:
        return False, 'marker write failed'
    if wait_front(policy['origins'], 503, args.front_wait_attempts, args.front_wait_delay):
        return True, note
    return False, 'marker written but 503 NOT confirmed on every origin'


def recapture_after_smoke(verifier, controller, container, policy, after):
    """Complete fresh recapture AFTER the post-lift auth smoke. Strict equality with
    the historical after-capture everywhere except declared append-only PostgreSQL
    tables, where every captured row must still be present. The activation journal
    must stay exactly as captured (its only authorized append is already in the
    after-capture); other declared append-only tables (audit trail of the smoke
    itself) may grow, counted and traced. Anything else is UNKNOWN."""
    fresh = verifier.container_capture(container, policy)
    if fresh.get('dolt') != after['dolt']:
        fail('Dolt inventory drifted (post-smoke recapture)')
    if fresh.get('bao') != after['bao']:
        fail('Bao metadata drifted (post-smoke recapture)')
    if verifier.container_credentials(container, policy['credentialFiles']) != after['credentials']:
        fail('credential files drifted (post-smoke recapture)')
    if verifier.container_ledger(container) != after['migrationLedger']:
        fail('migration ledger drifted (post-smoke recapture)')
    pg = controller.postgres(policy)
    old_pg = after['postgres']
    # Total equality on every surface EXCEPT rows of declared append-only tables and
    # sequence current values (monotonic counters that authorized appends advance).
    # Schema, sequence DEFINITIONS and any other key: strict equality.
    if set(pg) != set(old_pg):
        fail('PostgreSQL surface inventory drifted (post-smoke recapture)')
    for key in pg:
        if key in ('rows', 'sequences'):
            continue
        if pg[key] != old_pg[key]:
            fail('PostgreSQL ' + key + ' drifted (post-smoke recapture)')
    if set(pg.get('sequences', {})) != set(old_pg.get('sequences', {})):
        fail('PostgreSQL sequence inventory drifted (post-smoke recapture)')
    # Sequence current values are monotonic counters: authorized appends may ADVANCE
    # them, but any rewind (last_value down, is_called True->False) is a regression;
    # unknown types or shapes are refused, not guessed.
    for name, old_seq in old_pg.get('sequences', {}).items():
        new_seq = pg['sequences'][name]
        if not isinstance(old_seq, dict) or not isinstance(new_seq, dict) or set(new_seq) != set(old_seq):
            fail('PostgreSQL sequence shape unknown (post-smoke recapture)')
        old_last, new_last = old_seq.get('last_value'), new_seq.get('last_value')
        if (not isinstance(old_last, int) or isinstance(old_last, bool)
                or not isinstance(new_last, int) or isinstance(new_last, bool)):
            fail('PostgreSQL sequence value unknown (post-smoke recapture)')
        if new_last < old_last:
            fail('PostgreSQL sequence rewound (post-smoke recapture)')
        old_called, new_called = old_seq.get('is_called'), new_seq.get('is_called')
        if not isinstance(old_called, bool) or not isinstance(new_called, bool):
            fail('PostgreSQL sequence is_called unknown (post-smoke recapture)')
        if old_called and not new_called:
            fail('PostgreSQL sequence is_called regressed (post-smoke recapture)')
    old_rows = old_pg.get('rows', {})
    new_rows = pg.get('rows', {})
    if set(new_rows) != set(old_rows):
        fail('PostgreSQL table inventory drifted (post-smoke recapture)')
    declared = set(policy.get('appendOnlyTables') or [])
    appended = {}
    for table in old_rows:
        old_multiset = old_rows[table]
        new_multiset = new_rows[table]
        # Union of hashes, every multiplicity preserved: any decrease - including a
        # hash that vanished entirely - is a disappearance.
        for row_hash in set(old_multiset) | set(new_multiset):
            if new_multiset.get(row_hash, 0) < old_multiset.get(row_hash, 0):
                fail('a PostgreSQL row disappeared (post-smoke recapture)')
        extra = sum(new_multiset.get(row_hash, 0) - old_multiset.get(row_hash, 0)
                    for row_hash in new_multiset)
        if not extra:
            continue
        if table == verifier.ACTIVATIONS_TABLE:
            fail('the activation journal grew after its captured publication (post-smoke recapture)')
        if table not in declared:
            fail('rows appeared in a non-append-only table (post-smoke recapture)')
        appended[table] = extra
    return {'appendedRows': appended}


def close(args):
    proof = json.loads(Path(args.proof).read_text())
    if proof.get('format') != 1 or proof.get('kind') != 'recover-0002-proof' or proof.get('result') != 'PASS':
        fail('proof report is not a PASS recover-0002 proof')
    created = calendar.timegm(time.strptime(proof['createdAt'], '%Y-%m-%dT%H:%M:%SZ'))
    now = time.time()
    if created > now + FUTURE_PROOF_TOLERANCE_SECONDS:
        fail('proof report is dated in the future: clock skew or forged report')
    if now - created > args.max_proof_age_minutes * 60:
        fail('proof report is stale; re-run the proof collector')
    if proof.get('verifierSha256') != REVIEWED_VERIFIER_SHA256:
        fail('proof was produced by unreviewed verifier bytes')

    bin_dir = Path(args.bin_dir)
    for name, path in runner_paths(bin_dir, args.queue_runner).items():
        if proof.get('runnerSha256', {}).get(name) != sha256_file(path):
            fail('a runner changed since the proof: frozen-runners violation')
    if proof.get('policySha256') != sha256_file(args.policy):
        fail('policy changed since the proof')
    for key, path in (('beforeSha256', args.before), ('afterSha256', args.after)):
        if proof.get(key) != sha256_file(path):
            fail('evidence file changed since the proof')
    if proof.get('queueStateSha256') != sha256_file(args.queue_state):
        fail('queue state changed since the proof')
    env_eff = effective_env(args.env_file)
    if proof.get('envEffective') != env_eff:
        fail('effective environment configuration changed since the proof')

    controller = load_module(bin_dir / 'qualification.py', 'qualification_controller')
    queue = load_module(args.queue_runner, 'ordered_queue')
    if sha256_file(bin_dir / 'verify-0002-account-blocks.py') != REVIEWED_VERIFIER_SHA256:
        fail('installed verifier is not the reviewed bytes')
    verifier = load_module(bin_dir / 'verify-0002-account-blocks.py', 'reviewed_verifier')
    policy = controller.policy_load(args.policy)

    lock_fds = []
    try:
        # Locks held for the whole operation, released cleanly in the finally.
        for lock_path, label in ((args.queue_state + '.lock', 'queue'), (env_eff['updateLock'], 'updater')):
            if not Path(lock_path).is_file():
                fail(label + ' lock file missing: unknown runner state')
            fd = os.open(lock_path, os.O_RDWR)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                os.close(fd)
                fail(label + ' lock busy: a run is in flight')
            lock_fds.append(fd)

        # Preconditions, live, identical to what the proof covered.
        barrier_file = env_eff['barrierFile']
        barrier_proof = proof.get('barrier') or {}
        token = Path(barrier_file).read_text().strip() if Path(barrier_file).is_file() else ''
        if not token or token != barrier_proof.get('token'):
            fail('maintenance marker changed since the proof')
        match = re.fullmatch(r'lyam-update:(\d+):(\d{8}T\d{6}Z)', token)
        if not match or pid_alive(int(match.group(1))):
            fail('maintenance marker identity check failed')
        if not wait_front(policy['origins'], 503, args.front_wait_attempts, args.front_wait_delay):
            fail('an origin is not behind maintenance')
        container = find_single_stable_container(env_eff['container'])

        state = json.loads(Path(args.queue_state).read_text())
        if state['history'][-1].get('sha') != SHA_PARENT or state['history'][-1].get('digest') != OLD_DIGEST:
            fail('queue history tip changed')
        pending = state.get('pending') or {}
        if pending.get('sha') != SHA_118 or pending.get('parent') != SHA_PARENT or pending.get('digest') != NEW_DIGEST:
            fail('queue pending entry changed')
        if (state.get('failed') or {}).get('exit') != 4 or state['failed'].get('sha') != SHA_118:
            fail('queue failed record changed')

        # COMPLETE recapture under both locks, immediately before any lift: the full
        # reviewed verifier pass (historical evidence + fresh complete recapture)
        # must still hold right now.
        verifier.verify(args.before, args.after, args.policy)

        # Incident archive BEFORE any change: failure evidence is never forgotten.
        after_doc = json.loads(Path(args.after).read_text())
        incident = Path(args.incident_dir)
        incident.mkdir(mode=0o700, parents=False, exist_ok=False)
        private_json(incident / 'queue-state-archived.json', state)
        private_json(incident / 'proof-archived.json', proof)
        private_copy(args.before, incident / 'before-archived.json')
        private_copy(args.after, incident / 'after-archived.json')
        private_json(incident / 'manifest.json', {
            'queueStateSha256': sha256_file(args.queue_state),
            'proofSha256': sha256_file(args.proof),
            'beforeSha256': proof['beforeSha256'],
            'afterSha256': proof['afterSha256'],
            'policySha256': proof['policySha256'],
            'verifierSha256': proof['verifierSha256'],
            'runnerSha256': proof['runnerSha256'],
            'envEffective': env_eff,
            'approvalRef': args.approval_ref,
            'images': proof['images'],
        })

        # Lifted window. SIGTERM/SIGINT take the same re-arm path as any failure;
        # nothing in-process can survive SIGKILL between lift and re-arm (see module
        # docstring - the operator checks the origins after any abnormal exit).
        previous_handlers = {}
        def _raise_signalled(signum, frame):
            raise _Signalled('received signal %d' % signum)
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[signum] = signal.signal(signum, _raise_signalled)
        lifted = False
        journal_advanced = False
        step = 'lift'
        # Trace steps BEFORE irreversible operations: a crash then leaves private
        # evidence of how far the closure went.
        private_json(incident / 'progress-1-lift-started.json',
                     {'step': 'lift', 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
        try:
            os.unlink(barrier_file)
            lifted = True
            step = 'front-200-on-all-origins'
            if not wait_front(policy['origins'], 200, args.front_wait_attempts, args.front_wait_delay):
                fail('front did not answer 200 on every origin after lift')
            step = 'post-lift-auth-smoke'
            source = (bin_dir / 'qualification-container.mjs').read_text()
            auth = json.loads(Path(policy['authFile']).read_text())
            smoke = json.loads(run(['docker', 'exec', '-i', container, 'node', '--input-type=module', '-e', source, 'smoke'],
                                   input_text=json.dumps({**policy, 'auth': auth, 'reviewedLegacyRollback': False})))
            if not isinstance(smoke.get('journal'), dict) or not isinstance(smoke.get('ledger'), list):
                fail('post-lift smoke result incomplete')
            step = 'post-smoke-complete-recapture'
            recapture = recapture_after_smoke(verifier, controller, container, policy, after_doc)
            step = 'queue-state-unchanged'
            repaired = json.loads(Path(args.queue_state).read_text())
            if repaired != state:
                fail('queue state changed during the lift')
            step = 'journal-append'
            repaired['history'].append({'sha': SHA_118, 'parent': SHA_PARENT, 'digest': NEW_DIGEST,
                                        'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
            del repaired['pending']
            del repaired['failed']
            private_json(incident / 'progress-2-journal-append-started.json',
                         {'step': 'journal-append', 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
            try:
                queue.atomic(Path(args.queue_state), repaired)
                journal_advanced = True
            except BaseException:
                # ANY interruption of the append - error, timeout or signal - leaves
                # the journal state uncertain: the atomic write may have REPLACED the
                # file and only then failed (fsync). Resolve from the queue file
                # itself, never from local sequencing: INTEGRAL comparison with the
                # expected repaired state or with the original; anything else - or an
                # unreadable file - is UNKNOWN, never claimed unadvanced.
                try:
                    actual = json.loads(Path(args.queue_state).read_text())
                    if actual == repaired:
                        journal_advanced = True
                    elif actual == state:
                        journal_advanced = False
                    else:
                        journal_advanced = None
                except Exception:
                    journal_advanced = None
                raise
            step = 'incident-trace'
            private_json(incident / 'incident-trace.json', {
                'format': 1,
                'kind': 'recover-0002-trace',
                'approvalRef': args.approval_ref,
                'failure': {'sha': SHA_118, 'exit': 4, 'cause': 'missing digest-specific transformation verifier (policy gap)'},
                'proofSha256': sha256_file(args.proof),
                'liftedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'front': {origin: 200 for origin in policy['origins']},
                'postLiftSmoke': {'journal': smoke.get('journal'), 'ledger': smoke.get('ledger')},
                'postSmokeRecapture': recapture,
                'historyAppended': {'sha': SHA_118, 'parent': SHA_PARENT, 'digest': NEW_DIGEST},
                'pendingFailedPreservedIn': 'queue-state-archived.json',
            })
        except BaseException:
            for signum, handler in previous_handlers.items():
                signal.signal(signum, handler)
            if not lifted:
                raise
            if journal_advanced:
                # Partial commit: the journal already records the reviewed entry, so
                # re-arming would contradict it. The front was just proven 200 + real
                # login; leave it OPEN and report the missing trace faithfully.
                raise CloseFailure(step, None, True,
                                   'journal advanced and verified front left open; only the incident trace is missing')
            confirmed, note = rearm(barrier_file, token, policy, args)
            if journal_advanced is None:
                # The queue file could not even be re-read after the failed append:
                # fail-closed default (gate re-armed) but the journal state is
                # UNKNOWN - the operator must reconcile it before anything else.
                note = 'journal state UNKNOWN after a failed append; ' + note
            raise CloseFailure(step, confirmed, journal_advanced, note)
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
        return {'history': len(repaired['history']), 'incident': str(incident)}
    finally:
        for fd in lock_fds:
            os.close(fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--approval-ref', required=True,
                        help='Trace reference of the external coordinated owner approval (recorded only; NOT a permission check)')
    parser.add_argument('--proof', required=True)
    parser.add_argument('--before', required=True)
    parser.add_argument('--after', required=True)
    parser.add_argument('--incident-dir', required=True)
    parser.add_argument('--policy', default='/opt/lyam/qualification.json')
    parser.add_argument('--queue-state', default='/opt/lyam/deploy-queue/state.json')
    parser.add_argument('--queue-runner', default=QUEUE_RUNNER,
                        help='REAL installed path of the queue runner (hashed and imported, never a copy)')
    parser.add_argument('--env-file', default='/opt/lyam/lyam.env')
    parser.add_argument('--bin-dir', default='/opt/lyam/bin')
    parser.add_argument('--max-proof-age-minutes', type=int, default=30)
    parser.add_argument('--front-wait-attempts', type=int, default=30)
    parser.add_argument('--front-wait-delay', type=float, default=2)
    args = parser.parse_args()
    try:
        result = close(args)
    except CloseFailure as e:
        report = {'failedStep': e.step, 'journalAdvanced': e.journal_advanced,
                  'rearmConfirmed503': e.rearm_confirmed, 'note': e.note}
        print('Exceptional closure FAILED: ' + json.dumps(report), file=sys.stderr)
        if e.journal_advanced:
            return 4
        if e.journal_advanced is None:
            return 3
        if e.rearm_confirmed is True:
            return 2
        return 3
    except Exception:
        print('Exceptional closure aborted BEFORE any lift. Gate untouched; no journal change.', file=sys.stderr)
        return 1
    print('Exceptional closure complete: ' + json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
