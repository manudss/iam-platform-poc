# iam-platform-poc

Private proof of concept for a new IAM/IGA platform. Design choices come from the architecture document
(stack: Angular, NestJS, Rust core, Dolt for versioned business data). No license has been granted for
redistribution.

## What exists and was tested
| Part | State |
|---|---|
| `core/` Rust: Cedar decision engine (forbid wins, errored policy = deny), WASM plugin runtime (fuel limit, no imports), HTTP `/health` and `/v1/decide` | 11 unit/integration tests pass (`cd core && cargo test`); the WASM hook is wired into `/v1/decide` when `IAM_PLUGIN_WAT` is set (tested in-process only, not in the HTTP end-to-end suite) |
| `apps/api` NestJS: health, in-memory activation journal (A,B,A = 3 activations), async plugin host with idempotent effects, `/access/check` proxy to the Rust core (fails closed) | 4 unit tests + 4 end-to-end tests pass (`cd core && cargo build -p iam-core`, then `cd apps/api && npm i && npm test`) |
| `data/demo/01-schema.sql` + `scripts/dolt-smoke.sh`: real Dolt 2.6.1 CLI (no Docker): seed, branch, simulated SoD violation, main untouched before merge, merge | script passes (`DOLT_BIN=/path/to/dolt scripts/dolt-smoke.sh`). Found and fixed a real bug: `sensitive` is a reserved word in Dolt |
| `apps/web` Angular: empty console shell | builds, 2 tests pass (`cd apps/web && npm i && npx ng test --watch=false`) |

## Real vs simulated
- Real in the end-to-end test: the Rust core binary (Cedar decisions) and the NestJS HTTP API.
- In-memory stand-ins (simulated): the activation journal (target: PostgreSQL), plugin effects (nothing is sent).
- Dolt: only via the CLI smoke script; NestJS does not read/write Dolt yet.
- Not present yet: PostgreSQL, Temporal, NATS, OpenBao running for real.

## Written but NOT run or verified
- `infra/docker-compose.yml` (Dolt, two PostgreSQL, Temporal, NATS JetStream, OpenBao dev). Never started: the authoring environment had no Docker.
- `proto/decision.proto` is a draft; no gRPC server yet.

## Not built yet
OIDC IdP module (code + PKCE, JWKS), gRPC between NestJS and Rust (HTTP JSON only today), NestJS Dolt read/write, Temporal workflows, NATS publisher,
SCIM/LDAP/CSV connectors, durable activation protocol, plugin packaging. The home-made IdP is the main security
work before any production use.

## Local use
1. `cp .env.example .env` and change the placeholder values (never commit `.env`).
2. `docker compose --env-file .env -f infra/docker-compose.yml up -d` (untested).
3. Core: `cd core && IAM_POLICY_FILE=../policies/demo.cedar cargo run -p iam-core`.
