# Historical-source CI controls

The reusable CI workflow receives a target source SHA, but its workflow steps come from the calling revision. Newly introduced feature tests must not be silently absent or incorrectly demanded before their feature existed.

A shared `control_policy` job checks out the caller revision with full history, runs the current policy tests, and resolves one control plan. All five existing jobs depend on this job. Its outputs reach both API and demo-image checks. The plan is saved as an artifact with target and policy revision.

## Versioned feature controls

The policy pins the first main releases containing these controls:

- Password eye: `fa0acdc00895c96acfe52fb217864de101464b37`.
- Gallery bootstrap: `25a0898391422f0da8e9f88c562296ca1f867605`, whose source addition is commit `e2cab654752620db05681214cf652e4dd50c6903`.

A regular, nonempty script in the target makes its control mandatory, including earlier backports. An absent script is exempt only when the target is a proven **strict ancestor** of that release, recorded explicitly in the evidence. A missing script at or after introduction, an empty file, a symlink, unknown ancestry or a divergent target fails closed. Both target and introduction must belong to the caller-policy history.

The Gallery bootstrap script and its matching `docker cp` image-bundle extraction share one guarded step. The seeded Gallery browser end-to-end and popup checks remain mandatory; they are not the bootstrap control and are not removed for historical releases.

## Reference audit

Every referenced `scripts/`, `demo/` and `deploy/` JavaScript or Python source file is checked against the target tree. Only explicit caller-policy tools, the caller-owned automation checkout, and declared legacy-feature exemptions use another source. A new missing reference without a policy entry is an error. A legacy exemption without its matching workflow-step guard is also an error. The Gallery bundle copy must remain under its bootstrap guard.

The audit runs for the requested target and the first-parent boundary before each feature's introduction. This checks legacy wiring even when an ordinary PR run targets a current source with all scripts present. Future feature controls need their own reviewed applicability entry.

## Limits

Local policy and workflow-structure checks do not prove a remote reusable-workflow run with historical input. Full CI and an explicitly authorized qualification-only run remain necessary. Arbitrary unmerged source branches are outside this historical-release path.

This does not repair Gallery behavior, change host scripts/data, resolve a failed queue entry, unpause, drain, retry or authorize deployment. All existing non-feature-specific checks remain in place.
