import copy, hashlib, importlib.util, json, os, tempfile, types, unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location('verifier', Path(__file__).with_name('verify-0002-isolated-test.py'))
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)
cspec = importlib.util.spec_from_file_location('qualification_controller', Path(__file__).resolve().parent.parent / 'qualification.py')
REAL_CONTROLLER = importlib.util.module_from_spec(cspec)
cspec.loader.exec_module(REAL_CONTROLLER)

HEAD_BEFORE = 'beforehead0000000000000000000000'
HEAD_AFTER = 'afterhead00000000000000000000000'
ROOT_BEFORE = 'rootbefore0000000000000000000000'
ROOT_AFTER = 'rootafter00000000000000000000000'
OTHER_HEAD = 'otherhead00000000000000000000000'
OTHER_ROOT = 'otherroot00000000000000000000000'
CONTAINER = 'candidatecid'


def policy():
    return {'format': 1, 'pgContainer': 'pg', 'pgUser': 'lyam', 'pgDatabase': 'lyam', 'tenant': 'acme-demo',
            'appendOnlyTables': ['public.activations', 'public.decision_audit'],
            'credentialFiles': ['core-state/credentials.json'], 'baoTokenFile': '/x', 'baoAddress': 'http://bao-iso:8200',
            'baoMetadataRoots': ['secret/metadata/iam'], 'origins': ['http://127.0.0.1:8080'],
            'issuer': 'http://127.0.0.1:8080/core', 'network': 'lyam-iso-net', 'authFile': '/auth',
            'isolatedLoopbackTest': True}


def fixtures(policy_hash):
    before = {
        'image': v.OLD_IMAGE, 'transportCoverage': 'ISOLATED_LOOPBACK_NO_PUBLIC_TLS_PROOF', 'policyHash': policy_hash,
        'migrationLedger': {'format': 1, 'entries': [{'id': '0001', 'checksum': '1' * 64, 'disposition': 'adopted'}]},
        'bao': {'secret/metadata/iam/app': 'hash'}, 'credentials': {'core-state/credentials.json': 'credhash'},
        'dolt': [
            {'database': 'dolt', 'branch': 'main', 'head': OTHER_HEAD, 'root': OTHER_ROOT},
            {'database': 'iam', 'branch': 'main', 'head': HEAD_BEFORE, 'root': ROOT_BEFORE},
            {'database': 'iam', 'branch': 'personal/demo-alice', 'head': OTHER_HEAD, 'root': OTHER_ROOT},
            {'database': 'iam_meta', 'branch': 'main', 'head': OTHER_HEAD, 'root': OTHER_ROOT}],
        'postgres': {
            'rows': {'public.activations': {'a1': 1}, 'public.decision_audit': {'d1': 2}},
            'schema': {'columns': []}, 'sequenceDefinitions': [],
            'sequences': {'public.decision_audit_id_seq': {'last_value': 7, 'is_called': True}}}}
    after = copy.deepcopy(before)
    after['image'] = v.NEW_IMAGE
    after['migrationLedger']['entries'] = before['migrationLedger']['entries'] + [
        {'id': '0002', 'checksum': v.MIGRATION_CHECKSUM, 'disposition': 'applied'}]
    for item in after['dolt']:
        if (item['database'], item['branch']) == ('iam', 'main'):
            item['head'], item['root'] = HEAD_AFTER, ROOT_AFTER
    after['postgres']['rows']['public.activations'] = {'a1': 1, 'a2': 1}
    return before, after


def summary_row(**overrides):
    """Host-proven dolt_diff_summary row on the deployed Dolt 2.6.1 (fixtures
    dolt-fixtures-v4, 2026-11-21): columns from_table_name/to_table_name (there is
    no table_name column) and flags as the STRINGS '1'/'0'."""
    row = {'from_table_name': 'policy_rules', 'to_table_name': 'policy_rules',
           'diff_type': 'modified', 'data_change': '1', 'schema_change': '0'}
    row.update(overrides)
    return row


