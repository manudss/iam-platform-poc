import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
COLLECT = HERE / 'collect-failure-logs.sh'
CYCLE = HERE / 'run-isolated-cycle.sh'

SECRET = 's.fictiveApiTokenValue1234567890'

STUB_OK = """\
#!/bin/sh
for last; do :; done
if [ "$1" = "inspect" ]; then echo "running 0 0"; exit 0; fi
if [ "$1" = "logs" ]; then
  printf 'CANARY-%s routine start, token """ + SECRET + """\\n' "$last"
  exit 0
fi
exit 1
"""

STUB_BAO_FAILS = """\
#!/bin/sh
for last; do :; done
if [ "$last" = "bao-iso" ]; then exit 1; fi
if [ "$1" = "inspect" ]; then echo "running 0 0"; exit 0; fi
if [ "$1" = "logs" ]; then printf 'CANARY-%s ok\\n' "$last"; exit 0; fi
exit 1
"""


class CollectFailureLogs(unittest.TestCase):
    """The collector stores ONLY the fixed-schema JSON diagnostics document, is
    loud on any gap, and - through the orchestrator's real EXIT trap
    (--selftest-trap) - never alters the run's original exit code."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        self.work = root / 'iso-work'
        self.work.mkdir()
        self.bin = root / 'bin'
        self.bin.mkdir()
        self.env = dict(os.environ)
        self.env['PATH'] = str(self.bin) + ':' + self.env['PATH']

    def tearDown(self):
        self.dir.cleanup()

    def stub_docker(self, body):
        stub = self.bin / 'docker'
        stub.write_text(body)
        stub.chmod(0o755)

    def run_collect(self):
        return subprocess.run(['bash', str(COLLECT), str(self.work)],
                              capture_output=True, text=True, env=self.env)

    def doc_path(self):
        return self.work / 'evidence' / 'container-diagnostics.json'

    def test_document_stored_and_no_secret_leaks(self):
        self.stub_docker(STUB_OK)
        result = self.run_collect()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('container-diagnostics.json', result.stderr)
        self.assertTrue(self.doc_path().is_file())
        text = self.doc_path().read_text()
        doc = json.loads(text)
        self.assertEqual(doc['schema'], 'isolated-container-diagnostics/2')
        self.assertEqual(len(doc['containers']), 4)
        self.assertNotIn(SECRET, text)
        self.assertNotIn('CANARY', text)

    def test_no_log_line_files_are_kept(self):
        self.stub_docker(STUB_OK)
        self.assertEqual(self.run_collect().returncode, 0)
        leftovers = [p for p in self.work.rglob('*') if p.is_file()]
        self.assertEqual([p.name for p in leftovers], ['container-diagnostics.json'])

    def test_read_failure_is_loud_but_document_kept(self):
        self.stub_docker(STUB_BAO_FAILS)
        result = self.run_collect()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('INCOMPLETE', result.stderr)
        doc = json.loads(self.doc_path().read_text())
        entries = {e['container']: e for e in doc['containers']}
        self.assertEqual(entries['bao-iso']['inspect'], 'error')
        self.assertEqual(entries['pg-iso']['logs'], 'ok')

    def test_trap_preserves_original_exit_code_on_successful_collection(self):
        self.stub_docker(STUB_OK)
        (self.work / 'cycle-step').write_text('UPDATE_POSITIVE')
        result = subprocess.run(
            ['bash', str(CYCLE), '--selftest-trap', str(self.work), '7'],
            capture_output=True, text=True, env=self.env)
        self.assertEqual(result.returncode, 7)
        doc = json.loads(self.doc_path().read_text())
        self.assertEqual(doc['run']['exit_code'], 7)
        self.assertEqual(doc['run']['step'], 'UPDATE_POSITIVE')

    def test_trap_preserves_original_exit_code_even_when_collection_fails(self):
        self.stub_docker(STUB_BAO_FAILS)
        result = subprocess.run(
            ['bash', str(CYCLE), '--selftest-trap', str(self.work), '7'],
            capture_output=True, text=True, env=self.env)
        self.assertEqual(result.returncode, 7)
        self.assertIn('FAILURE DIAGNOSTICS INCOMPLETE', result.stderr)

    def test_garbage_document_is_loud_failure(self):
        stub = self.bin / 'python3'
        stub.write_text('#!/bin/sh\ncase " $* " in\n'
                        '  *diagnose-containers.py*) echo "this is not json"; exit 0 ;;\nesac\n'
                        'exec ' + sys.executable + ' "$@"\n')
        stub.chmod(0o755)
        self.stub_docker(STUB_OK)
        result = self.run_collect()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('no valid JSON', result.stderr)
        self.assertFalse(self.doc_path().exists())


if __name__ == '__main__':
    unittest.main()
