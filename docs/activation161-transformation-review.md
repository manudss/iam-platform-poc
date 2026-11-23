# Activation161 transformation verifier, offline review only

Target only:
`ghcr.io/manudss/iam-platform-poc@sha256:455e2556b74fb2abc9e55f0868144ecc1daa3d9a4743c36ffce400845544a273`.
The operator must independently confirm this identity before use.

`verify-activation161.py` performs no SQL, network, policy edits, qualification,
receipt generation, deployment or opening. It checks an already captured before,
after and operator projection evidence against separately reviewed file pins.
The projection evidence must bind both captures by hash and include the exact
whole-after row-hash multiset, old-column-projection multiset, total row count,
zero count of rows with any new column non-NULL, and original appendOnlyTables.
The policy file is hashed and its appendOnlyTables must be exactly the pinned
original list. It is not widened by this verifier.

Only three new public.activations columns are accepted, in source order:
actor_id text, actor_kind text, applied_at timestamp with time zone. Nullable,
no default, old column metadata unchanged, all other schema sections identical.
The nullable pre-existing error text column is used as the information_schema
metadata template, changing only name/ordinal and timestamp type/precision.
Every old activation row hash and multiplicity must match exactly after removing
those three keys. All new values must be NULL. Normal compare remains unchanged
and still checks all non-target tables, Dolt, Bao, credentials and sequences.

The reviewed pin must contain format1, image, original policyHash, before_sha256,
after_sha256, projection_sha256, policy_file, projection_file, appendOnlyTables.
The projection JSON contains format1, image, before_sha256, after_sha256,
removed_columns, legacy_projection, whole_rows, row_count, nonnull_new_columns,
appendOnlyTables. Paths are local private files. Select the reviewed pin through
LYAM_ACTIVATION161_REVIEWED_PIN. Neither file metadata nor an evidence reference
authenticates permission or the provenance of the original projection query.
The independent operator/reviewer must bind these files to the actual observed
PostgreSQL computation. The verifier cannot prove a fabricated projection came
from PostgreSQL without that source-grounded review.

Important: exact after/projection pins qualify only that captured pair. This is
an OFFLINE verification deliverable, not yet a plug-in authorization for a later
qualification run with a different after hash. No policy change or future receipt
is implied. Any later authorized qualification needs a separately reviewed way
to bind its exact capture/projection; do not remove the hash checks to make a
new run pass. No live installation or rerun was performed.

Local tests include positive multiplicities and17 mutations: extra column, wrong
type, nonnullable/default, non-NULL new values, old-value hash mismatch, missing
or extra/duplicate rows, other table, sequence rewind, unknown digest, missing
pin, row-count/current multiset mismatch, other schema, Dolt/Bao/credentials.
An isolated PostgreSQL reproduction established the hash-key mechanism and a
negative changed-old-commit control, but is not the operator's host evidence.
