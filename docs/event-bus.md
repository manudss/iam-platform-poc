# Core event bus (plan steps 1 and 2)

Status: steps 1 and 2 of the event plan. The bus lives in the Rust core (`core/crates/iam-bus`). Step 1 is the bus itself,
tested alone and over a real NATS server. Step 2 (see `docs/plugin-contract-v2.md`) adds the plugin host protocol:
the API serves its plugins over the bus (`POST /v1/bus/plugins/register`, `POST /v1/bus/emit`, source stamped by the core).
Authorization decisions, activation, IdP and gRPC do not depend on the bus.

## What exists (implemented and tested)

| Piece | Where | Notes |
|---|---|---|
| Envelope | `envelope.rs` | id, kind, `tenant` (reserved, carried and never interpreted: D11), `effect_key`, JSON payload, `source` (stamped by the core, step 2) |
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

## Step 3: durable, at-least-once notify delivery

A notify emission no longer waits for subscriber replies. The core writes one durable copy per delivery address
into the JetStream stream `IAM_BUS_EVENTS` (subjects `bus.events.<id-or-group>`, work queue) and answers the
emitter with per-address `queued` outcomes only after the publish ack. A missing ack refuses the whole emission
(HTTP 502): no success without durable storage, and a retried emission can deliver twice, so consumers stay
idempotent on the effect key (the API host records effects in the JetStream KV bucket `iam-effects`, which
survives API restarts). Consumers ack only after their handler ran: a crash or a nak means redelivery
(at-least-once, bounded at 10 deliveries for the API host). A group names ONE shared delivery address: its
members pull the same durable consumer and NATS balances between them. Control and query kinds keep the
synchronous request/reply path. Every observer record is also persisted to the `IAM_BUS_JOURNAL` stream
(`bus.journal`); the HTTP feed still reads the fast in-memory ring. Envelopes carry `branch`: the API host
resolves each delivery against the registry of that working branch (decision: all branches share the one bus).

## What is prepared, NOT built (later steps)

Absorbing AppEvents of PR #7 (not merged), routing blocking hooks (auth step),
restart-proof reads of the journal stream, local in-process duplicate for latency (D16 evaluation: not done).

## Step 2 endpoints (plugin host protocol)

All behind the admin token. `POST /v1/bus/plugins/register` pushes a plugin's subscriptions, emission grants and
kind declarations (idempotent, replaces the set); `POST /v1/bus/plugins/unregister` removes them; `GET /v1/bus/plugins`
lists them; `POST /v1/bus/emit` emits one event after checking the grant and stamping `source`. The API host serves
its plugins as the restricted `api-host` NATS user (see `conf/nats-local.conf`). Details: `docs/plugin-contract-v2.md`.

## Limits to keep in mind

- Notify delivery is at least once (JetStream, redelivery after crash/nak): an effect can run twice and must stay idempotent on its effect key. Control and query calls are still at most once (request/reply, no redelivery).
- The API-side effect ledger is the `iam-effects` KV bucket (durable). The Rust-side `EffectLedger` used by core tests stays in memory on purpose.
- NATS is a base process: a core configured with `IAM_CORE_NATS_URL` that cannot reach NATS, or cannot create its streams, REFUSES to start. The start scripts bring NATS up first and restart the core. After a first connection async-nats reconnects by itself; while NATS is down the `/v1/bus` self-test returns `deny` (mandatory subscriber silent), checked by stopping and restarting nats-server.
- Nothing in the existing flows depends on the bus yet. A flow that needs a mandatory control treats a missing bus as refusal (fail closed, D3).
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

## Observer (read only) - implemented
- **Core**: every exchange through the bus is recorded in a ring of the last 500 (in memory, lost on core restart; `first_seq` tells a reader when older ones were dropped). `GET /v1/bus/records?after=<seq>` needs the core admin token. It only reads: it never emits, replays or answers.
- **What is recorded**: envelope id (correlation), kind, mode, effectKey, masked payload, who was **expected** (with mandatory flag), who **answered** and with what verdict, who stayed **silent**, invalid answers, delay (ms), verdict. Masking (core `iam-bus::mask`, then again in the API): credential-like keys replaced by `[masked]`, e-mails partly hidden, scalars only, values cut at 120 chars.
- **Real events** now sent to the bus (notifications only, no decision depends on them): `activation.applied` (effectKey `activation:<tenant>:<seq>`), `signin.succeeded`, `signin.refused`. Core-hosted subscribers: `audit-log` (answers through NATS) and `mail-notifier` (declared, never started: shows as "expected, silent").
- **API**: `GET /tenants/:tenant/bus/records` (sign-in + admin capability, read only, scrubs again, core token never leaves the server). **Console**: page "Event bus" (player: play, speed, position, previous/next, detail card with expected/answered/silent, correlation id, masked data).
- **Not done / limits**: no persistence (ring in memory), no timeline over days, a mandatory silent subscriber is shown as "refused" from the record but no mandatory control exists yet in production flows, no signal for NATS reconnects in the page, single core instance only. Time-outs appear as `silent` with the dispatcher's detail.
