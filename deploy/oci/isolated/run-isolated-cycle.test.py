import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / 'run-isolated-cycle.sh'


class IsolatedCycleRefusals(unittest.TestCase):
    """The orchestrator's hard refusals fire BEFORE any mutation. A stub `docker`
    (always failing) on PATH proves the pure refusals need no daemon; the one
    fully-valid setup must get PAST them and stop at the docker availability check."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        self.work = root / 'iso-work'
        bin_dir = root / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'docker').write_text('#!/bin/sh\nexit 1\n')
        (bin_dir / 'docker').chmod(0o755)
        self.env = dict(os.environ)
        self.env['PATH'] = str(bin_dir) + ':' + self.env['PATH']
        self.env['CI'] = 'true'
        self.env['RUNNER_TEMP'] = str(root)
        self.env.pop('ALLOW_NON_CI_RUNNER', None)

    def tearDown(self):
        self.dir.cleanup()

    def run_cycle(self, work=None, env_updates=None):
        env = dict(self.env)
        env.update(env_updates or {})
        return subprocess.run(['bash', str(SCRIPT), str(work if work is not None else self.work)],
                              capture_output=True, text=True, env=env)

    def test_relative_work_refused(self):
        result = self.run_cycle(work='relative/path')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('absolute', result.stderr)

    def test_production_opt_lyam_refused(self):
        result = self.run_cycle(work='/opt/lyam/isolated')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('disposable', result.stderr)

    def test_production_var_lib_refused(self):
        result = self.run_cycle(work='/var/lib/lyam-front-gate/x')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('disposable', result.stderr)

    def test_root_refused(self):
        result = self.run_cycle(work='/')
        self.assertNotEqual(result.returncode, 0)

    def test_noncanonical_work_refused(self):
        # Raw string dodges the prefix check; realpath -m must catch it (reproduced).
        result = self.run_cycle(work=str(Path(self.dir.name) / 'subdir' / '..' / 'escape'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('canonical', result.stderr)

    def test_dotdot_to_production_refused(self):
        result = self.run_cycle(work='/tmp/../opt/lyam/isolated')
        self.assertNotEqual(result.returncode, 0)

    def test_preexisting_work_refused(self):
        self.work.mkdir()
        result = self.run_cycle()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('created new', result.stderr)

    def test_work_outside_runner_temp_refused_in_ci(self):
        result = self.run_cycle(work='/tmp/elsewhere-iso-work')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('RUNNER_TEMP', result.stderr)

    def test_outside_ci_refused_without_explicit_opt_in(self):
        result = self.run_cycle(env_updates={'CI': ''})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ALLOW_NON_CI_RUNNER', result.stderr)

    def test_valid_setup_passes_pure_refusals_and_stops_at_docker(self):
        result = self.run_cycle()
        self.assertNotEqual(result.returncode, 0)
        # Reached the daemon check: every pure refusal above passed.
        self.assertIn('docker unavailable', result.stderr)

    def test_rendered_env_paths_all_exist(self):
        # Regression for the doubled <checkout>/deploy/oci/deploy/oci path defect.
        self.run_cycle()
        content = (self.work / 'lyam.env').read_text()
        import re
        paths = sorted(set(re.findall(r'/\S+', content)))
        repo_paths = [p for p in paths if p.startswith(str(Path(__file__).resolve().parents[3]))]
        self.assertTrue(repo_paths)
        for path in repo_paths:
            self.assertTrue(Path(path).exists(), path)

    def test_rendered_config_carries_no_production_path(self):
        self.run_cycle()
        for name in ('lyam.env', 'qualification.isolated.json'):
            content = (self.work / name).read_text()
            self.assertNotIn('/opt/lyam', content)
            self.assertNotIn('/var/lib/lyam-front-gate', content)

    def test_rendered_policy_keeps_isolated_marker_and_no_https_origin(self):
        self.run_cycle()
        import json
        policy = json.loads((self.work / 'qualification.isolated.json').read_text())
        self.assertIs(policy['isolatedLoopbackTest'], True)
        self.assertTrue(all(not o.startswith('https://') for o in policy['origins']))
        self.assertIn('verify-0002-isolated-test.py',
                      policy['transformationVerifiers'][
                          'ghcr.io/manudss/iam-platform-poc@sha256:7c5ce38f03b378afbb060e6092706a03503c47eac58c2cbca943d15d0d652201'])
        neg = json.loads((self.work / 'qualification.isolated.no-verifier.json').read_text())
        self.assertNotIn('transformationVerifiers', neg)


if __name__ == '__main__':
    unittest.main()
