#!/usr/bin/env python3
"""Digest-specific reviewed transformation verifier: migration 0002 (account-blocks
screen rule) for exactly one image transition:

  ghcr.io/manudss/iam-platform-poc@sha256:accbd340a59db8a87762f9cdb338a6aca70f92f99a5a5c9e5ba2425f8f3eb3de
    -> ghcr.io/manudss/iam-platform-poc@sha256:7c5ce38f03b378afbb060e6092706a03503c47eac58c2cbca943d15d0d652201

Contract (docs/oci-ordered-deploy.md, "Digest-specific transformation verifiers"):
invoked by deploy/oci/qualification.py, or manually by the operator, as

  verify-0002-account-blocks.py <before.json> <after.json>

with the controller's private hash-only evidence files. It must prove the WHOLE
declared transformation, including preservation outside it. It exits 0 only when
every check below holds; anything unknown, missing, drifted or unexpected exits 1
with a generic message (never print secret values; evidence contains hashes only).

What is proven:
  A. Evidence-internal: exact image pair, unchanged qualification policy (re-hashed
     from the live policy file), migration ledger strictly extended by 0002 with the
     manifest checksum and disposition "applied", Bao metadata and credential file
     hashes identical, and the controller's own compare() reporting exactly ['dolt'].
  B. Live-tied (read-only, against the single running container of the new image):
     the iam/main Dolt head moved by exactly ONE commit, on top of the captured
     before-head, with the exact migration commit message; that commit touches only
     policy_rules and adds exactly one row - default/screen-account-blocks with the
     frozen Cedar text from apps/api/src/migrations/v0002/rule.ts; the working set is
     clean and every captured database/branch head+root still matches live; every
     PostgreSQL row-hash multiset still matches the after-capture, and the single
     appended public.activations row is the activation of exactly the migration
     commit for the policy tenant.
"""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

OLD_IMAGE = 'ghcr.io/manudss/iam-platform-poc@sha256:accbd340a59db8a87762f9cdb338a6aca70f92f99a5a5c9e5ba2425f8f3eb3de'
NEW_IMAGE = 'ghcr.io/manudss/iam-platform-poc@sha256:7c5ce38f03b378afbb060e6092706a03503c47eac58c2cbca943d15d0d652201'
MIGRATION_ID = '0002'
MIGRATION_CHECKSUM = '3fef799dcba07cf71f9cc53b4ba1199850d06cefae4720826b70733fd2256a4f'
MIGRATION_DISPOSITION = 'applied'
COMMIT_MESSAGE = 'migration 0002: policy rule default/screen-account-blocks (pending Review & Apply)'
DOLT_DATABASE = 'iam'
DOLT_BRANCH = 'main'
RULE_SET = 'default'
RULE_ID = 'screen-account-blocks'
# Frozen text, byte-identical to ACCOUNT_BLOCKS_RULE in apps/api/src/migrations/v0002/rule.ts
# at the verified image's source SHA. A spec in this repository compares them.
RULE_CEDAR = (
    '@id("screen-account-blocks")\n'
    '@description("Managing account blocks is a right of its own: administrators (main-merger) and managers hold it for now. Change this rule to give it to other roles.")\n'
    '@pillar("access")\n'
    'permit(principal, action == Action::"screen:open", resource == Screen::"account-blocks")\n'
    '  when { context has roles && (context.roles.contains("manager") || context.roles.contains("main-merger")) };'
)
POLICY_PATH = '/opt/lyam/qualification.json'
ACTIVATIONS_TABLE = 'public.activations'


def fail(message):
    raise ValueError(message)


