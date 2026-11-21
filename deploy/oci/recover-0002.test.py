import fcntl, importlib.util, json, os, shutil, signal, tempfile, time, types, unittest
import urllib.error
from pathlib import Path
from unittest import mock

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

p = load('recover_proof', 'recover-0002-proof.py')
c = load('recover_close', 'recover-0002-close.py')

HERE = Path(__file__).parent
TOKEN = 'lyam-update:99999999:20261121T115800Z'
SMOKE_OK = {'journal': {'count': 3, 'checksum': 'j'}, 'ledger': [{'id': '0001', 'checksum': '1' * 64}, {'id': '0002', 'checksum': '3' * 64}]}
STARTED_STABLE = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(time.time() - 3600)) + '.000000000Z'


def policy():
    return {'format': 1, 'origins': ['https://a.example', 'https://b.example', 'https://c.example'],
            'issuer': 'https://a.example/core', 'tenant': 'acme-demo', 'network': 'lyam-net',
            'pgContainer': 'pg', 'pgUser': 'lyam', 'pgDatabase': 'lyam', 'baoAddress': 'http://bao:8200',
            'baoTokenFile': '/x', 'baoMetadataRoots': ['secret/metadata/iam'], 'authFile': '/auth',
            'credentialFiles': ['core-state/credentials.json'],
            'appendOnlyTables': ['public.activations', 'public.decision_audit']}


def evidence_docs():
    before = {'image': p.OLD_IMAGE,
              'dolt': [{'database': 'iam', 'branch': 'main', 'head': 'h1', 'root': 'r1'}],
              'bao': {'secret/metadata/iam/app': 'hash'},
              'postgres': {'schema': {'columns': []}, 'sequenceDefinitions': [],
                           'sequences': {'public.decision_audit_id_seq': {'last_value': 7, 'is_called': True}},
                           'rows': {'public.activations': {'a1': 1}, 'public.decision_audit': {'d1': 2}}},
              'credentials': {'core-state/credentials.json': 'credhash'},
              'migrationLedger': {'format': 1, 'entries': [{'id': '0001', 'checksum': '1' * 64}]}}
    after = json.loads(json.dumps(before))
    after['image'] = p.NEW_IMAGE
    after['migrationLedger']['entries'].append({'id': '0002', 'checksum': '3' * 64})
    after['postgres']['rows']['public.activations'] = {'a1': 1, 'a2': 1}
    return before, after


