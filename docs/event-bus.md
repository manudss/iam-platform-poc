# Core event bus (plan step 1)

Status: step 1 of the event plan. The bus lives in the Rust core (`core/crates/iam-bus`). It is tested alone and over a real
NATS server. It is **not** wired to any real emitter yet: no existing behaviour (decisions, activation, IdP, gRPC, API) changes.

## What exists (implemented and tested)

| Piece | Where | Notes |
|---|---|---|
| Envelope | `envelope.rs` | id, kind, `tenant` (reserved, carried and never interpreted: D11), `effect_key`, JSON payload |
| Catalogue | `catalogue.rs` | each kind is `Notify`, `Control` (allow/deny) or `Query` (data merged by the core); unknown kind or wrong mode is refused |
| Subscription registry | `registry.rs` | `mandatory` (Control/Query only), one-of `group` (Notify only), subscriber id restricted to `[A-Za-z0-9_-]` (it becomes a NATS subject token) |
| Dispatcher | `dispatcher.rs` | broadcast; one of a group (round robin); blocking call with timeout; Query merge (shallow union, first subscriber by id wins, conflicts reported); each subscriber has its own request, timeout and error |
| Missing-answer rule (D3) | `dispatcher.rs` | mandatory silent, invalid or without verdict = refusal; optional silent = ignored; any valid deny = deny; no subscriber = allow |
| Reply identity check | `dispatcher.rs` + NATS permissions | a reply whose `from` is not the subscriber asked, or whose `id` is not the envelope id, counts as silence. On NATS the server also refuses a plugin that publishes on a reply subject it does not own |
| Transport interface | `transport.rs` | `Transport` trait, `InProcTransport` (tests) |
| NATS transport (D14/D16) | `nats.rs` | async-nats, `plugin.<id>.call` per subscriber, `serve()` for subscriber side. A NATS request is always made, even for a subscriber hosted by the core |
| WASM subscriber | `handler.rs` | wraps the existing v0 runtime (`decide(hour, sensitive)`); trap, out of fuel or bad payload = silent |
| Executor idempotency | `handler.rs` `EffectLedger` | an effect with a given `effect_key` runs once per ledger |

### Observation points (prepares the bus-observation milestone, PR #11 idea)
`Dispatcher::observe(Arc<dyn Observer>)` hands a `BusRecord` to observers after every notify / call / query: envelope id, kind, mode,
reserved tenant, effect key, payload SIZE (never the content), duration, per-subscriber outcome (replied, silent with reason, invalid reply), merged verdict.
Silent and refused exchanges are visible. Limits: in process only, synchronous callback (an observer must queue and return), no persistence, so records are lost if
the core restarts or an observer drops them; only exchanges that go through this core are seen. A durable, loss-free viewer needs a persisted record stream (later step).

## What is prepared, NOT built (later steps)

Plugin host / contract v2, API protocol, JetStream consumers for durable delivery, journal plugin (D6), absorbing AppEvents of PR #7
(not merged), a durable effect ledger, real emitters calling the bus, local in-process duplicate for latency (D16 evaluation: not done).

## Limits to keep in mind

- `EffectLedger` is in memory: it does **not** survive a restart. Crash and resume were NOT tested. One process only; no multi-instance test.
- Delivery is at most once (request/reply, no redelivery). The NATS `Nats-Msg-Id` dedup (measured in step 0, PR #13) covers publication only and is not used here.
- Connection: the core retries for up to 20 s at startup (slow host), then runs without the bus and says so in its log. After a first connection async-nats reconnects by itself; while NATS is down the `/v1/bus` self-test returns `deny` (mandatory subscriber silent), checked by stopping and restarting nats-server.
- Nothing in the existing flows depends on the bus. If NATS is down the core starts and runs without it (`/v1/bus` says `enabled: false`);
  no existing authorization path falls back to "allow" because of the bus. A future flow that needs a mandatory control must treat a missing bus as refusal.
- Resource numbers (measured locally, debug build): nats-server 13 MB RSS idle; core 23-25 MB. They say nothing about the 0.1 CPU free host.

## Run it locally

```
nats-server -c conf/nats-local.conf          # 127.0.0.1:4222, one user per subscriber, dev passwords, local only
cd core && IAM_CORE_NATS_URL=127.0.0.1:4222 IAM_CORE_NATS_PASSWORD=core-dev cargo run -p iam-core
curl http://127.0.0.1:8081/v1/bus            # live self-test through NATS
```
`scripts/demo-start.sh` starts nats-server when the binary is installed. `GET /v1/bus` public view shows only enabled, verdict
and latency; the admin token (`x-core-admin-token`) adds the details. The self-test only reaches the core's own `core-selftest` subscriber and is cached for 5 s.
The API's own `IAM_NATS_URL` (JetStream stream `IAM_EVENTS`, subjects `iam.>`) is separate and unchanged. That client does not authenticate, so it cannot connect to `conf/nats-local.conf` (auth required); use a plain `nats-server -js` for it, as before.

## Tests

`cd core && cargo test --workspace`. The NATS end-to-end file (`tests/nats_e2e.rs`) needs `nats-server` (`NATS_SERVER_BIN` or PATH) and is **skipped with a message** otherwise;
set `IAM_REQUIRE_NATS=1` to make a missing binary a failure (the manual CI `core` job does).
Note: `ci.yml` runs only when started by hand (`workflow_dispatch`), so these tests do not run on every push.
