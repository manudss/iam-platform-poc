# Activation journal qualification contract

PR161 deliberately separates the authenticated compatibility feed
`GET /api/tenants/:tenant/activations` (seq, commit) from the detailed administrator
journal at `/activations/journal`. The latter keeps AdminGuard, screen rights and
the current administrator sign-in assurance policy. Do not lower those guards or
raise a password-only session's declared level to make deployment pass.

The host qualification smoke still performs real password-only OIDC, PKCE,
issuer/audience, session verification, expected origins and negative redirect
checks. Its compatibility feed must now exactly match every seq/commit in an
independently read PostgreSQL journal for the same tenant. That read uses the
qualification account already required for preservation capture, not the web
session. Detailed tenant, sequence, commit, state, error and request ID validation
runs before the smoke. A second complete read after smoke must be identical or
qualification fails closed. The smoke archive records a hash of that complete
journal and the source coverage. PostgreSQL preservation checks remain unchanged.

The standalone activation-inventory utility now uses `/activations/journal` and
therefore requires a real administrator session satisfying the published policy.
Its password convenience path may fail with403 when stronger sign-in is required.
That is UNKNOWN, not an empty journal. Supply a suitable normal session via its
private stdin route. Never add a bypass or static-capability-only fallback.

This change does not unpause a deployment queue, remove maintenance, replay
activation, restart services or authorize any of those actions. The deployment
operator must inspect the preserved incident evidence and obtain the user's
approval before any recovery. No previous failed candidate is reclassified as
qualified by changing these scripts.

Local evidence for the reviewed change: 80 OCI Node tests,17 Python tests, API
TypeScript build and17 activation/admin-boundary tests pass without skips. The
actual generated journal SQL also ran on isolated local PostgreSQL with two
tenants and returned only the target tenant with its native columns. This is not
an isolated full deployment qualification or proof that the blocked host can
open. Remote CI is separate.

## Reviewed in-place recovery of an already installed image

If the exact failed pending source AND digest are still running and pass the
corrected qualification against the original pre-update evidence, the queue can
record a one-entry reviewed recovery chain. Its only outcome is `delivered`.
The exact source chain/main membership, state fingerprint, expected previous
cursor, authorization/evidence references, exact qualification attestation and
read-only Docker image/source checks still apply. A changed digest with the same
source is not in-place recovery and is refused.

The record stores `qualified-in-place`, preserves the original pending/failure
incident, advances the history to the actually observed image and retains
`resume_required`. The existing separate reviewed resume and external pause
remain. No updater is called.30 queue tests cover this path and refusals.

This is the minimal route for an image already installed whose only identified
failure was qualification. It is not permission to use it, a substitute for
integrity evidence or a path for installing a different image through an
inherited maintenance barrier. If the image fails the corrected qualification,
keep maintenance/pause and investigate instead of declaring it delivered.

## Distinct in-place protocol, success receipt and opening harness

The final protocol uses the separate `record-reviewed-in-place` command and
`reviewed-in-place` manifest kind. `reviewed-recovery` again requires at least two
entries, unchanged. A legacy executable refuses the new command/kind. The saved
format2 also makes format1-only readers fail closed. The in-place manifest binds
the complete original pending and failed objects. Historical failed records had
no digest, so they bind the original pending digest and failed SHA through that
exact incident and its fingerprint; if failed contains a digest it must match.
New failure records also retain their digest.

`qualification.py --receipt-file <fresh-private-path>` writes a success receipt
only after all checks and comparison/verifier succeed. It hashes the original
before, complete after and smoke files, image, policy and transport coverage.
The queue verifies those files and requires real TLS coverage. An after file
alone is never a success receipt. These local file checks preserve evidence but
are not a cryptographic attestation from an independent signer; the operator's
reviewed script provenance and authorization are still required.

`recover-in-place.py` is a separate stdin-manifest harness, never a sourced
updater. It takes both existing queue/updater locks, requires the external pause,
pins the qualification/helper bytes and original before file, verifies exact
former-owner token/PID absence, observes exact Docker identity, proves TLS503,
runs qualification, verifies the fresh receipt, and only then removes that exact
barrier and proves TLS200. It records the queue confirmation with resume_required
and leaves the pause untouched. Failed opening or queue recording, including a
catchable interruption, rearms the exact marker and proves503. A foreign marker
is never overwritten. Uncatchable kill or machine loss during the open-to-record
window still needs operator review; queue remains unresolved and paused. This is
not a crash-atomic transaction with the external front.

The smoke is NOT read-only: real login/session extension can append sessions and
audit. The authorized plan must name those effects. No activation replay,
container update, restart, policy rewrite, before replacement or improvised
transformation verifier is part of this harness. It remains draft pending an
independent final review and isolated full recovery rehearsal.

Final review hardening: recovery is armed before unlink so a signal immediately
after the syscall rearms the marker. Tests inject that exact interruption and
foreign-marker arrival. All incident/target/qualification-attestation/source
checks run before qualification/opening, then queue recording rechecks under
both locks. Manifest origins must equal the pinned policy origins. The executed
queue and harness, qualification pair, policy and original before are pinned and
rehash-checked after qualification.12 harness tests pass. File hashes and
operator references still do not authenticate the user's permission. Full
isolated recovery rehearsal is still required before a ready verdict.
