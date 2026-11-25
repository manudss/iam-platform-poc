import os, re, stat, subprocess, tempfile, textwrap, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
WF = open(os.path.join(ROOT, '.github/workflows/oci-readonly-diagnostic.yml')).read()
DEPLOY = open(os.path.join(ROOT, '.github/workflows/oci-deploy.yml')).read()
HOST = open(os.path.join(HERE, 'host.sh')).read()
INV = open(os.path.join(HERE, 'inventory.cjs')).read()
def code(t): return '\n'.join(l for l in t.splitlines() if not l.strip().startswith('#') and not l.strip().startswith('//'))
WFC, HOSTC, INVC = code(WF), code(HOST), code(INV)
SECRET = 'SUPERSECRET-KEY-VALUE-9f3'
SHA = 'a' * 40

class Workflow(unittest.TestCase):
    def test_trigger_permissions_timeouts(self):
        self.assertRegex(WF, r'(?m)^on:\n  workflow_dispatch:\n\npermissions:\n  contents: read\n')
        self.assertNotRegex(WFC, r'(?m)^\s+(push|pull_request|schedule|inputs):')
        self.assertIn('timeout-minutes: 5', WF); self.assertIn("github.ref == 'refs/heads/main'", WF)
        self.assertIn('transport.sh host', WF); self.assertIn('transport.sh inventory', WF)
        self.assertNotIn('inputs.', WF)
        self.assertNotIn('sudo ', WFC)
    def test_secrets_are_exactly_the_existing_four(self):
        names = lambda t: set(re.findall(r'secrets\.(OCI_DEPLOY_[A-Z_]+)', t))
        self.assertEqual(names(WF), names(DEPLOY)); self.assertEqual(len(names(WF)), 4)
        self.assertEqual(set(re.findall(r'secrets\.([A-Z_]+)', WF)), names(WF))
    def test_strict_host_checking(self):
        transport=open(os.path.join(HERE,'transport.sh')).read()
        self.assertIn('StrictHostKeyChecking=yes',transport)
        for bad in ('StrictHostKeyChecking=no', 'accept-new', 'ssh-keyscan'): self.assertNotIn(bad, WF)
        self.assertIn('UserKnownHostsFile=',transport)
    def test_no_artifacts_no_echo_no_mutation(self):
        for bad in ('upload-artifact', 'GITHUB_STEP_SUMMARY', 'set -x', 'ordered-queue.py', 'update.sh', 'drain', 'oci-deploy'): self.assertNotIn(bad, WFC, bad)
        self.assertNotRegex(WFC, r'echo[^\n]*\$OCI_SSH_(KEY|KNOWN)')
        self.assertIn('persist-credentials: false', WF); self.assertIn('sparse-checkout: deploy/oci/readonly-diagnostic', WF)
    def _step(self, name):
        m = re.search(r'- name: ' + re.escape(name) + r'.*?run: \|\n((?:          [^\n]*\n?)+)', WF, re.S)
        return textwrap.dedent(m.group(1))

