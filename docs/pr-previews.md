# PR previews on Render (free tier)

Every pull request that targets this repository's default branch gets its own
hosted preview, the same way the demo at <https://iam-poc-demo.onrender.com> is
hosted, without touching the two standing services (`iam-poc-demo` in
`Production`, `iam-poc-explorer-test` in `dev`).

## What happens

- **PR opened / updated** (`.github/workflows/pr-previews.yml`, job `ensure`):
  one free Render web service named `iam-pr<N>` is created (or redeployed) in
  the **IAM POOC** project, `dev` environment. It builds the PR branch with
  `demo/Dockerfile`. Auto-deploy is OFF on the preview services: the
  workflow's explicit API deploy is the single trigger, so one push never
  starts two builds of the same commit. (all-in-one container: Dolt seeded with fictional data +
  Rust core + NestJS API + Angular console, health check `/healthz`). A comment
  on the PR carries the URL.
- **PR closed** (job `cleanup`): the service is deleted, and with it the
  embedded Dolt data. The comment is updated.

If the PR branch has no `demo/Dockerfile`, no service is created and the
comment says so.

## Security model

- `pull_request_target`: the workflow file and `scripts/render-pr-previews.mjs`
  always run from the **base** branch; PR code is never checked out or executed
  by the workflow. PRs from forks are ignored.
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

## Cost and limits (verified 2026-10-29)

- Render workspace: Hobby plan, no card on file, so an overage suspends
  services instead of billing. Usage then: 6 / 750 free instance-hours,
  118 / 500 pipeline minutes, $0 month to date.
- Each preview is one free web service (0.1 CPU / 512 MB, Frankfurt): it counts
  toward the shared 750 free instance-hours while running and spins down after
  15 minutes idle. Each branch update rebuilds the Docker image on Render
  (Rust + Node multi-stage build: it counts toward the 500 free pipeline
  minutes).
- GitHub Actions: the workflow itself runs a small Node script (seconds); it
  does not build anything on the runner.
