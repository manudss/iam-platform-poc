# iam-platform-poc

Private proof of concept for a new IAM/IGA platform. Design choices come from the architecture document
(stack: Angular, NestJS, Rust core, Dolt for versioned business data). No license has been granted for
redistribution.

## What exists and was tested
| Part | State |
|---|---|
| `core/` Rust: Cedar decision engine (forbid wins, errored policy = deny), WASM plugin runtime (fuel limit, no imports), HTTP `/health` and `/v1/decide` | 16 unit/integration tests pass (incl. 5 for the IdP) (`cd core && cargo test`); the WASM hook is wired into `/v1/decide` when `IAM_PLUGIN_WAT` is set (tested in-process only, not in the HTTP end-to-end suite) |
| `apps/api` NestJS: health, in-memory activation journal (A,B,A = 3 activations), async plugin host with idempotent effects, `/access/check` proxy to the Rust core (fails closed) | 4 unit tests (guard overridden, logic only) + 11 end-to-end tests pass, incl. negative auth: no token, garbage, alg=none, tampered payload, expired, other issuer, wrong tenant (403); audience mismatch is implemented but NOT covered by a test (`cd core && cargo build -p iam-core`, then `cd apps/api && npm i && npm test`) |
| `data/demo/01-schema.sql` + `scripts/dolt-smoke.sh`: real Dolt 2.6.1 CLI (no Docker): seed, branch, simulated SoD violation, main untouched before merge, merge | script passes (`DOLT_BIN=/path/to/dolt scripts/dolt-smoke.sh`). Found and fixed a real bug: `sensitive` is a reserved word in Dolt |
| `core/crates/iam-idp` OAuth/OIDC-inspired authentication PROTOTYPE, not a standard OIDC flow (authorization code + PKCE S256, EdDSA tokens with tenant claim, JWKS, discovery document, fictional users) served by iam-core at `/authorize` (JSON), `/token` (JSON), `/jwks.json` | unit tests pass; the NestJS API verifies these tokens (signature via JWKS, issuer, audience, expiry, tenant) on every business endpoint through `AuthGuard`, no bypass switch. POC-only (local fictional demo mode, never a production configuration): in-memory key regenerated at each start, plain demo passwords, no sessions/MFA/passkeys/SAML/refresh/rotation, JSON instead of the form/redirect flow |
| `apps/web` Angular: empty console shell | builds, 2 tests pass (`cd apps/web && npm i && npx ng test --watch=false`) |

## Demo credentials
The demo users and their shared password are fictional and exist only for local runs (`policies/`, IdP crate). They must never be reused or presented as a real configuration.

## Real vs simulated
- Real in the end-to-end test: the Rust core binary (Cedar decisions) and the NestJS HTTP API.
- In-memory stand-ins (simulated): the activation journal (target: PostgreSQL), plugin effects (nothing is sent).
- Dolt: only via the CLI smoke script; NestJS does not read/write Dolt yet.
- Not present yet: PostgreSQL, Temporal, NATS, OpenBao running for real.

## Written but NOT run or verified
- `infra/docker-compose.yml` (Dolt, two PostgreSQL, Temporal, NATS JetStream, OpenBao dev). Never started: the authoring environment had no Docker.
- `proto/decision.proto` is a draft; no gRPC server yet.

## Not built yet
Standard OIDC (redirect/form flow, userinfo, refresh, MFA, passkeys), gRPC between NestJS and Rust (HTTP JSON only today), NestJS Dolt read/write, Temporal workflows, NATS publisher,
SCIM/LDAP/CSV connectors, durable activation protocol, plugin packaging. The home-made IdP is the main security
work before any production use.

## Local use
1. `cp .env.example .env` and change the placeholder values (never commit `.env`).
2. `docker compose --env-file .env -f infra/docker-compose.yml up -d` (untested).
3. Core: `cd core && IAM_POLICY_FILE=../policies/demo.cedar cargo run -p iam-core`.
