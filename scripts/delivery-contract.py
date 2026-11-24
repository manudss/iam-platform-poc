#!/usr/bin/env python3
"""Fail-closed delivery evidence aggregation. No network or deployment effects."""
import argparse
import hashlib
import json
import re
from pathlib import Path

JOBS = ('build', 'baseline_build', 'delivery_regressions', 'delivery_fresh', 'delivery_upgrade')
SCENARIOS = ('fresh', 'upgrade')
CHECKS = {
    'fresh': {'boot', 'migrationLedger', 'oidc', 'uiDocument', 'browserDesktopMobile', 'cleanup'},
    'upgrade': {'realUpdater', 'realQueue', 'guardedQueueRefusal', 'preservation', 'migrationLedger',
                'oidc', 'backupReadback', 'realReceipt', 'gate', 'cleanup'},
}


def aggregate(needs, receipts, sha, digest):
    errors = []
    if not re.fullmatch(r'[a-f0-9]{40}', sha or ''):
        errors.append('invalid-source-sha')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', digest or ''):
        errors.append('invalid-image-digest')
    if set(needs) != set(JOBS):
        errors.append('job-set-mismatch')
    for job in JOBS:
        if needs.get(job, {}).get('result') != 'success':
            errors.append('job-not-success:' + job)
    if len(receipts) != len(SCENARIOS):
        errors.append('receipt-count-mismatch')
    seen = set()
    for receipt in receipts:
        scenario = receipt.get('scenario')
        if scenario not in SCENARIOS or scenario in seen:
            errors.append('unknown-or-duplicate-scenario')
            continue
        seen.add(scenario)
        if receipt.get('format') != 1 or receipt.get('passed') is not True:
            errors.append('receipt-not-passed:' + scenario)
        if receipt.get('sha') != sha or receipt.get('digest') != digest:
            errors.append('receipt-identity-mismatch:' + scenario)
        checks = receipt.get('checks', {})
        if set(checks) != CHECKS[scenario] or any(v is not True for v in checks.values()):
            errors.append('incomplete-checks:' + scenario)
        evidence = receipt.get('evidence', {})
        if not evidence or any(not re.fullmatch(r'[a-f0-9]{64}', v or '') for v in evidence.values()):
            errors.append('missing-evidence-hashes:' + scenario)
    if seen != set(SCENARIOS):
        errors.append('scenario-set-mismatch')
    return {'format': 1, 'passed': not errors, 'sha': sha, 'digest': digest,
            'expectedJobs': list(JOBS), 'expectedScenarios': list(SCENARIOS), 'errors': errors}


def main():
    parser = argparse.ArgumentParser()
    for key in ('needs', 'receipts', 'sha', 'digest', 'out'):
        parser.add_argument('--' + key, required=True)
    args = parser.parse_args()
    root = Path(args.receipts)
    receipts = []
    for path in sorted(root.rglob('delivery-receipt.json')):
        receipts.append(json.loads(path.read_text()))
    result = aggregate(json.loads(Path(args.needs).read_text()), receipts, args.sha, args.digest)
    # Validate uploaded evidence bytes, not merely SHA-shaped strings in a receipt.
    for path in sorted(root.rglob('delivery-receipt.json')):
        record=json.loads(path.read_text())
        if record.get('scenario')=='fresh' and not {'ui/browser-proof.json','ui/desktop-login.png','ui/mobile-login.png','ui/desktop-authenticated.png','ui/mobile-authenticated.png'}.issubset(record.get('evidence',{})):
            result['errors'].append('browser-artifacts-missing')
        execution=path.parent/'execution-evidence.json'
        if execution.is_file():
            measured=json.loads(execution.read_text())
            if any(record.get(key)!=measured.get(key) for key in ['format','scenario','passed','sha','digest','checks','cleanup']):
                result['errors'].append('receipt-execution-evidence-mismatch')
        for name, expected in record.get('evidence', {}).items():
            item=path.parent/name
            if Path(name).is_absolute() or '..' in Path(name).parts or name not in {'execution-evidence.json','candidate-script-hashes.json','ui/browser-proof.json','ui/desktop-login.png','ui/mobile-login.png','ui/desktop-authenticated.png','ui/mobile-authenticated.png'} or item.is_symlink() or not item.is_file() or hashlib.sha256(item.read_bytes()).hexdigest()!=expected:
                result['errors'].append('artifact-evidence-mismatch')
    result['passed']=not result['errors']
    Path(args.out).write_text(json.dumps(result, indent=2) + '\n')
    print('Delivery contract: ' + ('PASS' if result['passed'] else 'FAIL'))
    for error in result['errors']:
        print(error)
    raise SystemExit(0 if result['passed'] else 1)


if __name__ == '__main__':
    main()
