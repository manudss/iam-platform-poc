import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('guard', Path(__file__).with_name('migration-verifier-guard.py'))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)

MANIFEST_0001 = {'format': 1, 'versions': [{'id': '0001', 'name': 'baseline', 'files': {'a.sql': 'x' * 64}, 'checksum': 'y' * 64}]}
MANIFEST_0002 = {'format': 1, 'versions': MANIFEST_0001['versions'] + [
    {'id': '0002', 'name': 'rule', 'files': {'b.ts': 'z' * 64}, 'checksum': 'w' * 64}]}
SUITE = ("import unittest\n"
         "class T(unittest.TestCase):\n"
         "    def test_loads(self):\n"
         "        self.assertIn('verify-0002-account-blocks', 'verify-0002-account-blocks')\n"
         "unittest.main()\n")
EMPTY_SUITE = "print('nothing ran')  # verify-0002-account-blocks\n"
FAILING_SUITE = SUITE.replace("assertIn('verify-0002-account-blocks', 'verify-0002-account-blocks')",
                              "assertIn('verify-0002-account-blocks', 'verify-0002-account-blocks'); self.assertTrue(False)")


def sh(root, *args):
    subprocess.run(['git', '-C', str(root), *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class Guard(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        (root / 'data/migrations').mkdir(parents=True)
        (root / 'deploy/oci').mkdir(parents=True)
        (root / '.github/workflows').mkdir(parents=True)
        (root / 'data/migrations/manifest.json').write_text(json.dumps(MANIFEST_0002))
        (root / '.github/workflows/ci.yml').write_text('jobs: {}\n')
        sh(root, 'init', '-q')
        sh(root, 'add', '-A')
        sh(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base')
        self.root = root
        self.base = 'HEAD'

    def tearDown(self):
        self.dir.cleanup()

    def commit(self, message='change'):
        sh(self.root, 'add', '-A')
        sh(self.root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message)

    def add_verifier(self, suite=SUITE):
        (self.root / 'deploy/oci/verify-0002-account-blocks.py').write_text('# verifier proving migration 0002\n')
        if suite is not None:
            (self.root / 'deploy/oci/verify-0002-account-blocks.test.py').write_text(suite)

    def add_ci_step(self, prefix='      '):
        ci = self.root / '.github/workflows/ci.yml'
        ci.write_text(ci.read_text() + prefix + '- run: python3 deploy/oci/verify-0002-account-blocks.test.py\n')

    # -- pass paths --------------------------------------------------------------
    def test_baseline_only_passes(self):
        (self.root / 'data/migrations/manifest.json').write_text(json.dumps(MANIFEST_0001))
        self.assertEqual(g.guard(self.root, self.base), [])

    def test_complete_coverage_passes(self):
        self.add_verifier()
        self.add_ci_step()
        self.assertEqual(g.guard(self.root, self.base), [])

    def test_base_commit_without_manifest_passes(self):
        # A REAL base commit that predates the manifest (initial release), distinct
        # from an unresolvable ref: only the baseline version exists and is exempt.
        other = Path(self.dir.name) / 'other'
        (other / 'data/migrations').mkdir(parents=True)
        (other / 'deploy/oci').mkdir(parents=True)
        (other / 'seed.txt').write_text('seed')
        sh(other, 'init', '-q')
        sh(other, 'add', '-A')
        sh(other, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'no manifest yet')
        base = subprocess.run(['git', '-C', str(other), 'rev-parse', 'HEAD'],
                              text=True, stdout=subprocess.PIPE).stdout.strip()
        (other / 'data/migrations/manifest.json').write_text(json.dumps(MANIFEST_0001))
        self.assertEqual(g.guard(other, base), [])

    # -- UNKNOWN / fail-closed paths ---------------------------------------------
    def test_unresolvable_base_ref_fails_closed(self):
        missing = g.guard(self.root, 'refs/does/not/exist')
        self.assertEqual(missing, ['base ref refs/does/not/exist unresolvable: UNKNOWN, not a pass'])

    # -- coverage defects ----------------------------------------------------------
    def test_existing_migration_without_verifier_fails(self):
        # No new id: the ALREADY RELEASED 0002 must still be covered - an empty
        # lint result here is what failed the nominal path of #118.
        missing = g.guard(self.root, self.base)
        self.assertTrue(any('verify-0002' in item and 'non-empty reviewed verifier' in item for item in missing))
        self.assertTrue(any('counter-tests' in item for item in missing))
        self.assertTrue(any(item.startswith('.github/workflows/ci.yml') for item in missing))

    def test_empty_files_fail(self):
        self.add_verifier(suite=None)
        (self.root / 'deploy/oci/verify-0002-account-blocks.test.py').write_text('')
        self.add_ci_step()
        missing = g.guard(self.root, self.base)
        self.assertTrue(any('non-empty counter-tests' in item for item in missing))

    def test_test_not_referencing_verifier_fails(self):
        self.add_verifier(suite=SUITE.replace('verify-0002-account-blocks', 'something-else-entirely'))
        self.add_ci_step()
        missing = g.guard(self.root, self.base)
        self.assertTrue(any('must reference the verifier module' in item for item in missing))

    def test_suite_reporting_zero_tests_fails(self):
        self.add_verifier(suite=EMPTY_SUITE)
        self.add_ci_step()
        missing = g.guard(self.root, self.base)
        self.assertTrue(any('non-zero number of passing tests' in item for item in missing))

    def test_failing_suite_fails(self):
        self.add_verifier(suite=FAILING_SUITE)
        self.add_ci_step()
        missing = g.guard(self.root, self.base)
        self.assertTrue(any('non-zero number of passing tests' in item for item in missing))

    # -- CI wiring defects ---------------------------------------------------------
    def test_commented_ci_step_fails(self):
        self.add_verifier()
        self.add_ci_step(prefix='# ')
        self.assertTrue(any(item.startswith('.github/workflows/ci.yml') for item in g.guard(self.root, self.base)))

    def test_disabled_ci_step_fails(self):
        self.add_verifier()
        ci = self.root / '.github/workflows/ci.yml'
        ci.write_text(ci.read_text() + '      - name: off\n        if: false\n        run: python3 deploy/oci/verify-0002-account-blocks.test.py\n')
        self.assertTrue(any(item.startswith('.github/workflows/ci.yml') for item in g.guard(self.root, self.base)))

    # -- shipped-verifier deletion ---------------------------------------------------
    def test_deleted_shipped_verifier_fails(self):
        self.add_verifier()
        self.add_ci_step()
        self.commit('ship verifier')
        base = subprocess.run(['git', '-C', str(self.root), 'rev-parse', 'HEAD'],
                              text=True, stdout=subprocess.PIPE).stdout.strip()
        (self.root / 'deploy/oci/verify-0002-account-blocks.py').unlink()
        missing = g.guard(self.root, base)
        self.assertTrue(any('deleted previously shipped verifier' in item for item in missing))

    # -- CLI --------------------------------------------------------------------------
    def test_main_exit_codes(self):
        import sys
        from unittest import mock
        with mock.patch.object(sys, 'argv', ['guard', '--base', self.base, '--root', str(self.root)]):
            self.assertEqual(g.main(), 1)
        self.add_verifier()
        self.add_ci_step()
        with mock.patch.object(sys, 'argv', ['guard', '--base', self.base, '--root', str(self.root)]):
            self.assertEqual(g.main(), 0)


if __name__ == '__main__':
    unittest.main()
