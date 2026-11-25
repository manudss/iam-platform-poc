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


COMMAND_FAILURE={}

def run(args, check=True, **kwargs):
    result = subprocess.run(args, text=True, capture_output=True, timeout=1000, **kwargs)
    if check and result.returncode:
        # Caller records only fixed command categories and numeric exit status.
        COMMAND_FAILURE.update(returnCode=result.returncode,role='docker' if args[0]=='docker' else 'other')
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


def verify_held_queue_refusals(qmodule,root,bindir,guarded_state,plan,wrapper):
    held=root/'held-queue.json'
    held_state=json.loads(json.dumps(guarded_state));held_state['format']=3
    held_state['history'][-1]['mode']='ui-open-automation-held'
    held.write_text(json.dumps(held_state));held_original=held.read_bytes()
    if qmodule.load(held)!=held_state:raise RuntimeError('held-fixture-invalid')
    attempted=[]
    try:qmodule.deploy(held,plan,str(wrapper),runner=lambda *a,**k:attempted.append(True))
    except ValueError as error:
        if str(error)!='prior deployment unresolved, operator review required':raise
    else:raise RuntimeError('held-deploy-not-refused')
    resume={'format':1,'kind':'reviewed-resume','state_fingerprint':qmodule.fingerprint(held_state),
            'expected_delivered':{k:held_state['history'][-1][k] for k in ['sha','digest']},
            'authorization_ref':'synthetic-refusal-only','evidence_refs':['synthetic-fixture']}
    try:qmodule.resume_reviewed(held,resume,'fixture',observe=lambda *a:attempted.append(True))
    except ValueError as error:
        if str(error)!='held UI is not full automation delivery; generic resume forbidden':raise
    else:raise RuntimeError('held-resume-not-refused')
    held_status=run(['python3',str(bindir/'ordered-queue.py'),'status','--state',str(held),'--pause-file',str(root/'absent-pause')],False)
    if held_status.returncode==0 or 'deployment queue blocked or paused' not in held_status.stderr:raise RuntimeError('held-status-not-refused')
    if attempted or held.read_bytes()!=held_original:raise RuntimeError('held-queue-mutated')
    unsupported=root/'unsupported-queue.json'
    unsupported.write_text(json.dumps({**guarded_state,'format':99}))
    try:qmodule.load(unsupported)
    except ValueError as error:
        if str(error)!='uninitialized or corrupt deployment history':raise
    else:raise RuntimeError('unknown-format-not-refused')
