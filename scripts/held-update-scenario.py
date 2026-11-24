#!/usr/bin/env python3
"""Held-update CI scenario. ROOT, disposable GitHub-hosted runner only; invoked by delivery-docker-integration.py when the
delivery scenario is 'held-update'. Synthetic data only, no production. Real: update.sh --closed-recovery, closed helper
launcher, Docker, Caddy/TLS front, ordered-queue CLI, held-update-host.py, reviewed-ui-held.py controller, durable
worker/watchdog processes, SIGKILL. NOT real here: systemd units (the same worker/watchdog code runs as plain processes with
REQUIRE_UNITS=False, set only inside this harness), distinct PRODUCT migrations (four fixture versions prove chain mechanics).
Evidence is bounded: statuses, phases, hashes, exit codes. No env, secrets or raw logs leave."""
import fcntl, hashlib, json, os, shutil, signal, subprocess, sys, threading, time, urllib.request, urllib.error
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

    # Every fixture image is derived from the same product bytes. Verify that explicitly;
    # this harness does not claim migration history between different product versions.
    target_configs={}
    for i,img in enumerate(images):
        ref='ghcr.io/manudss/iam-platform-poc@'+img['digest']
        image=json.loads(docker('image','inspect',ref))[0]
        cid=docker('create','--network','none','--entrypoint','/bin/true',ref)
        try:
            hashes={}
            for n,path in enumerate(['/app/migration-source/data/migrations/manifest.json',*config['offlineFileSHA256']]):
                dest=root/('step-inventory-%d-%d'%(i,n));docker('cp',cid+':'+path,str(dest));hashes[path]=sh256(dest)
            if hashes['/app/migration-source/data/migrations/manifest.json']!=config['manifestSHA256'] or any(hashes[k]!=v for k,v in config['offlineFileSHA256'].items()):
                raise RuntimeError('fixture-product-bytes-not-identical')
        finally:docker('rm',cid)
        target_configs[i]={'image':ref,'imageID':image['Id'],'manifestSHA256':hashes['/app/migration-source/data/migrations/manifest.json'],'offlineFileSHA256':{k:hashes[k] for k in config['offlineFileSHA256']}}

    def arm_config(i=0):
        policy['requireAutomationHold'] = True; pol.write_text(json.dumps(policy))
        config.update(target_configs[i])
        config['ledgerSHA256'] = sh256(Path(c['data']) / 'migrations/journal.json')
        config['controllerSHA256'] = {n: sh256(bindir / n) for n in ['update.sh', 'closed-recovery-integrity.py', 'closed-recovery-call.py']}
        config['qualificationSHA256'] = {str(p): sh256(p) for p in [bindir / 'qualification.py', bindir / 'qualification-container.mjs', pol]}
        configpath.write_text(json.dumps(config))

    def unseal_bao():
        for attempt in range(30):
            r=runp(['python3',str(root/'bao-unseal.py'),str(root/'bao-keys/init.json'),c['bao']],False)
            if r.returncode==0:return
            time.sleep(1)
        raise RuntimeError('fixture-bao-unseal-timeout')

    # ---- pristine copy of the cold baseline dataset, then every scenario restarts from it (never reused across scenarios)
    docker('stop', app)
    # Quiescent synthetic checkpoint of all three stores, never only a data-dir copy.
    pristine = root / 'data-pristine'; runp(['cp', '-a', c['data'], str(pristine)])
    pg_dump=root/'pristine-pg.sql'
    with pg_dump.open('wb') as f:
        subprocess.run(['docker','exec',c['pg'],'pg_dump','-U','lyam','-d','lyam','--clean','--if-exists'],stdout=f,stderr=subprocess.PIPE,check=True)
    pg_dump.chmod(0o600)
    docker('stop',c['bao']); bao_pristine=root/'bao-pristine'
    runp(['cp','-a',str(root/'bao-storage'),str(bao_pristine)])
    docker('start',c['bao'])
    unseal_bao()
    report['checkpoint']={'stores':['data','postgres','bao'],'appStopped':True,'baoColdCopy':True,'pgDumpSHA256':sh256(pg_dump)}
    def reset_baseline():
        runp(['docker', 'rm', '-f', app], False)
        for g in [gates / 'MAINTENANCE', gates / 'OPS-MAINTENANCE']: g.unlink(missing_ok=True)
        shutil.rmtree(c['data'], ignore_errors=True); runp(['cp', '-a', str(pristine), c['data']])
        with pg_dump.open('rb') as f:
            subprocess.run(['docker','exec','-i',c['pg'],'psql','-X','-U','lyam','-d','lyam','-v','ON_ERROR_STOP=1'],stdin=f,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True)
        docker('stop',c['bao'])
        # Keep the mounted directory inode. Replacing it would leave Docker bound to deleted storage.
        for child in (root/'bao-storage').iterdir():
            if child.is_dir() and not child.is_symlink():shutil.rmtree(child)
            else:child.unlink()
        runp(['cp','-a',str(bao_pristine)+'/.',str(root/'bao-storage')]);docker('start',c['bao'])
        unseal_bao()
        shutil.rmtree(root / 'backups', ignore_errors=True); shutil.rmtree(queue_dir, ignore_errors=True); queue_dir.mkdir(mode=0o700)
        pause.write_text('harness pause\n'); lock.write_text(''); arm_config()
        runp([str(wrappers['preflight']), *args]); runp([str(wrappers['launcher']), *args])
        x['health'](app)
    reset_baseline()

    # ---- 1. REAL pre-qualification of each successor image on an isolated copy (never a fabricated JSON)
    def prequalify(i):
        img = images[i]; ref = 'ghcr.io/manudss/iam-platform-poc@' + img['digest']
        reset_baseline(); arm_config(i); (gates / 'OPS-MAINTENANCE').write_text('synthetic-ops-prequal\n')
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
        configs=[]
        for i in range(1,n+1):
            cp=root/('reviewed-step-%d.json'%i)
            cp.write_text(json.dumps({**config,**target_configs[i]}));cp.chmod(0o600)
            configs.append({'path':str(cp),'sha256':sh256(cp),**{k:target_configs[i][k] for k in ['imageID','manifestSHA256','offlineFileSHA256']}})
        manifest['step_configs']={'install_to':str(configpath),'steps':configs}
        return manifest, chain

    def supervise(name, n, kill_phase=None, kill_mode='group'):
        manifest, chain = build(n); folder = root / ('sup-' + name); shutil.rmtree(folder, ignore_errors=True); folder.mkdir(mode=0o700)
        engagement='held-' + name + '-' + os.environ.get('GITHUB_RUN_ID', '0')
        manifest['engagement_id']=engagement
        if kill_phase:
            hd=folder/'hooks';hd.mkdir(mode=0o700)
            sent=hd/'ISOLATED_HARNESS';sent.write_text(hashlib.sha256(('%s\n%s'%(state_path.absolute(),engagement)).encode()).hexdigest());sent.chmod(0o600)
            manifest['phase_hook']={'dir':str(hd),'phases':[kill_phase],'timeout':120}
        mp = folder / 'manifest.json'; mp.write_text(json.dumps(manifest)); mp.chmod(0o600)
        du_path = bindir / 'held-update-durable.py'; py = os.path.realpath(sys.executable)
        spec = {'kind': 'reviewed-held-update-supervision', 'engagement_id': engagement, 'queue': str(bindir / 'ordered-queue.py'), 'state': str(state_path), 'pause': str(pause), 'lock': str(lock),
                'repository': repo, 'container': app, 'updater': str(bindir / 'update.sh'), 'manifest': str(mp), 'python': py, 'target_sha': chain[-1]['sha'], 'target_digest': chain[-1]['digest'], 'self': str(du_path),
                'fileSHA256': {p: sh256(p) for p in [str(bindir / 'ordered-queue.py'), str(bindir / 'update.sh'), str(mp), py, str(du_path)]}}
        (folder / 'supervision-spec.json').write_text(json.dumps(spec)); os.chmod(folder / 'supervision-spec.json', 0o600)
        def unit(role):
            code = "import sys,importlib.util;s=importlib.util.spec_from_file_location('du',%r);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.REQUIRE_UNITS=False;sys.exit(m.main(['%s','--folder',%r,'--poll','2']))" % (str(du_path), role, str(folder))
            return subprocess.Popen([py, '-c', code], stdout=open(folder / (role + '.launcher.log'), 'xb'), stderr=subprocess.STDOUT)
        sampler = Sampler(origin); sampler.start()
        wd = unit('watchdog'); wk = unit('worker')
        t0 = time.monotonic()
        while not (folder / 'WATCH_READY').exists() or not (folder / 'worker-identity.json').exists():
            if time.monotonic() - t0 > 120: raise RuntimeError('supervision-not-ready')
            time.sleep(0.2)
        (folder / 'GO').write_text('operator-go-harness\n')
        closed_seen = None; opening_seen = None; killed = None; deadline = time.monotonic() + 3000
        while time.monotonic() < deadline and not (folder / 'watchdog-result.json').exists():
            try: st = jread(state_path); ph = (st.get('opening_intent') or {}).get('phase')
            except Exception: ph = None
            if closed_seen is None and (gates/'OPS-MAINTENANCE').is_file():
                try: urllib.request.urlopen(origin+'/healthz',timeout=3)
                except urllib.error.HTTPError as e:
                    if e.code==503:closed_seen=time.monotonic()
            if ph == 'opening' and opening_seen is None: opening_seen = time.monotonic()
            if kill_phase and ph == kill_phase and killed is None and (folder/'hooks'/(kill_phase+'.reached')).is_file() and (folder / 'queue-identity.json').exists():
                qi = jread(folder / 'queue-identity.json')
                marker=jread(folder/'hooks'/(kill_phase+'.reached'))
                if marker.get('pid')!=qi['pid'] or marker.get('phase')!=kill_phase or marker.get('engagement_id')!=engagement or not marker.get('nonce'):raise RuntimeError('phase-marker-identity-mismatch')
                if kill_mode=='orphan':
                    uc=st['opening_intent'].get('updater_child') or {};ident=uc.get('identity') or {}
                    du=load_module(du_path,'orphan_measure')
                    if du.state_of(ident)!='alive' or uc.get('measured',{}).get('fd8_is_lock') is not True:raise RuntimeError('orphan-child-not-measured-live-locked')
                    def require_live_locked():
                        if du.state_of(ident)!='alive':raise RuntimeError('orphan-child-ended-before-kill')
                        with lock.open('a') as fd:
                            try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                            except BlockingIOError:return
                        raise RuntimeError('orphan-lock-not-held')
                    require_live_locked()
                    # Fixture-only SIGSTOP makes this injection deterministic. It is not natural-crash timing evidence.
                    os.kill(ident['pid'],signal.SIGSTOP)
                    try:
                        require_live_locked()
                        os.kill(qi['pid'],signal.SIGKILL);killed=ph;time.sleep(.3)
                        before=state_path.read_bytes()
                        require_live_locked()
                        with lock.open('a') as lf:
                            try:fcntl.flock(lf,fcntl.LOCK_EX|fcntl.LOCK_NB)
                            except BlockingIOError:pass
                            else:raise RuntimeError('orphan-lock-not-held')
                        cmd=[py,str(bindir/'ordered-queue.py'),'rearm-held-update','--state',str(state_path),'--pause-file',str(pause),'--update-lock',str(lock)]
                        refused=runp(cmd,False)
                        if refused.returncode==0 or state_path.read_bytes()!=before:raise RuntimeError('orphan-rearm-not-refused-unchanged')
                        end=time.monotonic()+15;observed=False
                        while time.monotonic()<end:
                            events=folder/'watchdog-events.jsonl'
                            if events.is_file() and any(jread_line.get('action')=='orphan-updater-alive-observe' for jread_line in [json.loads(line) for line in events.read_text().splitlines()]):observed=True;break
                            time.sleep(.2)
                        require_live_locked()
                        if not observed or (folder/'rearm-attempt.json').exists():raise RuntimeError('orphan-watchdog-did-not-observe-only')
                        (folder/'STOP_WATCHDOG').write_text('fixture end orphan observation\n')
                        wd.wait(timeout=10)
                        rec={'childAliveMeasured':True,'fd8LockIdentity':True,'lockContentionMeasured':True,'rearmExit':refused.returncode,'stateUnchanged':True,'watchdogObserveOnly':True,'injection':'real-updater-SIGSTOP-then-queue-SIGKILL'}
                        (ev/('scenario-%s.json'%name)).write_text(json.dumps(rec,indent=2));report['scenarios'][name]=rec
                    finally:
                        if du.state_of(ident)=='alive':os.kill(ident['pid'],signal.SIGCONT)
                    wk.wait(timeout=120)
                    end=time.monotonic()+1000
                    while du.state_of(ident)=='alive' and time.monotonic()<end:time.sleep(.2)
                    if du.state_of(ident)!='absent':raise RuntimeError('orphan-child-not-finished')
                    sampler.stop.set();sampler.join(5)
                    return
                (os.killpg if kill_mode == 'group' else os.kill)(qi['pid'], signal.SIGKILL); killed = ph
            time.sleep(0.1)
        for p in (wk, wd):
            try: p.wait(timeout=120)
            except subprocess.TimeoutExpired: p.kill(); raise RuntimeError('supervision-process-did-not-exit')
        sampler.stop.set(); sampler.join(5)
        wres = jread(folder / 'watchdog-result.json'); st = jread(state_path)
        persisted_steps=(st.get('opening_intent') or {}).get('steps')
        if persisted_steps is None:
            matches=[r for r in st.get('recoveries',[]) if r.get('manifest',{}).get('engagement_id')==engagement]
            persisted_steps=matches[-1].get('steps',[]) if matches else []
        for i,step in enumerate(persisted_steps):
            if step.get('receipt',{}).get('config_sha256')!=manifest['step_configs']['steps'][i]['sha256']:
                raise RuntimeError('actual-helper-receipt-config-binding-mismatch')
        rec = {'watchdog': {k: wres.get(k) for k in ['action', 'needs_operator']}, 'killed_at_phase': killed, 'statuses': sampler.statuses(), 'worker_exit': jread(folder / 'worker-result.json')['exit'] if (folder / 'worker-result.json').exists() else None}
        report.setdefault('initialStatuses',{})[name]=sorted({v for t,v in sampler.rows if closed_seen is None or t<closed_seen})
        first200 = next((t for t,status in sampler.rows if closed_seen is not None and t>=closed_seen and status==200),None)
        if closed_seen is None:raise RuntimeError('closure-marker-not-proved')
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
                if kill_mode!='queue':raise RuntimeError('required-recovery-not-measured')
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
    supervise('one-orphan-updater', 1, 'closed-step-0-updater-spawned', 'orphan')
    if not any(v.get('rearm')=='measured-closed' for v in report['scenarios'].values()):raise RuntimeError('no-measured-recovery')
    result['checks']['heldUpdateChain'] = True