def diff_row(**overrides):
    """Host-proven dolt_diff row for the pure addition: Dolt 2.6.1 OMITS the
    from_set_name/from_id/from_cedar keys; to_* and from/to_commit stay present."""
    row = {'diff_type': 'added', 'from_commit': HEAD_BEFORE, 'from_commit_date': '2026-11-20 08:58:38.942000',
           'to_commit': HEAD_AFTER, 'to_commit_date': '2026-11-21 11:59:29.231000',
           'to_set_name': v.RULE_SET, 'to_id': v.RULE_ID, 'to_cedar': v.RULE_CEDAR}
    row.update(overrides)
    return row


def _harness(before, after, overrides=None):
    """All external seams stubbed from the fixtures: one docker point, the fresh-capture
    functions, and the controller module (real compare, stubbed postgres/policy_load)."""
    overrides = overrides or {}
    state = {
        'sql_log': [],
        'committed_drift': {},  # 'db/branch' -> wrong root: captured root not its branch commit
        'working_drift': {},    # 'db/branch' -> wrong root: uncommitted changes live
        'database_echo': {},    # 'db/branch' -> wrong DATABASE() echo: session elsewhere
        'branches': {item['database'] + '/' + item['branch']: [{'name': item['branch'], 'hash': item['head']}]
                     for item in after['dolt']},  # dolt_branches rows per use-db
        'before_revision_root': ROOT_BEFORE,  # what the revision database iam/<before-head> reports
        'ps': CONTAINER,
        'log': [{'commit_hash': HEAD_AFTER, 'message': v.COMMIT_MESSAGE}, {'commit_hash': HEAD_BEFORE, 'message': 'older'}],
        'summary': [summary_row()],
        'diff': [diff_row()],
        'status': [],
        'status_raw': None,  # verbatim CLI payload override for malformed-shape tests
        'activation_rows': [{'h': 'a1', 'j': {'commit_hash': 'oldcommit', 'tenant': 'acme-demo', 'state': 'applied'}},
                            {'h': 'a2', 'j': {'commit_hash': HEAD_AFTER, 'tenant': 'acme-demo', 'state': 'applied'}}],
        'capture': {'dolt': after['dolt'], 'bao': after['bao']},
        'credentials_live': after['credentials'],
        'ledger_live': after['migrationLedger'],
        'postgres_live': after['postgres']}
    state.update(overrides)
    harness_last.clear()
    harness_last.update(state)

    def run(args, input_text=None):
        if args[:2] == ['docker', 'ps']:
            return state['ps']
        if args[:2] == ['docker', 'inspect']:
            return json.dumps([{'Config': {'Image': v.NEW_IMAGE}, 'State': {'Running': True}}])
        if 'dolt' in args:
            sql = args[-1]
            state['sql_log'].append(sql)
            use_db = [a[len('--use-db='):] for a in args if a.startswith('--use-db=')][0]
            if 'DATABASE()' in sql:
                return json.dumps({'rows': [{'db': state['database_echo'].get(use_db, use_db)}]})
            if 'FROM dolt_branches' in sql:
                return json.dumps({'rows': state['branches'].get(use_db, [])})
            if 'DOLT_HASHOF_DB(' in sql:
                ref = sql.split("DOLT_HASHOF_DB('", 1)[1].split("'", 1)[0]
                if use_db == 'iam/' + HEAD_BEFORE:
                    # Host-proven revision-database syntax: HEAD at the before commit.
                    if ref != 'HEAD':
                        return json.dumps({'rows': []})
                    return json.dumps({'rows': [{'root': state['before_revision_root']}]})
                item = next((i for i in after['dolt'] if i['database'] + '/' + i['branch'] == use_db), None)
                if item is None:
                    raise AssertionError('unexpected use-db: ' + use_db)
                if ref == 'WORKING':
                    return json.dumps({'rows': [{'root': state['working_drift'].get(use_db, item['root'])}]})
                if ref != item['branch']:
                    return json.dumps({'rows': []})  # unknown refspec, as the deployed Dolt behaves
                return json.dumps({'rows': [{'root': state['committed_drift'].get(use_db, item['root'])}]})
            if 'FROM dolt_log' in sql:
                return json.dumps({'rows': state['log']})
            if 'dolt_diff_summary' in sql:
                return json.dumps({'rows': state['summary']})
            if 'dolt_diff(' in sql:
                return json.dumps({'rows': state['diff']})
            if 'dolt_status' in sql:
                if state.get('status_raw') is not None:
                    return state['status_raw']
                # Host-verified: an empty result renders as {} with NO rows key.
                return json.dumps({'rows': state['status']}) if state['status'] else '{}'
            raise AssertionError('unexpected dolt sql: ' + sql)
        if 'psql' in args:
            sql = args[-1]
            if 'to_jsonb(t) j FROM public.activations' in sql:
                return json.dumps(state['activation_rows'])
            raise AssertionError('unexpected pg sql: ' + sql)
        raise AssertionError('unexpected command: ' + ' '.join(args))

    controller = types.SimpleNamespace(
        compare=REAL_CONTROLLER.compare,
        postgres=lambda p: state['postgres_live'],
        policy_load=lambda path, isolated_loopback=False: json.loads(Path(path).read_text()))
    return [mock.patch.object(v, 'run', run),
            mock.patch.object(v, 'load_controller', lambda: controller),
            mock.patch.object(v, 'container_capture', lambda c, p: state['capture']),
            mock.patch.object(v, 'container_credentials', lambda c, files: state['credentials_live']),
            mock.patch.object(v, 'container_ledger', lambda c: state['ledger_live'])]


