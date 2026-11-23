# Per-access role recertification

Campaigns may explicitly choose granularity `access`. The official recertification template chooses it. Existing saved workflows/campaigns without this option keep their historical person-level decision semantics.

An access item is one person and one DIRECT role assignment, read from Lyam's `assignments` source on the snapshot ref. It records a stable item id, role, direct provenance and the identity's role baseline. A person with two roles receives two independent tasks and may keep one and deny the other. The evidence file retains each access/provenance/decision separately in `accessReviews`, without changing the historical minimal item projection.

Only the denied item's role produces a revoke action. Preparation and the pre-write gate compare the current role baseline. The final effective-state check requires that reviewed role to be absent on the campaign ref, and permits sibling reviewed roles to remain. New roles outside the baseline refuse finalization. Identity-only item selection is refused when ambiguous; the template passes stable item ids throughout.

Limits:
- This source models direct assignments only. No indirect application entitlements or group-derived access inventory is asserted. The database has no assignment generation id: revoke-and-regrant of an identical person/role between snapshots is not distinguishable from the same assignment remaining present.
- Campaigns cap at 200 items. The catalog template explicitly refuses a batch above 50 denied items or revoke actions BEFORE preparing any remediation item or revoking anything. It never runs a truncated 50-action subset. A campaign already reviewed beyond that limit remains open for reconciliation; use a narrower campaign or an explicitly complete larger-batch workflow. Other workflows and loop semantics are unchanged.
- Several denied roles of one person are revoked on the same run branch and published together once. Sequential publications against the original full baseline may fail closed and are not promised.
- Preparing several roles, human publication and verifying removal are separate steps. Concurrent directory changes can require fresh review; this is not a transaction spanning decision and publication.
- Roles absent from a person's source yield no access item in access mode, not an invented empty access. Person mode retains its legacy empty-role item behavior.
- This branch builds on the reliability fixes in PR #152. It does not merge them or replace the separate active-review authority changes in PR #143.
