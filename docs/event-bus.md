# Core event bus (plan steps 1 and 2)

Status: steps 1 and 2 of the event plan. The bus lives in the Rust core (`core/crates/iam-bus`). Step 1 is the bus itself,
tested alone and over a real NATS server. Step 2 (see `docs/plugin-contract-v2.md`) adds the plugin host protocol:
the API serves its plugins over the bus (`POST /v1/bus/plugins/register`, `POST /v1/bus/emit`, source stamped by the core).
Authorization decisions, activation, IdP and gRPC do not depend on the bus. Authentication DOES (step 3): when the bus host is configured, auth.authenticate and auth.challenge are mandatory controls on the bus - no bus, no answer, no sign-in (fail closed).

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

### Application events on the bus

The platform's own application events (`user.created`, `signup.approved`, `sso.login.*`, ... - the
`APP_EVENT_KINDS` list, mirrored by `WF_EVENTS` in the workflows model) travel on the same bus. When the API's
bus host is up it attaches `AppEvents`: emissions become notify envelopes declared by `api` (`at` rides inside
the payload, the branch is stamped), and the two internal listeners consume their own durable delivery
addresses - `workflow-triggers` (all application kinds: a matching definition starts a run) and `audit-trail`
(the `sso.*` kinds: sign-in decisions land in the audit log). Emissions stay fire-and-forget with a
deterministic effect key (hash of the whole event), so a bus redelivery replays the same key and the consumers
absorb the duplicate; a bus failure is logged, never propagated - an event listener can still never break the
action that produced it. Without the bus (unit tests, bus disabled) the historical in-process fan-out applies.

### One activation circuit

The core owns the activation.applied fact: it emits it on the bus (durable, at-least-once, effect key
activation:<tenant>:<seq>) when /v1/activate applies a version. The API no longer publishes anything about
activations: NatsService, the IAM_EVENTS stream, the PostgreSQL outbox relay and IAM_NATS_URL are gone.
The API's ActivationService journals and pushes (its event field just says 'core' when the core applied, or
'disabled'); the opt-in EffectsService (IAM_EFFECTS=1) is a durable subscriber on its own delivery address
'activation-effects' - a handler failure is nakked and redelivered, per-effect idempotency keys (PostgreSQL
ledger) absorb duplicates - and replays the applied activations of the journal at startup (catch-up: the bus
keeps no copy for an address nobody registered). Core-owned kinds can be subscribed to but never declared or
emitted by the API (403/400).

### Other blocking kinds (step 3)

risk.score is a mandatory CONTROL too (registry.control): only an active plugin answers, and a deny or no
answer at all refuses - the hook is sensitive, so it fails closed exactly like authentication. profile.enrich
is a merged QUERY (registry.queryHook): every active plugin answers with the fields it owns, the core merges
the objects, and only the plugins that answered appear - a disabled or unreachable plugin disappears from the
merge instead of refusing the call.

### Audit via the bus (step 3)

- The core emits `access.decided` (notify) for EVERY decision, allow or deny, HTTP and gRPC (they share `decide_value`). The payload identifies the request (tenant, principal, action, resource, allow, reasons, activation seq/commit) and NEVER carries the context (it may hold personal data), same rule as the trail table. It is a core-owned kind: the API can subscribe but never declare (400) or emit (403) it.
- The caller's audit meta (`audit: {source, note, subject}` in the `/v1/decide` body) rides on the event, so a trail row written from the bus keeps who asked and why. The meta is never trusted for the decision itself; unknown body fields are ignored by the core parser. gRPC calls carry no meta: their trail rows fall back to source `core`.
- The API's AuditService serves `decision-audit` (kinds `access.decided` + `audit.event`): trail rows come from the bus, at-least-once, instead of a local write after the HTTP answer. With the bus up, the call sites skip their local record (`recordDecision`) so a decision lands exactly once; a failure the core never saw (unreachable, HTTP error) is still recorded locally, and without a bus everything behaves as before.
- Plugin administration events (`plugin.install`, `plugin.enable`, `core.settings.changed`, ...) previously only logged now travel as `audit.event` (one-shot effect key `audit-event:<uuid>`) and land in the same trail with source `plugin`.
- The core's journal observer (IAM_BUS_JOURNAL stream) is restart-proof: at startup the ring is refilled from the journal (last 500 records, renumbered, `first_seq` says so), so `GET /v1/bus/records` keeps the pre-restart history.