harness_last = {}


def harness(before, after, overrides=None):
    global harness_last
    patchers = _harness(before, after, overrides)
    return patchers


class Verify(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.policy_path = Path(self.dir.name) / 'policy.json'
        self.policy_path.write_text(json.dumps(policy()))
        self.policy_hash = hashlib.sha256(self.policy_path.read_bytes()).hexdigest()
        self.before, self.after = fixtures(self.policy_hash)
        self.before_path = Path(self.dir.name) / 'before.json'
        self.after_path = Path(self.dir.name) / 'after.json'

    def tearDown(self):
        self.dir.cleanup()

    def run_verifier(self, overrides=None, before=None, after=None):
        before = self.before if before is None else before
        after = self.after if after is None else after
        self.before_path.write_text(json.dumps(before))
        self.after_path.write_text(json.dumps(after))
        for patcher in harness(before, after, overrides):
            patcher.start()
            self.addCleanup(patcher.stop)
        v.verify(str(self.before_path), str(self.after_path), str(self.policy_path))

    def expect_fail(self, overrides=None, before=None, after=None):
        with self.assertRaises(ValueError):
            self.run_verifier(overrides, before, after)

    def mutate_after(self, fn):
        after = copy.deepcopy(self.after)
        fn(after)
        return after

    # -- the one passing path ---------------------------------------------------
    def test_declared_transition_passes(self):
        self.run_verifier()

    def test_constants_match_migration_source(self):
        root = Path(__file__).parents[3]
        self.assertIn(json.dumps(v.RULE_CEDAR), (root / 'apps/api/src/migrations/v0002/rule.ts').read_text())
        manifest = json.loads((root / 'data/migrations/manifest.json').read_text())
        entry = [x for x in manifest['versions'] if x['id'] == v.MIGRATION_ID][0]
        self.assertEqual(entry['checksum'], v.MIGRATION_CHECKSUM)
        self.assertIn(v.COMMIT_MESSAGE, (root / 'apps/api/src/migrations/v0002/run.ts').read_text())

    # -- historical evidence rejections -----------------------------------------
    def test_wrong_after_image(self):
        self.expect_fail(after=self.mutate_after(lambda a: a.update(image='ghcr.io/manudss/iam-platform-poc@sha256:' + '0' * 64)))

    def test_wrong_before_image(self):
        before = copy.deepcopy(self.before); before['image'] = v.NEW_IMAGE
        self.expect_fail(before=before)

    def test_policy_drift_since_capture(self):
        self.policy_path.write_text(json.dumps({**policy(), 'tenant': 'other'}))
        self.expect_fail()

    def test_ledger_checksum_mismatch(self):
        self.expect_fail(after=self.mutate_after(lambda a: a['migrationLedger']['entries'][-1].update(checksum='0' * 64)))

    def test_ledger_not_strictly_extended(self):
        self.expect_fail(after=self.mutate_after(lambda a: a['migrationLedger']['entries'][0].update(checksum='0' * 64)))

    def test_ledger_pending_fails(self):
        self.expect_fail(after=self.mutate_after(lambda a: a['migrationLedger'].update(pending={'id': '0002'})))

    def test_migration_already_present_before(self):
        before = copy.deepcopy(self.before)
        before['migrationLedger']['entries'].append({'id': '0002', 'checksum': v.MIGRATION_CHECKSUM, 'disposition': 'applied'})
        self.expect_fail(before=before)

    def test_bao_change(self):
        self.expect_fail(after=self.mutate_after(lambda a: a.update(bao={})))

    def test_credential_change(self):
        self.expect_fail(after=self.mutate_after(lambda a: a['credentials'].update({'core-state/credentials.json': 'new'})))

    def test_other_branch_movement(self):
        def tamper(a):
            for item in a['dolt']:
                if item['branch'] == 'personal/demo-alice':
                    item['root'] = 'tampered' + item['root'][8:]
        self.expect_fail(after=self.mutate_after(tamper))

    def test_transformation_absent(self):
        def revert(a):
            for item in a['dolt']:
                if (item['database'], item['branch']) == ('iam', 'main'):
                    item['head'], item['root'] = HEAD_BEFORE, ROOT_BEFORE
        self.expect_fail(after=self.mutate_after(revert))

    # -- commit content rejections ----------------------------------------------
    def test_moved_root_not_bound_to_its_branch_commit(self):
        self.expect_fail({'committed_drift': {'iam/main': 'otherroot' + ROOT_AFTER[9:]}})

    def test_moved_branch_wrong_database_session(self):
        self.expect_fail({'database_echo': {'iam/main': 'dolt/main'}})

    def test_unmoved_branch_commit_ref_never_consulted(self):
        # Preservation, not commit/root binding: a pre-existing dirty working set on
        # an unchanged branch (its named-ref root differing from the capture) is
        # ACCEPTED when head and WORKING root are identically preserved - the
        # verifier never queries named refs on unchanged branches.
        self.run_verifier({'committed_drift': {'dolt/main': 'drifted00' + OTHER_ROOT[9:],
                                               'iam_meta/main': 'drifted00' + OTHER_ROOT[9:]}})

    def test_unmoved_branch_head_drift(self):
        branches = {'iam_meta/main': [{'name': 'main', 'hash': 'moved00' + OTHER_HEAD[7:]}]}
        self.expect_fail({'branches': branches})

    def test_unmoved_branch_row_missing(self):
        self.expect_fail({'branches': {'iam_meta/main': []}})

    def test_unmoved_branch_head_shape_unknown(self):
        self.expect_fail({'branches': {'iam_meta/main': [{'name': 'main'}]}})

    def test_unmoved_branch_wrong_database_session(self):
        self.expect_fail({'database_echo': {'iam_meta/main': 'dolt/main'}})

    def test_unmoved_branch_working_drift(self):
        self.expect_fail({'working_drift': {'iam_meta/main': 'drifted00' + OTHER_ROOT[9:]}})

    def test_live_working_set_dirty_via_root(self):
        self.expect_fail({'working_drift': {'iam/main': 'dirtyworking' + ROOT_AFTER[12:]}})

    def test_before_root_not_bound_to_its_commit(self):
        # A diff between commits can never exclude that the before-capture recorded
        # uncommitted changes which were then lost: the before root must bind to the
        # before commit through the host-proven revision database.
        self.expect_fail({'before_revision_root': 'drifted00' + ROOT_BEFORE[9:]})

    def test_dolt_queries_use_only_version_proven_refs(self):
        # The deployed Dolt 2.6.1 REJECTS raw commit hashes as DOLT_HASHOF_DB refspecs
        # and accepts branch refs and WORKING (host-verified). Pin the emitted queries
        # to the proven forms: no raw hash may ever reach DOLT_HASHOF_DB.
        self.run_verifier()
        hashof_refs = [sql.split("DOLT_HASHOF_DB('", 1)[1].split("'", 1)[0]
                       for sql in harness_last['sql_log'] if 'DOLT_HASHOF_DB(' in sql]
        self.assertTrue(hashof_refs)
        for ref in hashof_refs:
            self.assertIn(ref, ('WORKING', 'HEAD', 'main'))
            self.assertNotIn(ref, (HEAD_BEFORE, HEAD_AFTER))
        # The before-commit binding uses the host-proven revision-database syntax,
        # and named refs are NEVER queried on unchanged branches (preservation is
        # proven via dolt_branches head + WORKING root + session identity instead).
        self.assertTrue(any("DOLT_HASHOF_DB('HEAD')" in sql for sql in harness_last['sql_log']))
        self.assertFalse(any('personal/demo-alice' in sql for sql in harness_last['sql_log']
                             if 'DOLT_HASHOF_DB(' in sql))
        self.assertTrue(any('FROM dolt_branches' in sql for sql in harness_last['sql_log']))
        self.assertTrue(any('DATABASE()' in sql for sql in harness_last['sql_log']))

    def test_two_commits(self):
        self.expect_fail({'log': [{'commit_hash': HEAD_AFTER, 'message': v.COMMIT_MESSAGE}, {'commit_hash': 'surprise', 'message': 'x'}]})

    def test_log_shape_unknown(self):
        self.expect_fail({'log': [{'commit_hash': HEAD_AFTER}, {'commit_hash': HEAD_BEFORE, 'message': 'older'}]})

    def test_commit_message(self):
        self.expect_fail({'log': [{'commit_hash': HEAD_AFTER, 'message': 'relabelled'}, {'commit_hash': HEAD_BEFORE, 'message': 'older'}]})

    def test_extra_table_in_commit(self):
        self.expect_fail({'summary': [summary_row(), summary_row(from_table_name='users', to_table_name='users')]})

    def test_summary_flags_absent_is_unknown_not_false(self):
        row = summary_row()
        del row['data_change']
        self.expect_fail({'summary': [row]})

    def test_summary_schema_change_null_is_unknown(self):
        self.expect_fail({'summary': [summary_row(schema_change=None)]})

    def test_summary_schema_change_true(self):
        self.expect_fail({'summary': [summary_row(schema_change='1')]})

    def test_summary_data_change_absent(self):
        row = summary_row()
        del row['schema_change']
        self.expect_fail({'summary': [row]})

    def test_summary_diff_type_unexpected(self):
        self.expect_fail({'summary': [summary_row(diff_type='added', schema_change='1')]})

    def test_summary_boolean_flags_refused(self):
        # The deployed Dolt renders the flags as STRINGS; a boolean is not '1'/'0'.
        self.expect_fail({'summary': [summary_row(data_change=True)]})
        self.expect_fail({'summary': [summary_row(schema_change=False)]})

    def test_summary_data_change_zero(self):
        self.expect_fail({'summary': [summary_row(data_change='0')]})

    def test_summary_to_table_mismatch(self):
        self.expect_fail({'summary': [summary_row(to_table_name='users')]})

    def test_summary_from_table_mismatch(self):
        self.expect_fail({'summary': [summary_row(from_table_name='users')]})

    def test_rule_text_mismatch(self):
        self.expect_fail({'diff': [diff_row(to_cedar='permit(principal, action, resource);')]})

    def test_diff_to_column_absent_is_unknown(self):
        # On an addition only the from_* keys may be omitted; an omitted to_* key
        # is UNKNOWN, never success.
        row = diff_row()
        del row['to_cedar']
        self.expect_fail({'diff': [row]})

    def test_diff_from_keys_present_but_null_passes(self):
        # Absence-or-NULL: explicitly present NULL from_* keys mean the same as omitted.
        self.run_verifier({'diff': [diff_row(from_set_name=None, from_id=None, from_cedar=None)]})

    def test_diff_from_key_valued_fails(self):
        # A valued from_* key on the single row means an existing rule was touched.
        self.expect_fail({'diff': [diff_row(from_id='screen-users')]})

    def test_diff_type_key_absent_is_unknown(self):
        row = diff_row()
        del row['diff_type']
        self.expect_fail({'diff': [row]})

    def test_diff_not_bound_to_exact_commits(self):
        self.expect_fail({'diff': [diff_row(to_commit=HEAD_BEFORE)]})
        self.expect_fail({'diff': [diff_row(from_commit=HEAD_AFTER)]})

    def test_diff_commit_keys_absent_is_unknown(self):
        row = diff_row()
        del row['from_commit']
        del row['to_commit']
        self.expect_fail({'diff': [row]})

    def test_existing_row_modified(self):
        self.expect_fail({'diff': [diff_row(diff_type='modified', from_set_name='default', from_id='screen-users',
                                            from_cedar='x', to_id='screen-users', to_cedar='y')]})

    def test_two_rows_changed(self):
        self.expect_fail({'diff': [diff_row(), diff_row(to_id='other', to_cedar='x')]})

    def test_dirty_working_set(self):
        self.expect_fail({'status': [{'table_name': 'sessions', 'status': 'modified'}]})

    def test_status_malformed_payload_is_unknown(self):
        # Only the exact {} empty object means zero rows; any other shape without a
        # rows list is UNKNOWN, never an empty success.
        self.expect_fail({'status_raw': '{"unexpected": []}'})
        self.expect_fail({'status_raw': '{"rows": null, "extra": 1}'})


    # -- fresh complete recapture rejections -------------------------------------
    def test_live_branch_created_after_capture(self):
        capture = {'dolt': self.after['dolt'] + [{'database': 'iam', 'branch': 'personal/intruder', 'head': 'x', 'root': 'y'}],
                   'bao': self.after['bao']}
        self.expect_fail({'capture': capture})

    def test_live_bao_drift(self):
        self.expect_fail({'capture': {'dolt': self.after['dolt'], 'bao': {}}})

    def test_live_postgres_drift(self):
        self.expect_fail({'postgres_live': {**self.after['postgres'], 'schema': {'columns': ['new']}}})

    def test_live_credential_drift(self):
        self.expect_fail({'credentials_live': {'core-state/credentials.json': 'rotated'}})

    def test_live_ledger_drift(self):
        drifted = copy.deepcopy(self.after['migrationLedger'])
        drifted['entries'].append({'id': '0003', 'checksum': '3' * 64})
        self.expect_fail({'ledger_live': drifted})

    # -- activation append rejections --------------------------------------------
    def test_two_activation_appends(self):
        after = self.mutate_after(lambda a: a['postgres']['rows'].update({'public.activations': {'a1': 1, 'a2': 1, 'a3': 1}}))
        self.expect_fail(after=after)

    def test_activation_of_wrong_commit(self):
        rows = [{'h': 'a1', 'j': {'commit_hash': 'oldcommit', 'tenant': 'acme-demo', 'state': 'applied'}},
                {'h': 'a2', 'j': {'commit_hash': 'unrelatedcommit', 'tenant': 'acme-demo', 'state': 'applied'}}]
        self.expect_fail({'activation_rows': rows})

    def test_activation_unknown_state(self):
        rows = [{'h': 'a1', 'j': {'commit_hash': 'oldcommit', 'tenant': 'acme-demo', 'state': 'applied'}},
                {'h': 'a2', 'j': {'commit_hash': HEAD_AFTER, 'tenant': 'acme-demo', 'state': 'mystery'}}]
        self.expect_fail({'activation_rows': rows})

    def test_activation_legacy_commit_key_absent_is_unknown(self):
        # The deployed schema exposes commit_hash; a row keyed by the old API name
        # must not be recognized as the migration publication.
        rows = [{'h': 'a1', 'j': {'commit_hash': 'oldcommit', 'tenant': 'acme-demo', 'state': 'applied'}},
                {'h': 'a2', 'j': {'commit': HEAD_AFTER, 'tenant': 'acme-demo', 'state': 'applied'}}]
        self.expect_fail({'activation_rows': rows})

    # -- environment rejections ---------------------------------------------------
    def test_not_exactly_one_container(self):
        self.expect_fail({'ps': CONTAINER + '\nothercid'})


class IsolatedVariantGuards(unittest.TestCase):
    """Counter-tests for the deltas of the isolated loopback test variant."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.policy_path = Path(self.dir.name) / 'policy.json'
        self.policy_path.write_text(json.dumps(policy()))
        self.policy_hash = hashlib.sha256(self.policy_path.read_bytes()).hexdigest()
        self.before, self.after = fixtures(self.policy_hash)
        self.before_path = Path(self.dir.name) / 'before.json'
        self.after_path = Path(self.dir.name) / 'after.json'

    def tearDown(self):
        self.dir.cleanup()

    def test_env_policy_required(self):
        env = {k: val for k, val in os.environ.items() if k != 'LYAM_ISOLATED_POLICY'}
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(ValueError):
                v.default_policy_path()

    def test_production_policy_path_refused(self):
        with mock.patch.dict(os.environ, {'LYAM_ISOLATED_POLICY': '/opt/lyam/qualification.json'}):
            with self.assertRaises(ValueError):
                v.default_policy_path()

    def test_env_policy_used_without_explicit_path(self):
        self.before_path.write_text(json.dumps(self.before))
        self.after_path.write_text(json.dumps(self.after))
        for patcher in harness(self.before, self.after):
            patcher.start()
            self.addCleanup(patcher.stop)
        with mock.patch.dict(os.environ, {'LYAM_ISOLATED_POLICY': str(self.policy_path)}):
            v.verify(str(self.before_path), str(self.after_path))

    def test_tls_coverage_refused(self):
        before = copy.deepcopy(self.before)
        before['transportCoverage'] = 'TLS_EXPECTED_ORIGINS'
        self.before_path.write_text(json.dumps(before))
        self.after_path.write_text(json.dumps(self.after))
        for patcher in harness(before, self.after):
            patcher.start()
            self.addCleanup(patcher.stop)
        with self.assertRaises(ValueError):
            v.verify(str(self.before_path), str(self.after_path), str(self.policy_path))

    def test_real_policy_load_accepts_loopback_when_isolated(self):
        loaded = REAL_CONTROLLER.policy_load(str(self.policy_path), isolated_loopback=True)
        self.assertEqual(loaded['origins'], ['http://127.0.0.1:8080'])

    def test_real_policy_load_rejects_loopback_without_flag(self):
        with self.assertRaises(ValueError):
            REAL_CONTROLLER.policy_load(str(self.policy_path))

    def test_real_policy_load_rejects_non_loopback_http_even_isolated(self):
        p = {**policy(), 'origins': ['http://192.0.2.10:8080']}
        path = Path(self.dir.name) / 'policy-http.json'
        path.write_text(json.dumps(p))
        with self.assertRaises(ValueError):
            REAL_CONTROLLER.policy_load(str(path), isolated_loopback=True)

    def test_real_policy_load_rejects_loopback_without_marker(self):
        p = {k: val for k, val in policy().items() if k != 'isolatedLoopbackTest'}
        path = Path(self.dir.name) / 'policy-nomarker.json'
        path.write_text(json.dumps(p))
        with self.assertRaises(ValueError):
            REAL_CONTROLLER.policy_load(str(path), isolated_loopback=True)

if __name__ == '__main__':
    unittest.main()
