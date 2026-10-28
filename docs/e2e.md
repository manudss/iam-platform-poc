# End-to-end tests: how to run them and what they prove

All commands run from `apps/api` unless stated. `npm test` compiles TypeScript, then runs the suites with `node --test`.

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
- Rust: `cd core && cargo test --locked` (Cedar engine, WASM runtime, IdP).
- Angular: `cd apps/web && npm test -- --watch=false` (PKCE S256 test vector, API client with a fake fetch, component render).
- Real browser: `DOLT_BIN=... CHROME_BIN=/usr/bin/google-chrome NODE_PATH=<dir with playwright-core>/node_modules node scripts/ui-e2e.mjs [outDir]` starts Dolt, core, API and `ng serve` on 127.0.0.1, drives the console in headless Chrome and writes screenshots (build core and API first).
- Script: `DOLT_BIN=... scripts/dolt-smoke.sh` (Dolt CLI branch/merge scenario).

## What is NOT covered
- The same chain against the docker-compose containers (only container-level checks run, in CI), gRPC (OPEN, not implemented),
  crash recovery of activations, load/performance, security review of the home-made IdP.
