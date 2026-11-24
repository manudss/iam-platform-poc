# Detect deployment contract failures before merge

The existing CI already runs on pull requests, including drafts: core, API/real services/browser, web, compose, demo Docker build/health/sign-in/Gallery and versioned-control policy. A green PR is not proof that a later main run cannot fail. The Gallery persistence failure had already passed PR CI. Its separate synchronization fix is PR #147; this change does not replace that fix.

## Changes

Deployment-controller unit contracts move out of the late web job into `deployment_preflight`, a short job running alongside the versioned-control policy before any expensive build/integration jobs. They need no host credentials or host access. The current pinned-controller host guards run early too; the target-revision host guards still run in the web job, retaining historical application coverage. No suite is removed. A contract test checks PR lifecycle triggers, merge-queue coverage, exact target checkout, the fast dependencies, required test references and aggregate behavior. Mutations demonstrate refusal, and tests execute the aggregate's actual embedded JavaScript for failed, canceled, skipped and missing job outcomes.

The `premerge` aggregate runs with `always()` and succeeds only when every qualification job succeeded. It is a stable candidate for a required branch check, not a branch-protection rule by itself. The workflow also handles `merge_group/checks_requested`, without enabling a merge queue. New pushes cancel obsolete runs for the same PR rather than using a different concurrency group per SHA. Main/deployment reusable calls keep separate run/SHA groups, preserving the ordered queue's independent qualifications.

## SHA boundaries remain explicit

PR application checks deliberately test GitHub's synthetic merge commit (`github.sha`), proving integration with the current base. The PR image workflow builds the immutable PR head. After merge, main and reusable deployment qualification use their exact requested SHA. The controller unit tests are pinned to `github.workflow_sha` in a separate directory, so historical application qualification does not silently lose current controller checks. Receipts and host verification remain mandatory. This PR does not substitute a PR-head image for an exact main image, suppress deployment CI or claim equality between a synthetic merge SHA and a PR head SHA.

## Repository settings: separate owner decision

At inspection on 2026-11-22, GitHub's branch endpoint reported `protected: false` for main and the ruleset list was empty. Reading the detailed legacy protection endpoint returned 403 with the available credential. No repository settings have been changed. The proposed owner action after this PR's checks are established is to require `premerge` for main and require an up-to-date branch, with the desired administrator/bypass policy reviewed explicitly. Until that setting is applied, a failed check is visible but this code alone cannot prevent an authorized manual merge.

No host changes, queue/pause operations, paid services, live provider calls, deployments or merges are part of this change. Final deployment checks remain as a second safety net. Stubbed host contracts are not evidence of a live migration, cold restart or real provider/demo success.
