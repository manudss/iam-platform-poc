# Badge safety: isolated review candidate

Base: cumulative PR 135 at `90a46150e1cb7dc73b7e2807c9f3e6a3979aa0b5`.
This local branch is not integrated or independently qualified. Do not merge or run real badges from it on the strength of these tests alone.

## Identity creation provenance

`lyam-create-user` requires the tenant/run/node supplied by the engine, never a configurable ownership field. A nullable internal `workflow_creation_ref` column stores the SHA-256 digest of that execution tuple and identity. The marker and identity are written in the same INSERT on the run branch.

An existing identity is reusable only when its marker matches this execution. Historical unmarked identities and a new run targeting an identity created by another run fail closed. No automatic backfill or adoption is provided. Refusal precedes schema/data writes. A same-execution retry returns the stored email and checks that actual recipient, rather than trusting a newly supplied address.

This is lineage under the trusted database/operator boundary, not a signature against an operator who can rewrite database rows. UsersService public profiles and application events, and permission snapshots, exclude the marker. Generic operator/versioning reads may expose it. Typed row edits and SQL explicitly naming the marker cannot write it; this is not a complete defense against arbitrary SQL or database operators. Discard retains the current target's sensitive-column value when restoring named columns. Undoing a newly added identity removes the row and marker together. No editor field or graph was added.

## Read-only feasibility and current authority

The engine derives badge request/done mode from the stored graph, not an editable ownership flag. Request preflight runs before create-user writes; done preflight runs before correlation claim. It checks current-main publication authorization, workspace/live-engine/self-merge feasibility, current-main mail recipient policy and sender syntax, presence of the server mail key, and configured real managed connections. Real connection resolution is checked without probing the remote provider or creating effects.

Done preflight also checks the linked main account/email, creation-run ownership of every active block, mail target/body markers, temporary target/hours and the configured owned-block removal. Only fields knowable at that stage are substituted. Read-only correlation peek precedes the store's atomic claim. The account and link are read again after claim. A race fails closed but can leave that run's claim for reconciliation.

Before the temporary write, before publication, and inside the serialized publication precheck, the engine rehydrates the stored create/resolve output and reads current account/block state and policy. A resumed completed resolution is not fresh authority. Both actual mail blocks require a live main-policy reader, without a fallback to branch/cached settings. Existing final secret-mail state and reset checks remain. Generic temporary-password use outside the badge-done path has no new approval requirement. Badge templates/design are unchanged.

These checks do not reserve provider availability or make the whole journey atomic. In particular, late revocation or failure can leave a correlation claimed, a temporary credential written, or publication completed before later steps fail. Those are partial states to reconcile, not success and not permission to retry effects blindly.

## Publisher contract correction

The publisher previously extracted `name`, while real `VersioningService.diffSummary().tables` rows supply `table` and `from`. The isolated correction validates the array/row/name shapes, reads both rename sides, deduplicates names, compares forbidden names case-insensitively, and refuses malformed or failed reads before merge. Empty diffs retain the existing publication retry behavior. Human Apply behavior is unchanged.

Real-Dolt cases cover adding runtime settings, deleting a forbidden table, renaming away from it, renaming toward it, and a failed real diff read. Each refuses before merge with main unchanged. This demonstrates the tested refusal boundary, not a complete exploit chain on the previous source or a claim about a deployed system.

Other-consumer inspection: branch protection already reads `.table`, so it does not share the `.name` mismatch. Its assignments-only handling does not inspect `.from`; this lot does not modify it or claim an executed bypass. Pull-request/controller adapters inspected simply relay the summary.

## Bounded manual reconciliation

There is no automatic reconciliation command in this patch.

1. Stop the affected badge execution and preserve tenant, workflow/run/node IDs, branch/head, identity, ticket correlation and step statuses. Keep secrets out of the evidence.
2. For an unmarked historical identity or another-run identity, an authorized operator must verify the identity's ownership and actual provider/account state. Do not copy or manufacture a marker, adopt the row into a new run, or delete the identity merely to make create-user pass. Any migration/adoption requires a separately reviewed procedure outside this lot.
3. For a claimed correlation or partial credential/publication state, inspect the owning run, current main/activation, active blocks, temporary revision/expiry and ticket/sheet state. Preserve independent blocks. Do not release another run's claim or relaunch the whole workflow merely because it failed later.
4. If an external effect is uncertain, reconcile at the provider using the existing durable evidence/idempotency reference. Provider acceptance is not inbox delivery. Do not clear `EXTERNAL_EFFECT_REVIEW_REQUIRED` or blindly resend/create another ticket. Record the reviewed outcome and authorize only the specific missing action through a separate supported procedure.
5. If the supported tools cannot establish the state or repair it safely, keep the run blocked for operator review. This document is a triage boundary, not an authorization to edit production metadata, credentials or provider state.

## Local evidence and limits

TypeScript build passed. On the complete local source, 473 tests across every workflows spec and 127 tests across versioning/workspace/users passed: 600 total, zero failures, zero skipped tests. The newest cases include policy refusal without a live reader, stale branch settings versus current main, resumed resolution, and email/block changes before temporary write.

The workflow batch includes six new provenance-path cases using real Dolt and a local Rust core/NATS for merge, snapshot export and activation. Directory validation and registry calls in that fixture are doubles. The cases verify UsersService named upsert, marker preservation through publication/activation, snapshot exclusion, named-column undo, actual forbidden-table diffs and the bounded marker reservations. Earlier three real-Dolt create-user cases and connector HTTP/engine cases are in the same workflow batch. Mail providers and remote account/sheet/ticket effects are controlled test doubles or local targets, with fictional data.

This is not the complete API test suite, a CI run for this branch, full authentication qualification, remote-provider delivery, a production migration test or a whole-system cold-restart guarantee. The earlier green CI on PR 135 qualifies only that earlier exact head, not this patch. Independent review of this exact-base lot remains required.

No real badge/mail effect, remote account change, push, merge, deployment, dispatch, host, queue or pause action was performed for this lot. The separate authentication review and secured-reset readiness decision are outside this patch.
