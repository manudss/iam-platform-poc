import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location('preflight', Path(__file__).with_name('update-preflight.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

IMAGE = 'ghcr.io/manudss/iam-platform-poc@sha256:' + 'a' * 64
OTHER_IMAGE = 'ghcr.io/manudss/iam-platform-poc@sha256:' + 'b' * 64


class Preflight(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        self.verifier = root / 'verify-0002-account-blocks.py'
        self.verifier.write_text('# reviewed verifier bytes\n')
        os.chmod(self.verifier, 0o700)
        self.pin = hashlib.sha256(self.verifier.read_bytes()).hexdigest()
        self.policy_path = root / 'policy.json'
        self.write_policy({IMAGE: str(self.verifier)})

    def tearDown(self):
        self.dir.cleanup()

    def write_policy(self, verifiers, fmt=1):
        self.policy_path.write_text(json.dumps({'format': fmt, 'transformationVerifiers': verifiers}))

    def check(self, image=IMAGE, pin=None, uid=0):
        with mock.patch.object(p, 'owner_uid', return_value=uid):
            return p.preflight(image, str(self.policy_path), pin or self.pin)

    def test_pass(self):
        self.assertEqual(self.check(), [])

    def test_missing_exact_key(self):
        self.write_policy({})
        self.assertIn('no verifier listed for the exact target image', self.check())

    def test_near_miss_digest_reported(self):
        self.write_policy({OTHER_IMAGE: str(self.verifier)})
        failures = self.check()
        self.assertIn('no verifier listed for the exact target image', failures)
        self.assertTrue(any('near-miss' in failure and OTHER_IMAGE in failure for failure in failures))

    def test_unreadable_policy_is_unknown(self):
        self.policy_path.write_text('not json')
        self.assertEqual(self.check(), ['policy unreadable or not JSON: UNKNOWN'])

    def test_bad_format(self):
        self.write_policy({IMAGE: str(self.verifier)}, fmt=2)
        self.assertIn('policy format is not 1', self.check())

    def test_relative_path(self):
        self.write_policy({IMAGE: 'relative/verify.py'})
        self.assertIn('verifier path is not absolute', self.check())

    def test_missing_file(self):
        self.write_policy({IMAGE: '/nonexistent/verify.py'})
        self.assertIn('verifier file does not exist', self.check())

    def test_not_root_owned(self):
        self.assertIn('verifier is not owned by root', self.check(uid=1000))

    def test_loose_permissions(self):
        os.chmod(self.verifier, 0o755)
        self.assertIn('verifier permissions are not the reviewed root-only executable (0700)', self.check())

    def test_wrong_pin(self):
        self.assertIn('verifier bytes differ from the reviewed pin', self.check(pin='0' * 64))

    def test_main_exit_codes(self):
        argv = ['preflight', '--image', IMAGE, '--policy', str(self.policy_path), '--verifier-sha256', self.pin]
        with mock.patch.object(sys, 'argv', argv), mock.patch.object(p, 'owner_uid', return_value=0):
            self.assertEqual(p.main(), 0)
        self.write_policy({})
        with mock.patch.object(sys, 'argv', argv):
            self.assertEqual(p.main(), 1)


if __name__ == '__main__':
    unittest.main()
