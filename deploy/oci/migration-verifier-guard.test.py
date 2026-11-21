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


def sh(root, *args):
    subprocess.run(['git', '-C', str(root), *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class Guard(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        (root / 'data/migrations').mkdir(parents=True)
        (root / 'deploy/oci').mkdir(parents=True)
        (root / '.github/workflows').mkdir(parents=True)
        (root / 'data/migrations/manifest.json').write_text(json.dumps(MANIFEST_0001))
        (root / '.github/workflows/ci.yml').write_text('jobs: {}\n')
        sh(root, 'init', '-q')
        sh(root, 'add', '-A')
        sh(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base')
        self.root = root
        self.base = 'HEAD'

    def tearDown(self):
        self.dir.cleanup()

    def add_migration_0002(self):
        (self.root / 'data/migrations/manifest.json').write_text(json.dumps(MANIFEST_0002))

    def add_verifier(self, with_test=True):
        (self.root / 'deploy/oci/verify-0002-account-blocks.py').write_text('# verifier\n')
        if with_test:
            (self.root / 'deploy/oci/verify-0002-account-blocks.test.py').write_text('# tests\n')

    def add_ci_step(self):
        ci = self.root / '.github/workflows/ci.yml'
        ci.write_text(ci.read_text() + '          python3 deploy/oci/verify-0002-account-blocks.test.py\n')

    def test_no_new_migration_passes(self):
        self.assertEqual(g.guard(self.root, self.base), [])

    def test_new_migration_without_verifier_fails(self):
        self.add_migration_0002()
        missing = g.guard(self.root, self.base)
        self.assertTrue(any('verify-0002' in item and item.endswith('reviewed verifier)') for item in missing))
        self.assertTrue(any(item.endswith('(counter-tests)') for item in missing))
        self.assertTrue(any(item.startswith('.github/workflows/ci.yml') for item in missing))

    def test_verifier_without_tests_fails(self):
        self.add_migration_0002()
        self.add_verifier(with_test=False)
        self.add_ci_step()
        missing = g.guard(self.root, self.base)
        self.assertEqual(missing, ['deploy/oci/verify-0002-*.test.py (counter-tests)'])

    def test_verifier_and_tests_without_ci_step_fail(self):
        self.add_migration_0002()
        self.add_verifier()
        self.assertEqual(g.guard(self.root, self.base),
                         ['.github/workflows/ci.yml (a step running the verifier tests)'])

    def test_complete_coverage_passes(self):
        self.add_migration_0002()
        self.add_verifier()
        self.add_ci_step()
        self.assertEqual(g.guard(self.root, self.base), [])

    def test_base_without_manifest_passes(self):
        self.assertEqual(g.guard(self.root, 'refs/does/not/exist'), [])

    def test_main_exit_codes(self):
        import sys
        from unittest import mock
        self.add_migration_0002()
        with mock.patch.object(sys, 'argv', ['guard', '--base', self.base, '--root', str(self.root)]):
            self.assertEqual(g.main(), 1)
        self.add_verifier()
        self.add_ci_step()
        with mock.patch.object(sys, 'argv', ['guard', '--base', self.base, '--root', str(self.root)]):
            self.assertEqual(g.main(), 0)


if __name__ == '__main__':
    unittest.main()
