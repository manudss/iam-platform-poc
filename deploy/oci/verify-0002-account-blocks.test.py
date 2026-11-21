import copy, hashlib, importlib.util, json, tempfile, unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location('verifier', Path(__file__).with_name('verify-0002-account-blocks.py'))
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)

HEAD_BEFORE = 'beforehead0000000000000000000000'
HEAD_AFTER = 'afterhead00000000000000000000000'
ROOT_BEFORE = 'rootbefore0000000000000000000000'
ROOT_AFTER = 'rootafter00000000000000000000000'
OTHER_HEAD = 'otherhead00000000000000000000000'
OTHER_ROOT = 'otherroot00000000000000000000000'
CONTAINER = 'candidatecid'


def policy():
    return {'format': 1, 'pgContainer': 'pg', 'pgUser': 'lyam', 'pgDatabase': 'lyam', 'tenant': 'acme-demo',
            'appendOnlyTables': ['public.activations', 'public.decision_audit']}


def fixtures(policy_hash):
    before = {
        'image': v.OLD_IMAGE, 'transportCoverage': 'TLS_EXPECTED_ORIGINS', 'policyHash': policy_hash,
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


def fake_run_factory(before, after, overrides=None):
    """A subprocess stand-in answering every docker call from the fixture state, with per-test tampering."""
    overrides = overrides or {}
    diff_row = {'diff_type': 'added', 'from_set_name': None, 'from_id': None, 'from_cedar': None,
                'to_set_name': v.RULE_SET, 'to_id': v.RULE_ID, 'to_cedar': v.RULE_CEDAR}
    state = {
        'ps': CONTAINER,
        'log': [{'commit_hash': HEAD_AFTER, 'message': v.COMMIT_MESSAGE}, {'commit_hash': HEAD_BEFORE, 'message': 'older'}],
        'summary': [{'table_name': 'policy_rules', 'diff_type': 'modified', 'data_change': True, 'schema_change': False}],
        'diff': [diff_row],
        'status': [],
        'activation_rows': [{'h': 'a1', 'j': {'commit': 'oldcommit', 'tenant': 'acme-demo', 'state': 'applied'}},
                            {'h': 'a2', 'j': {'commit': HEAD_AFTER, 'tenant': 'acme-demo', 'state': 'applied'}}]}
    state.update(overrides)

    def run(args, input_text=None):
        if args[:2] == ['docker', 'ps']:
            return state['ps']
        if args[:2] == ['docker', 'inspect']:
            return json.dumps([{'Config': {'Image': v.NEW_IMAGE}, 'State': {'Running': True}}])
        if 'dolt' in args:
            sql = args[-1]
            db = [a for a in args if a.startswith('--use-db=')][0][9:]
            if 'FROM dolt_log' in sql:
                rows = state['log']
            elif 'dolt_diff_summary' in sql:
                rows = state['summary']
            elif 'dolt_diff(' in sql:
                rows = state['diff']
            elif 'dolt_status' in sql:
                rows = state['status']
            elif 'FROM dolt_branches' in sql:
                rows = [{'name': b, 'hash': h} for (d, b), h in
                        {(x['database'], x['branch']): x['head'] for x in after['dolt']}.items() if d == db]
            elif "DOLT_HASHOF_DB('WORKING')" in sql:
                root = {('/'.join([x['database'], x['branch']])): x['root'] for x in after['dolt']}[db]
                rows = [{'root': root}]
            else:
                raise AssertionError('unexpected dolt sql: ' + sql)
            return json.dumps({'rows': rows})
        if 'psql' in args:
            sql = args[-1]
            if 'to_jsonb(t) j FROM public.activations' in sql:
                return json.dumps(state['activation_rows'])
            if 'last_value, is_called FROM ' in sql:
                name = sql.split('last_value, is_called FROM ', 1)[1].split(')')[0].strip()
                rows = state.get('pg_sequences', {}).get(name, after['postgres']['sequences'][name])
                return json.dumps(rows)
            for table in ('public.activations', 'public.decision_audit'):
                if 'FROM %s t GROUP BY 1' % table in sql:
                    rows = state.get('pg_rows', {}).get(table, after['postgres']['rows'][table])
                    return json.dumps([{'h': h, 'n': n} for h, n in rows.items()])
            raise AssertionError('unexpected pg sql: ' + sql)
        raise AssertionError('unexpected command: ' + ' '.join(args))
    return run


class Verify(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.policy_path = Path(self.dir.name) / 'policy.json'
        self.policy_path.write_text(json.dumps(policy()))
        self.policy_hash = hashlib.sha256(self.policy_path.read_bytes()).hexdigest()
        self.before, self.after = fixtures(self.policy_hash)
        self.before_path = Path(self.dir.name) / 'before.json'
        self.after_path = Path(self.dir.name) / 'after.json'
        self.before_path.write_text(json.dumps(self.before))
        self.after_path.write_text(json.dumps(self.after))

    def tearDown(self):
        self.dir.cleanup()

    def run_verifier(self, overrides=None, before=None, after=None):
        if before is not None:
            self.before_path.write_text(json.dumps(before))
        if after is not None:
            self.after_path.write_text(json.dumps(after))
        b, a = json.loads(self.before_path.read_text()), json.loads(self.after_path.read_text())
        with mock.patch.object(v, 'run', fake_run_factory(b, a, overrides)):
            v.verify(str(self.before_path), str(self.after_path), str(self.policy_path))

    def expect_fail(self, overrides=None, before=None, after=None):
        with self.assertRaises(ValueError):
            self.run_verifier(overrides, before, after)

    def test_declared_transition_passes(self):
        self.run_verifier()

    def test_constants_match_migration_source(self):
        root = Path(__file__).parents[2]
        self.assertIn(json.dumps(v.RULE_CEDAR), (root / 'apps/api/src/migrations/v0002/rule.ts').read_text())
        manifest = json.loads((root / 'data/migrations/manifest.json').read_text())
        entry = [x for x in manifest['versions'] if x['id'] == v.MIGRATION_ID][0]
        self.assertEqual(entry['checksum'], v.MIGRATION_CHECKSUM)
        self.assertIn(v.COMMIT_MESSAGE, (root / 'apps/api/src/migrations/v0002/run.ts').read_text())

    def test_wrong_after_image(self):
        after = copy.deepcopy(self.after); after['image'] = 'ghcr.io/manudss/iam-platform-poc@sha256:' + '0' * 64
        self.expect_fail(after=after)

    def test_policy_drift_since_capture(self):
        self.policy_path.write_text(json.dumps({**policy(), 'tenant': 'other'}))
        self.expect_fail()

    def test_ledger_checksum_mismatch(self):
        after = copy.deepcopy(self.after); after['migrationLedger']['entries'][-1]['checksum'] = '0' * 64
        self.expect_fail(after=after)

    def test_ledger_not_strictly_extended(self):
        after = copy.deepcopy(self.after); after['migrationLedger']['entries'][0]['checksum'] = '0' * 64
        self.expect_fail(after=after)

    def test_ledger_pending_fails(self):
        after = copy.deepcopy(self.after); after['migrationLedger']['pending'] = {'id': '0002'}
        self.expect_fail(after=after)

    def test_bao_change(self):
        after = copy.deepcopy(self.after); after['bao'] = {}
        self.expect_fail(after=after)

    def test_credential_change(self):
        after = copy.deepcopy(self.after); after['credentials']['core-state/credentials.json'] = 'new'
        self.expect_fail(after=after)

    def test_other_branch_movement(self):
        after = copy.deepcopy(self.after)
        for item in after['dolt']:
            if item['branch'] == 'personal/demo-alice':
                item['root'] = 'tampered' + item['root'][8:]
        self.expect_fail(after=after)

    def test_transformation_absent(self):
        after = copy.deepcopy(self.after)
        for item in after['dolt']:
            if (item['database'], item['branch']) == ('iam', 'main'):
                item['head'], item['root'] = HEAD_BEFORE, ROOT_BEFORE
        self.expect_fail(after=after)

    def test_two_commits(self):
        self.expect_fail({'log': [{'commit_hash': HEAD_AFTER, 'message': v.COMMIT_MESSAGE}, {'commit_hash': 'surprise', 'message': 'x'}]})

    def test_commit_message(self):
        self.expect_fail({'log': [{'commit_hash': HEAD_AFTER, 'message': 'relabelled'}, {'commit_hash': HEAD_BEFORE, 'message': 'older'}]})

    def test_extra_table_in_commit(self):
        self.expect_fail({'summary': [{'table_name': 'policy_rules', 'diff_type': 'modified', 'data_change': True, 'schema_change': False},
                                      {'table_name': 'users', 'diff_type': 'modified', 'data_change': True, 'schema_change': False}]})

    def test_schema_change_in_commit(self):
        self.expect_fail({'summary': [{'table_name': 'policy_rules', 'diff_type': 'modified', 'data_change': True, 'schema_change': True}]})

    def test_rule_text_mismatch(self):
        row = {'diff_type': 'added', 'from_set_name': None, 'from_id': None, 'from_cedar': None,
               'to_set_name': v.RULE_SET, 'to_id': v.RULE_ID, 'to_cedar': 'permit(principal, action, resource);'}
        self.expect_fail({'diff': [row]})

    def test_existing_row_modified(self):
        row = {'diff_type': 'modified', 'from_set_name': 'default', 'from_id': 'screen-users', 'from_cedar': 'x',
               'to_set_name': 'default', 'to_id': 'screen-users', 'to_cedar': 'y'}
        self.expect_fail({'diff': [row]})

    def test_dirty_working_set(self):
        self.expect_fail({'status': [{'table_name': 'sessions', 'status': 'modified'}]})

    def test_live_root_drift(self):
        after = copy.deepcopy(self.after)
        for item in after['dolt']:
            if (item['database'], item['branch']) == ('iam_meta', 'main'):
                item['root'] = 'drifted' + item['root'][7:]
        # evidence compare sees only ['dolt'] with iam/main; live tie must catch iam_meta drift
        self.expect_fail(after=after)

    def test_pg_rows_drift(self):
        # live rows no longer match the after-capture: something wrote after the evidence
        self.expect_fail({'pg_rows': {'public.decision_audit': {'d1': 2, 'd2': 1}}})

    def test_pg_row_lost_since_capture(self):
        self.expect_fail({'pg_rows': {'public.decision_audit': {'d1': 1}}})

    def test_two_activation_appends(self):
        after = copy.deepcopy(self.after)
        after['postgres']['rows']['public.activations'] = {'a1': 1, 'a2': 1, 'a3': 1}
        self.expect_fail(after=after)

    def test_activation_of_wrong_commit(self):
        rows = [{'h': 'a1', 'j': {'commit': 'oldcommit', 'tenant': 'acme-demo', 'state': 'applied'}},
                {'h': 'a2', 'j': {'commit': 'unrelatedcommit', 'tenant': 'acme-demo', 'state': 'applied'}}]
        self.expect_fail({'activation_rows': rows})

    def test_not_exactly_one_container(self):
        self.expect_fail({'ps': CONTAINER + '\nothercid'})

    def test_missing_controller_is_unknown(self):
        with mock.patch.object(v, 'load_controller', side_effect=ValueError('x')):
            self.expect_fail()


if __name__ == '__main__':
    unittest.main()
