# Usage guide (local development only)

Everything here runs on one machine with fictional demo data. Nothing is a production configuration. Demo user passwords
(`demo-only-not-a-secret`) and dev tokens are public on purpose and protect nothing.

Step-by-step install/configure/run guide (Windows PowerShell and bash, Docker-based infrastructure): [local-setup.md](local-setup.md).

## 1. Prerequisites
- Rust (stable; on Windows the MSVC toolchain + C++ Build Tools), Node.js 22+ and npm.
- Either Docker (Compose v2) for the infrastructure (recommended, see [local-setup.md](local-setup.md)), or the plain binaries below.
- Optional real services, each as a plain binary (no Docker needed): `dolt`, PostgreSQL (`initdb`/`postgres`), `nats-server`,
  `bao` (OpenBao), `temporal` (CLI dev server). Tests that need one are skipped with a message when its variable below is unset.

## 2. Build and run the whole POC (minimal path: core + API + Dolt + UI)
With Docker instead of a local `dolt` binary: replace the Dolt block below by
`docker compose --env-file .env -f infra/docker-compose.yml up -d` (Dolt on 127.0.0.1:3307, seeded from `data/demo/`) and start the
API with `DOLT_PASSWORD=<DOLT_ROOT_PASSWORD from .env>` (plus `IAM_PG_URL=postgres://postgres:<RUNTIME_PG_PASSWORD>@127.0.0.1:5433/runtime`
for a durable journal). Details and PowerShell equivalents: [local-setup.md](local-setup.md).