class Fixture(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        self.bin = root / 'bin'
        self.bin.mkdir()
        for name in p.RUNNER_FILES:
            shutil.copy(HERE / name, self.bin / name)
        self.libexec = root / 'libexec'
        self.libexec.mkdir()
        self.qrunner = self.libexec / 'ordered-queue.py'
        shutil.copy(HERE / 'ordered-queue.py', self.qrunner)
        self.policy = root / 'policy.json'
        fixture_policy = policy()
        fixture_policy['authFile'] = str(root / 'auth.json')
        (root / 'auth.json').write_text(json.dumps({'username': 'u', 'password': 'p'}))
        self.policy.write_text(json.dumps(fixture_policy))
        self.before = root / 'before.json'
        self.after = root / 'after.json'
        before_doc, self.after_doc = evidence_docs()
        self.before.write_text(json.dumps(before_doc))
        self.after.write_text(json.dumps(self.after_doc))
        self.queue = root / 'state.json'
        self.queue.write_text(json.dumps(self.queue_state()))
        (root / 'state.json.lock').touch()
        self.update_lock = root / '.update.lock'
        self.update_lock.touch()
        self.barrier = root / 'MAINTENANCE'
        self.barrier.write_text(TOKEN + '\n')
        self.env = root / 'lyam.env'
        self.env.write_text('LYAM_FRONT_BARRIER_FILE=%s\nLYAM_LOCK_FILE=%s\nLYAM_CONTAINER=lyam\n' % (self.barrier, self.update_lock))
        self.out = root / 'proof-out'
        self.incident = root / 'incident'

    def tearDown(self):
        self.dir.cleanup()

    def env_effective(self):
        return {'barrierFile': str(self.barrier), 'updateLock': str(self.update_lock), 'container': 'lyam'}

    def queue_state(self):
        return {'format': 1,
                'history': [{'sha': p.SHA_PARENT, 'digest': p.OLD_DIGEST, 'at': '2026-11-19T22:00:00Z'}],
                'pending': {'sha': p.SHA_118, 'parent': p.SHA_PARENT, 'digest': p.NEW_DIGEST},
                'failed': {'sha': p.SHA_118, 'exit': 4, 'at': '2026-11-21T12:00:10Z'}}

    def run_stub(self, args, input_text=None):
        if args[:2] == ['docker', 'ps']:
            return 'abc123\n'
        if args[:2] == ['docker', 'inspect']:
            return json.dumps([{'Id': 'abc1234567890abcdef', 'Config': {'Image': p.NEW_IMAGE},
                                'State': {'Running': True, 'Restarting': False, 'StartedAt': STARTED_STABLE}}])
        if 'smoke' in args:
            return json.dumps(SMOKE_OK)
        raise AssertionError('unexpected command: ' + ' '.join(args))

    def patch_proof(self, **overrides):
        controller = types.SimpleNamespace(policy_load=lambda path, isolated_loopback=False: json.loads(Path(path).read_text()))
        verifier = types.SimpleNamespace(verify=lambda *a: None, find_container=lambda image: 'cid', NEW_IMAGE=p.NEW_IMAGE)
        patchers = [mock.patch.object(p, 'load_sibling', lambda bin_dir, name, mod: controller if name == 'qualification.py' else verifier),
                    mock.patch.object(p, 'run', overrides.get('run', self.run_stub)),
                    mock.patch.object(p, 'http_status', overrides.get('http_status', lambda url: 503)),
                    mock.patch.object(p, 'pid_alive', overrides.get('pid_alive', lambda pid: False))]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def collect_proof(self):
        return p.collect(str(self.before), str(self.after), str(self.out), str(self.policy),
                         str(self.queue), str(self.env), str(self.bin), str(self.qrunner))

    def close_args(self, proof_path):
        return types.SimpleNamespace(approval_ref='owner-approval-2026-11-21', proof=str(proof_path),
                                     before=str(self.before), after=str(self.after), incident_dir=str(self.incident),
                                     policy=str(self.policy), queue_state=str(self.queue), env_file=str(self.env),
                                     bin_dir=str(self.bin), queue_runner=str(self.qrunner), max_proof_age_minutes=30,
                                     front_wait_attempts=3, front_wait_delay=0)


class Proof(Fixture):
    def test_full_pass_writes_private_report(self):
        self.patch_proof()
        report = self.collect_proof()
        self.assertEqual(report['result'], 'PASS')
        path = self.out / 'proof.json'
        self.assertTrue(path.is_file())
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.out.stat().st_mode & 0o777, 0o700)
        self.assertEqual(report['gate'], {o: 503 for o in policy()['origins']})
        self.assertEqual(report['verifierSha256'], p.REVIEWED_VERIFIER_SHA256)
        self.assertEqual(set(report['runnerSha256']), set(p.runner_paths(str(self.bin), str(self.qrunner))))
        self.assertEqual(report['runnerSha256']['ordered-queue.py'], p.sha256_file(self.qrunner))
        self.assertEqual(report['envEffective'], self.env_effective())
        self.assertEqual(report['barrier']['token'], TOKEN)
        with self.assertRaises(FileExistsError):
            p.collect(str(self.before), str(self.after), str(self.out), str(self.policy),
                      str(self.queue), str(self.env), str(self.bin), str(self.qrunner))

    def test_verifier_bytes_not_the_reviewed_pin(self):
        (self.bin / 'verify-0002-account-blocks.py').write_text('# tampered\n')
        self.patch_proof()
        with self.assertRaises(ValueError):
            self.collect_proof()

    def test_gate_not_armed_while_proving(self):
        self.patch_proof(http_status=lambda url: 200)
        with self.assertRaises(ValueError):
            self.collect_proof()

    def test_marker_not_an_updater_token(self):
        self.barrier.write_text('manual maintenance\n')
        self.patch_proof()
        with self.assertRaises(ValueError):
            self.collect_proof()

    def test_marker_owner_alive(self):
        self.patch_proof(pid_alive=lambda pid: True)
        with self.assertRaises(ValueError):
            self.collect_proof()

    def test_marker_missing(self):
        self.barrier.unlink()
        self.patch_proof()
        with self.assertRaises(ValueError):
            self.collect_proof()

    def test_queue_lock_busy(self):
        fd = os.open(str(self.queue) + '.lock', os.O_RDWR)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.addCleanup(os.close, fd)
        self.patch_proof()
        with self.assertRaises(ValueError):
            self.collect_proof()

    def test_update_lock_busy(self):
        fd = os.open(str(self.update_lock), os.O_RDWR)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.addCleanup(os.close, fd)
        self.patch_proof()
        with self.assertRaises(ValueError):
            self.collect_proof()

    def test_queue_tip_not_baseline(self):
        state = self.queue_state()
        state['history'][-1]['digest'] = p.NEW_DIGEST
        self.queue.write_text(json.dumps(state))
        self.patch_proof()
        with self.assertRaises(ValueError):
            self.collect_proof()

    def test_pending_not_reviewed_entry(self):
        state = self.queue_state()
        state['pending']['digest'] = 'sha256:' + '0' * 64
        self.queue.write_text(json.dumps(state))
        self.patch_proof()
        with self.assertRaises(ValueError):
            self.collect_proof()

    def test_failed_record_not_reviewed(self):
        state = self.queue_state()
        state['failed']['exit'] = 1
        self.queue.write_text(json.dumps(state))
        self.patch_proof()
        with self.assertRaises(ValueError):
            self.collect_proof()

    def test_smoke_ledger_unexpected(self):
        def run(args, input_text=None):
            if 'smoke' in args:
                return json.dumps({'journal': {}, 'ledger': [{'id': '0001', 'checksum': '1' * 64}]})
            return self.run_stub(args, input_text)
        self.patch_proof(run=run)
        with self.assertRaises(ValueError):
            self.collect_proof()


