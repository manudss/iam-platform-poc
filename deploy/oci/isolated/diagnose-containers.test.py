import importlib.util
import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
DIAGNOSE = HERE / 'diagnose-containers.py'
CYCLE = HERE / 'run-isolated-cycle.sh'

spec = importlib.util.spec_from_file_location('diagnose_containers', DIAGNOSE)
diag_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diag_mod)

SECRET = 's.fictiveApiTokenValue1234567890'
FREE_LINE = 'openbao: error initializing storage /bao/file: permission denied'

STUB = """\
#!/bin/sh
printf '%s\\n' "$*" >> "$DIAG_ARGV" 2>/dev/null
for last; do :; done
if [ "$1" = "inspect" ]; then
  case "$last" in
    bao-iso) echo "restarting 5 1" ;;
    caddy-iso) echo "weird output" ;;
    *) echo "running 0 0" ;;
  esac
  exit 0
fi
if [ "$1" = "logs" ]; then
  case "$last" in
    bao-iso)
      printf '""" + FREE_LINE + """\\n'
      printf 'leaked token """ + SECRET + """ plus short abc here\\n'
      exit 0 ;;
    api-iso) exit 1 ;;
    *) printf 'CANARY-%s routine start\\n' "$last" ;;
  esac
  exit 0
fi
exit 1
"""

ALLOWED_ENTRY_KEYS = {'container', 'inspect', 'status', 'restart_count', 'exit_code',
                      'logs', 'log_tail_lines', 'patterns'}
ALLOWED_PATTERN_LABELS = {'permission_denied', 'address_in_use', 'connection_refused',
                          'no_such_file', 'storage_init_error', 'auth_failure',
                          'fatal', 'panic', 'out_of_memory', 'no_space'}


