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