def queue_failure_diagnostic(stderr, state):
    # Fixed enums only. Never export stderr, paths, environment, SQL, or credentials.
    vocabulary = {
        'pre-update preservation capture failed': 'preservation-before-refused',
        'pre-update hook failed': 'pre-update-hook-refused',
        'front gate could not be proven': 'front-closure-not-proved',
        'another update is running': 'update-lock-busy',
        'does not support IAM_DEMO_SEED_MODE=never': 'seednever-label-missing',
        'no Dolt dataset': 'baseline-dataset-missing',
        'must be immutable': 'mutable-image-refused',
        'new version is healthy BUT': 'final-front-open-not-proved',
        'rolled back to': 'rolled-back',
        'post-update qualification failed': 'qualification-after-refused',
        'the pg dump is corrupt': 'pg-backup-corrupt',
        'the pg dump header is missing': 'pg-backup-header-missing',
        'pre-opening qualification failed': 'qualification-before-open-refused',
        'pg state capture failed': 'pg-state-capture-refused',
        'pg backup failed': 'pg-backup-refused',
        'data backup failed': 'data-backup-refused',
        'OpenBao did not become ready/unsealed': 'bao-readiness-refused',
        'bao backup failed': 'bao-backup-refused',
        'recovery bundle failed': 'recovery-bundle-refused',
        'preservation changed': 'preservation-diff',
        'expected origin/form refused': 'oidc-form-refused',
        'real OIDC login failed': 'oidc-login-refused',
        'journal schema invalid': 'journal-contract-mismatch',
    }
    markers=sorted({code for needle,code in vocabulary.items() if needle in stderr})
    # Bound numeric code from queue journal, not a parsed arbitrary external string.
    code=state.get('failed',{}).get('exit')
    diag=[]
    import re
    for raw in re.findall(r'^QUALIFICATION_DIAG_V1 (\{[^\n]{1,600}\})$',stderr,re.M):
        try:
            v=json.loads(raw)
            if set(v)=={'exceptionType','sourceLines'} and v['exceptionType'] in {'ValueError','RuntimeError','TimeoutExpired','FileNotFoundError','PermissionError','KeyError','TypeError','JSONDecodeError','Other'} and isinstance(v['sourceLines'],list) and len(v['sourceLines'])<=8 and all(type(n) is int and 0<n<1000000 for n in v['sourceLines']):diag.append(v)
        except (ValueError,TypeError):pass
    result={'updaterExit':code if type(code) is int else None,'categories':markers or ['unclassified']}
    if diag:result['qualificationDiagnostics']=diag[-4:]
    allowed={'dolt','bao','credentials','postgres-schema','postgres-tables','postgres-append-preservation','postgres-rows','postgres-sequences','postgres-sequence-rewind'}
    for raw in re.findall(r'^PRESERVATION_DIAG_V1 (\{[^\n]{1,600}\})$',stderr,re.M):
        try:
            v=json.loads(raw)
            if set(v)=={'categories'} and isinstance(v['categories'],list) and 0<len(v['categories'])<=len(allowed) and all(type(c) is str and c in allowed for c in v['categories']):result['preservationCategories']=sorted(set(v['categories']))
        except (ValueError,TypeError):pass
    refused=re.findall(r'^TRANSFORM_DIAG_V1 ([a-z][a-z-]{0,63})$',stderr,re.M)
    if refused:result['transformationRefusal']=refused[-1]
    for raw in re.findall(r'^DOLT_STATUS_DIAG_V1 (\{[^\n]{1,400}\})$',stderr,re.M)[-1:]:
        try:
            v=json.loads(raw)
            if set(v)=={'before','after'} and all(isinstance(v[k],list) and len(v[k])==20 and all(type(n) is int and 0<=n<=1000000 for n in v[k]) for k in v):result['doltStatusCounts']=v
        except (ValueError,TypeError):pass
    return result


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
                              'Browser screenshots require human pixel inspection before readiness',
                              'Bao durable cold backup readback is checked; semantic fresh-stack restore remains unproved']}
    stage = 'tls-front'
    try:
        docker('run', '-d', '--name', caddy, '--network', 'host',
               '-v', str(caddyfile) + ':/etc/caddy/Caddyfile:ro',
               '-v', str(tls) + ':/tls:ro', '-v', str(gates) + ':/gates:ro', 'caddy:2.10.2-alpine')
        stage='configure-synthetic-environment'
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
        # Reviewed companion evidence must live under protected installed ancestry, not the runner-owned checkout.
        companion_evidence=owned/'companion-evidence';companion_evidence.mkdir(mode=0o700)
        for name in ['bao.hcl','bao-policy.hcl']:
            src=source/'deploy/oci/companions'/name;dst=companion_evidence/name
            shutil.copyfile(src,dst);dst.chmod(0o600)
            if sha(src)!=sha(dst):raise RuntimeError('companion-evidence-copy-mismatch')
        settings.update({'LYAM_BACKUP_BAO_DIR':str(root/'bao-storage'),
                         'LYAM_BACKUP_BAO_CONTAINER':c['bao'],
                         'LYAM_BACKUP_BAO_KEYS_DIR':str(root/'bao-keys'),
                         'LYAM_BAO_CONFIG_FILE':str(companion_evidence/'bao.hcl'),
                         'LYAM_BAO_POLICY_FILE':str(companion_evidence/'bao-policy.hcl'),
                         'LYAM_BAO_UNSEAL_CMD':'python3 '+str(unseal)+' '+str(root/'bao-keys/init.json')+' '+c['bao']})
        # Include actual companion definitions, not invented empty placeholder files.
        (root / 'companions.env').write_text('PG_PASSWORD=synthetic-ci-only\n')
        (root / 'companions.env').chmod(0o600)
        token = root / 'bao-token'
        token.write_text(settings['IAM_BAO_TOKEN'])
        token.chmod(0o600)
        stage='synthetic-bao-metadata'
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
        verifier=bindir/'qualification-dolt-piece-storage-verifier.py'
        if verifier.is_file():
            if not os.access(verifier,os.X_OK):raise RuntimeError('transformation-verifier-not-executable')
            policy['transformationVerifiers'][c['image']]={'path':str(verifier),'interface':'categories-v1'}
            result['transformationVerifier']={'image':c['image'],'sha256':sha(verifier),'scope':'only-empty-piece-storage-table'}
        pol = owned / 'qualification.json'
        pol.write_text(json.dumps(policy))
        pol.chmod(0o600)
        env.write_text(''.join(k + '=' + v + '\n' for k, v in settings.items()))
        # Reconfigure the running fresh image, or start the actual old image on its original volume.
        stage='restart-baseline-with-companions'
        if c['scenario'] != 'held-update':   # held-update keeps the closed-helper-launched baseline (the real UIHELD-equivalent runtime)
          docker('rm', '-f', c['app'])
          current = c.get('baselineImage') or c['image']
        if c['scenario'] != 'held-update': docker('run', '-d', '--name', c['app'], '--network', c['network'], '--restart', 'no',
               '-p', '127.0.0.1:18089:8080', '-v', c['data'] + ':/data', '--env-file', str(env),
               '-e', 'IAM_DEMO_SEED_MODE=never', current)
        if c['scenario']=='held-update':
            # The initial closed helper boot predates the fixture TLS origin/env.
            # Relaunch through the real confinement helper, never a plain docker run.
            docker('stop',c['app']);docker('rm',c['app'])
            config['ledgerSHA256']=sha(Path(c['data'])/'migrations/journal.json')
            configpath.write_text(json.dumps(config))
            helper_args=['--image',c['image'],'--container',c['app'],'--env-file',str(env),'--data-dir',c['data'],'--port','18089']
            run([c['wrappers']['preflight'],*helper_args]);run([c['wrappers']['launcher'],*helper_args])
        stage='baseline-edge-health'
        health(c['app'])
        # Ensure TLS is genuinely verified, with no ignore-certificate option.
        stage='trusted-tls-published-front'
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
        known_stages={'smoke-hold','smoke-health','smoke-workflows-before','smoke-auth-input','smoke-oidc-form','smoke-oidc-login','smoke-oidc-token','smoke-oidc-session','smoke-activations','smoke-activations-validation','smoke-negative-redirect','smoke-workflows-after','smoke-ledger'}
        result['prebaselineSmokeStage']=next((stage for stage in known_stages if 'QUALIFICATION_DIAG_V1:'+stage+'\n' in warm.stderr),'unclassified')

        if warm.returncode:
            raise RuntimeError('candidate-qualifier-smoke-refused')
        if c['scenario'] == 'held-update':
            stage = 'held-update-chain'
            held = load_module(source / 'scripts/held-update-scenario.py', 'held_update_scenario')
            held.run({'c': c, 'root': root, 'out': out, 'bindir': bindir, 'gates': gates, 'origin': origin, 'env': env, 'source': source,
                      'result': result, 'run': run, 'docker': docker, 'load_module': load_module, 'health': health,
                      'pol': pol, 'policy': policy, 'configpath': Path(c['config']), 'config': json.loads(Path(c['config']).read_text())})
        elif c['scenario'] == 'fresh':
            stage='native-browser-trust'
            run(['mkdir','-p','/root/.pki/nssdb'])
            run(['certutil','-N','--empty-password','-d','sql:/root/.pki/nssdb'],False)
            run(['certutil','-A','-d','sql:/root/.pki/nssdb','-n','delivery-fixture','-t','C,,','-i',str(cert)])
            stage='browser-desktop-mobile'
            browserout=out/'ui';browserout.mkdir(exist_ok=True)
            run(['node',str(source/'scripts/delivery-browser-proof.cjs'),origin,str(browserout)])
            proof=json.loads((browserout/'browser-proof.json').read_text())
            if proof.get('desktop') is not True or proof.get('mobile') is not True or proof.get('authenticatedSyntheticUser') is not True:raise RuntimeError('browser-proof-incomplete')
            result['checks']['browserDesktopMobile']=True
            result['evidence']['browserProof']=sha(browserout/'browser-proof.json')
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
            baseline_contract=load_module(source/'scripts/delivery-baseline.py','baseline_identity')
            baseline_contract.verify_baseline(source,base,os.environ.get('DELIVERY_BASELINE_SHA'))
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
            verify_held_queue_refusals(qmodule,root,bindir,guarded_state,plan,wrapper)
            pause=root/'PAUSE';pause.write_text('synthetic-guard\n')
            paused=run(['python3',str(bindir/'ordered-queue.py'),'drain','--state',str(queue),'--pause-file',str(pause),'--updater',str(wrapper)],False,input=json.dumps(plan))
            if paused.returncode==0 or 'deployment paused; no pending entry written' not in paused.stderr or json.loads(queue.read_text())!=state:raise RuntimeError('paused-queue-was-not-refused')
            pause.unlink() # Fixture-owned pause scenario finished; normal scenario has separate state.
            result['checks']['guardedQueueRefusal']=True
            result['guardedQueueCoverage']={'format2ResumeRequiredRefusal':refusal,'format3Status':'ui-held-deploy-resume-status-refused-state-unchanged','pauseExit':paused.returncode,'queueUnchanged':json.loads(queue.read_text())==state,'productionStateNotReplayed':True}
            q = run(['python3', str(bindir / 'ordered-queue.py'), 'drain', '--state', str(queue),
                     '--pause-file', str(root / 'PAUSE'), '--updater', str(wrapper)], False, input=json.dumps(plan))
            result['queueExit'] = q.returncode
            result['evidence']['queueState'] = sha(queue)
            if q.returncode:
                result['queueFailure']=queue_failure_diagnostic(q.stdout+'\n'+q.stderr,json.loads(queue.read_text()))
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
            if changes:
                declared=policy['transformationVerifiers'].get(c['image'])
                if not declared or declared.get('interface')!='categories-v1':raise RuntimeError('measured-preservation-diff')
                run([declared['path'],str(evidence_dir/'before.json'),str(after_paths[0]),','.join(sorted({k.split(':',1)[0] for k in changes}))])
                result['declaredTransformationVerified']=True
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
                wire=load_module(source/'scripts/delivery-receipt.py','delivery_wire_contract')
                fields=wire.validate_actual_receipt(receipt.read_bytes())
                if fields.get('state')!='CLOSED_QUALIFIED' or fields.get('image')!=c['image'] or fields.get('held')!='true' or fields.get('public_status')!='503':raise RuntimeError('actual-receipt-fields-mismatch')
                result['receiptWireContract']='exact-helper-triplet-twice-identical-other-fields-once'
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
                parser.receipt_fields(receipt.read_bytes())
                result['incidentReceiptConsumer']['passed']=True
        result['passed'] = True
    except Exception as error:
        result['stage'] = stage
        # Only our fixed errors, not external stderr, paths, tokens, or environment.
        result['errorType'] = type(error).__name__
        result['commandFailure']=COMMAND_FAILURE
        if str(error) in {'prequalification-updater-refused','prequalification-receipt-mismatch','prequalification-index-mismatch','prequalification-index-incomplete','prequalification-evidence-mismatch','prequalification-preservation-changed','tampered-qualification-accepted','missing-qualification-accepted','supervision-not-ready','supervision-process-did-not-exit','clean-run-contract-failed','history-modes-wrong','kill-phase-never-reached','200-before-opening-after-kill','cursor-advanced-after-interruption','unexpected-watchdog-category','origin-not-503-after-rearm','four distinct fixture images required','baseline image must be fixture image 0','candidate-qualifier-smoke-refused', 'candidate-receipt-consumer-absent',
                          'real-closed-updater-refused', 'real-queue-update-refused', 'candidate-ui-document-refused',
                          'held-fixture-invalid', 'held-deploy-not-refused', 'held-resume-not-refused',
                          'held-status-not-refused', 'held-queue-mutated', 'unknown-format-not-refused'}:
            result['reason'] = str(error)
        # Scenario errors are fixed literals authored in this source tree, never raw subprocess text.
        if c['scenario']=='held-update':
            import ast
            tree=ast.parse((source/'scripts/held-update-scenario.py').read_text())
            allowed={n.exc.args[0].value for n in ast.walk(tree) if isinstance(n,ast.Raise) and isinstance(n.exc,ast.Call) and n.exc.args and isinstance(n.exc.args[0],ast.Constant) and isinstance(n.exc.args[0].value,str)}
            if str(error) in allowed:result['heldScenarioReason']=str(error)
        raise
    finally:
        stopped = run(['docker', 'rm', '-f', caddy], False)
        result['frontCleanup'] = stopped.returncode == 0
        if stopped.returncode != 0:
            result['passed'] = False
        (out / 'delivery-intermediate.json').write_text(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