def run(args, input_text=None):
    """One subprocess call. Tests patch this single point; no other process execution exists."""
    result = subprocess.run(args, input=input_text, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    if result.returncode:
        fail('command failed, private diagnostic inspection required')
    return result.stdout.strip()


def load_controller():
    """Import the sibling qualification controller; a missing/moved controller is UNKNOWN."""
    import importlib.util
    path = Path(__file__).with_name('qualification.py')
    if not path.is_file():
        fail('qualification controller not adjacent')
    spec = importlib.util.spec_from_file_location('qualification_controller', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def truthy(value):
    return value in (True, 1, '1', 'true', 't')


def check_evidence(before, after, policy, policy_path=POLICY_PATH):
    if before.get('image') != OLD_IMAGE or after.get('image') != NEW_IMAGE:
        fail('image pair is not the verified transition')
    if before.get('transportCoverage') != 'TLS_EXPECTED_ORIGINS' or after.get('transportCoverage') != before.get('transportCoverage'):
        fail('transport coverage unexpected')
    if before.get('policyHash') != after.get('policyHash'):
        fail('qualification policy changed mid-update')
    live_policy_hash = hashlib.sha256(Path(policy_path).read_bytes()).hexdigest()
    if live_policy_hash != after['policyHash']:
        fail('live qualification policy differs from the captured policy')

    ledger_before, ledger_after = before.get('migrationLedger'), after.get('migrationLedger')
    if not ledger_before or not ledger_after:
        fail('migration ledger missing')
    for ledger in (ledger_before, ledger_after):
        if ledger.get('format') != 1 or ledger.get('pending'):
            fail('migration ledger incomplete or pending')
    entries_before, entries_after = ledger_before.get('entries'), ledger_after.get('entries')
    if not isinstance(entries_before, list) or not isinstance(entries_after, list):
        fail('migration ledger entries unknown')
    if entries_after[:len(entries_before)] != entries_before or len(entries_after) != len(entries_before) + 1:
        fail('migration ledger is not the before-ledger plus exactly one entry')
    added = entries_after[-1]
    if added.get('id') != MIGRATION_ID or added.get('checksum') != MIGRATION_CHECKSUM:
        fail('appended ledger entry is not the declared migration 0002')
    if added.get('disposition') != MIGRATION_DISPOSITION:
        fail('migration 0002 is not marked applied')
    if MIGRATION_ID in [entry.get('id') for entry in entries_before]:
        fail('migration 0002 was already present before this transition')

    if not after.get('bao') or before.get('bao') != after.get('bao'):
        fail('Bao metadata coverage changed')
    if not any(after.get('credentials', {}).values()) or before.get('credentials') != after.get('credentials'):
        fail('credential file coverage changed')

    before_index = {(item['database'], item['branch']): item for item in before.get('dolt', [])}
    after_index = {(item['database'], item['branch']): item for item in after.get('dolt', [])}
    if not before_index or set(before_index) != set(after_index):
        fail('Dolt database/branch inventory changed')
    changed = [key for key in before_index if before_index[key] != after_index[key]]
    if changed != [(DOLT_DATABASE, DOLT_BRANCH)]:
        fail('unexpected Dolt branch movement')
    moved_before, moved_after = before_index[(DOLT_DATABASE, DOLT_BRANCH)], after_index[(DOLT_DATABASE, DOLT_BRANCH)]
    if moved_before['head'] == moved_after['head'] or moved_before['root'] == moved_after['root']:
        fail('declared transformation did not happen')

    controller = load_controller()
    if controller.compare(before, after, policy) != ['dolt']:
        fail('controller preservation comparison is not exactly the Dolt change')
    return moved_before, moved_after, after_index


def find_container(image):
    ids = run(['docker', 'ps', '-q']).split()
    matches = []
    for container_id in ids:
        inspect = json.loads(run(['docker', 'inspect', container_id]))[0]
        if inspect.get('Config', {}).get('Image') == image and inspect.get('State', {}).get('Running'):
            matches.append(container_id)
    if len(matches) != 1:
        fail('expected exactly one running container of the verified image')
    return matches[0]


def dolt_query(container, database, sql):
    out = run(['docker', 'exec', '-i', container, 'dolt', '--host', '127.0.0.1', '--port', '3307', '--no-tls',
               '-u', 'root', '--password', '', '--use-db=' + database, 'sql', '-r', 'json', '-q', sql])
    rows = json.loads(out).get('rows')
    if not isinstance(rows, list):
        fail('Dolt inventory unknown')
    return rows


def pg_query(policy, sql):
    out = run(['docker', 'exec', policy['pgContainer'], 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
               '-U', policy['pgUser'], '-d', policy['pgDatabase'], '-c', sql])
    return json.loads(out)


def check_live_dolt(container, moved_before, moved_after, after_index):
    head_before, head_after = moved_before['head'], moved_after['head']
    branch_ref = DOLT_DATABASE + '/' + DOLT_BRANCH
    log = dolt_query(container, branch_ref, 'SELECT commit_hash, message FROM dolt_log LIMIT 2')
    if len(log) != 2 or log[0].get('commit_hash') != head_after or log[1].get('commit_hash') != head_before:
        fail('iam/main did not advance by exactly one commit on top of the captured head')
    if log[0].get('message') != COMMIT_MESSAGE:
        fail('unexpected migration commit message')
    summary = dolt_query(container, DOLT_DATABASE,
                         "SELECT table_name, diff_type, data_change, schema_change FROM dolt_diff_summary('%s','%s')" % (head_before, head_after))
    if len(summary) != 1 or summary[0].get('table_name') != 'policy_rules' or not truthy(summary[0].get('data_change')) or truthy(summary[0].get('schema_change')):
        fail('migration commit touches more than policy_rules data')
    diff = dolt_query(container, DOLT_DATABASE,
                      "SELECT * FROM dolt_diff('%s','%s','policy_rules')" % (head_before, head_after))
    if len(diff) != 1:
        fail('policy_rules changed by other than exactly one row')
    row = diff[0]
    if row.get('diff_type') != 'added':
        fail('policy_rules row is not a pure addition')
    if any(row.get('from_' + column) is not None for column in ('set_name', 'id', 'cedar')):
        fail('an existing policy_rules row was modified')
    if row.get('to_set_name') != RULE_SET or row.get('to_id') != RULE_ID or row.get('to_cedar') != RULE_CEDAR:
        fail('added policy rule is not the frozen account-blocks rule')

    status = dolt_query(container, branch_ref, 'SELECT * FROM dolt_status')
    if status:
        fail('iam/main has uncommitted changes beyond the migration commit')
    for (database, branch), want in after_index.items():
        heads = dolt_query(container, database, 'SELECT name, hash FROM dolt_branches ORDER BY name')
        live_head = {item['name']: item['hash'] for item in heads}.get(branch)
        live_root_rows = dolt_query(container, database + '/' + branch, "SELECT DOLT_HASHOF_DB('WORKING') AS root")
        live_root = live_root_rows[0].get('root') if live_root_rows else None
        if live_head != want['head'] or live_root != want['root']:
            fail('captured Dolt state no longer matches live; something changed since the capture')
    return head_after


def check_live_postgres(policy, before, after, migration_head):
    row_hashes = ("SELECT coalesce(json_agg(s),'[]') FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') h, count(*) n FROM %s t GROUP BY 1) s")
    for table, want in after['postgres']['rows'].items():
        live = {item['h']: item['n'] for item in pg_query(policy, row_hashes % table)}
        if live != want:
            fail('captured PostgreSQL rows no longer match live for ' + table)
    for name, want in after['postgres']['sequences'].items():
        live = pg_query(policy, 'SELECT row_to_json(s) FROM (SELECT last_value, is_called FROM ' + name + ') s')
        if live != want:
            fail('captured PostgreSQL sequence no longer matches live for ' + name)
    added_hashes = []
    before_rows = before['postgres']['rows'].get(ACTIVATIONS_TABLE, {})
    for h, n in after['postgres']['rows'].get(ACTIVATIONS_TABLE, {}).items():
        extra = n - before_rows.get(h, 0)
        if extra < 0:
            fail('an activation journal row disappeared')
        added_hashes.extend([h] * extra)
    if len(added_hashes) != 1:
        fail('expected exactly one appended activation journal row')
    rows = pg_query(policy, "SELECT coalesce(json_agg(s),'[]') FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') h, to_jsonb(t) j FROM %s t) s" % ACTIVATIONS_TABLE)
    new_rows = [item['j'] for item in rows if item['h'] == added_hashes[0]]
    if len(new_rows) != 1:
        fail('could not isolate the appended activation journal row')
    appended = new_rows[0]
    if appended.get('commit') != migration_head or appended.get('tenant') != policy['tenant']:
        fail('appended activation row is not the publication of the migration commit for this tenant')
    if appended.get('state') not in ('pending', 'recorded', 'applied'):
        fail('appended activation row has an unknown state')


def verify(before_path, after_path, policy_path=POLICY_PATH):
    before = json.loads(Path(before_path).read_text())
    after = json.loads(Path(after_path).read_text())
    policy = json.loads(Path(policy_path).read_text())
    moved_before, moved_after, after_index = check_evidence(before, after, policy, policy_path)
    container = find_container(NEW_IMAGE)
    migration_head = check_live_dolt(container, moved_before, moved_after, after_index)
    check_live_postgres(policy, before, after, migration_head)


def main():
    if len(sys.argv) != 3:
        print('usage: verify-0002-account-blocks.py <before.json> <after.json>', file=sys.stderr)
        return 1
    try:
        verify(sys.argv[1], sys.argv[2])
    except Exception:
        print('Transformation verification failed or UNKNOWN. Keep maintenance armed and inspect private evidence.', file=sys.stderr)
        return 1
    print('Migration 0002 transformation proven: declared changes only, everything else preserved and tied to live state.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