Without Docker (bash):
```bash
# Dolt data (needs `dolt`): seed the demo database, then serve it on port 3307
mkdir -p /tmp/iam-dolt 
cd /tmp/iam-dolt
dolt config --global --add user.name poc 
dolt config --global --add user.email poc@example.invalid
dolt sql < <repo>/data/demo/01-schema.sql
dolt sql-server --host 127.0.0.1 --port 3307 --data-dir /tmp/iam-dolt &

# Rust core (run from core/: the default policy path is ../policies/demo.cedar)
cd <repo>/core 
cargo build -p iam-core -j2 
./target/debug/iam-core     # listens on 127.0.0.1:8081

# NestJS API
cd <repo>/apps/api 
npm ci 
npm run build
IAM_CORE_URL=http://127.0.0.1:8081 IAM_ISSUER=http://127.0.0.1:8081 node dist/main.js &   # port 3000

# Angular console (proxies /core -> 8081 and /api -> 3000, so no CORS)
cd <repo>/apps/web 
npm ci 
npx ng serve        # http://localhost:4200
```
In the console: click "Sign in (browser flow, recommended)": you go to the core login form (http://127.0.0.1:8081/authorize, loopback), sign in as `demo-alice` (password in README "Demo credentials"), and come back to http://localhost:4200/callback; the console checks `state` and the PKCE verifier, exchanges the code, clears the URL and shows the data (the old JSON login stays under "Legacy JSON login (diagnostic only)"). Use `localhost` (not 127.0.0.1) for the console URL: the registered redirect_uri is `http://localhost:4200/callback`. Then, simulate `demo-bob` + `payment-approver`
(SoD violation, merge refused), simulate `demo-alice` + `accountant` (mergeable, merge), then "Activate current main".

## 3. Configuration (environment variables)
| Variable | Component | Meaning (default) |
|---|---|---|
| `IAM_CORE_ADDR` | core | listen address (`127.0.0.1:8081`) |
| `IAM_CORE_GRPC_ADDR` | core, api | core: also serve gRPC `Decision/Decide` on this `host:port` (plaintext, no TLS/auth: always bind 127.0.0.1 or a private network, never a public interface; there is no default, it is off unless set). api: `/access/check` calls the core over gRPC instead of HTTP when set |
| `IAM_ISSUER` | core, API | token issuer; must be identical on both sides |
| `IAM_POLICY_FILE` | core | Cedar policy file (`../policies/demo.cedar`) |
| `IAM_POLICY_SCHEMA` | core | Cedar schema the rules are validated against at load (`../policies/demo.cedarschema` by default when it exists; a set but unreadable/invalid schema refuses the start) |
| `IAM_TOKEN_TTL_SECS` | core | token lifetime (300) |
| `IAM_PLUGIN_WAT` | core | WASM plugin (text format) run on `/v1/decide` |
| `IAM_CORE_URL` | API | core base URL |
| `IAM_AUDIENCE` | API | expected token audience (`demo-web`) |
| `API_PORT` | API | HTTP port (3000) |
| `DOLT_HOST/PORT/USER/PASSWORD/DATABASE` | API | Dolt SQL server (`127.0.0.1:3307`, `root`, empty, `iam`) |
| `IAM_PG_URL` | API | PostgreSQL URL: durable activation journal; unset = in-memory journal |
| `IAM_CORE_ADMIN_TOKEN` | core + API | shared admin token (>= 8 chars, local fictional value): enables `/v1/activate` on the core and core-apply in the API; unset = activation only journaled (`state: recorded`) |
| `IAM_PLUGIN_PACKAGE` / `IAM_PLUGIN_TRUSTED_KEYS` | core | signed WASM plugin package dir and trusted publisher public keys (core refuses to start on any verification failure) |
| `IAM_CORE_STATE_DIR` | core | directory where each tenant's active version is persisted and reloaded at start |
| `IAM_RECONCILE_INTERVAL_MS` | API | >= 200: periodic outbox relay + reconcile of every tenant (PostgreSQL journal only) |
| `IAM_BAO_ADDR`, `IAM_BAO_TOKEN` | API | OpenBao KV v2; `secret/iam/pg` field `url` supplies the PostgreSQL URL when `IAM_PG_URL` is unset |
| `IAM_TEMPORAL_ADDR` | API | Temporal frontend: enables `POST .../activation-workflows` |
| `IAM_API_ADMIN_TOKEN` | API | 16+ chars, local only: enables `POST /access/simulate` (header `x-api-admin-token`) |
| `IAM_EFFECTS`, `IAM_NOTIFY_SINK_URL`, `IAM_PROVISION_TARGET_URL` | API | notification/provisioning effects to loopback demo targets (see below) |

With the compose stack (`.env` from `.env.example`): `DOLT_PASSWORD` = `DOLT_ROOT_PASSWORD`,
`IAM_PG_URL=postgres://postgres:<RUNTIME_PG_PASSWORD>@127.0.0.1:5433/runtime`, the core bus (`IAM_BUS_NATS_URL` + `IAM_BUS_NATS_PASSWORD` + `IAM_CORE_URL` + `IAM_CORE_ADMIN_TOKEN`),
`IAM_TEMPORAL_ADDR=127.0.0.1:7233`, `IAM_BAO_ADDR=http://127.0.0.1:8200` + `IAM_BAO_TOKEN` = `BAO_DEV_ROOT_TOKEN`.

## 4. HTTP API (all business routes need `Authorization: Bearer <id_token>`)
Authentication prototype (OAuth/OIDC-inspired, JSON instead of redirects/forms, not standard OIDC), served by the core:
- `POST /authorize` `{client_id:"demo-web", redirect_uri:"http://localhost:4200/callback", code_challenge, username, password}` -> `{code}`
- `POST /token` `{code, code_verifier, redirect_uri, client_id}` -> `{id_token, ...}` (EdDSA JWT: iss, aud, sub, iat, exp, tenant)
- `GET /jwks.json`, discovery document. `code_challenge` = base64url(SHA-256(code_verifier)) (PKCE S256).

Business API (NestJS). The `AuthGuard` checks signature (JWKS), issuer, audience, expiry and that the token tenant equals `:tenant`
(otherwise 401/403). No bypass switch exists.
| Route | Effect |
|---|---|
| `GET /health` | liveness (public) |
| `POST /access/check` | proxy to the core decision engine; fails closed (502) |
| `GET /tenants/:t/assignments` | role assignments on Dolt main |
| `POST /tenants/:t/changes` `{identity, role}` | creates a Dolt branch, adds the assignment, runs the SoD check, commits on the branch only |
| `POST /tenants/:t/changes/:branch/merge` | re-checks SoD; 409 if violated; else merges into main |
| `POST /tenants/:t/connectors/csv` `{csv}` | CSV connector (header `identity_id,display_name,manager_id,department,role_id`, <=500 rows, <=100 KB): same branch + SoD flow |
| `POST /tenants/:t/activations` `{commit?, requestId?}` | journals and applies an activation (default: Dolt main head); a new request (or none) is always a new seq, even for an old commit; the same `requestId` retried is idempotent (same seq, no new effect) |
| `POST /tenants/:t/activations/reconcile` | compares the core's version with the latest activation and re-applies if different |
| `GET /tenants/:t/activations` | journal for the tenant |
| `POST /tenants/:t/connectors/scim` `{Resources:[...]}` | SCIM 2.0-like import (subset) onto a Dolt branch with SoD simulation; returns `skipped` count |
| `POST /tenants/:t/activation-workflows` `{commit?}` | same, run as a Temporal workflow (needs `IAM_TEMPORAL_ADDR`) |

## 5. Plugins
See `docs/plugin-contract-v0.md`. Two kinds exist in the POC: a WASM decision hook in the core (fuel-limited, no imports) and an
async notification plugin host in the API (idempotent per activation). Packaging/distribution of plugins is not implemented.

## 6. Known gaps
See README sections "Written but NOT run" and "Not implemented".

## Decision audit
`POST /access/check` (bearer token) records every answer. Read it: `curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:3000/tenants/acme-demo/audit?limit=50` (newest first, only your token's tenant). Set `IAM_PG_URL` for the durable PostgreSQL table `decision_audit`; without it the audit lives in memory only.

## Notification manager and provisioning (local demo targets)
Start any two local HTTP receivers (the tests show a minimal one), then run the API with `IAM_EFFECTS=1 IAM_PG_URL=...` plus the core bus variables and `IAM_NOTIFY_SINK_URL=http://127.0.0.1:<port> IAM_PROVISION_TARGET_URL=http://127.0.0.1:<port>`. Each activation of a Dolt commit then sends one notification per changed role (to a fictional manager address, nothing is delivered to a person) and one PUT/DELETE per granted/revoked role. Non-loopback URLs are refused. Status per effect: table `effects` in PostgreSQL.

## Browser sign-in (IdP prototype) and agent demo
Recommended path: the Angular console above (it IS the client of the browser flow, validated by `scripts/ui-e2e.mjs`). Diagnostic alternative without Angular: `cd core && cargo run -p iam-core`, then `node scripts/demo-client.mjs` and open `http://localhost:4200/start` (same port 4200: do not run it together with `ng serve`); it prints `SIGNED IN (token exchange ok)` without showing the token. Wrong redirect_uri, `plain`, missing `state` give a 400 page and never a redirect. The JSON `/authorize` + `/token` endpoints still exist (legacy, used by the API test suites).
Agent demo: `POST /agent/delegations` (user bearer; JSON `agent_id`, `tools` among `read-report`, `approve-payment` (both simulated), optional `ttl_seconds` <= 600, `max_calls` <= 20; the principal is the token subject, a body `principal`/`context`/`tenant_mode` is refused; activate a data version first, tenant mode denies without one) returns a `delegation` secret. The agent calls `POST /agent/tools/call` with header `x-agent-delegation: <secret>` and JSON `{"tool":"read-report"}`. Results are simulated. Audit rows have `source: agent` (`GET /tenants/:tenant/audit`).

`POST /access/check` decides as the token subject in tenant mode (body principal/tenant other than yours = 403; roles/sod_conflict are ignored). What-if decisions as another identity: `POST /access/simulate` with `x-api-admin-token` (set `IAM_API_ADMIN_TOKEN`, 16+ chars, local only).

See also [docs/session.md](session.md): configurable session length, timer bar and "Stay signed in".

## Roles and assignment management

The **Roles** page is a searchable catalogue. Open a role to inspect its **Members**,
**Grants**, **SoD rules** and **Settings** tabs. Members can be searched by name/id
and department. Add or remove members on the selected working branch. Settings
keep role IDs immutable; assigned roles and roles named in a SoD rule cannot be
deleted. Removing a SoD rule requires confirmation because it loosens a control.

The **Assignments** page is an access search console, not a second profile editor.
Search people by name, id, e-mail, department or role. Combine department,
organization membership, held role and sign-in status filters. Quick views show
people without a role, people with SoD conflicts, or people whose assignments
changed against the working branch's merge base with main. The staged view reports
an unavailable or truncated diff instead of pretending the comparison is complete.
Open **Manage roles** to use the shared role editor. The same editor is available
under **Roles & rights** in an existing user's drawer. Assignment buttons stage
immediately and separately from **Save user**. Creating a user does not grant a role.

**Bulk edit matrix** is for an explicit scope: choose up to 100 people with the same
search/facets and up to 20 role columns, then open the matrix. Selections survive
filter changes; the page states how many selected people are hidden by the filters.
Unselecting a person or column discards that part of the local edits. Unchanged
cells are not written. Red cells flag existing SoD conflicts; conflicting additions
are disabled, including conflicts with roles outside the chosen columns. Remove
an incompatible role before adding its counterpart. Column actions skip conflicts
and report the count. Review the exact additions/removals before staging. One
batch (up to 1000 changed cells) is validated before any mutation and produces one
assignment commit. A failed server write resets the working set through the
existing versioning write guard. All paths are read-only on main. Switching data
branches clears the matrix selection, local edits and open role/assignment drawers.

**Grants / Resulting rights are policy references, not an authorization result.**
The UI lists Cedar rules explicitly mentioning a role and preserves the effect,
action identifiers, conditions and source. It does not evaluate Cedar, promise
unconditional rights, or infer access from a role's label. Other rules can apply;
forbid wins and resource/context conditions still matter. Use Policies to inspect
and simulate, and Review & Apply to run the authoritative publication checks.

Scope limits: the POC has no directory group model or assignment expiry field.
There is no group facet, expiry quick view or temporary-access control. In
particular it does **not** automatically remove a role on a date. Those need a
separate model and permission-engine change, not a cosmetic date input. Organization
and policy features are plugin-backed: when unavailable their controls or sections
say so. All examples use the existing fictional demo seeds, never real identities.

API: `POST /tenants/:tenant/workspace/assignment` and `/unassignment` accept
`{identity,role}`. `POST /tenants/:tenant/workspace/assignments` accepts
`{ops:[{identity,role,assigned:boolean}]}`. All three retain authentication, admin
capability, working-branch validation, identity/role existence checks and the
versioned write guard. Staging may contain SoD conflicts; Apply refuses them.
