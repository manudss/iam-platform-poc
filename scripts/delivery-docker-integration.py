#!/usr/bin/env python3
"""Real candidate delivery against fixture-owned services. Never production.
The outer fixture owns creation and teardown. No source substitutions are allowed.
"""
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def run(args, check=True, **kwargs):
    result = subprocess.run(args, text=True, capture_output=True, timeout=1000, **kwargs)
    if check and result.returncode:
        raise RuntimeError('delivery-subprocess-failed')
    return result


def docker(*args):
    return run(['docker', *args]).stdout.strip()


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def health(app):
    for _ in range(120):
        if run(['docker', 'exec', app, 'node', '-e',
                "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], False).returncode == 0:
            return
        time.sleep(2)
    raise RuntimeError('candidate-edge-health-timeout')


def main():
    if os.geteuid() != 0 or os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        raise RuntimeError('disposable-runner-required')
    c = json.loads(Path(sys.argv[1]).read_text())
    root, out = Path(c['root']), Path(c['out'])
    source = Path(__file__).resolve().parents[1]
    if not root.is_relative_to('/root') or not root.name.startswith('closed-ci-') or Path('/opt/lyam').exists():
        raise RuntimeError('fixture-root-required')
    owned = Path('/opt/lyam')
    owned.mkdir(mode=0o700)
    bindir = root / 'bin'
    bindir.mkdir(mode=0o700)
    for path in (source / 'deploy/oci').iterdir():
        if path.is_file():
            shutil.copyfile(path, bindir / path.name)
            (bindir / path.name).chmod(0o700)
    # These are the candidate's bytes, not incident branch replacements.
    inventory = {path.name: sha(path) for path in bindir.iterdir()}
    (out / 'candidate-script-hashes.json').write_text(json.dumps(inventory, indent=2))
    gates = root / 'gates'
    gates.mkdir(mode=0o755)
    tls = root / 'tls'
    tls.mkdir()
    cert, key = tls / 'cert.pem', tls / 'key.pem'
    run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key),
         '-out', str(cert), '-days', '1', '-subj', '/CN=delivery.localhost',
         '-addext', 'subjectAltName=DNS:delivery.localhost'])
    with open('/etc/hosts', 'a') as file:
        file.write('\n127.0.0.1 delivery.localhost\n')
    os.environ['SSL_CERT_FILE'] = str(cert)
    shutil.copyfile(cert, '/usr/local/share/ca-certificates/delivery-fixture.crt')
    run(['update-ca-certificates'])
    origin = 'https://delivery.localhost:18443'
    caddyfile = root / 'Caddyfile'
    caddyfile.write_text('''{
 admin off
 auto_https off
}
https://delivery.localhost:18443 {
 tls /tls/cert.pem /tls/key.pem
 @closed file {
 root /gates
 try_files /MAINTENANCE /OPS-MAINTENANCE
 }
 respond @closed "Maintenance" 503
 reverse_proxy 127.0.0.1:18089
}
''')
    caddy = root.name + '-caddy'
    result = {'format': 1, 'scenario': c['scenario'], 'passed': False,
              'sha': os.environ['DELIVERY_SHA'], 'digest': c['image'].split('@')[1],
              'checks': {}, 'evidence': {'scripts': sha(out / 'candidate-script-hashes.json')},
              'limitations': ['Synthetic data only', 'Not production qualification',
                              'No production availability or automatic rollback claim',
                              'Old data is a fresh fictional seed under historical image, not production-migrated data',
                              'Normal delivery uses synthetic format1 queue; guarded formats2/3 are refusal-only',
                              'UI document check is not a visual desktop/mobile review',
                              'Bao durable cold backup readback is checked; semantic fresh-stack restore remains unproved']}
    stage = 'tls-front'
    try:
        docker('run', '-d', '--name', caddy, '--network', 'host',
               '-v', str(caddyfile) + ':/etc/caddy/Caddyfile:ro',
               '-v', str(tls) + ':/tls:ro', '-v', str(gates) + ':/gates:ro', 'caddy:2.10.2-alpine')
        env = Path(c['env'])
        settings = dict(line.split('=', 1) for line in env.read_text().splitlines() if '=' in line)
        settings.update({'IAM_PUBLIC_ORIGIN': origin, 'LYAM_CONTAINER': c['app'],
                         'LYAM_DATA_DIR': c['data'], 'LYAM_BACKUP_DIR': str(root / 'backups'),
                         'LYAM_PORT': '18089', 'LYAM_LOCK_FILE': str(root / 'update.lock'),
                         'LYAM_PAUSE_FILE': str(root / 'PAUSE'),
                         'LYAM_FRONT_BARRIER_FILE': str(gates / 'MAINTENANCE'),
                         'LYAM_OPS_BARRIER_FILE': str(gates / 'OPS-MAINTENANCE'),
                         'LYAM_POST_UPDATE_CHECK': str(bindir / 'qualification.py'),
                         'LYAM_BACKUP_PG_CONTAINER': c['pg'],
                         'LYAM_COMPOSE_FILE': str(source / 'deploy/oci/companions/docker-compose.yml'),
                         'LYAM_COMPOSE_ENV_FILE': str(root / 'companions.env'),
                         'LYAM_STACK_FILES': str(caddyfile) + ' ' + str(bindir / 'host-boot.sh')})
        unseal = root / 'bao-unseal.py'
        unseal.write_text('''import json,subprocess,sys
from pathlib import Path
value=json.loads(Path(sys.argv[1]).read_text())
r=subprocess.run(['docker','exec','-e','BAO_ADDR=http://127.0.0.1:8200',sys.argv[2],'bao','operator','unseal',value['unseal_keys_b64'][0]],capture_output=True)
raise SystemExit(r.returncode)
''')
        settings.update({'LYAM_BACKUP_BAO_DIR':str(root/'bao-storage'),
                         'LYAM_BACKUP_BAO_CONTAINER':c['bao'],
                         'LYAM_BACKUP_BAO_KEYS_DIR':str(root/'bao-keys'),
                         'LYAM_BAO_CONFIG_FILE':str(source/'deploy/oci/companions/bao.hcl'),
                         'LYAM_BAO_POLICY_FILE':str(source/'deploy/oci/companions/bao-policy.hcl'),
                         'LYAM_BAO_UNSEAL_CMD':'python3 '+str(unseal)+' '+str(root/'bao-keys/init.json')+' '+c['bao']})
        # Include actual companion definitions, not invented empty placeholder files.
        (root / 'companions.env').write_text('PG_PASSWORD=synthetic-ci-only\n')
        (root / 'companions.env').chmod(0o600)
        token = root / 'bao-token'
        token.write_text(settings['IAM_BAO_TOKEN'])
        token.chmod(0o600)
        docker('exec', '-e', 'BAO_ADDR=http://127.0.0.1:8200', '-e', 'BAO_TOKEN=' + settings['IAM_BAO_TOKEN'],
               c['bao'], 'bao', 'kv', 'put', 'secret/iam/delivery-contract', 'value=synthetic')
        auth = root / 'auth.json'
        auth.write_text(json.dumps({'username': 'demo-alice', 'password': 'demo-only-not-a-secret'}))
        auth.chmod(0o600)
        configpath = Path(c['config'])
        config = json.loads(configpath.read_text())
        policy = {'format': 1, 'origins': [origin], 'issuer': origin + '/core', 'tenant': 'acme-demo',
                  'network': c['network'], 'pgContainer': c['pg'], 'pgUser': 'lyam', 'pgDatabase': 'lyam',
                  'baoAddress': 'http://' + config['baoIP'] + ':8200', 'baoTokenFile': str(token),
                  'baoMetadataRoots': ['secret/metadata/iam'], 'authFile': str(auth),
                  'credentialFiles': ['core-state/credentials.json', 'core-state/iam-poc-account-blocks.json',
                                      'core-state/iam-poc-authn-enrollments.json', 'core-state/iam-poc-password-history.json'],
                  'appendOnlyTables': ['public.activations', 'public.decision_audit'], 'transformationVerifiers': {}}
        pol = owned / 'qualification.json'
        pol.write_text(json.dumps(policy))
        pol.chmod(0o600)
        env.write_text(''.join(k + '=' + v + '\n' for k, v in settings.items()))
        # Reconfigure the running fresh image, or start the actual old image on its original volume.
        docker('rm', '-f', c['app'])
        current = c.get('baselineImage') or c['image']
        docker('run', '-d', '--name', c['app'], '--network', c['network'], '--restart', 'no',
               '-p', '127.0.0.1:18089:8080', '-v', c['data'] + ':/data', '--env-file', str(env),
               '-e', 'IAM_DEMO_SEED_MODE=never', current)
        health(c['app'])
        # Ensure TLS is genuinely verified, with no ignore-certificate option.
        for _ in range(30):
            try:
                if urllib.request.urlopen(origin + '/healthz', timeout=5).status == 200:
                    break
            except Exception:
                time.sleep(1)
        else:
            raise RuntimeError('trusted-tls-front-not-ready')
        stage = 'real-prebaseline-smoke'
        # Real public journal read and auth may initialize schema. Warm before a cold baseline.
        warm = run(['docker', 'exec', '-i', c['app'], 'node', '--input-type=module', '-e',
                    (bindir / 'qualification-container.mjs').read_text(), 'smoke'], False,
                   input=json.dumps({**policy, 'auth': json.loads(auth.read_text())}))
        result['prebaselineSmokeExit'] = warm.returncode
        # Fixed known source literals become bounded enum diagnostics, never raw output.
        smoke_reasons={'journal schema invalid':'journal-contract-mismatch',
                       'real OIDC login failed':'oidc-login-refused',
                       'migration ledger incomplete':'migration-ledger-incomplete',
                       'workflow state changed during held smoke':'held-workflow-state-changed',
                       'expected origin/form refused':'oidc-form-refused'}
        matches=[code for literal,code in smoke_reasons.items() if literal in warm.stderr]
        result['prebaselineSmokeReason']=matches[-1] if matches else 'unclassified'

        if warm.returncode:
            raise RuntimeError('candidate-qualifier-smoke-refused')
        if c['scenario'] == 'fresh':
            result['checks'].update(boot=True, migrationLedger=True, oidc=True)
            stage = 'fresh-ui'
            ui = run(['docker', 'exec', c['app'], 'node', '-e',
                      "fetch('http://127.0.0.1:8080/login').then(async r=>{const t=await r.text();if(r.status!==200||!t.includes('<app-root'))process.exit(1)})"], False)
            if ui.returncode:
                raise RuntimeError('candidate-ui-document-refused')
            result['checks']['uiDocument'] = True
        else:
            stage = 'real-ordered-queue-update'
            queue = root / 'queue.json'
            base = json.loads(docker('image','inspect',current))[0]['Config']['Labels']['org.opencontainers.image.revision']
            if len(base)!=40:raise RuntimeError('baseline-source-label-invalid')
            candidate_parent=run(['git','-C',str(source),'rev-parse','HEAD^1']).stdout.strip()
            if candidate_parent!=base:raise RuntimeError('historical-baseline-is-not-candidate-first-parent-review-baseline')
            result['baselineSha']=base
            result['baselineDigest']=current.split('@')[1]
            state = {'format': 1, 'history': [{'sha': base, 'digest': current.split('@')[1]}]}
            queue.write_text(json.dumps(state))
            # Wrapper changes only the env-file argument, not the real updater or command semantics.
            wrapper = root / 'updater'
            wrapper.write_text('#!/bin/sh\nexec sh ' + str(bindir / 'update.sh') + ' --env-file ' + str(env) + ' "$@"\n')
            wrapper.chmod(0o700)
            plan = {'format': 1, 'base': base, 'entries': [{'sha': result['sha'], 'parent': base, 'digest': result['digest']}]}
            # Preserve production-style barriers as refusal scenarios. Never strip
            # a pause/resume fence from an active queue to make deployment proceed.
            qmodule=load_module(bindir/'ordered-queue.py','guarded_candidate_queue')
            guarded=root/'guarded-queue.json'
            guarded_state={'format':2,'history':state['history'],
                           'recovery_fence':base,'resume_required':True,
                           'recoveries':[{'target':{'sha':base}}]}
            guarded.write_text(json.dumps(guarded_state))
            if qmodule.load(guarded)!=guarded_state:raise RuntimeError('guard-fixture-invalid')
            original=guarded.read_bytes();attempted=[];refusal=None
            try:qmodule.deploy(guarded,plan,str(wrapper),runner=lambda *a,**k:attempted.append(True))
            except ValueError as error:refusal=str(error)
            if refusal!='prior deployment unresolved, operator review required':raise RuntimeError('wrong-queue-guard-refusal')
            if attempted or guarded.read_bytes()!=original:raise RuntimeError('guarded-queue-mutated')
            unsupported=root/'unsupported-queue.json'
            unsupported.write_text(json.dumps({**guarded_state,'format':3}))
            try:qmodule.load(unsupported)
            except ValueError as error:
                if str(error)!='uninitialized or corrupt deployment history':raise
            else:raise RuntimeError('format3-support-needs-explicit-scenario')
            pause=root/'PAUSE';pause.write_text('synthetic-guard\n')
            paused=run(['python3',str(bindir/'ordered-queue.py'),'drain','--state',str(queue),'--pause-file',str(pause),'--updater',str(wrapper)],False,input=json.dumps(plan))
            if paused.returncode==0 or 'deployment paused; no pending entry written' not in paused.stderr or json.loads(queue.read_text())!=state:raise RuntimeError('paused-queue-was-not-refused')
            pause.unlink() # Fixture-owned pause scenario finished; normal scenario has separate state.
            result['checks']['guardedQueueRefusal']=True
            result['guardedQueueCoverage']={'format2ResumeRequiredRefusal':refusal,'format3Status':'unsupported-format-rejected-not-resume-proof','pauseExit':paused.returncode,'queueUnchanged':json.loads(queue.read_text())==state,'productionStateNotReplayed':True}
            q = run(['python3', str(bindir / 'ordered-queue.py'), 'drain', '--state', str(queue),
                     '--pause-file', str(root / 'PAUSE'), '--updater', str(wrapper)], False, input=json.dumps(plan))
            result['queueExit'] = q.returncode
            result['evidence']['queueState'] = sha(queue)
            if q.returncode:
                raise RuntimeError('real-queue-update-refused')
            delivered = json.loads(queue.read_text())
            if delivered['history'][-1]['sha'] != result['sha'] or delivered.get('pending') or delivered.get('failed'):
                raise RuntimeError('queue-delivery-not-confirmed')
            stage='measure-real-qualification-evidence'
            qualification_dirs=list((root/'backups').glob('qualification-*'))
            if len(qualification_dirs)!=1:raise RuntimeError('exact-qualification-evidence-required')
            evidence_dir=qualification_dirs[0]
            before=json.loads((evidence_dir/'before.json').read_text())
            after_paths=list(evidence_dir.glob('after-*'));smoke_paths=list(evidence_dir.glob('smoke-*'))
            if len(after_paths)!=1 or len(smoke_paths)!=1:raise RuntimeError('missing-final-qualification-evidence')
            after=json.loads(after_paths[0].read_text());smoke=json.loads(smoke_paths[0].read_text())
            qualifier=load_module(bindir/'qualification.py','candidate_qualifier')
            changes=qualifier.compare(before,after,policy)
            if changes:raise RuntimeError('measured-preservation-diff')
            if not after.get('migrationLedger') or not smoke:raise RuntimeError('missing-ledger-or-smoke-proof')
            if urllib.request.urlopen(origin+'/healthz',timeout=10).status!=200 or (gates/'MAINTENANCE').exists():raise RuntimeError('measured-final-front-not-open')
            result['measurements']={'preservationChanges':changes,'beforeSHA256':sha(evidence_dir/'before.json'),
                                    'afterSHA256':sha(after_paths[0]),'smokeSHA256':sha(smoke_paths[0]),
                                    'publicTLSFinalStatus':200,'maintenanceAbsent':True,
                                    'actualRunningImage':json.loads(docker('inspect',c['app']))[0]['Config']['Image']}
            if result['measurements']['actualRunningImage']!=c['image']:raise RuntimeError('final-running-image-mismatch')
            result['checks'].update(realUpdater=True, realQueue=True, preservation=True, migrationLedger=True, oidc=True, gate=True)
            stage = 'real-backup-readback'
            backups=root/'backups'
            archives={kind:sorted(backups.glob(pattern)) for kind,pattern in [('data','lyam-data-*.tar.gz'),('bao','lyam-bao-*.tar.gz'),('recovery','lyam-recovery-*.tar.gz'),('pg','lyam-pg-*.sql.gz')]}
            if any(not paths for paths in archives.values()):raise RuntimeError('backup-kind-missing')
            import gzip,tarfile
            for kind,paths in archives.items():
                for archive in paths:
                    if kind=='pg':
                        with gzip.open(archive,'rb') as stream:
                            while stream.read(1024*1024):pass
                    else:
                        with tarfile.open(archive,'r:gz') as tar:
                            if not tar.getmembers():raise RuntimeError('empty-backup-archive')
                            for member in tar:
                                if member.isfile():
                                    with tar.extractfile(member) as stream:
                                        while stream.read(1024*1024):pass
                    result['evidence']['backup-'+kind]=sha(archive)
            result['checks']['backupReadback']=True
            stage = 'real-closed-updater-receipt'
            (root / 'PAUSE').touch()
            (gates / 'OPS-MAINTENANCE').write_text('synthetic-ops\n')
            policy['requireAutomationHold'] = True
            pol.write_text(json.dumps(policy))
            config['ledgerSHA256']=sha(Path(c['data'])/'migrations/journal.json')
            config['controllerSHA256'] = {n: sha(bindir / n) for n in ['update.sh', 'closed-recovery-integrity.py', 'closed-recovery-call.py']}
            config['qualificationSHA256'] = {str(p): sha(p) for p in [bindir / 'qualification.py', bindir / 'qualification-container.mjs', pol]}
            configpath.write_text(json.dumps(config))
            receipt = root / 'closed.receipt'
            closed = run(['python3', str(bindir / 'closed-recovery-call.py'), '--updater', str(bindir / 'update.sh'),
                          '--image', c['image'], '--env-file', str(env), '--receipt', str(receipt)], False)
            result['closedCallerExit'] = closed.returncode
            if receipt.exists():
                result['evidence']['actualUpdaterReceipt'] = sha(receipt)
                # Synthetic hashes only, but keep raw receipt private; the artifact records hash + multiplicities.
                names = [line.partition('=')[0] for line in receipt.read_text().splitlines()]
                result['receiptKeyCounts'] = {k: names.count(k) for k in set(names)}
            if closed.returncode != 10:
                raise RuntimeError('real-closed-updater-refused')
            result['checks']['realReceipt'] = True
            # Incident opening is not a requirement for normal candidate delivery.
            # Record applicability independently rather than require an absent draft file.
            consumer = bindir / 'reviewed-ui-held.py'
            result['incidentReceiptConsumer'] = {'applicable':consumer.is_file()}
            if consumer.is_file():
                parser = load_module(consumer, 'candidate_receipt_consumer')
                parser.receipt_fields(receipt.read_text())
                result['incidentReceiptConsumer']['passed']=True
        result['passed'] = True
    except Exception as error:
        result['stage'] = stage
        # Only our fixed errors, not external stderr, paths, tokens, or environment.
        result['errorType'] = type(error).__name__
        if str(error) in {'candidate-qualifier-smoke-refused', 'candidate-receipt-consumer-absent',
                          'real-closed-updater-refused', 'real-queue-update-refused', 'candidate-ui-document-refused'}:
            result['reason'] = str(error)
        raise
    finally:
        stopped = run(['docker', 'rm', '-f', caddy], False)
        result['frontCleanup'] = stopped.returncode == 0
        if stopped.returncode != 0:
            result['passed'] = False
        (out / 'delivery-intermediate.json').write_text(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
