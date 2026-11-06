# End-to-end tests: how to run them and what they prove

All commands run from `apps/api` unless stated. `npm test` compiles TypeScript, then runs the suites with `node --test`. The suite list is discovered automatically (`node --test "dist/**/*.spec.js"`): a new `*.spec.ts` is picked up as-is, never add file names to the `test` script.

## Environment variables that switch the real-service suites on
| Variable | Points to | Suite |
|---|---|---|
| (none) | `core/target/debug/iam-core` must exist (`cd core && cargo build -p iam-core -j2`) | `e2e.spec.ts`: real Rust core + real NestJS API |
| `DOLT_BIN` | `dolt` binary | `dolt.e2e.spec.ts` (also needed by the Temporal suite) |
| `PG_BIN` | directory containing `initdb` and `postgres` | `pg.e2e.spec.ts` |
| `NATS_SERVER_BIN` | `nats-server` binary | `integrations.e2e.spec.ts` (NATS part) |
| `BAO_BIN` | `bao` (OpenBao) binary | `integrations.e2e.spec.ts` (OpenBao part) |
| `TEMPORAL_BIN` | `temporal` CLI binary | `temporal.e2e.spec.ts` |

PostgreSQL binaries without a system install: `npm i embedded-postgres` somewhere, then
`PG_BIN=<that dir>/node_modules/@embedded-postgres/linux-x64/native/bin`. Other binaries come from the products' GitHub releases.
A suite whose variable is unset is reported as skipped with a reason, never as passed.

## What each suite covers
- `app.spec.ts` (unit, guard overridden): health, activation journal logic (A,B,A), invalid commit, plugin idempotence.
- `e2e.spec.ts` (real core + API): IdP login (wrong password 401, burnt code), decisions (approve, SoD forbid, unknown principal deny),
  negative authentication: no token, garbage/alg=none, tampered payload, expired token, other issuer, wrong audience, wrong tenant (403),
  fail-closed when the core is down (502).
- `dolt.e2e.spec.ts` (real Dolt SQL server on a temp copy): seeded read, branch simulation with SoD violation, main untouched before merge,
  merge refused 409, clean merge then activation records the Dolt hash, CSV connector (clean import, SoD conflict, malformed input), input validation, auth/tenant checks.
- `pg.e2e.spec.ts` (real PostgreSQL): durable journal across service restart, concurrent activations get distinct seq, URL from a (stubbed) secret store.
- `integrations.e2e.spec.ts`: real NATS JetStream (event received; unreachable -> `not-published`; disabled), real OpenBao dev server (KV read, missing, bad token).
- `temporal.e2e.spec.ts` (real Temporal dev server + real Dolt): workflow success; unknown commit fails the workflow and nothing is journaled.
- `fullstack.e2e.spec.ts` (real Dolt + PostgreSQL + NATS JetStream + Rust core + NestJS services, nothing stubbed): Dolt data change -> export -> activation -> core applies and the decision flips -> outbox relay -> NATS -> idempotent consumer handles it once; same request id again gives no new seq; SoD computed by the core.
- `grpc.e2e.spec.ts` (real core binary with `IAM_CORE_GRPC_ADDR`, NestJS gRPC client): gRPC allow/deny equals HTTP, tenant mode fail closed then activated, unreachable core rejects. Rust: `grpc.rs` test over a real socket.
- `audit.e2e.spec.ts` (real core + API; PostgreSQL part on a real server): allow/deny/core-down recorded with tenant, seq, commit; no token 401, other tenant 403, context not stored; rows survive a restart and are tenant-isolated.
- `effects.e2e.spec.ts` (real PostgreSQL + NATS, local HTTP fakes, Dolt stubbed): role diff, notification and provisioning once per effect key, DELETE on revoke, target down then retry, non-loopback refused, duplicate NATS event.
- Rust: `cd core && cargo test --locked` (Cedar engine, WASM runtime, IdP).
- Angular: `cd apps/web && npm test -- --watch=false` (PKCE S256 test vector, API client with a fake fetch, component render).
- Real browser: `DOLT_BIN=... CHROME_BIN=/usr/bin/google-chrome NODE_PATH=<dir with playwright-core>/node_modules node scripts/ui-e2e.mjs [outDir]` starts Dolt, core, API and `ng serve` on 127.0.0.1, drives the console in headless Chrome and writes screenshots (build core and API first).
- Script: `DOLT_BIN=... scripts/dolt-smoke.sh` (Dolt CLI branch/merge scenario).

## What is NOT covered
- The same chain against the docker-compose containers (only container-level checks run, in CI), gRPC beyond `Decide` (activate, IdP: OPEN), TLS/auth on the gRPC port,
  crash recovery of activations, load/performance, security review of the home-made IdP.

## Slices 4 and 5 (local runs only, not in CI yet)
- `cd core && cargo test -p iam-core --bin iam-core`: includes the browser code+PKCE flow tests (`authz::tests`).
- `agent.e2e.spec.ts` (needs the built core binary only): delegation allowlist, SoD deny through the same Cedar decision, audit source `agent`, negatives (outside allowlist, unknown tool, no/forged delegation, re-delegation, call budget). 5/5 passed locally.
- `scripts/authz-browser-e2e.mjs` (real headless Chrome through playwright-core, loopback only): starts the real core and a tiny client on `http://localhost:4200`; the client keeps `state` and the PKCE verifier in sessionStorage, the login form is submitted in the browser, the client checks `state` at the callback and exchanges the code. 6 steps: happy path (form, 302, state ok, token exchange, password never in any visited URL, code replay refused), wrong password (form again, no redirect), forged callback with another `state` (code ignored, no exchange), wrong verifier (refused), unregistered redirect_uri (error page, no navigation to the attacker host), `plain` method (error page). Run: `CHROME_BIN=... NODE_PATH=<dir with playwright-core>/node_modules node scripts/authz-browser-e2e.mjs [outDir]` (core binary built first). 6/6 passed locally; screenshots inspected (login form, wrong password, state mismatch, bad redirect). A real Chrome found a real bug the Rust tests could not: the CSP `form-action 'self'` blocked the redirect to the client; the page CSP now allows the validated redirect origin. Added to CI, not run there yet.
- `effects-wiring.e2e.spec.ts` (needs DOLT_BIN, PG_BIN, NATS_SERVER_BIN and the core binary): the opt-in `EffectsService` (IAM_EFFECTS=1) with real Dolt exports, PostgreSQL, core and NATS and loopback sink/target started by the test. 4/4 passed locally; full API suite 75/75 locally.
- `scripts/ui-e2e.mjs` now drives the console through the BROWSER sign-in flow (forged callback with another state ignored, wrong password on the core form, then sign-in and back to the console, URL without code/state), then SoD simulate/merge/activate. Passed locally (headless Chrome, real Dolt, core, API, `ng serve`); screenshots inspected.

### Administration data regression

Build API and Rust core, install playwright-core in scripts, then run:

```sh
DOLT_BIN=/path/to/dolt CHROME_BIN=/path/to/chrome node scripts/admin-data-e2e.mjs /tmp/admin-shots
```

The harness runs an isolated real Dolt database, Rust gate, Nest API and Angular UI. It removes its processes, database and credential file after testing. Fictional account passwords are test fixtures only. Screenshots are saved for visual inspection, not a substitute for it.
