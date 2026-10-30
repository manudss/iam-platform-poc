# PR previews on Render (free tier)

Every pull request that targets this repository's default branch can get its own
hosted preview, the same way the demo at <https://iam-poc-demo.onrender.com> is
hosted, without touching the two standing services (`iam-poc-demo` in
`Production`, `iam-poc-explorer-test` in `dev`).

## Deploy on demand

**A push on a PR branch never starts a Render build.** Each Docker build of the
all-in-one demo costs roughly 10-20 of the 500 free pipeline minutes/month
shared by the whole Render workspace, and exhaustion blocks *every* build until
the monthly reset (observed 2026-10-30 on PR #7). So the preview builds only
when someone actually wants to test the branch:

- Comment `/preview` on the PR (works for the repository owner, members and
  collaborators), or
- Run **Actions > PR Previews > Run workflow** with the PR number.

The first demand creates one free Render web service named `iam-pr<N>` in the
**IAM POOC** project, `dev` environment, built from the PR branch with
`demo/Dockerfile` (all-in-one container: Dolt seeded with fictional data + Rust
core + NestJS API + Angular console, health check `/healthz`). Later demands
redeploy the latest commit of the branch. The PR comment always carries the URL
and the current state. Auto-deploy is OFF on the preview services: the
workflow's explicit API deploy is the single trigger, so one request never
starts two builds of the same commit.

## What happens on PR events

- **PR opened / updated** (`.github/workflows/pr-previews.yml`, job `ensure`):
  no build, no service creation. The status comment on the PR is created or
  refreshed (preview URL once it exists, how to deploy on demand).
- **`/preview` comment or manual dispatch** (jobs `refresh-comment` /
  `refresh-manual`): the service is created if needed, then the latest commit
  of the PR branch is deployed.
- **PR closed** (job `cleanup`): the service is deleted, and with it the
  embedded Dolt data. The comment is updated.

If the PR branch has no `demo/Dockerfile`, no service is created and the
comment says so.

## Security model

- `pull_request_target`, plus `issue_comment` and `workflow_dispatch` runs,
  always execute the **default/base branch** version of the workflow file and
  of `scripts/render-pr-previews.mjs`; PR code is never checked out or executed
  by the workflow. PRs from forks are ignored or refused.
- `/preview` requires a comment authored by an OWNER, MEMBER or COLLABORATOR.
- The head branch and commit a deploy builds are read back from the GitHub API
  by the script, never taken from event metadata.
- `RENDER_API_KEY` (repository secret) is only visible to this trusted
  workflow. The preview service itself receives exactly one environment
  variable, `IAM_PUBLIC_ORIGIN` (its own public URL): no infrastructure secret
  ever reaches the PR-built container. Dolt credentials, admin tokens and the
  IdP signing key are generated at boot by `demo/start.sh`, as in the standing
  demo.
- Render builds the PR code on its own builders, like any Render service.

## Setup (already done on this repository)

- Repository secret `RENDER_API_KEY`: a dedicated Render API key named
  `github-actions-iam-previews` (Render account settings > API Keys).
- Repository variables `RENDER_OWNER_ID` (workspace id) and
  `RENDER_ENVIRONMENT_ID` (`dev` environment of the IAM POOC project).

## Cost and limits (verified 2026-10-29, behavior updated 2026-10-30)

- Render workspace: Hobby plan, no card on file, so an overage suspends
  services instead of billing. Usage then: 6 / 750 free instance-hours,
  118 / 500 pipeline minutes, $0 month to date. On 2026-10-30 the pipeline
  minutes hit 504 / 500: builds are blocked until the monthly reset, services
  keep serving their last build.
- Each preview is one free web service (0.1 CPU / 512 MB, Frankfurt): it counts
  toward the shared 750 free instance-hours while running and spins down after
  15 minutes idle.
- Only the on-demand `/preview` deploys rebuild the Docker image on Render
  (Rust + Node multi-stage build: each one counts ~10-20 minutes toward the 500
  free pipeline minutes). Pushes, comments and cleanups cost no pipeline time.
- GitHub Actions: the workflow itself runs a small Node script (seconds); it
  does not build anything on the runner.