class Close(Fixture):
    def make_proof(self, **changes):
        report = {'format': 1, 'kind': 'recover-0002-proof', 'result': 'PASS',
                  'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                  'verifierSha256': c.REVIEWED_VERIFIER_SHA256,
                  'policySha256': p.sha256_file(self.policy),
                  'beforeSha256': p.sha256_file(self.before),
                  'afterSha256': p.sha256_file(self.after),
                  'queueStateSha256': p.sha256_file(self.queue),
                  'runnerSha256': {name: p.sha256_file(path) for name, path in c.runner_paths(str(self.bin), str(self.qrunner)).items()},
                  'envEffective': self.env_effective(),
                  'barrier': {'file': str(self.barrier), 'token': TOKEN},
                  'images': {'previous': p.OLD_IMAGE, 'candidate': p.NEW_IMAGE}}
        report.update(changes)
        path = Path(self.dir.name) / 'proof.json'
        path.write_text(json.dumps(report))
        return path

    def patch_close(self, front=None, smoke_ok=True, verify_ok=True, capture=None,
                    postgres_live=None, atomic_ok=True, atomic_fn=None):
        """front: callable url->status (default 503 gated, 200 lifted).
        The module seams (controller, queue runner, verifier) are stubbed: what the
        close script exercises here is ITS OWN sequencing, re-arm and faithfulness."""
        barrier = self.barrier
        if front is None:
            front = lambda url: 503 if barrier.exists() else 200
        after_doc = self.after_doc

        def run(args, input_text=None):
            if 'smoke' in args and not smoke_ok:
                raise ValueError('smoke failed')
            return self.run_stub(args, input_text)

        def verify(*a, **k):
            if not verify_ok:
                raise ValueError('complete recapture under locks failed')

        def atomic(path, doc):
            if atomic_fn is not None:
                return atomic_fn(path, doc)
            if not atomic_ok:
                raise ValueError('disk full on journal append')
            Path(path).write_text(json.dumps(doc))

        controller = types.SimpleNamespace(
            policy_load=lambda path, isolated_loopback=False: json.loads(Path(path).read_text()),
            postgres=lambda pol: (postgres_live if postgres_live is not None else after_doc['postgres']))
        queue = types.SimpleNamespace(atomic=atomic)
        verifier = types.SimpleNamespace(
            verify=verify,
            container_capture=lambda cont, pol: (capture if capture is not None else {'dolt': after_doc['dolt'], 'bao': after_doc['bao']}),
            container_credentials=lambda cont, files: after_doc['credentials'],
            container_ledger=lambda cont: after_doc['migrationLedger'],
            ACTIVATIONS_TABLE='public.activations')
        modules = {'qualification_controller': controller, 'ordered_queue': queue, 'reviewed_verifier': verifier}
        patchers = [mock.patch.object(c, 'load_module', lambda path, name: modules[name]),
                    mock.patch.object(c, 'run', run),
                    mock.patch.object(c, 'http_status', front),
                    mock.patch.object(c, 'pid_alive', lambda pid: False)]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_full_close(self):
        proof = self.make_proof()
        self.patch_close()
        result = c.close(self.close_args(proof))
        self.assertFalse(self.barrier.exists())
        state = json.loads(self.queue.read_text())
        self.assertEqual(len(state['history']), 2)
        self.assertEqual(state['history'][0], {'sha': c.SHA_PARENT, 'digest': c.OLD_DIGEST, 'at': '2026-11-19T22:00:00Z'})
        self.assertEqual(state['history'][1]['sha'], c.SHA_118)
        self.assertEqual(state['history'][1]['parent'], c.SHA_PARENT)
        self.assertEqual(state['history'][1]['digest'], c.NEW_DIGEST)
        self.assertNotIn('pending', state)
        self.assertNotIn('failed', state)
        archived = json.loads((self.incident / 'queue-state-archived.json').read_text())
        self.assertIn('pending', archived)
        self.assertIn('failed', archived)
        # Evidence files are archived, not only hashed.
        self.assertEqual((self.incident / 'before-archived.json').read_text(), self.before.read_text())
        self.assertEqual((self.incident / 'after-archived.json').read_text(), self.after.read_text())
        trace = json.loads((self.incident / 'incident-trace.json').read_text())
        self.assertEqual(trace['approvalRef'], 'owner-approval-2026-11-21')
        self.assertEqual(trace['historyAppended']['sha'], c.SHA_118)
        self.assertEqual(trace['postSmokeRecapture'], {'appendedRows': {}})
        self.assertEqual(result['history'], 2)
        # Steps are traced BEFORE irreversible operations.
        self.assertTrue((self.incident / 'progress-1-lift-started.json').is_file())
        self.assertTrue((self.incident / 'progress-2-journal-append-started.json').is_file())

    def test_stale_proof(self):
        old = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - 3600))
        proof = self.make_proof(createdAt=old)
        self.patch_close()
        with self.assertRaises(ValueError):
            c.close(self.close_args(proof))
        self.assertTrue(self.barrier.exists())

    def test_future_proof_rejected(self):
        future = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + 3600))
        proof = self.make_proof(createdAt=future)
        self.patch_close()
        with self.assertRaises(ValueError):
            c.close(self.close_args(proof))
        self.assertTrue(self.barrier.exists())

    def test_unreviewed_verifier_bytes_in_proof(self):
        proof = self.make_proof(verifierSha256='0' * 64)
        self.patch_close()
        with self.assertRaises(ValueError):
            c.close(self.close_args(proof))

    def test_runner_changed_since_proof(self):
        proof = self.make_proof()
        (self.bin / 'update.sh').write_text('# touched\n')
        self.patch_close()
        with self.assertRaises(ValueError):
            c.close(self.close_args(proof))
        self.assertTrue(self.barrier.exists())

    def test_queue_runner_changed_since_proof(self):
        proof = self.make_proof()
        self.qrunner.write_text('# touched\n')
        self.patch_close()
        with self.assertRaises(ValueError):
            c.close(self.close_args(proof))
        self.assertTrue(self.barrier.exists())

    def test_policy_changed_since_proof(self):
        proof = self.make_proof()
        self.policy.write_text(json.dumps({**policy(), 'tenant': 'other'}))
        self.patch_close()
        with self.assertRaises(ValueError):
            c.close(self.close_args(proof))

    def test_queue_changed_since_proof(self):
        proof = self.make_proof()
        self.queue.write_text(json.dumps({**self.queue_state(), 'extra': 1}))
        self.patch_close()
        with self.assertRaises(ValueError):
            c.close(self.close_args(proof))

    def test_env_config_changed_since_proof(self):
        proof = self.make_proof(envEffective={'barrierFile': str(self.barrier), 'updateLock': str(self.update_lock), 'container': 'other'})
        self.patch_close()
        with self.assertRaises(ValueError):
            c.close(self.close_args(proof))
        self.assertTrue(self.barrier.exists())

    def test_marker_token_changed(self):
        proof = self.make_proof()
        self.barrier.write_text('lyam-update:123:20261121T130000Z\n')
        self.patch_close()
        with self.assertRaises(ValueError):
            c.close(self.close_args(proof))
        self.assertEqual(self.barrier.read_text().strip(), 'lyam-update:123:20261121T130000Z')

    def test_two_containers_of_the_image_abort(self):
        proof = self.make_proof()
        def run(args, input_text=None):
            if args[:2] == ['docker', 'ps']:
                return 'abc123\ndef456\n'
            return self.run_stub(args, input_text)
        self.patch_close()
        with mock.patch.object(c, 'run', run):
            with self.assertRaises(ValueError):
                c.close(self.close_args(proof))
        self.assertTrue(self.barrier.exists())

    def test_container_restarted_recently_aborts(self):
        proof = self.make_proof()
        recent = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime()) + '.000000000Z'
        def run(args, input_text=None):
            if args[:2] == ['docker', 'inspect']:
                return json.dumps([{'Id': 'abc1234567890abcdef', 'Config': {'Image': p.NEW_IMAGE},
                                    'State': {'Running': True, 'Restarting': False, 'StartedAt': recent}}])
            return self.run_stub(args, input_text)
        self.patch_close()
        with mock.patch.object(c, 'run', run):
            with self.assertRaises(ValueError):
                c.close(self.close_args(proof))
        self.assertTrue(self.barrier.exists())

    def test_pre_lift_recapture_failure_aborts_before_unlink(self):
        proof = self.make_proof()
        self.patch_close(verify_ok=False)
        with self.assertRaises(ValueError):
            c.close(self.close_args(proof))
        self.assertTrue(self.barrier.exists())
        self.assertEqual(self.barrier.read_text().strip(), TOKEN)
        self.assertFalse(self.incident.exists())
        state = json.loads(self.queue.read_text())
        self.assertIn('pending', state)
        self.assertEqual(len(state['history']), 1)

    def test_front_never_200_rearms_and_keeps_queue(self):
        proof = self.make_proof()
        self.patch_close(front=lambda url: 503)
        with self.assertRaises(c.CloseFailure) as ctx:
            c.close(self.close_args(proof))
        self.assertEqual(ctx.exception.step, 'front-200-on-all-origins')
        self.assertTrue(ctx.exception.rearm_confirmed)
        self.assertFalse(ctx.exception.journal_advanced)
        self.assertTrue(self.barrier.exists())
        self.assertEqual(self.barrier.read_text().strip(), TOKEN)
        state = json.loads(self.queue.read_text())
        self.assertIn('pending', state)
        self.assertIn('failed', state)
        self.assertEqual(len(state['history']), 1)
        self.assertTrue((self.incident / 'queue-state-archived.json').is_file())

    def test_post_lift_smoke_failure_rearms(self):
        proof = self.make_proof()
        self.patch_close(smoke_ok=False)
        with self.assertRaises(c.CloseFailure) as ctx:
            c.close(self.close_args(proof))
        self.assertEqual(ctx.exception.step, 'post-lift-auth-smoke')
        self.assertTrue(ctx.exception.rearm_confirmed)
        self.assertTrue(self.barrier.exists())
        self.assertIn('pending', json.loads(self.queue.read_text()))

    def test_post_smoke_recapture_drift_rearms(self):
        proof = self.make_proof()
        drift = {'dolt': [{'database': 'iam', 'branch': 'main', 'head': 'h2', 'root': 'r2'}], 'bao': self.after_doc['bao']}
        self.patch_close(capture=drift)
        with self.assertRaises(c.CloseFailure) as ctx:
            c.close(self.close_args(proof))
        self.assertEqual(ctx.exception.step, 'post-smoke-complete-recapture')
        self.assertTrue(ctx.exception.rearm_confirmed)
        self.assertTrue(self.barrier.exists())
        self.assertIn('pending', json.loads(self.queue.read_text()))

    def test_post_smoke_activation_growth_rearms(self):
        # The activation journal must stay exactly as captured: its only authorized
        # append is already in the after-capture.
        proof = self.make_proof()
        pg = json.loads(json.dumps(self.after_doc['postgres']))
        pg['rows']['public.activations'] = {'a1': 1, 'a2': 1, 'a3': 1}
        self.patch_close(postgres_live=pg)
        with self.assertRaises(c.CloseFailure) as ctx:
            c.close(self.close_args(proof))
        self.assertEqual(ctx.exception.step, 'post-smoke-complete-recapture')
        self.assertTrue(self.barrier.exists())

    def test_post_smoke_undeclared_table_growth_rearms(self):
        proof = self.make_proof()
        pg = json.loads(json.dumps(self.after_doc['postgres']))
        pg['rows']['public.sessions'] = {'s1': 1}
        self.patch_close(postgres_live=pg)
        with self.assertRaises(c.CloseFailure) as ctx:
            c.close(self.close_args(proof))
        self.assertEqual(ctx.exception.step, 'post-smoke-complete-recapture')
        self.assertTrue(self.barrier.exists())

    def test_post_smoke_declared_audit_append_allowed_and_traced(self):
        # A real login appends its own audit rows: declared append-only tables may
        # grow, old rows preserved, counted and traced - not silently ignored.
        proof = self.make_proof()
        pg = json.loads(json.dumps(self.after_doc['postgres']))
        pg['rows']['public.decision_audit'] = {'d1': 2, 'd2': 1}
        self.patch_close(postgres_live=pg)
        result = c.close(self.close_args(proof))
        self.assertEqual(result['history'], 2)
        trace = json.loads((self.incident / 'incident-trace.json').read_text())
        self.assertEqual(trace['postSmokeRecapture'], {'appendedRows': {'public.decision_audit': 1}})

    def test_post_smoke_row_disappearance_rearms(self):
        proof = self.make_proof()
        pg = json.loads(json.dumps(self.after_doc['postgres']))
        pg['rows']['public.decision_audit'] = {'d1': 1}
        self.patch_close(postgres_live=pg)
        with self.assertRaises(c.CloseFailure) as ctx:
            c.close(self.close_args(proof))
        self.assertEqual(ctx.exception.step, 'post-smoke-complete-recapture')
        self.assertTrue(self.barrier.exists())

    def test_post_smoke_row_fully_vanished_rearms(self):
        # A hash present in the capture and ENTIRELY absent live must be caught too:
        # the comparison walks the union of hashes, not only the new ones.
        proof = self.make_proof()
        pg = json.loads(json.dumps(self.after_doc['postgres']))
        pg['rows']['public.decision_audit'] = {}
        self.patch_close(postgres_live=pg)
        with self.assertRaises(c.CloseFailure) as ctx:
            c.close(self.close_args(proof))
        self.assertEqual(ctx.exception.step, 'post-smoke-complete-recapture')
        self.assertTrue(self.barrier.exists())

    def test_post_smoke_sequence_definitions_drift_rearms(self):
        proof = self.make_proof()
        pg = json.loads(json.dumps(self.after_doc['postgres']))
        pg['sequenceDefinitions'] = [{'name': 'sneaky'}]
        self.patch_close(postgres_live=pg)
        with self.assertRaises(c.CloseFailure) as ctx:
            c.close(self.close_args(proof))
        self.assertEqual(ctx.exception.step, 'post-smoke-complete-recapture')
        self.assertTrue(self.barrier.exists())

    def test_post_smoke_sequence_advance_allowed(self):
        # Sequence current values are monotonic counters advanced by authorized
        # appends: exempt from equality, but the sequence inventory is fixed.
        proof = self.make_proof()
        pg = json.loads(json.dumps(self.after_doc['postgres']))
        pg['sequences']['public.decision_audit_id_seq'] = {'last_value': 9, 'is_called': True}
        self.patch_close(postgres_live=pg)
        result = c.close(self.close_args(proof))
        self.assertEqual(result['history'], 2)

    def test_post_smoke_sequence_inventory_drift_rearms(self):
        proof = self.make_proof()
        pg = json.loads(json.dumps(self.after_doc['postgres']))
        pg['sequences']['public.new_seq'] = {'last_value': 1, 'is_called': False}
        self.patch_close(postgres_live=pg)
        with self.assertRaises(c.CloseFailure) as ctx:
            c.close(self.close_args(proof))
        self.assertEqual(ctx.exception.step, 'post-smoke-complete-recapture')
        self.assertTrue(self.barrier.exists())

    def test_journal_append_failure_rearms_and_reports_faithfully(self):
        proof = self.make_proof()
        self.patch_close(atomic_ok=False)
        with self.assertRaises(c.CloseFailure) as ctx:
            c.close(self.close_args(proof))
        self.assertEqual(ctx.exception.step, 'journal-append')
        self.assertTrue(ctx.exception.rearm_confirmed)
        self.assertFalse(ctx.exception.journal_advanced)
        self.assertTrue(self.barrier.exists())
        state = json.loads(self.queue.read_text())
        self.assertIn('pending', state)
        self.assertIn('failed', state)
        self.assertEqual(len(state['history']), 1)

    def test_journal_append_replaced_then_failed_rereads_the_file(self):
        # queue.atomic may REPLACE the file and only then fail (fsync): the faithful
        # state comes from re-reading the queue, not from local sequencing.
        proof = self.make_proof()
        def atomic(path, doc):
            Path(path).write_text(json.dumps(doc))
            raise ValueError('fsync failed after replace')
        self.patch_close(atomic_fn=atomic)
        with self.assertRaises(c.CloseFailure) as ctx:
            c.close(self.close_args(proof))
        self.assertEqual(ctx.exception.step, 'journal-append')
        # The file WAS replaced: the closure must see the journal as advanced and
        # leave the verified front open instead of re-arming over a moved journal.
        self.assertTrue(ctx.exception.journal_advanced)
        self.assertIsNone(ctx.exception.rearm_confirmed)
        self.assertFalse(self.barrier.exists())
        state = json.loads(self.queue.read_text())
        self.assertEqual(len(state['history']), 2)
        self.assertNotIn('pending', state)
        self.assertTrue((self.incident / 'progress-2-journal-append-started.json').is_file())

    def test_journal_append_unreadable_reread_is_unknown_not_false(self):
        # The append failed AND the queue file cannot be re-read: journal state is
        # UNKNOWN (not False), the closure still re-arms fail-closed, and the report
        # says the journal state is unknown - it never claims 'journal not advanced'.
        proof = self.make_proof()
        def atomic(path, doc):
            Path(path).write_text('not json at all')
            raise ValueError('fsync failed after garbage write')
        self.patch_close(atomic_fn=atomic)
        with self.assertRaises(c.CloseFailure) as ctx:
            c.close(self.close_args(proof))
        self.assertEqual(ctx.exception.step, 'journal-append')
        self.assertIsNone(ctx.exception.journal_advanced)
        self.assertIn('UNKNOWN', ctx.exception.note)
        self.assertTrue(ctx.exception.rearm_confirmed)
        self.assertTrue(self.barrier.exists())

    def test_queue_state_changed_during_lift_rearms(self):
        proof = self.make_proof()
        original_atomic_path = str(self.queue)
        def atomic(path, doc):
            Path(path).write_text(json.dumps(doc))
        # Simulate an outside queue write between the pre-lift check and the append:
        # patch the controller postgres seam to also mutate the queue on the smoke step.
        def run(args, input_text=None):
            result = self.run_stub(args, input_text)
            if 'smoke' in args:
                state = json.loads(self.queue.read_text())
                state['history'].append({'sha': 'other', 'digest': 'sha256:' + '0' * 64, 'at': '2026-11-21T13:00:00Z'})
                Path(original_atomic_path).write_text(json.dumps(state))
            return result
        self.patch_close()
        with mock.patch.object(c, 'run', run):
            with self.assertRaises(c.CloseFailure) as ctx:
                c.close(self.close_args(proof))
        self.assertEqual(ctx.exception.step, 'queue-state-unchanged')
        self.assertTrue(ctx.exception.rearm_confirmed)
        self.assertFalse(ctx.exception.journal_advanced)
        self.assertTrue(self.barrier.exists())

    def test_trace_failure_is_a_faithful_partial_commit(self):
        # Journal append succeeded, trace write fails: the gate stays OPEN (re-arming
        # would contradict the advanced journal) and the failure says exactly that.
        proof = self.make_proof()
        mkdir_original = Path.mkdir
        def mkdir_then_block(self_path, *a, **k):
            mkdir_original(self_path, *a, **k)
            (self_path / 'incident-trace.json').write_text('{}')
        self.patch_close()
        with mock.patch.object(Path, 'mkdir', mkdir_then_block):
            with self.assertRaises(c.CloseFailure) as ctx:
                c.close(self.close_args(proof))
        self.assertEqual(ctx.exception.step, 'incident-trace')
        self.assertIsNone(ctx.exception.rearm_confirmed)
        self.assertTrue(ctx.exception.journal_advanced)
        self.assertFalse(self.barrier.exists())
        state = json.loads(self.queue.read_text())
        self.assertEqual(len(state['history']), 2)
        self.assertNotIn('pending', state)

    def test_rearm_overwrites_preexisting_marker(self):
        # Something recreated the marker between lift and re-arm: the updater lock is
        # held, so the archived token is restored over it and 503 re-confirmed.
        proof = self.make_proof()
        barrier = self.barrier
        def front(url):
            if not barrier.exists():
                barrier.write_text('squatter\n')
            return 503
        self.patch_close(front=front)
        with self.assertRaises(c.CloseFailure):
            c.close(self.close_args(proof))
        self.assertTrue(self.barrier.exists())
        self.assertEqual(self.barrier.read_text().strip(), TOKEN)

    def test_rearm_not_confirmed_is_reported_not_claimed(self):
        proof = self.make_proof()
        lifted = {'done': False}
        barrier = self.barrier
        def front(url):
            if barrier.exists() and not lifted['done']:
                return 503
            if not barrier.exists():
                lifted['done'] = True
                return 503  # the front never comes up after the lift
            return 200  # and the re-armed gate never comes back either
        self.patch_close(front=front)
        with self.assertRaises(c.CloseFailure) as ctx:
            c.close(self.close_args(proof))
        self.assertEqual(ctx.exception.step, 'front-200-on-all-origins')
        self.assertFalse(ctx.exception.rearm_confirmed)
        self.assertIn('503', ctx.exception.note)

    def test_network_error_during_rearm_is_not_an_escape(self):
        # A transport error/timeout while confirming the re-arm must degrade to
        # 're-arm NOT confirmed', never escape and corrupt the faithful status.
        proof = self.make_proof()
        barrier = self.barrier
        lifted = {'done': False}
        def front(url):
            if barrier.exists() and not lifted['done']:
                return 503
            lifted['done'] = True
            raise urllib.error.URLError('timeout')
        # The production http_status never raises (any transport error degrades to
        # 0); this shim plays exactly that role so the raised error crosses the same
        # boundary it would in production.
        def safe_http_status(url):
            try:
                return front(url)
            except urllib.error.HTTPError as e:
                return e.code
            except Exception:
                return 0
        self.patch_close(front=safe_http_status)
        with self.assertRaises(c.CloseFailure) as ctx:
            c.close(self.close_args(proof))
        self.assertEqual(ctx.exception.step, 'front-200-on-all-origins')
        self.assertFalse(ctx.exception.rearm_confirmed)
        self.assertFalse(ctx.exception.journal_advanced)

    def test_sigterm_during_lift_takes_the_rearm_path(self):
        proof = self.make_proof()
        sent = {'done': False}
        barrier = self.barrier
        def front(url):
            if not barrier.exists() and not sent['done']:
                sent['done'] = True
                os.kill(os.getpid(), signal.SIGTERM)
            return 503 if barrier.exists() else 200
        self.patch_close(front=front)
        with self.assertRaises(c.CloseFailure) as ctx:
            c.close(self.close_args(proof))
        self.assertTrue(ctx.exception.rearm_confirmed)
        self.assertFalse(ctx.exception.journal_advanced)
        self.assertTrue(self.barrier.exists())
        self.assertEqual(self.barrier.read_text().strip(), TOKEN)
        self.assertIn('pending', json.loads(self.queue.read_text()))

    def test_queue_lock_busy(self):
        proof = self.make_proof()
        fd = os.open(str(self.queue) + '.lock', os.O_RDWR)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.addCleanup(os.close, fd)
        self.patch_close()
        with self.assertRaises(ValueError):
            c.close(self.close_args(proof))
        self.assertTrue(self.barrier.exists())


