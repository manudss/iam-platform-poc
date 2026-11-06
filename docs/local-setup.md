# Local setup (step by step)

Local development only, fictional demo data. All passwords/tokens below are the public placeholder values of `.env.example`
and protect nothing. Commands are given for **Windows PowerShell** (primary) and **bash** (Linux/macOS).

Recommended path: infrastructure in Docker (`infra/docker-compose.yml`), the three application processes run natively:

| Process | Port | Started from |
|---|---|---|
| Rust core (decisions + IdP prototype) | `127.0.0.1:8081` | `core/` |
| NestJS API | `127.0.0.1:3000` | `apps/api/` |
| Angular console (proxies `/core` -> 8081, `/api` -> 3000) | `http://localhost:4200` | `apps/web/` |
| Dolt SQL (container, seeded with `data/demo/01-schema.sql`) | `127.0.0.1:3307` | compose |
| PostgreSQL runtime (container: journal, outbox, audit) | `127.0.0.1:5433` | compose |
| Temporal / NATS JetStream / OpenBao dev (containers) | `7233` / `4222` / `8200` | compose |

## 1. Install the prerequisites (once)

| Tool | Version | Windows | Check |
|---|---|---|---|
| Git | any | `winget install Git.Git` | `git --version` |
| Docker Desktop (Compose v2) | recent | `winget install Docker.DockerDesktop`, then start it | `docker version` |
| Node.js + npm | 22+ (24 works) | `winget install OpenJS.NodeJS.LTS` (or Volta) | `node -v` |
| Rust (stable, MSVC toolchain) | stable | `winget install Rustlang.Rustup` | `cargo --version` |
| MSVC C++ Build Tools (needed by Rust on Windows) | 2022 | `winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` | - |

Open a **new** terminal after installing Rust so `cargo` is on the `PATH`. On Linux/macOS: `curl https://sh.rustup.rs -sSf | sh`,
Node 22+ from your package manager / nvm, Docker Engine + compose plugin.

`dolt`, `psql`, `nats-server`, `bao` and `temporal` binaries are NOT needed in this path (they run in containers). They are only
needed for the test suites described in `docs/e2e.md`.

## 2. Configure

```powershell
# from the repository root
Copy-Item .env.example .env        # bash: cp .env.example .env
```
Edit `.env` if you like (local values only, never commit it, it is git-ignored):

| Variable in `.env` | Used by | Must be repeated in |
|---|---|---|
| `DOLT_ROOT_PASSWORD` | Dolt container (`root` user) | API: `DOLT_PASSWORD` |
| `RUNTIME_PG_PASSWORD` | runtime PostgreSQL (`postgres` user, db `runtime`) | API: `IAM_PG_URL` |
| `TEMPORAL_PG_PASSWORD` | Temporal's own PostgreSQL | - |
| `BAO_DEV_ROOT_TOKEN` | OpenBao dev root token | API: `IAM_BAO_TOKEN` (optional) |

The commands below assume the unchanged placeholder `dev-only-change-me`; replace it everywhere if you changed `.env`.

## 3. Install the application dependencies and build (once, then after each pull)

```powershell
cd core;      cargo build -p iam-core;        cd ..     # first build takes several minutes
cd apps\api;  npm ci; npm run build;          cd ..\..
cd apps\web;  npm ci;                          cd ..\..
```
bash: same commands with `/` and `&&`.

## 4. Start (4 terminals, all from the repository root)

### Terminal 1: infrastructure
```powershell
docker compose --env-file .env -f infra/docker-compose.yml up -d
docker compose --env-file .env -f infra/docker-compose.yml ps      # 6 services "running"
# Check the Dolt demo seed (1 row demo-bob / payment-creator, commit "demo seed"):
docker compose --env-file .env -f infra/docker-compose.yml exec -T dolt dolt sql -q "use iam; select * from assignments; select message from dolt_log;"
```
Always pass `--env-file .env`: without it Compose warns that the variables are blank (it looks for `.env` in `infra/`).
Temporal needs ~30 s after the first start. The Dolt seed runs only on the first start of an empty volume.

### Terminal 2: Rust core
```powershell
cd core
$env:IAM_CORE_ADMIN_TOKEN = "local-demo-admin-token"   # >= 8 chars, same value as the API; enables activation
$env:IAM_CORE_STATE_DIR   = "$PWD\target\state"        # optional: keep activated versions across restarts
cargo run -p iam-core                                  # listens on 127.0.0.1:8081 (policy: ../policies/demo.cedar)
```
bash: `cd core && IAM_CORE_ADMIN_TOKEN=local-demo-admin-token cargo run -p iam-core`

