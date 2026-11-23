# Explicit closed qualification of the activation161 transformation

This is a separate, one-run incident exception. It does not change the original
policy, compare(), appendOnlyTables, original before, queue or maintenance.
Authorization and reviewed file pins are required before an operator runs it.
No host run is implied by implementing or testing this code.

Use qualification.py phase after with ALL three explicit flags:
--reviewed-activation161-manifest, --reviewed-activation161-manifest-sha256,
--closed-exception-output. No env-only activation, normal receipt flag, before
phase or loopback qualification is accepted. The output directory must be new.
The manifest kind is reviewed-activation161-closed, format1. It contains image,
source_sha, before_sha256, policy_file, policy_sha256, incident_file,
incident_sha256, original_incident (full queue state), code_sha256 for the five
fixed files named CODE in activation161-exception.py, authorization_ref,
evidence_refs, and an absolute one_shot_claim path. The claim is written with
O_EXCL/0600 and remains consumed on failure. One approval covers one attempt;
there is no automatic retry. Approval references and hashes are not consent.

The source/digest, failed/pending linkage, exact incident, original before,
original policy and executed code/helper/SQL/metadata pins are checked before
smoke, and rechecked before/after preservation verification and before writing
the final result. The manifest itself is rehashed. Output files are exclusive
0600 in a0700 directory and never recycle a prior successful result.

Normal OIDC/session/journal checks still run. This smoke may write sessions and
audit. It does not call activation POST or reconcile; exact legacy activation
multiset equality means any added or changed activation will refuse this mode.
No announced extra activation or wider append-only exception is accepted.

activation161-capture.sql is fixed and versioned. A session-local temporary
transport table is created before the read-only transaction. ALL PostgreSQL
business schema, tables, sequence definitions/values and activation full/legacy
hash pairs are collected in one connection, in a REPEATABLE READ READ ONLY
transaction, with settings asserted by SQL. Temporary transport metadata is
excluded. All projection hashing is done by PostgreSQL, not reconstructed in
Python. Sequence values are not MVCC transactional snapshots: concurrent nextval
can still advance them, so normal non-rewind/non-uncall checks remain mandatory.
This does not claim stronger sequence atomicity than PostgreSQL provides.

The verifier accepts exactly actor_id text, actor_kind text, applied_at
timestamptz, nullable without defaults, at the next exact ordinals. Full expected
information_schema column metadata was captured on real PostgreSQL17.12 and is
versioned. No template from an existing error column is used in this mode.
The paired projection must reconstruct exactly the full-after multiset AND the
old-before multiset, with exact multiplicities/count and all new values NULL.
All other schema sections must match. Only that proven transformation is
normalized before calling the unchanged normal compare() over all other state.

Success writes after.json, smoke.json and capture.json, bound by hashes in
closed-exception-result.json. Its format is activation161-closed-exception-v1,
type closed-qualification-only, result
verified-with-reviewed-exception-no-opening. It is structurally incompatible
with normal format1/result qualified receipts. Existing queue verifier refuses
it, as does the existing recovery harness through that verifier. No normal
receipt is made, no queue state changed and no opening performed. Further
review and explicit authority would be needed for any later operational effect.

Tests:9 focused exception tests plus adversarial subcases; real PostgreSQL17.12
capture/verifier with14 fictional rows and another table/sequence; injected SQL
UPDATE refused as read-only, removing READ ONLY refused by SQL assertion.
Existing80 Node,17 qualification,36 queue,12 recovery,3 offline tests pass.
No Docker/full stack is available here. The real PG test does not prove OIDC,
Docker identity, TLS, host permissions or production recovery. Existing operator
projection evidence is separate and preserved. No live policy or host changed.

## Final review corrections

The mode uses fixed real host registry `/opt/lyam/deploy-queue/state.json`, its
existing `.lock`, existing `/opt/lyam/.update.lock` and retained external pause.
A copied incident_file is refused. Both locks are acquired nonblocking before
incident validation and held through the complete process attempt. Exact full
registry bytes/hash, pending/failed/exit/resume state and target are rechecked.
Test fixtures replace module constants only inside tests, not through CLI/env.
These fixed paths must match the reviewed deployment setup, otherwise fail and
review the code rather than redirecting to a convenient copy.

Actual orchestration order is smoke, second activation journal check, capture
Dolt/Bao, final PostgreSQL transaction, preservation verification/save. It was
already post-smoke, now guarded by an order regression test. A simulated
smoke-appended activation is rejected by final exact legacy multiset equality.
The equality between capture.postgres and after.postgres is only internal
artifact consistency, NOT independent proof: provenance comes from the pinned
SQL executed in that session, operator review and immutable hashes. Writes after
that snapshot are not covered, and cross-system atomicity is not claimed.

16 exception tests now include actual mutations of policy/incident/helper/
metadata/manifest/source/digest after capture, consumed claim with a fresh
output path, both held locks, copied registry refusal, CLI partial/conflicting
normal-receipt/loopback flags, and post-smoke activation change. PostgreSQL17.12
local integration and the existing test suites remain green. No Docker/full
stack/host qualification is claimed and no live policy/queue/gate was changed.

## Catalog correction after the failed closed attempt

The reviewed PG-only diagnostic found an exact metadata refusal: udt_catalog
was fixture database postgres while the host database was lyam. No business type
difference was reported in that diagnostic. This establishes the present
verifier refusal, not a recovered historical stack trace from the opaque run.

The verifier now derives the one database identity from legacy columns in the
original BEFORE, requires the policy's selected DB and current_database()
returned by the same live PG snapshot to equal it, and requires every legacy
UDT catalog and every new column table/UDT catalog to agree. Only udt_catalog
in a copy of the concrete expected fixture is contextualized. Other metadata,
ordinals, type/schema, precision, defaults and nullability remain exact. A real
PG17.12 test now uses a different database lyam_fixture rather than postgres.
No consumed claim is reset. New code requires new reviewed pins and a new
agreement/claim/output for any future attempt.

Qualification now emits fixed stage codes, allowlisted child stage/HTTP codes,
and no raw child stderr, credentials, argv or exception messages. An optional
--failure-diagnostic-file writes a fresh exclusive0600 private JSON with fixed
stage/class/reason; stdout/stderr must still be redirected to the operator's
private0600 log. It never changes failure into success or relaxes comparisons.
Node codes distinguish OIDC, session, activation projection, migration ledger,
Dolt and Bao stages. JSON inputs before the Node catch remain outer SMOKE or
CAPTURE failures, not guessed sub-stages.