class Pins(unittest.TestCase):
    def test_reviewed_verifier_pin_matches_shipped_bytes(self):
        digest = p.sha256_file(HERE / 'verify-0002-account-blocks.py')
        self.assertEqual(p.REVIEWED_VERIFIER_SHA256, digest)
        self.assertEqual(c.REVIEWED_VERIFIER_SHA256, digest)

    def test_queue_runner_is_the_real_installed_path(self):
        self.assertEqual(p.QUEUE_RUNNER, '/usr/local/libexec/lyam-queue/ordered-queue.py')
        self.assertEqual(c.QUEUE_RUNNER, p.QUEUE_RUNNER)
        self.assertNotIn('ordered-queue.py', p.RUNNER_FILES)
        self.assertNotIn('ordered-queue.py', c.RUNNER_FILES)

    def test_http_status_never_raises(self):
        # The faithful end-state report depends on this: transport errors and
        # timeouts degrade to 0, HTTP errors return their code.
        with mock.patch('urllib.request.urlopen', side_effect=urllib.error.URLError('down')):
            self.assertEqual(c.http_status('https://x.example/healthz'), 0)
        with mock.patch('urllib.request.urlopen',
                        side_effect=urllib.error.HTTPError('u', 503, 'm', {}, None)):
            self.assertEqual(c.http_status('https://x.example/healthz'), 503)

    def test_incident_constants_match_queue_and_image_facts(self):
        self.assertEqual(p.SHA_118, c.SHA_118)
        self.assertEqual(p.SHA_PARENT, c.SHA_PARENT)
        self.assertTrue(p.NEW_IMAGE.endswith(p.NEW_DIGEST))
        self.assertTrue(p.OLD_IMAGE.endswith(p.OLD_DIGEST))


if __name__ == '__main__':
    unittest.main()
