# PR previews on Render (free tier), prebuilt images

Every pull request that targets this repository's default branch can get its own
hosted preview, the same way the demo at <https://iam-poc-demo.onrender.com> is
hosted, without touching the two standing services (`iam-poc-demo` in
`Production`, `iam-poc-explorer-test` in `dev`).

## Prebuilt images: GitHub builds, Render only pulls

Since 2026-11-08 the all-in-one demo image is **built on GitHub Actions** and
pushed to **GHCR** (`ghcr.io/manudss/iam-platform-poc:<commit sha>`); Render
services are **image-backed** and only pull and start it.

Why: a Docker build of the all-in-one demo on Render costs roughly 10-20 of the
**500 free build pipeline minutes/month** shared by the whole workspace
(pricing: <https://render.com/pricing> - pipeline minutes meter *builds*, not
deploys of prebuilt images), and exhaustion blocks *every* build until the
monthly reset (observed 2026-10-30 on PR #7). GitHub-hosted runners are free
and unlimited on a public repo, and GHCR storage/bandwidth are free for public
images, so building there removes the bottleneck entirely:

| | before (git-backed) | now (image-backed) |
|---|---|---|
| `/preview` latency | ~10-20 min Render build | ~1-3 min image pull + boot |
| Render pipeline minutes | ~10-20 per deploy | 0 (no build) |
| GitHub minutes | - | free on a public repo |

`.github/workflows/demo-image.yml` builds `demo/Dockerfile` on every push to
`main` and on every (same-repo) PR head, with the GitHub Actions build cache
(`type=gha, mode=max`) and BuildKit cache mounts in the Dockerfile (cargo
registry/target, npm cache), so rebuilds only redo what changed. Tags: the full
commit SHA (immutable, the one previews deploy), `pr-<N>` (moving), and
`latest` (main only). `workflow_dispatch` with an optional `ref` is the
backstop when a commit's image is missing.

The GHCR package is **public** (one-time toggle in the package settings after
the first push): Render pulls it anonymously, no credential to maintain.

## Deploy on demand

**A push on a PR branch never deploys anything.** The preview deploys only
when someone actually wants to test the branch:

- Comment `/preview` on the PR (works for the repository owner, members and
  collaborators), or
- Run **Actions > PR Previews > Run workflow** with the PR number.

The first demand creates one free Render web service named `iam-pr<N>` in the
**IAM POOC** project, `dev` environment, **image-backed**
(`ghcr.io/manudss/iam-platform-poc:<head sha>`, health check `/healthz`,
0.1 CPU / 512 MB, spins down after 15 min idle). Later demands repoint it at
the latest commit's image and redeploy. The PR comment always carries the URL
and the current state. Auto-deploy is OFF on the preview services: the
workflow's explicit API deploy is the single trigger. A legacy git-backed
`iam-pr<N>` service is deleted and recreated image-backed on the next
`/preview` (the embedded Dolt data is fictional and disposable).

If the image for the head commit is not on GHCR yet (its build usually started
on the push itself), the refresh waits for the build run, and dispatches it as
a last resort. If the build fails, the PR comment says so and Render is never
touched.

## What happens on PR events

- **PR opened / updated** (`.github/workflows/pr-previews.yml`, job `ensure`):
  no deploy, no service creation. The status comment on the PR is created or
  refreshed (preview URL once it exists, how to deploy on demand).
- **`/preview` comment or manual dispatch** (jobs `refresh-comment` /
  `refresh-manual`): the service is created if needed, pointed at the head
  image, and deployed.
- **PR closed** (job `cleanup`): the service is deleted, and with it the
  embedded Dolt data. The comment is updated.

If the PR branch has no `demo/Dockerfile`, no service is created and the
comment explains why. The orchestration itself
(`scripts/render-pr-previews.mjs`) is unit-tested with a mocked network by
`.github/workflows/pr-previews-selftest.yml`.

## Security model

- `pull_request_target`, plus `issue_comment` and `workflow_dispatch` runs,
  always execute the **default/base branch** version of the workflow file and
  of `scripts/render-pr-previews.mjs`; PR code is never checked out or executed
  by those workflows. PRs from forks are ignored or refused.
- `/preview` requires a comment authored by an OWNER, MEMBER or COLLABORATOR.
- The head branch and commit a deploy serves are read back from the GitHub API
  by the script, never taken from event metadata.
- `RENDER_API_KEY` (repository secret) is only visible to the trusted
  workflow. The preview service itself receives exactly one environment
  variable, `IAM_PUBLIC_ORIGIN` (its own public URL): no infrastructure secret
  ever reaches the PR-built container. Dolt credentials, admin tokens and the
  IdP signing key are generated at boot by `demo/start.sh`, as in the standing
  demo.
- The `Demo image (GHCR)` workflow builds the PR's Dockerfile with a
  `packages: write` GITHUB_TOKEN, on same-repo PRs only (fork PRs are skipped):
  the same trust boundary as the repository's other CI.

## Setup (already done on this repository)

- Repository secret `RENDER_API_KEY`: a dedicated Render API key named
  `github-actions-iam-previews` (Render account settings > API Keys).
- Repository variables `RENDER_OWNER_ID` (workspace id) and
  `RENDER_ENVIRONMENT_ID` (`dev` environment of the IAM POOC project).
- One-time, after the first image push: the GHCR package
  `iam-platform-poc` is switched to **public** (package settings > Change
  visibility) so Render pulls it without a credential.

## Cost and limits

- Render workspace: Hobby plan, no card on file, so an overage suspends
  services instead of billing. On 2026-10-30 the pipeline minutes hit
  504 / 500: builds were blocked until the monthly reset, services kept
  serving their last build. Prebuilt images remove this class of failure:
  image-backed deploys consume no build pipeline minutes.
- Each preview is one free web service (0.1 CPU / 512 MB, Frankfurt): it counts
  toward the shared 750 free instance-hours while running and spins down after
  15 minutes idle.
- GitHub Actions: the image build is the only heavy job (minutes per push,
  free on a public repo); the preview workflows themselves run a small Node
  script (seconds, plus the deploy watch on demand).

## Migrating the standing services (`iam-poc-demo`)

The production demo still builds from git today; switching it is a one-time
manual step, deliberately NOT automated here:

1. Let the `Demo image (GHCR)` workflow build `main` (it runs on every push).
2. In the Render dashboard, on `iam-poc-demo` (**Production**): switch the
   service to a prebuilt image, URL `ghcr.io/manudss/iam-platform-poc:latest`
   (or pin a SHA tag for reproducibility), keep plan/region/health check
   (`/healthz`) and env vars.
3. Trigger one deploy and verify `/healthz` and the sign-in flow.

After that, each push to `main` rebuilds `latest`; deploys stay manual
(dashboard button or the service's deploy hook) so a merge never takes the
demo down on its own. Rollback = redeploy the previous SHA tag (kept on GHCR).
