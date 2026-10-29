# Hosted demo (free tier) and branch demos

Everything on this page uses free services only and fictional demo data. Nothing
here publishes production configuration: the demo users and their shared
password are fictional, signing keys and admin tokens are regenerated at every
boot, and the data set is re-seeded from `data/demo/01-schema.sql` on every
restart.

## Live demo

URL: <https://iam-poc-demo.onrender.com>

Verified on 2026-10-29 in a real browser (headless Chrome):

1. Open the URL. The Angular console shows "Not logged in".
2. "Sign in (browser flow)" redirects to the core login form on the same
   origin (`/core/authorize`), sign in as `demo-alice` with the fictional
   password `demo-only-not-a-secret`; the code + PKCE + state callback returns
   to `/callback` and the console shows the signed-in state.
3. "Assignments on Dolt main" lists the seeded rows.
4. Simulate a change: identity `demo-bob`, role `payment-approver`. The change
   is committed on a Dolt branch; the console shows the SoD violation
   (demo-bob already holds `payment-creator`) and `mergeable: false`.
   "Merge into main" is refused with a 409 SoD violation.
5. Simulate identity `demo-alice`, role `accountant`: no violation, merge
   succeeds, and "Activate current main" applies and journals the activation
   (`#1`, `event: disabled` because NATS is not part of the free demo scope).
6. The Plugins section lists the base plugins. The admin capability token is
   random per boot and printed in the service logs (Render dashboard > Logs).

### What the live demo is (and is not)

- One free Render web service (Docker, plan Free, 0.1 CPU / 512 MB) running a
  single container built from `demo/Dockerfile`: Dolt (seeded fictional
  data), the Rust core, the NestJS API, and the Angular console, all behind
  the same-origin static+proxy edge server `demo/server.mjs`.
- In-memory fallbacks: PostgreSQL, NATS, Temporal and OpenBao are NOT part of
  the free demo (`IAM_PG_URL` unset). Activation journaling falls back to
  memory and activation events are disabled; this is the minimal demo scope,
  not a full-stack deployment.
- Fictional users only: `demo-alice`, `demo-bob`, shared fictional password
  `demo-only-not-a-secret` (documented in `policies/` and the IdP crate).
- Memory footprint measured locally: about 300 MB RSS at idle for the whole
  stack (dolt ~88 MB, API ~131 MB, core ~24 MB, edge ~58 MB). During 8
  consecutive full flows (login, simulate, merge, activate) the per-process
  peaks stayed at dolt ~100 MB, API ~128 MB, core ~21 MB, i.e. no measurable
  growth under the demo load. This fits the 512 MB free instance with
  headroom, but it is not a load-test guarantee: treat ~200 MB as reserve.
  Dolt is capped with `GOMEMLIMIT=250MiB` and the API with
  `--max-old-space-size=192`.

### Free-tier limits (Render, verified on the dashboard and render.com/docs/free)

- The instance spins down after 15 minutes of inactivity; the next request
  waits for a cold start (Render states 50 seconds or more).
- Free web services include 750 instance-hours per month per workspace; one
  always-on service fits (744 h/month).
- The filesystem is ephemeral: on every restart or wake, Dolt is re-seeded
  from `data/demo/01-schema.sql` and all demo state (change branches,
  activations, tokens) resets. This is a demo property, not a bug.
- Cost: $0. Verified on the billing page: plan Hobby, no card on file, so an
  overage suspends the service and can never bill.

## Deploy your own (any branch)

The demo works with Git branches: the Render service simply builds whichever
branch it is pointed at.

1. Fork or push this repository (it can stay private) and connect it to
   Render with the Render GitHub App.
2. Create a new Web Service: Docker runtime, Dockerfile path
   `demo/Dockerfile`, build context `.`, health check path `/healthz`,
   branch of your choice (here: `demo`).
3. Set one environment variable: `IAM_PUBLIC_ORIGIN=https://<your-service>.onrender.com`.
   The start script derives the IdP issuer, the extra redirect URIs
   (`IAM_IDP_EXTRA_REDIRECT_URIS`) and the API issuer check from it. The
   console derives its API and core URLs from `location.origin`, so the whole
   demo is same-origin behind the edge server.
4. Deploy. Auto-deploy is disabled on this service; use Manual Deploy, or
   change the branch in Settings to demo another branch.

No secret is required in the service: Dolt credentials, admin tokens and the
IdP signing key are generated at boot (`demo/start.sh`).

## Branch demo in GitHub Codespaces (free quota)

For a branch-local, full-fidelity run (no hosting at all), the repository
carries a dev container:

- `.devcontainer/devcontainer.json` (Rust + Node + Dolt toolchain),
- `scripts/demo-setup.sh` (installs dependencies, seeds Dolt),
- `scripts/demo-start.sh` (starts Dolt sql-server, core, API and the console
  dev server with `apps/web/proxy.conf.json` proxying `/core`, `/api`,
  `/authorize`, `/token`, `/jwks.json`, `/.well-known`).

Open any branch in a Codespace (Code > Codespaces): the container builds
itself and `postCreateCommand` runs `demo-setup.sh` (several minutes: Rust and
npm builds). Then run `bash scripts/demo-start.sh` and open the forwarded
port 4200. On loopback (`http://localhost:4200`) the sign-in redirect is
registered by default; to SHARE the demo, set port 4200 visibility to Public
and `demo-start.sh` registers the Codespaces forwarded origin
(`https://<name>-4200.app.github.dev/callback`) with the IdP automatically.

Status: the dev container and scripts are configured and reviewed against the
hosted-demo environment contract (same issuer / redirect-URI derivation), but
this exact Codespaces path has NOT been exercised end-to-end in a real
Codespace yet. The hosted demo above is the verified path.

Personal GitHub accounts include a free monthly Codespaces quota (see GitHub's
billing documentation for current numbers); stop the Codespace when done so
the quota is not consumed.
