# Reviewed recovery of a blocked deployment journal

This is an operator-only, record-only protocol. It does not deploy an image, retry a failed entry, remove a pause, fetch a script, dispatch a workflow, or grant permission. Do not apply it to a host merely because this document or a pull request exists.

## Separate facts and decisions

- **Delivered history** records only a baseline already confirmed and a corrected target actually observed running. Intermediate source commits are not described as delivered.
- **Incident history** keeps the complete original `pending` and `failed` objects, the canonical pre-change state fingerprint, and evidence references.
- **Source outcomes** give every intermediate commit an explicit `replaced` or `abandoned` outcome. These mean not delivered by this recovery. They do not erase a failed attempt.
- **Recovery acceptance** records an already executed and qualified corrected delivery, under its own approval.
- **Queue resume** is a separate reviewed decision and separate journal operation. It still does not remove `UPDATE_PAUSED`.

Approval and evidence reference strings are operator attestations, not authenticated consent and not independent proof that a CI run or preservation check succeeded. The operator must recover the actual approval, verify its owner, scope, exact source/digest and conditions, and inspect the referenced evidence before preparing either manifest. Do not put credentials or private evidence contents in manifests or public issues.

## Gates before any operational use

1. Review and qualify the exact candidate and this queue executable. Install the reviewed executable as a separate authorized host change, never from an unqualified default checkout. No installation is performed by this protocol. Check the configured state, container, pause and updater-lock paths against the host configuration.
2. Keep the existing pause and preserve the original incident evidence and state file privately. Run `inspect-reviewed-state` with the correct state/pause paths. It succeeds even for a blocked queue and returns its canonical JSON SHA-256 fingerprint, cursor, pending failure and barriers. Inspection does not resolve the incident.
3. Choose the corrected **main first-parent** target under explicit owner/operator authority. Review which intermediate sources will be replaced or abandoned. A passing unit test or the storage fix alone is not a full application-startup or host-preservation qualification.
4. Qualify the exact target without delivery. The existing OCI workflow's `qualification_only=true` input bypasses the host cursor and does not run delivery. Its dispatch still needs its own permission. Verify the exact-SHA CI, immutable image digest and same-run receipt. This document dispatches nothing.
5. Separately approve and execute a one-off corrected delivery through the reviewed preservation route. Its pause handling, backups, maintenance barrier, migration/OIDC/journal/TLS checks and any digest-specific transform verifier belong to that authorization. Do not clear the failure or replay the broken image to get there. If this route or its approval is unavailable, stop with the incident retained.
6. After that delivery passes its checks, retain/restore the deployment pause before journal recovery. A restart, configuration change or data change after qualification requires renewed review. The recorder checks current image identity, not the full host state or the authenticity of an approval reference.

## Recovery manifest

The following is a schema illustration with invalid placeholders, not an executable authorization. Use a private reviewed file. `chain` contains every first-parent commit after the old delivered cursor through the corrected target, at most 256 entries. The first must be the actual failed pending source. At least one later corrected source is required.

```json
{
  "format": 1,
  "kind": "reviewed-recovery",
  "state_fingerprint": "CANONICAL_STATE_SHA256",
  "expected_delivered": {"sha": "BASE_FULL_SHA", "digest": "sha256:BASE_IMAGE_DIGEST"},
  "authorization_ref": "reference to verified approval of this exact recovery",
  "evidence_refs": ["private original incident and delivery evidence references"],
  "chain": [
    {"sha": "FAILED_FULL_SHA", "parent": "BASE_FULL_SHA", "outcome": "replaced"},
    {"sha": "INTERMEDIATE_FULL_SHA", "parent": "FAILED_FULL_SHA", "outcome": "abandoned"},
    {"sha": "CORRECTED_FULL_SHA", "parent": "INTERMEDIATE_FULL_SHA", "outcome": "delivered"}
  ],
  "target": {"sha": "CORRECTED_FULL_SHA", "digest": "sha256:CORRECTED_IMAGE_DIGEST"},
  "qualification": {
    "sha": "CORRECTED_FULL_SHA",
    "digest": "sha256:CORRECTED_IMAGE_DIGEST",
    "evidence_refs": ["verified exact target CI/receipt and successful same-delivery host checks"]
  }
}
```

`record-reviewed-recovery --repository REVIEWED_LOCAL_CHECKOUT --container CONFIGURED_CONTAINER` reads that manifest from stdin, under the queue lock and the existing configured updater lock. `--state`, `--pause-file` and `--update-lock` select the verified configured paths. A real pause file must remain present. No network fetch, Docker mutation or updater invocation occurs.

The local checkout must contain the reviewed `refs/remotes/origin/main` history. Read-only Git checks verify every actual first parent and target membership in that mainline. Read-only Docker checks require the running digest reference, matching image ID and repository digest, and the exact OCI source revision label. A failed check changes nothing.

One atomic, fsynced state replacement then preserves the incident in `recoveries`, appends only the observed corrected target, raises `resume_required`, and establishes its permanent `recovery_fence`. The format becomes **2**, intentionally. The previous format-1-only reader fails closed instead of ignoring these new gates, including a reader process started before the executable replacement and waiting on the queue lock. Do not downgrade the reader or manually rewrite the format.

## Separate reviewed resume

Reinspect the new state. Prepare a second private manifest:

```json
{
  "format": 1,
  "kind": "reviewed-resume",
  "state_fingerprint": "NEW_CANONICAL_STATE_SHA256",
  "expected_delivered": {"sha": "CORRECTED_FULL_SHA", "digest": "sha256:CORRECTED_IMAGE_DIGEST"},
  "authorization_ref": "reference to separate verified queue-resume approval",
  "evidence_refs": ["fresh operator checks"]
}
```

`resume-reviewed --container CONFIGURED_CONTAINER` takes the same verified path options and reads this manifest from stdin. It again requires the pause, unchanged state/cursor, no unresolved deployment, and the observed corrected image. It records a separate resume audit. It does not delete or edit the pause.

Only a separately authorized pause change can make automatic status/drain available again. While paused, both commands refuse before a new pending entry is written. After resume, a plan based before the recovery fence is always refused, even when it includes the corrected target. Generate a fresh plan from the actual corrected cursor. Never retry an old workflow's pre-recovery plan.

## Crash and review behavior

- Before atomic replacement, refusal or a crash leaves the old incident authoritative.
- After replacement, the full audit, corrected cursor and resume barrier are visible together. Reinspect after any uncertain command result. The old fingerprint cannot be reused to append a duplicate recovery.
- After a resume replacement, the external pause still protects the host. Reinspect rather than repeating a stale manifest.
- Pending-only crash incidents, inconsistent pending/failure identities, divergent source histories, absent qualification attestations and unknown running images are refused. They need their own reviewed resolution, not an improvised field clear.

## Evidence limits

The local suite covers 27 queue cases, including the original 7 cases, state/chain checks, real temporary Git repositories, Docker observation doubles, CLI pause/lock gates, stale runners, two incidents, and simulated crashes before/after the existing atomic replacement. Docker checks are not a live-host integration test. Crash tests model failures at the replacement boundary, not an operating-system power-loss experiment. No host recovery, pause change, historical workflow dispatch or corrected delivery is qualified merely by these tests.
