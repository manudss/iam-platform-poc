import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
WRAPPER = HERE / 'run-qualification-isolated.sh'

ARGS = ['--phase', 'after', '--container', 'api-iso', '--image', 'img@sha256:x',
        '--env-file', '/w/env', '--data-dir', '/w/data', '--backup-dir', '/w/backups',
        '--barrier-file', '/w/gate/MAINTENANCE', '--target-image', 'img@sha256:y',
        '--evidence-dir', '/w/evidence']


class RunQualificationIsolated(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        # Mirror the deploy/oci layout with a stub controller that echoes its argv.
        self.oci = root / 'oci'
        (self.oci / 'isolated').mkdir(parents=True)
        (self.oci / 'qualification.py').write_text(
            "import json,sys;print(json.dumps(sys.argv[1:]))")
        self.wrapper = self.oci / 'isolated' / 'run-qualification-isolated.sh'
        self.wrapper.write_text(WRAPPER.read_text())
        self.wrapper.chmod(0o755)
        self.policy = root / 'test-policy.json'
        self.policy.write_text('{"format": 1, "isolatedLoopbackTest": true}')

    def tearDown(self):
        self.dir.cleanup()

    def run_wrapper(self, env_extra=None):
        env = dict(os.environ)
        env.pop('LYAM_ISOLATED_POLICY', None)
        env.update(env_extra or {})
        return subprocess.run(['bash', str(self.wrapper)] + ARGS,
                              capture_output=True, text=True, env=env)

    def test_forwards_args_with_isolated_flags(self):
        result = self.run_wrapper({'LYAM_ISOLATED_POLICY': str(self.policy)})
        self.assertEqual(result.returncode, 0, result.stderr)
        forwarded = json.loads(result.stdout)
        self.assertEqual(forwarded[:4],
                         ['--policy', str(self.policy), '--isolated-loopback-test', '--phase'])
        self.assertEqual(forwarded[2:], ['--isolated-loopback-test'] + ARGS)

    def test_policy_unset_refused(self):
        result = self.run_wrapper()
        self.assertNotEqual(result.returncode, 0)

    def test_policy_empty_refused(self):
        result = self.run_wrapper({'LYAM_ISOLATED_POLICY': ''})
        self.assertNotEqual(result.returncode, 0)

    def test_production_policy_path_refused(self):
        result = self.run_wrapper({'LYAM_ISOLATED_POLICY': '/opt/lyam/qualification.json'})
        self.assertNotEqual(result.returncode, 0)

    def test_production_policy_symlink_refused(self):
        link = Path(self.dir.name) / 'innocent-name.json'
        os.symlink('/opt/lyam/qualification.json', link)
        result = self.run_wrapper({'LYAM_ISOLATED_POLICY': str(link)})
        self.assertNotEqual(result.returncode, 0)

    def test_policy_without_isolated_marker_refused(self):
        self.policy.write_text('{"format": 1}')
        result = self.run_wrapper({'LYAM_ISOLATED_POLICY': str(self.policy)})
        self.assertNotEqual(result.returncode, 0)

    def test_missing_policy_file_refused(self):
        result = self.run_wrapper({'LYAM_ISOLATED_POLICY': str(Path(self.dir.name) / 'absent.json')})
        self.assertNotEqual(result.returncode, 0)

    def test_real_wrapper_points_at_real_controller(self):
        content = WRAPPER.read_text()
        self.assertIn('../qualification.py', content)
        self.assertIn('--isolated-loopback-test', content)


if __name__ == '__main__':
    unittest.main()