### Documented exceptions (decision 8)

Two blocking kinds stay OFF the bus, by decision, and this section is their record (decision 1: an exception
exists only for a security or performance reason, is managed by the platform, and always keeps an audit trail):

- ui.screens: the answer is static, read from the manifest (registry.screens) - there is no decision to take,
  so there is nothing a bus round trip could add, and nothing to audit beyond the plugin enable/disable trail.
- access.decide: the hook runs in the CORE (WASM), on the request path where a bus round trip would add a
  network hop to every authorization check (performance), and the core must answer even to serve the bus
  itself. Every decision through the API is already written to the decision_audit table; the bus-level audit
  feed (audit.event) lands with the audit commit.

### Authentication over the bus (step 3)

auth.authenticate and auth.challenge are declared to the core as CONTROL kinds and routed through the bus
(PluginRegistry.callSlot's bus path): the caller posts the control emit, the core asks every registered
subscriber on plugin.<id>.call and merges the verdict. Three fail-closed rules make it safe:

- single responder: every active plugin with the handler gets a MANDATORY subscription, but only the plugin
  chosen for the slot answers (registry.blockingResponder); the others reply not-concerned, which counts
  neither as an answer nor as silence. A faulted replacement answers deny - the base is never asked instead.
- no answer = refusal: a silent mandatory subscriber (plugin down, NATS down) makes the core deny, and the
  caller also refuses when NO subscriber gave a usable reply at all (all silent or not-concerned).
- a 'challenge' outcome is not a denial: only outcome 'deny' carries the deny verdict; the result data (allow
  with methods, or the challenge to draw) always rides along, so MFA chains keep working.

The envelope carries the caller registry's branch, so a sign-in test on a working branch is answered by that
branch's registry (decision 7). ui.screens and access.decide stay in process (decision 8). NATS down therefore
means sign-in refused until the bus is back; core and host reconnect by themselves.

## What is prepared, NOT built (later steps)

risk.score and profile.enrich as control/query (auth done above), restart-proof reads of the journal stream,
local in-process duplicate for latency (D16 evaluation: not done).

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

## Tests

`cd core && cargo test --workspace`. The NATS end-to-end file (`tests/nats_e2e.rs`) needs `nats-server` (`NATS_SERVER_BIN` or PATH) and is **skipped with a message** otherwise;
set `IAM_REQUIRE_NATS=1` to make a missing binary a failure (the manual CI `core` job does).
Note: `ci.yml` runs only when started by hand (`workflow_dispatch`), so these tests do not run on every push.

## Observer (read only) - implemented
- **Core**: every exchange through the bus is recorded in a ring of the last 500 (in memory, lost on core restart; `first_seq` tells a reader when older ones were dropped). `GET /v1/bus/records?after=<seq>` needs the core admin token. It only reads: it never emits, replays or answers.
- **What is recorded**: envelope id (correlation), kind, mode, effectKey, masked payload, who was **expected** (with mandatory flag), who **answered** and with what verdict, who stayed **silent**, invalid answers, delay (ms), verdict. Masking (core `iam-bus::mask`, then again in the API): credential-like keys replaced by `[masked]`, e-mails partly hidden, scalars only, values cut at 120 chars.
- **Real events** now sent to the bus (notifications only, no decision depends on them): `activation.applied` (effectKey `activation:<tenant>:<seq>`), `signin.succeeded`, `signin.refused`, `access.decided`. Core-hosted subscribers: `audit-log` (answers through NATS) and `mail-notifier` (declared, never started: shows as "expected, silent").
- **API**: `GET /tenants/:tenant/bus/records` (sign-in + admin capability, read only, scrubs again, core token never leaves the server). **Console**: page "Event bus" (player: play, speed, position, previous/next, detail card with expected/answered/silent, correlation id, masked data).
- The ring is refilled from the durable journal (IAM_BUS_JOURNAL) on restart; history older than the 500-record replay window is only in JetStream itself.
- **Not done / limits**: no timeline over days, a mandatory silent subscriber is shown as "refused" from the record but no mandatory control exists yet in production flows, no signal for NATS reconnects in the page, single core instance only. Time-outs appear as `silent` with the dispatcher's detail.