class DiagnoseContainers(unittest.TestCase):
    """Only the fixed schema may leave the process: whitelisted keys, fixed enums,
    counters of fixed patterns. No original line, secret (long or short) or error
    text - the canary assertions grep the whole document for them."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        self.bin = root / 'bin'
        self.bin.mkdir()
        stub = self.bin / 'docker'
        stub.write_text(STUB)
        stub.chmod(0o755)
        self.argv_log = root / 'argv.log'
        self.work = root / 'iso-work'
        self.work.mkdir()
        self.env = dict(os.environ)
        self.env['PATH'] = str(self.bin) + ':' + self.env['PATH']
        self.env['DIAG_ARGV'] = str(self.argv_log)

    def tearDown(self):
        self.dir.cleanup()

    def run_diagnose(self, exit_code=None):
        argv = ['python3', str(DIAGNOSE), str(self.work)]
        if exit_code is not None:
            argv.append(exit_code)
        return subprocess.run(argv, capture_output=True, text=True, env=self.env)

    def test_step_enum_matches_orchestrator(self):
        text = CYCLE.read_text()
        m = re.search(r"^STEPS_ALL='([^']*)'", text, re.M)
        self.assertIsNotNone(m)
        self.assertEqual(set(m.group(1).split()), diag_mod.STEPS)

    def test_fixed_schema_and_state_fields(self):
        result = self.run_diagnose()
        doc = json.loads(result.stdout)
        self.assertEqual(doc['schema'], 'isolated-container-diagnostics/2')
        self.assertLessEqual(set(doc), {'schema', 'run', 'containers'})
        entries = {e['container']: e for e in doc['containers']}
        self.assertEqual(set(entries), {'pg-iso', 'bao-iso', 'caddy-iso', 'api-iso'})
        bao = entries['bao-iso']
        self.assertEqual(bao['status'], 'restarting')
        self.assertEqual(bao['restart_count'], 5)
        self.assertEqual(bao['exit_code'], 1)
        self.assertEqual(bao['logs'], 'ok')
        self.assertGreaterEqual(bao['patterns']['permission_denied'], 1)
        self.assertGreaterEqual(bao['patterns']['storage_init_error'], 1)
        for entry in entries.values():
            self.assertLessEqual(set(entry), ALLOWED_ENTRY_KEYS)
            if entry['patterns'] is not None:
                self.assertLessEqual(set(entry['patterns']), ALLOWED_PATTERN_LABELS)

    def test_read_failures_are_fixed_enums_named_only(self):
        result = self.run_diagnose()
        self.assertEqual(result.returncode, 2)
        doc = json.loads(result.stdout)
        entries = {e['container']: e for e in doc['containers']}
        self.assertEqual(entries['api-iso']['logs'], 'error')
        self.assertIsNone(entries['api-iso']['patterns'])
        self.assertEqual(entries['caddy-iso']['inspect'], 'error')
        self.assertIn('api-iso', result.stderr)
        self.assertIn('caddy-iso', result.stderr)

    def test_step_localizes_failure_stage(self):
        (self.work / 'cycle-step').write_text('S1_BAO_BOOTSTRAP')
        result = self.run_diagnose(exit_code='1')
        doc = json.loads(result.stdout)
        self.assertEqual(doc['run']['step'], 'S1_BAO_BOOTSTRAP')
        self.assertEqual(doc['run']['step_read'], 'ok')
        self.assertEqual(doc['run']['exit_code'], 1)
        self.assertEqual(doc['run']['exit_code_read'], 'ok')
        self.assertLessEqual(set(doc['run']), {'step', 'step_read', 'exit_code', 'exit_code_read'})

    def test_step_outside_enum_never_exported(self):
        (self.work / 'cycle-step').write_text(SECRET)
        result = self.run_diagnose()
        doc = json.loads(result.stdout)
        self.assertIsNone(doc['run']['step'])
        self.assertEqual(doc['run']['step_read'], 'invalid')
        self.assertNotIn(SECRET, result.stdout)
        self.assertNotIn(SECRET, result.stderr)

    def test_step_absent_and_exit_code_bounds(self):
        result = self.run_diagnose(exit_code='999')
        doc = json.loads(result.stdout)
        self.assertEqual(doc['run']['step_read'], 'absent')
        self.assertIsNone(doc['run']['exit_code'])
        self.assertEqual(doc['run']['exit_code_read'], 'invalid')
        result = self.run_diagnose(exit_code='4')
        doc = json.loads(result.stdout)
        self.assertEqual(doc['run']['exit_code'], 4)
        self.assertEqual(doc['run']['exit_code_read'], 'ok')

    def test_no_secret_no_line_no_error_text_leaks(self):
        result = self.run_diagnose()
        self.assertNotIn(SECRET, result.stdout)
        self.assertNotIn(SECRET, result.stderr)
        self.assertNotIn('short abc', result.stdout)
        self.assertNotIn('leaked token', result.stdout)
        self.assertNotIn(FREE_LINE, result.stdout)

    def test_exact_docker_argv(self):
        result = self.run_diagnose()
        self.assertIn(result.returncode, (0, 2))
        lines = self.argv_log.read_text().splitlines()
        fmt = 'inspect --format {{.State.Status}} {{.RestartCount}} {{.State.ExitCode}}'
        expected = sorted(['%s %s' % (fmt, c) for c in ('pg-iso', 'bao-iso', 'caddy-iso', 'api-iso')] +
                          ['logs --tail 200 %s' % c for c in ('pg-iso', 'bao-iso', 'caddy-iso', 'api-iso')])
        self.assertEqual(sorted(lines), expected)

    def test_status_outside_enum_and_unbounded_counters_rejected(self):
        (self.bin / 'docker').write_text(
            '#!/bin/sh\nfor last; do :; done\n'
            'if [ "$1" = "inspect" ]; then\n'
            '  case "$last" in\n'
            '    pg-iso) echo "' + SECRET + ' 0 0" ;;\n'
            '    caddy-iso) echo "running 99999999999999999999 0" ;;\n'
            '    *) echo "running 0 0" ;;\n'
            '  esac\n  exit 0\nfi\n'
            'if [ "$1" = "logs" ]; then echo "CANARY ok"; exit 0; fi\nexit 1\n')
        result = self.run_diagnose()
        self.assertEqual(result.returncode, 2)
        doc = json.loads(result.stdout)
        entries = {e['container']: e for e in doc['containers']}
        self.assertEqual(entries['pg-iso']['inspect'], 'error')
        self.assertEqual(entries['caddy-iso']['inspect'], 'error')
        self.assertEqual(entries['bao-iso']['inspect'], 'ok')
        self.assertNotIn(SECRET, result.stdout)
        self.assertNotIn(SECRET, result.stderr)

    def test_all_reads_ok_exits_zero(self):
        (self.bin / 'docker').write_text(
            '#!/bin/sh\nfor last; do :; done\n'
            'if [ "$1" = "inspect" ]; then echo "running 0 0"; exit 0; fi\n'
            'if [ "$1" = "logs" ]; then echo "CANARY ok"; exit 0; fi\nexit 1\n')
        result = self.run_diagnose()
        self.assertEqual(result.returncode, 0, result.stderr)
        doc = json.loads(result.stdout)
        for entry in doc['containers']:
            self.assertEqual(entry['inspect'], 'ok')
            self.assertEqual(entry['logs'], 'ok')


if __name__ == '__main__':
    unittest.main()
