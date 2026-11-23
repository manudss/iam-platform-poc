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