### Terminal 3: NestJS API
```powershell
cd apps\api
$env:IAM_CORE_URL         = "http://127.0.0.1:8081"
$env:IAM_ISSUER           = "http://127.0.0.1:8081"     # must equal the core's issuer
$env:IAM_CORE_ADMIN_TOKEN = "local-demo-admin-token"    # same as the core
$env:DOLT_PASSWORD        = "dev-only-change-me"        # = DOLT_ROOT_PASSWORD (Dolt host/port/user/db default to 127.0.0.1:3307 root iam)
$env:IAM_PG_URL           = "postgres://postgres:dev-only-change-me@127.0.0.1:5433/runtime"   # durable journal + audit
# optional integrations (all served by compose):
$env:IAM_TEMPORAL_ADDR    = "127.0.0.1:7233"
$env:IAM_BAO_ADDR         = "http://127.0.0.1:8200"; $env:IAM_BAO_TOKEN = "dev-only-change-me"
node dist/main.js                                       # listens on 3000 (takes a few seconds to start)
```
bash:
```bash
cd apps/api
IAM_CORE_URL=http://127.0.0.1:8081 IAM_ISSUER=http://127.0.0.1:8081 IAM_CORE_ADMIN_TOKEN=local-demo-admin-token \
DOLT_PASSWORD=dev-only-change-me IAM_PG_URL=postgres://postgres:dev-only-change-me@127.0.0.1:5433/runtime \
IAM_TEMPORAL_ADDR=127.0.0.1:7233 node dist/main.js
```
Without `IAM_PG_URL` the journal and audit are in memory. Without `IAM_CORE_ADMIN_TOKEN` activations are only journaled
(`state: recorded`) and decisions in tenant mode stay deny. Full list of variables: `docs/usage.md` section 3.

### Terminal 4: Angular console
```powershell
cd apps\web
npx ng serve            # open http://localhost:4200 (use localhost, NOT 127.0.0.1: the registered redirect_uri is localhost)
```

## 5. Check it works
```powershell
Invoke-RestMethod http://127.0.0.1:8081/health          # core
Invoke-RestMethod http://127.0.0.1:3000/health          # {"status":"ok","service":"iam-api"}
# business routes need a token: without one -> 401 (expected)
try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/tenants/acme-demo/assignments } catch { $_.Exception.Response.StatusCode.value__ }
```
bash: `curl -s 127.0.0.1:8081/health; curl -s 127.0.0.1:3000/health`.

Demo scenario in the console (http://localhost:4200):
1. "Sign in (browser flow, recommended)" -> core login form -> `demo-alice` / `demo-only-not-a-secret` (fictional) -> back on `/callback`.
2. Assignments on Dolt main are listed (`demo-bob` / `payment-creator`).
3. Simulate `demo-bob` + `payment-approver`: SoD violation shown, merge refused (409).
4. Simulate `demo-alice` + `accountant`: mergeable -> Merge.
5. "Activate current main": journaled in PostgreSQL, applied by the core (needs the admin token on both sides).

## 6. Stop / reset
```powershell
# Ctrl+C in terminals 2-4, then:
docker compose --env-file .env -f infra/docker-compose.yml down        # keep data
docker compose --env-file .env -f infra/docker-compose.yml down -v     # also delete volumes (Dolt is re-seeded on next up)
```

## 7. Troubleshooting
| Symptom | Cause / fix |
|---|---|
| `cargo` not found | Rust not installed or terminal not reopened after `rustup` install |
| `link.exe not found` while building the core | install the MSVC C++ Build Tools (step 1) |
| API answers 401 `bad issuer` | `IAM_ISSUER` differs between core and API |
| API 500 / `Access denied for user 'root'` on assignments | `DOLT_PASSWORD` not equal to `DOLT_ROOT_PASSWORD` of `.env` |
| `password authentication failed` (PostgreSQL) | password in `IAM_PG_URL` not equal to `RUNTIME_PG_PASSWORD`, or the volume was created with another password (`down -v`) |
| Assignments empty / no `iam` database | Dolt volume existed before the seed: `down -v` then `up -d` |
| Sign-in redirect fails | console opened on `127.0.0.1:4200` instead of `localhost:4200` |
| Port 3307/5433/4222/7233/8200/8081/3000/4200 already used | stop the other process, or change the compose port mapping / `IAM_CORE_ADDR` / `API_PORT` (the console proxy `apps/web/proxy.conf.json` expects 8081 and 3000) |
| "Activate" gives `state: recorded` / decisions deny | `IAM_CORE_ADMIN_TOKEN` missing or different on core and API |

## 8. Tests
- Core: `cd core; cargo test`
- Web: `cd apps\web; npx ng test --watch=false`
- API: `cd apps\api; npm test`. Most end-to-end suites need local service binaries and look for `core/target/debug/iam-core`
  (no `.exe`) and use `sh`: on Windows they are SKIPPED with a message; run them on Linux/macOS or WSL (see `docs/e2e.md`).
  Compose suites, with the stack of step 4 running: `$env:COMPOSE_STACK="1"; node --test dist/compose.e2e.spec.js`.
