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
6. The Plugins section lists the base plugins; install/enable/disable works
   out of the box in the hosted demo: the admin capability token is random per
   boot and stays server-side (the edge server attaches it to proxied API
   calls), so visitors never see or type it. The "Admin capability token"
   console field can be left empty. In the local/Codespaces path instead,
   `demo-start.sh` prints the token for the operator to type into that field.

### Sign-in cold-start readiness (2026-11-11)

The demo start script now requires both the public methods list and the core's
Password only form to answer before it starts the edge. The methods request goes
directly to `:3000/tenants/acme-demo/signin/options` (no `/api` prefix). The former
warm-up called the wrong path, received 404 and treated it as success.
`demo/warm-signin.mjs` validates the JSON, then exercises core -> internal gate ->
`auth.prepare` over the real bus. It does not submit a username, password or
one-time code and does not mint a signed-in session. Three bounded attempts are
allowed; persistent failure stops startup instead of exposing a misleading green
edge health check. Sign-in proxy routes allow the configured core gate budget
plus 15 seconds; other proxy routes keep their existing budgets. No authentication
check is bypassed and a gate refusal remains a refusal.

Context: after the #83 deployment, the live free instance returned an upstream
timeout and then `sign-in is temporarily unavailable` during its cold start. It
recovered without any intervention. The exact cause of the transient gate refusal
was not established: both exact GHCR images (before #83, `5d3fac7`, and after,
`0f8e489`) passed the real local entry and login checks. The wrong warm-up route
and the 15-second proxy cutting off a 30-second gate budget are independently
reproduced defects, not evidence that #83 broke authentication.

After recovery, the deployed `0f8e489` passed one browser login, My applications ->
PeopleHub (OIDC), return to Lyam -> ExpenseFlow (SAML), and a second return plus a
new Lyam tab without another login. Consent was still explicit. This is a demo
validation, not a guarantee against future free-tier delays. Provider state is
still in memory and disappears on restart. Internal API/core logs remain in the
container's `/data` directory; Render Free has no web shell, so the public stdout
alone cannot explain every gate failure.

Run the readiness, slow-upstream and routing regression tests with
`node --test demo/*.test.mjs`. The demo Docker CI job also boots the actual image
and completes a real fictional-account login after readiness passes.

### What the live demo is (and is not)

- A public privacy policy page (French + English summary) is served at `/privacy`, no sign-in required; the e-mail sending configuration needs a reachable privacy URL.

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

   Several public origins can serve the same service (a custom domain next to
   the `*.onrender.com` URL). Sign-in then works on every one of them: the
   console builds its redirect URI from `location.origin`, and the start script
   registers each origin's `/callback` with the IdP
   (`demo/public-redirect-uris.mjs`). The `*.onrender.com` URL is picked up
   automatically from Render's own `RENDER_EXTERNAL_URL`; list any further
   origins (e.g. a retired custom domain) in `IAM_PUBLIC_ORIGIN_EXTRA`,
   comma-separated. Example with `IAM_PUBLIC_ORIGIN=https://lyam.dss.name`:
   sign-in works on both `https://lyam.dss.name` and
   `https://<your-service>.onrender.com`.
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

Status: verified end-to-end on 2026-10-29 in a real Codespace created on the
`demo` branch (2-core machine, free monthly quota): the dev container built,
`postCreateCommand` ran `demo-setup.sh` unattended (Dolt install, `cargo
build -p iam-core`, `npm ci` for API and web, Dolt seed), `demo-start.sh`
started Dolt + core + API + the console and auto-registered the public
forwarded origin with the IdP. With port 4200 set to Public, the full flow
worked on `https://<codespace>-4200.app.github.dev`: PKCE sign-in as
demo-alice, assignments read from Dolt main, and a simulation of demo-bob +
payment-approver showing the SoD violation with `mergeable: false` on a Dolt
change branch. The Codespace was deleted after the test so it stops consuming
the storage quota; recreating it is one click (Code > Codespaces > Create).

Personal GitHub accounts include a free monthly Codespaces quota (see GitHub's
billing documentation for current numbers); stop the Codespace when done so
the quota is not consumed.

## Administration and data on `feature/dolt-explorer` (29 October 2026)

Legacy mode: the Users page writes main directly. The hosted workspace mode described below supersedes this with branch staging and explicit Apply. A new account can actually sign in through the existing Rust code+PKCE flow: when its loopback authentication gate is configured, that gate is the credential authority rather than a second hard-coded Rust user list. The gate still runs the active password plugin (including the lockout replacement) and fails closed on errors. Without a gate, the standalone Rust prototype retains its original fictional users. All signed-in visitors of the hosted demo have administration capability; **do not put real users, passwords or personal data into this demo**. Disabling a user blocks new sign-ins; existing signed tokens expire normally within 300 seconds (not immediate revocation).

Passwords are submitted only through the dedicated user form. The server stores salted scrypt hashes in a mode-0600 file under `IAM_CREDENTIAL_FILE`, outside Dolt, its SQL explorer and commit history. Passwords and hashes are never returned by the user API. There is no production enrollment, password reset mail, MFA or role-based administration here. On a local full stack set `IAM_DIRECTORY_AUTH=1`, configure the existing loopback gate on both API and core, and choose a private persistent `IAM_CREDENTIAL_FILE`. Profiles stay in Dolt; restoring a profile commit does not restore passwords.

