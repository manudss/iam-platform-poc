# Reviewed activation161 opening, separate from closed qualification

This is a separate, explicit operator action, NOT a normal qualification receipt,
normal recovery, deployment, PR merge or queue resume. No host invocation is
implied by this file. Closed qualification must succeed first. Opening has its
own approval reference, reviewed pinned manifest and exclusive consumed claim.
The operator alone executes it after independent review of code, private
manifest and incident. Never retry automatically, including a failed attempt.

## Invocation and reviewed manifest

`recover-activation161.py --manifest /private/opening.json --manifest-sha256 HASH`

The manifest is JSON with:

- `format: 1`, `kind: reviewed-activation161-opening`;
- `authorization_ref`, nonempty `evidence_refs` naming actual approval/evidence;
- `closed_manifest`, `closed_result`, `before`: each exact `{path, sha256}`;
- `code_sha256`: all names in recover-activation161.py CODE, covering both
  qualification stages, collector SQL, metadata, queue and recovery helpers;
- `one_shot_claim`: fresh absolute path, distinct from closed qualification
  claim; `output`: fresh private output directory;
- `barrier_file: /var/lib/lyam-front-gate/MAINTENANCE`, `barrier_token`,
  `former_pid`, `origins`, `container`, `data_dir`, `repository`;
- `queue_manifest`: format1, same opening kind, exact current state_fingerprint,
  expected_delivered SHA/digest, authorization_ref and evidence_refs,
  original_unresolved pending+failed, target `{sha,digest}` exactly161 and
  chain `[{sha,parent,outcome:"delivered"}]` exactly from last delivered.

All values come from verified operator evidence, not this example. In particular
an approval reference is an audit field, not authentication or consent.

## Guards and live evidence

The program takes existing real registry and updater locks nonblocking, queue
then updater, and retains them. A copied registry is refused. Closed manifest,
result and all after/smoke/capture bytes, original before/policy, both code sets,
and original consumed claim are verified. The live registry must still be
byte-identical to the original qualification incident, including pending,
failed nonzero integer exit, parent, digest and false resume state. Closed
format/type/result are required. Normal receipts cannot substitute, and the
normal queue receipt verifier is unchanged and refuses this exception.

The fresh opening claim is consumed even if the attempt later fails. It binds
the reviewed opening manifest. Live Dolt, Bao, migration ledger and credentials
are captured through the actual existing collector and hashing functions.
PostgreSQL full schema/tables/sequences plus paired legacy projection are freshly
captured in the fixed same-session READ ONLY REPEATABLE READ transaction.
The exact original-before multiset, exact three nullable no-default columns,
all new values NULL and normal non-target checks are rerun, not trusted from
an earlier result. The older closed capture is cleared before fresh collection,
so a missing collector cannot silently reuse it.

Container ID, image ID, StartedAt and RestartCount must stay unchanged through
capture, before unlink and record confirmation. OCI digest/revision are checked
against installed image and first-parent origin/main source chain. Live evidence
is written exclusively0600 and hashed. Capture-to-unlink has a hard60second
limit, not an adjustable operator shortcut.

The complete future format2 journal state and audit are prepared and validated
before removing the barrier: exact parent/failed target, fingerprint, source
chain and image, retained pause, all private evidence and original code pins.
The old PID must be dead, exact token unchanged, and all original TLS origins
must return503. Then the barrier is unlinked, all origins must return200, final
registry/identity/pins checked, and only that prepared state is atomically
written and reread for exact confirmation. The audit preserves original pending
and failed, closed-result/manifest hashes, live evidence hash, observed running
image and approval references. The journal has format2, fence161 and
resume_required:true. External pause is never removed. Old plans are fenced,
and normal/exception manifest types cannot substitute for each other.

## Failure and limits

Rearm is armed BEFORE unlink. Catchable errors/signals after unlink recreate
only an absent exact marker and verify TLS503; a foreign marker is never
overwritten. Errors after a queue write was attempted report an uncertain
queue-write/front-rearmed state requiring inspection of durable registry/audit,
not an assertion that pending/failed remain unresolved. A committed audit is
never erased or rolled back to make retry convenient. SIGKILL, host crash,
filesystem/fsync failure and network ambiguity cannot be made transactional
with the frontend: operator inspection is required and no auto retry is allowed.

Snapshots across Dolt/Bao/PostgreSQL/files are sequential, not an atomic
cross-system transaction. PostgreSQL sequences are not MVCC; normal monotonic
checks are retained. Workers can still write behind TLS503 and after the last
snapshot, even with stable container identity. This program establishes strict
fresh preservation at its observed snapshots; it cannot promise a global
write freeze through opening. Any observed divergence stops, never widens
policy. Stronger guarantees require a separately reviewed, verified quiescence
mechanism, not an invented claim that maintenance blocks all workers.

Tests use fictional isolated files, injected front probes/identity/commands and
real existing preservation/receipt/queue functions. They cover success audit,
claims/replay, normal/exception type refusal, live owner/foreign gate, missing
pause, initial200/open503, recorder errors and ambiguous postwrite commit,
signal immediately after unlink, foreign marker preservation, stale/missing
capture, added activation/non-target drift, changed registry, restart,
origin/main/image refusals, changed manifest and old-plan fence.
PostgreSQL17.12 collector integration is separately real. Docker, real TLS,
full-stack workflow and host opening are NOT established by these tests.
