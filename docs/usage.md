# Usage guide (local development only)

Everything here runs on one machine with fictional demo data. Nothing is a production configuration. Demo user passwords
(`demo-only-not-a-secret`) and dev tokens are public on purpose and protect nothing.

## 1. Prerequisites
- Rust (stable), Node.js 22+ and npm.
- Optional real services, each as a plain binary (no Docker needed): `dolt`, PostgreSQL (`initdb`/`postgres`), `nats-server`,
  `bao` (OpenBao), `temporal` (CLI dev server). Tests that need one are skipped with a message when its variable below is unset.

## 2. Build and run the whole POC (minimal path: core + API + Dolt + UI)
```bash
# Dolt data (needs `dolt`): seed the demo database, then serve it on port 3307
mkdir -p /tmp/iam-dolt && cd /tmp/iam-dolt
dolt config --global --add user.name poc && dolt config --global --add user.email poc@example.invalid
dolt sql < <repo>/data/demo/01-schema.sql
dolt sql-server --host 127.0.0.1 --port 3307 --data-dir /tmp/iam-dolt &

# Rust core (run from core/: the default policy path is ../policies/demo.cedar)
cd <repo>/core && cargo build -p iam-core -j2 && ./target/debug/iam-core &      # listens on 127.0.0.1:8081

# NestJS API
cd <repo>/apps/api && npm ci && npm run build
IAM_CORE_URL=http://127.0.0.1:8081 IAM_ISSUER=http://127.0.0.1:8081 node dist/main.js &   # port 3000

# Angular console (proxies /core -> 8081 and /api -> 3000, so no CORS)
cd <repo>/apps/web && npm ci && npx ng serve        # http://localhost:4200
```
In the console: sign in as `demo-alice` (password in README "Demo credentials"), simulate `demo-bob` + `payment-approver`
(SoD violation, merge refused), simulate `demo-alice` + `accountant` (mergeable, merge), then "Activate current main".

## 3. Configuration (environment variables)
| Variable | Component | Meaning (default) |
|---|---|---|
| `IAM_CORE_ADDR` | core | listen address (`127.0.0.1:8081`) |
| `IAM_ISSUER` | core, API | token issuer; must be identical on both sides |
| `IAM_POLICY_FILE` | core | Cedar policy file (`../policies/demo.cedar`) |
| `IAM_TOKEN_TTL_SECS` | core | token lifetime (300) |
| `IAM_PLUGIN_WAT` | core | WASM plugin (text format) run on `/v1/decide` |
| `IAM_CORE_URL` | API | core base URL |
| `IAM_AUDIENCE` | API | expected token audience (`demo-web`) |
| `API_PORT` | API | HTTP port (3000) |
| `DOLT_HOST/PORT/USER/PASSWORD/DATABASE` | API | Dolt SQL server (`127.0.0.1:3307`, `root`, empty, `iam`) |
| `IAM_PG_URL` | API | PostgreSQL URL: durable activation journal; unset = in-memory journal |
| `IAM_CORE_ADMIN_TOKEN` | core + API | shared admin token (>= 8 chars, local fictional value): enables `/v1/activate` on the core and core-apply in the API; unset = activation only journaled (`state: recorded`) |
| `IAM_NATS_URL` | API | NATS JetStream: publish `iam.activation.<tenant>` after activation |
| `IAM_BAO_ADDR`, `IAM_BAO_TOKEN` | API | OpenBao KV v2; `secret/iam/pg` field `url` supplies the PostgreSQL URL when `IAM_PG_URL` is unset |
| `IAM_TEMPORAL_ADDR` | API | Temporal frontend: enables `POST .../activation-workflows` |

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
| `POST /tenants/:t/activations` `{commit?}` | journals an activation (default: Dolt main head); re-activating an old commit is a new seq |
| `POST /tenants/:t/activations/reconcile` | compares the core's version with the latest activation and re-applies if different |
| `GET /tenants/:t/activations` | journal for the tenant |
| `POST /tenants/:t/activation-workflows` `{commit?}` | same, run as a Temporal workflow (needs `IAM_TEMPORAL_ADDR`) |

## 5. Plugins
See `docs/plugin-contract-v0.md`. Two kinds exist in the POC: a WASM decision hook in the core (fuel-limited, no imports) and an
async notification plugin host in the API (idempotent per activation). Packaging/distribution of plugins is not implemented.

## 6. Known gaps
See README sections "Written but NOT run" and "Not implemented".