The hosted demo now sets `IAM_PLUGIN_STORE=dolt`. Installation migrations, seed rows, installed/enabled/fault state, explicit grants and non-secret settings are really stored in Dolt and reloaded on API startup. Tables `plugin_runtime_state`, `plugin_runtime_settings`, `plugin_runtime_migrations`, `plugin_runtime_seeds` and the installed `plg_*` tables are visible in the explorer. Runtime control-plane tables are read only in generic row editing and write SQL; change them through Plugins. A database PR cannot carry changes to runtime control-plane tables: it must use plugin administration, not grant escalation by SQL or merge. Only shipped non-secret plugin manifests are allowed in this adapter; a secret setting manifest is refused. PostgreSQL remains the full-stack adapter when `IAM_PG_URL` is set and Dolt mode is not selected. Activation journal, NATS, Temporal and OpenBao are still optional and not made persistent by this change.

Dolt's versioned `plugin_config` remains a **proposal** path, not an automatic mirror of runtime plugin state. Applying it still requires its existing explicit administration flow. Generic Dolt branch edits become current profile data only when merged into Dolt main. In legacy mode Users, Plugins and Assignments write main directly; in hosted workspace mode they all stage on the globally selected branch. Generic tables do not mint credentials; use Users to create a sign-in account.

The Data page now has table search, field search, local horizontal scrolling for wide rows, complete field-by-field row inspection, typed field editing with explicit NULL and a commit message. Reads after save show the committed branch data. Protected refs and runtime tables stay read only. SQL and all previous branch/history/PR safeguards remain.

**Persistence boundary:** restarting only the API with the same Dolt database and credential file preserves users and plugin state (tested). Render's free ephemeral disk is still lost on replacement, deployment or spin-down. This change is database persistence, **not durable hosting**. No paid disk or external Allegria database was added. For durable local use mount Dolt and the private credential file on persistent volumes; for free remote durability a separate IAM-owned external data service plus backups would need to be selected and configured. Do not point IAM at Allegria's databases.

Regression run: API 106 tests on real Dolt, Angular 25 unit tests, Rust core/IdP tests, `scripts/admin-data-e2e.mjs` (real Rust/API/Dolt/browser, create/update/login/disable, plugin DB state and API restart, field editing, desktop/mobile), `scripts/session-expiry-e2e.mjs` (real 12-second server expiry and key rotation). External PG/NATS/Temporal/OpenBao suites require their services; a passing command does not imply those external systems were exercised.


## Global working data branch and Apply (workspace mode, supersedes the legacy walkthrough above)

The hosted test demo sets `IAM_WORKSPACE_MODE=1`. After signing in, choose a data branch in the global administration bar or create one from main. This is a Dolt data branch, not the Git code branch. Users, plugin installation/settings/enablement, staged assignments, table editing and SQL writes belong to this selected branch. Main can be viewed but refuses administration writes. The server validates the branch header, so changing a page's local ref cannot silently write another branch. Branch switches remount page data, clear staged UI state, and ignore responses from the prior branch. Sign-out clears branch selection; no mutation is replayed on reconnect.

Use **Review & Apply**, inspect the changed tables, then **Apply to main** and confirm. Apply rechecks the working branch head, serializes with writes, performs a real Dolt merge, and rejects conflicts, constraint violations and SoD violations. A refused merge leaves main unchanged. Applied users and plugin configuration become live, and Apply activates the merged role/SoD snapshot in the Rust permission engine. Existing signed JWTs still expire within 300 seconds; Apply is not immediate session revocation.

Passwords prepared on a branch use immutable random credential revisions in a private mode-0600 file. Dolt stores only the revision reference, not the password or hash. The revision is bound to the user ID. The live sign-in gate reads main's user and credential revision only. Thus a new account cannot sign in before Apply, and a staged password change does not alter the live password until Apply. A discarded branch can leave unused hashed revisions in the ephemeral private file; this sandbox does not implement credential garbage collection.

The old per-change Merge route, data PR Merge-to-main and separate policy activation endpoints are disabled in workspace mode; Apply is the data publishing path. CSV/SCIM connector imports stage on the globally selected branch and require admin capability. The Activation page is a read-only journal: Apply publishes the merged role/SoD snapshot to the Rust permission engine. If activation fails after a successful merge, the UI reports the partial result and asks for a retry of Apply on the same branch; this retries activation without a second merge. A failed activation is journaled and retried against the unchanged main head; this is a partial-result protocol, not a distributed atomic transaction. The free demo resets its entire filesystem/journal on container replacement. Plugin control-plane tables and credential references remain forbidden in generic write SQL/row editing; use their validated administration pages.

Outside workspace mode the standalone prototype keeps its legacy behavior for its existing integration tests. A real workspace E2E runs with the flag and gate enabled: `DOLT_BIN=... CHROME_BIN=... node scripts/workspace-e2e.mjs /tmp/workspace-shots`. It proves branch isolation for users/plugins/passwords, pre/post-Apply sign-in, SoD refusal, conflicting Apply refusal, unchanged main after failure, wrong-branch writes refused, legacy publishing bypass refused, and mobile layout. All data remains fictional and resettable, as intended for this experiment; durable backup infrastructure is out of scope.