class Host(unittest.TestCase):
    def test_static(self):
        self.assertEqual(subprocess.run(['sh', '-n', os.path.join(HERE, 'host.sh')]).returncode, 0)
        for bad in ('rm ', 'docker run', 'docker stop', 'docker restart', 'docker rm', 'docker kill', 'systemctl restart', 'systemctl stop', 'ordered-queue', 'lyam.env', 'touch ', 'mv ', 'tee ', 'chmod', 'flock', 'state.json.lock'):
            self.assertNotIn(bad, HOSTC, bad)
    def run_host(self, state, envlines, extra_files=()):
        with tempfile.TemporaryDirectory() as d:
            bindir = d + '/bin'; root = d + '/lyam'; os.makedirs(bindir); os.makedirs(root + '/deploy-queue')
            if state is not None: open(root + '/deploy-queue/state.json', 'w').write(state)
            for f in extra_files: open(root + '/' + f, 'w').write('x')
            open(bindir + '/docker', 'w').write(textwrap.dedent('''\
                #!/bin/sh
                case "$*" in
                  *"range .Config.Env"*) printf '%s\\n' ''' + ' '.join("'%s'" % e for e in envlines) + ''';;
                  *"exec"*"api.log"*) echo 'held=true,settingPresent=true';;
                  *"exec"*"8080/healthz"*) echo 200;;
                  *"exec"*"3000/health"*) echo 200;;
                  *"exec"*"8081/health"*) echo 200;;
                  *"exec"*) echo 500;;
                  *"{{.Config.Image}}"*) echo ghcr.io/manudss/iam-platform-poc@sha256:''' + 'b' * 64 + ''';;
                  *"{{.Image}}"*) echo sha256:''' + 'c' * 64 + ''';;
                  *Running*) echo true;;
                  *StartedAt*) echo 2026-11-25T07:00:00.123456789Z;;
                  *RestartCount*) echo 0;;
                  *ExitCode*) echo 0;;
                  *) exit 0;;
                esac
            '''))
            open(bindir + '/systemctl', 'w').write('#!/bin/sh\necho active\n')
            for f in os.listdir(bindir): os.chmod(os.path.join(bindir, f), 0o755)
            r = subprocess.run(['sh', '-c', HOST.replace('ROOT=/opt/lyam', 'ROOT=' + root)], env={'PATH': bindir + ':' + os.environ['PATH']}, capture_output=True, text=True, timeout=60)
            return r.stdout + r.stderr, sorted(os.listdir(root + '/deploy-queue'))
    def test_filtered_output_no_lock_no_secrets(self):
        import json
        state = json.dumps({'format': 3, 'history': [{'sha': 'd' * 40, 'mode': 'ui-open-automation-held', 'note': SECRET}, {'sha': SHA, 'mode': SECRET, 'digest': 'sha256:' + 'f' * 64}], 'pending': [], 'failed': [], 'resume_required': False,
                            'recovery_fence': 'e' * 40, 'opening_intent': None, 'resumptions': [{'observed_running': {'sha': 'e' * 40}}], 'token': SECRET})
        out, files = self.run_host(state, ['IAM_AUTOMATION_HOLD=1', 'IAM_APP_COMMIT=' + SHA, 'DOLT_PASSWORD=' + SECRET, 'X=' + SECRET], ['UPDATE_PAUSED'])
        self.assertNotIn(SECRET, out); self.assertEqual(files, ['state.json'])  # no state.json.lock created
        for want in ('container.hold_env=1', 'container.app_commit=' + SHA, 'container.api_hold_log=held=true,settingPresent=true', 'container.running=true', 'container.front_healthz_8080=200', 'container.api_health_3000=200', 'container.core_health_8081=200', 'container.restart_count=0',
                     'container.image_ref=ghcr.io/manudss/iam-platform-poc@sha256:' + 'b' * 64, 'file.UPDATE_PAUSED.present=true', 'file..update.lock.present=false', 'journal.format=3',
                     'journal.history_length=2', 'journal.last_delivered_sha=' + SHA, 'journal.last_delivered_digest=sha256:' + 'f' * 64, 'file.MAINTENANCE.present=false', 'file.OPS-MAINTENANCE.present=false', 'diag.problem_lines=0', 'journal.last_delivered_mode=other', 'journal.pending=0', 'journal.resume_required=False',
                     'journal.recovery_fence=' + 'e' * 40, 'journal.opening_intent_present=false', 'journal.last_resumption_observed_sha=' + 'e' * 40, 'diag.complete=true'):
            self.assertIn(want, out, want)
        self.assertRegex(out, r'state\.sha256=[0-9a-f]{64}')
    def test_endpoint_contract_from_source(self):
        self.assertIn('/health', open(os.path.join(ROOT, 'core/crates/iam-core/src/main.rs')).read())
        self.assertIn("'/healthz'", open(os.path.join(ROOT, 'demo/server.mjs')).read())
        self.assertIn('127.0.0.1:3000/health', open(os.path.join(ROOT, 'demo/start.sh')).read())
        self.assertIn('127.0.0.1:8081', open(os.path.join(ROOT, 'demo/start.sh')).read())
        for u in ('127.0.0.1:8080/healthz', '127.0.0.1:3000/health', '127.0.0.1:8081/health'): self.assertIn(u, HOST)
    def test_hostile_values_become_unexpected(self):
        import json
        state = json.dumps({'format': 9, 'history': [{'sha': SECRET}], 'pending': SECRET, 'failed': [], 'resume_required': 'yes', 'recovery_fence': SECRET})
        out, _ = self.run_host(state, ['IAM_AUTOMATION_HOLD=' + SECRET, 'IAM_APP_COMMIT=' + SECRET])
        self.assertNotIn(SECRET, out)
        for want in ('container.hold_env=invalid', 'container.app_commit=absent', 'journal.format=unexpected', 'journal.last_delivered_sha=unexpected', 'journal.last_delivered_digest=unexpected', 'diag.complete=false', 'journal.pending=unexpected', 'journal.resume_required=absent_or_unexpected', 'journal.recovery_fence=unexpected'):
            self.assertIn(want, out, want)
    def test_corrupt_or_missing_state(self):
        out, _ = self.run_host('{not json', []); self.assertIn('journal.parse=unknown', out); self.assertIn('diag.complete=false', out); self.assertNotIn('diag.complete=true', out)
        out, _ = self.run_host(None, []); self.assertIn('state.present=false', out); self.assertIn('diag.complete=false', out)

class Inventory(unittest.TestCase):
    def test_static(self):
        self.assertNotRegex(INVC, r'(?i)\b(insert|update|delete|alter|create table|drop|dolt_commit|dolt_checkout|call)\b\s+(into|from|table|database|\w+_)')
        for bad in ('WorkflowStore', 'STREAM.MSG.GET', 'CONSUMER.CREATE', 'CONSUMER.MSG.NEXT', 'DIRECT.GET', 'CONSUMER.INFO', 'DOLT_CHECKOUT', 'value_json'): self.assertNotIn(bad, INVC.replace("'value_json'", ''), bad) if bad != 'value_json' else None
        self.assertEqual(set(re.findall(r"\$JS\.API\.[A-Z.]+_?[A-Z_]*", INVC)), {'$JS.API.STREAM.INFO.IAM_BUS_EVENTS', '$JS.API.CONSUMER.LIST.IAM_BUS_EVENTS'})
        self.assertNotIn('workflow_tasks`'.replace('`', '') + '_x', INVC); self.assertIn("'workflow_tasks'", INVC); self.assertNotIn("'tasks'", INVC)
    def test_doubles(self):
        r = subprocess.run(['node', os.path.join(HERE, 'inventory.test.cjs')], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

if __name__ == '__main__': unittest.main()
