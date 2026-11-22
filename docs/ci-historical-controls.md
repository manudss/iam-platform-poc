# Historical-source CI controls

The reusable CI workflow receives a target source SHA. Its workflow steps come from the calling revision, which may be newer than that source. A newly added feature-specific test must not be silently absent or incorrectly demanded before its feature existed.

The API job now checks out the caller revision with full history first. It runs the current control-policy regression tests and resolves a control plan before checking out the exact target source. The plan is saved as a CI artifact with the target and policy revision.

## Password-eye control

The policy pins the first main release containing the password-eye regression to `fa0acdc00895c96acfe52fb217864de101464b37`.

- A regular, nonempty control script in the target source makes the control mandatory, including earlier backports.
- An absent script is exempt only when the target is a proven **strict ancestor** of that release. The evidence records this reason explicitly.
- An absent script at the release or later, an empty file, a symlink, unknown ancestry, unavailable objects or a divergent target fails the policy.
- Both target and introduction must be in the caller-policy history. Arbitrary unmerged branch qualification is intentionally outside this historical-release path.

This is not a file-existence skip. New policy tests run even when a historical source legitimately predates the feature. The existing migration, event inventory, API, core, web, compose, browser and security checks remain unchanged. Future feature-specific controls need their own reviewed applicability entry; this change does not infer policy for them automatically.

## Limits

A local control-plan test is not a successful remote reusable-workflow execution. The full workflow and historical qualification-only mode still need CI evidence. This policy does not repair Gallery behavior, deployment queue state or a host database difference. It cannot unpause, drain, retry, resolve a failed entry or authorize deployment.
