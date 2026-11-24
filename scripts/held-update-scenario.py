#!/usr/bin/env python3
"""Held-update CI scenario. ROOT, disposable GitHub-hosted runner only; invoked by delivery-docker-integration.py when the
delivery scenario is 'held-update'. Synthetic data only, no production. Real: update.sh --closed-recovery, closed helper
launcher, Docker, Caddy/TLS front, ordered-queue CLI, held-update-host.py, reviewed-ui-held.py controller, durable
worker/watchdog processes, SIGKILL. NOT real here: systemd units (the same worker/watchdog code runs as plain processes with
REQUIRE_UNITS=False, set only inside this harness), distinct PRODUCT migrations (four fixture versions prove chain mechanics).
Evidence is bounded: statuses, phases, hashes, exit codes. No env, secrets or raw logs leave."""
import hashlib, json, os, shutil, signal, subprocess, sys, threading, time, urllib.request, urllib.error
from pathlib import Path

def jread(p): return json.loads(Path(p).read_text())
def sh256(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()

class Sampler(threading.Thread):
    """Polls the public TLS origin; records (monotonic, status). No redirects, no proxies."""
    def __init__(self, origin):
        super().__init__(daemon=True); self.origin = origin; self.rows = []; self.stop = threading.Event()
    def run(self):
        class NR(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k): return None
        op = urllib.request.build_opener(urllib.request.ProxyHandler({}), NR)
        while not self.stop.is_set():
            try: s = op.open(self.origin + '/healthz', timeout=3).status
            except urllib.error.HTTPError as e: s = e.code
            except Exception: s = 0
            self.rows.append((time.monotonic(), s)); time.sleep(0.15)
    def first_200(self): return next((t for t, s in self.rows if s == 200), None)
    def statuses(self): return sorted({s for _, s in self.rows})

def run(x):
    c, root, out, bindir, gates, origin, env, source = (x[k] for k in ['c', 'root', 'out', 'bindir', 'gates', 'origin', 'env', 'source'])
    result, runp, docker, load_module = x['result'], x['run'], x['docker'], x['load_module']
    fx = jread(os.environ['HELD_FIXTURE_JSON']); images = fx['images']
    if len(images) != 4 or len({i['digest'] for i in images}) != 4 or len({i['sha'] for i in images}) != 4: raise RuntimeError('four distinct fixture images required')
    if not c['image'].endswith(images[0]['digest']): raise RuntimeError('baseline image must be fixture image 0')
    repo = fx['repo']; app = c['app']
    q = load_module(bindir / 'ordered-queue.py', 'held_queue')
    ev = out / 'held-update'; ev.mkdir(exist_ok=True); report = {'scenarios': {}, 'prequalification': {}}
    result['heldUpdate'] = report
    wrappers = {k: Path(v) for k, v in c['wrappers'].items()}
    args = ['--image', c['image'], '--container', app, '--env-file', str(env), '--data-dir', c['data'], '--port', '18089']
    pol, policy, configpath, config = x['pol'], x['policy'], x['configpath'], x['config']
    pause, lock = root / 'PAUSE', root / 'update.lock'
    queue_dir = root / 'queue'; state_path = queue_dir / 'state.json'

    def arm_config():
        policy['requireAutomationHold'] = True; pol.write_text(json.dumps(policy))
        config['ledgerSHA256'] = sh256(Path(c['data']) / 'migrations/journal.json')
        config['controllerSHA256'] = {n: sh256(bindir / n) for n in ['update.sh', 'closed-recovery-integrity.py', 'closed-recovery-call.py']}
        config['qualificationSHA256'] = {str(p): sh256(p) for p in [bindir / 'qualification.py', bindir / 'qualification-container.mjs', pol]}
        configpath.write_text(json.dumps(config))

    # ---- pristine copy of the cold baseline dataset, then every scenario restarts from it (never reused across scenarios)
    docker('stop', app); pristine = root / 'data-pristine'; runp(['cp', '-a', c['data'], str(pristine)])
    def reset_baseline():
        runp(['docker', 'rm', '-f', app], False)
        for g in [gates / 'MAINTENANCE', gates / 'OPS-MAINTENANCE']: g.unlink(missing_ok=True)
        shutil.rmtree(c['data'], ignore_errors=True); runp(['cp', '-a', str(pristine), c['data']])
        shutil.rmtree(root / 'backups', ignore_errors=True); shutil.rmtree(queue_dir, ignore_errors=True); queue_dir.mkdir(mode=0o700)
        pause.write_text('harness pause\n'); lock.write_text(''); arm_config()
        runp([str(wrappers['preflight']), *args]); runp([str(wrappers['launcher']), *args])
        x['health'](app)
    reset_baseline()

    # ---- 1. REAL pre-qualification of each successor image on an isolated copy (never a fabricated JSON)
    def prequalify(i):
        img = images[i]; ref = 'ghcr.io/manudss/iam-platform-poc@' + img['digest']
        reset_baseline(); (gates / 'OPS-MAINTENANCE').write_text('synthetic-ops-prequal\n')
        rec = ev / ('prequal-%d' % i); rec.mkdir(mode=0o700, exist_ok=True)
        receipt = root / ('prequal-%d.receipt' % i)
        r = runp(['python3', str(bindir / 'closed-recovery-call.py'), '--updater', str(bindir / 'update.sh'), '--image', ref, '--env-file', str(env), '--receipt', str(receipt)], False)
        if r.returncode != 10 or not receipt.exists(): raise RuntimeError('prequalification-updater-refused')
        wire = load_module(source / 'scripts/delivery-receipt.py', 'delivery_wire_contract')
        fields = wire.validate_actual_receipt(receipt.read_bytes())
        if fields.get('state') != 'CLOSED_QUALIFIED' or fields.get('image') != ref or fields.get('held') != 'true' or fields.get('public_status') != '503': raise RuntimeError('prequalification-receipt-mismatch')
        rows = {}
        for line in Path(fields['evidence_index']).read_text().splitlines():
            role, digest, path = line.split(' ', 2)
            if role in rows or sh256(path) != digest: raise RuntimeError('prequalification-index-mismatch')
            rows[role] = {'path': path, 'sha256': digest}
        if sh256(fields['evidence_index']) != fields['evidence_index_sha256'] or not {'before', 'after', 'smoke', 'backup-readback'} <= set(rows): raise RuntimeError('prequalification-index-incomplete')
        values = {k: jread(rows[k]['path']) for k in ['before', 'after', 'smoke']}
        policy_hash = sh256(pol)
        if values['after'].get('image') != ref or any(values[k].get('policyHash') != policy_hash or values[k].get('transportCoverage') != 'TLS_EXPECTED_ORIGINS' for k in ['before', 'after']): raise RuntimeError('prequalification-evidence-mismatch')
        qm = load_module(bindir / 'qualification.py', 'held_qualifier'); qm.policy_load(str(pol)); qm.exact_held_activations(values['before'], values['after'])
        if qm.compare(values['before'], values['after'], policy): raise RuntimeError('prequalification-preservation-changed')
        packed = {'format': 1, 'result': 'qualified', 'image': ref, 'transportCoverage': 'TLS_EXPECTED_ORIGINS', 'policyHash': policy_hash,
                  'before_sha256': rows['before']['sha256'], 'after_sha256': rows['after']['sha256'], 'smoke_sha256': rows['smoke']['sha256']}
        pp = rec / 'receipt.json'; fd = os.open(pp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f: json.dump(packed, f, sort_keys=True); f.flush(); os.fsync(f.fileno())
        # keep the three evidence files where verify_qualification_receipt reads them: copy beside the receipt, bytes identical
        qual = {'receipt': {'path': str(pp), 'sha256': sh256(pp)}}
        for k in ['before', 'after', 'smoke']:
            dst = rec / (k + '.json'); shutil.copyfile(rows[k]['path'], dst); os.chmod(dst, 0o600); qual[k] = {'path': str(dst), 'sha256': sh256(dst)}
        report['prequalification'][str(i)] = {'digest': img['digest'], 'updater_exit': r.returncode, 'receipt_sha256': sh256(pp), 'index_sha256': fields['evidence_index_sha256']}
        return qual
    qualifications = {i: prequalify(i) for i in (1, 2, 3)}
    # tamper / missing negatives on the real verifier
    bad = json.loads(json.dumps(qualifications[1])); tmp = ev / 'tampered-after.json'; shutil.copyfile(bad['after']['path'], tmp); tmp.write_text('{}'); bad['after']['path'] = str(tmp)
    try: q.verify_qualification_receipt(bad, {'digest': images[1]['digest']}); raise RuntimeError('tampered-qualification-accepted')
    except ValueError: pass
    try: q.verify_qualification_receipt({k: v for k, v in qualifications[1].items() if k != 'smoke'}, {'digest': images[1]['digest']}); raise RuntimeError('missing-qualification-accepted')
    except ValueError: pass

    # ---- 2. scenarios: 1 and 3 successors, clean and with SIGKILL at phases
    def build(n):
        reset_baseline(); base = {'sha': images[0]['sha'], 'digest': images[0]['digest']}
        state = {'format': 3, 'history': [{**base, 'mode': 'ui-open-automation-held', 'automation_held': True}], 'recovery_fence': base['sha'], 'resume_required': True, 'recoveries': [{'target': base}], 'opening_audits': []}
        q.atomic(state_path, state); (queue_dir / 'state.json.lock').touch()
        chain, parent = [], base['sha']
        for i in range(1, n + 1):
            chain.append({'sha': images[i]['sha'], 'parent': parent, 'digest': images[i]['digest'], 'qualification': qualifications[i]}); parent = images[i]['sha']
        env_spec = {'path': str(env), 'sha256': sh256(env)}
        static = {'env': env_spec, 'integrity': {'path': str(bindir / 'closed-recovery-integrity.py'), 'sha256': sh256(bindir / 'closed-recovery-integrity.py')},
                  'policy': {'path': str(pol), 'sha256': sh256(pol)}, 'qualifier': {'path': str(bindir / 'qualification.py'), 'sha256': sh256(bindir / 'qualification.py')}}
        receipts = root / 'held-receipts'; shutil.rmtree(receipts, ignore_errors=True); receipts.mkdir(mode=0o700)
        manifest = {'format': 1, 'kind': 'reviewed-held-update', 'state_fingerprint': q.fingerprint(state), 'expected_delivered': base,
                    'authorization_ref': 'ci-harness-synthetic-attestation-not-user-authority', 'evidence_refs': ['ci-harness-synthetic'], 'chain': chain, 'target': chain[-1],
                    'updater': {'path': str(bindir / 'update.sh'), 'sha256': sh256(bindir / 'update.sh')}, 'held_host': {'path': str(bindir / 'held-update-host.py'), 'sha256': sh256(bindir / 'held-update-host.py')},
                    'opening_static': static, 'receipt_dir': str(receipts), 'opening_controller': {'path': str(bindir / 'reviewed-ui-held.py'), 'sha256': sh256(bindir / 'reviewed-ui-held.py')}}
        return manifest, chain

    def supervise(name, n, kill_phase=None, kill_mode='group'):
        manifest, chain = build(n); folder = root / ('sup-' + name); shutil.rmtree(folder, ignore_errors=True); folder.mkdir(mode=0o700)
        mp = folder / 'manifest.json'; mp.write_text(json.dumps(manifest)); mp.chmod(0o600)
        du_path = bindir / 'held-update-durable.py'; py = os.path.realpath(sys.executable)
        spec = {'kind': 'reviewed-held-update-supervision', 'engagement_id': 'held-' + name + '-' + os.environ.get('GITHUB_RUN_ID', '0'), 'queue': str(bindir / 'ordered-queue.py'), 'state': str(state_path), 'pause': str(pause), 'lock': str(lock),
                'repository': repo, 'container': app, 'updater': str(bindir / 'update.sh'), 'manifest': str(mp), 'python': py, 'target_sha': chain[-1]['sha'], 'target_digest': chain[-1]['digest'], 'self': str(du_path),
                'fileSHA256': {p: sh256(p) for p in [str(bindir / 'ordered-queue.py'), str(bindir / 'update.sh'), str(mp), py, str(du_path)]}}
        (folder / 'supervision-spec.json').write_text(json.dumps(spec)); os.chmod(folder / 'supervision-spec.json', 0o600)
        def unit(role):
            code = "import sys,importlib.util;s=importlib.util.spec_from_file_location('du',%r);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.REQUIRE_UNITS=False;sys.exit(m.main(['%s','--folder',%r,'--poll','2']))" % (str(du_path), role, str(folder))
            return subprocess.Popen([py, '-c', code], stdout=open(folder / (role + '.log'), 'xb'), stderr=subprocess.STDOUT)
        sampler = Sampler(origin); sampler.start()
        wd = unit('watchdog'); wk = unit('worker')
        t0 = time.monotonic()
        while not (folder / 'WATCH_READY').exists() or not (folder / 'worker-identity.json').exists():
            if time.monotonic() - t0 > 120: raise RuntimeError('supervision-not-ready')
            time.sleep(0.2)
        (folder / 'GO').write_text('operator-go-harness\n')
        opening_seen = None; killed = None; deadline = time.monotonic() + 3000
        while time.monotonic() < deadline and not (folder / 'watchdog-result.json').exists():
            try: st = jread(state_path); ph = (st.get('opening_intent') or {}).get('phase')
            except Exception: ph = None
            if ph == 'opening' and opening_seen is None: opening_seen = time.monotonic()
            if kill_phase and ph == kill_phase and killed is None and (folder / 'queue-identity.json').exists():
                qi = jread(folder / 'queue-identity.json')
                (os.killpg if kill_mode == 'group' else os.kill)(qi['pid'], signal.SIGKILL); killed = ph
            time.sleep(0.1)
        for p in (wk, wd):
            try: p.wait(timeout=120)
            except subprocess.TimeoutExpired: p.kill(); raise RuntimeError('supervision-process-did-not-exit')
        sampler.stop.set(); sampler.join(5)
        wres = jread(folder / 'watchdog-result.json'); st = jread(state_path); rec = {'watchdog': {k: wres.get(k) for k in ['action', 'needs_operator']}, 'killed_at_phase': killed, 'statuses': sampler.statuses(), 'worker_exit': jread(folder / 'worker-result.json')['exit'] if (folder / 'worker-result.json').exists() else None}
        first200 = sampler.first_200()
        if kill_phase is None:
            if wres['action'] != 'completed' or st['history'][-1]['sha'] != chain[-1]['sha'] or opening_seen is None or first200 is None or first200 < opening_seen: raise RuntimeError('clean-run-contract-failed')
            if [h['mode'] for h in st['history'][-n:]] != ['closed-qualified-held'] * (n - 1) + ['ui-open-automation-held']: raise RuntimeError('history-modes-wrong')
            rec['zero_200_before_opening'] = True
        else:
            if killed is None: raise RuntimeError('kill-phase-never-reached')
            if first200 is not None and (opening_seen is None or first200 < opening_seen): raise RuntimeError('200-before-opening-after-kill')
            if st['history'][-1]['sha'] != manifest['expected_delivered']['sha'] or st['recovery_fence'] != manifest['expected_delivered']['sha']: raise RuntimeError('cursor-advanced-after-interruption')
            if wres['action'] not in ('interrupted-rearm-permitted',): raise RuntimeError('unexpected-watchdog-category')
            if wres['recovery']['exit'] != 0:
                rec['rearm'] = 'refused-report-only'
            else:
                rec['rearm'] = 'measured-closed'; s = None
                try: urllib.request.build_opener(urllib.request.ProxyHandler({})).open(origin + '/healthz', timeout=10)
                except urllib.error.HTTPError as e: s = e.code
                if s != 503: raise RuntimeError('origin-not-503-after-rearm')
        (ev / ('scenario-%s.json' % name)).write_text(json.dumps(rec, indent=2, sort_keys=True))
        report['scenarios'][name] = rec

    supervise('one-clean', 1)
    supervise('three-clean', 3)
    supervise('three-kill-closed-step-0-running', 3, 'closed-step-0-running')
    supervise('three-kill-closed-step-1-qualified', 3, 'closed-step-1-qualified')
    supervise('three-kill-opening', 3, 'opening')
    supervise('one-kill-queue-only-closed-step-0-running', 1, 'closed-step-0-running', 'queue')
    result['checks']['heldUpdateChain'] = True
