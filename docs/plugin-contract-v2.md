# Plugin contract v2 — plugins served by the core bus (step 3)

Status: step 3 of the event plan. The Rust core owns the bus (D1/D2); the API serves its plugins through it.
Step 1 (the bus itself) is documented in `docs/event-bus.md`. Existing plugins keep working unchanged: the same
manifest and handlers answer, only the delivery path changes (and only for the kinds listed below).

## The protocol (core side, all behind the admin token `x-core-admin-token`)

| Endpoint | Role |
|---|---|
| `POST /v1/bus/plugins/register` | Push one plugin's deliveries (`subscriptions`) and emission grants (`emits`), plus optional kind declarations (`declare_kinds`). Idempotent: the new set replaces the old one. |
| `POST /v1/bus/plugins/unregister` | Remove a plugin's deliveries and grants. Idempotent. |
| `GET /v1/bus/plugins` | What is registered right now. |
| `POST /v1/bus/emit` | Emit one event: `{source, kind, payload, tenant?, effect_key?, timeout_ms?}`. The core checks the emission grant, stamps `source` on the envelope itself (the caller cannot forge it) and dispatches by the kind's mode. |

Validation on register: plugin ids are `[A-Za-z0-9_-]` and never `core-*` or an id hosted inside the core
(`core-selftest`, `audit-log`, `mail-notifier`). Kinds must exist in the catalogue or be declared in the same call.
A plugin declares kinds only inside its own namespace `plg.<id>.*`; the API host (plugin id `api`) declares the
platform kinds. Core-owned kinds (`core.selftest`, `activation.applied`, `signin.succeeded`, `signin.refused`) are
refused for external emission and declaration; activation.applied, access.decided and policy.admin allow external subscribers. Mode rules follow the kind: `mandatory` only on
Control/Query, one-of `group` only on Notify. Registrations live in memory: a core restart forgets them and the
host re-pushes (60 s timer plus a re-push on every enable/disable).

Deliveries: the core calls `plugin.<id>.call` over NATS. The API host connects as the restricted `api-host` user
(subscribe `plugin.>`, publish only replies via `allow_responses`) and runs the plugin's v1 handler with its
validated settings. It re-checks `isActive` for the envelope's tenant on every delivery and dedupes effects by
`effect_key` (a redelivery gets a `deduped` reply, never a second run). A failing handler stays silent; for a
Control kind a silent mandatory subscriber denies the call (D3, fail closed).

## Manifest v2 (additive; v1 manifests are valid as-is)

```ts
{
  hooks: [{ name: 'notify.send', mode: 'async' }],        // unchanged: platform hooks
  subscribes: [{ name: 'plg.my-plugin.ping', mode: 'async', group?: 'g' }],  // NEW: custom kinds the plugin answers
  emits: ['plg.my-plugin.done'],                          // NEW: custom kinds the plugin may emit (grant checked by the core)
}
```
Custom kinds live in the plugin's own namespace `plg.<id>.*` and each `subscribes` entry needs a handler of the
same name. `mode: 'async'` maps to a Notify kind, `mode: 'blocking'` to a Control kind (`mandatory` allowed).

## Facades (API side)

`PluginRegistry.emit`, `callSlot`, `control` and `queryHook` require the bus. There is no production
local-delivery path. The host requires NATS credentials, the core URL and the core admin token;
a missing or unreachable bus refuses API startup. ApplicationBus has no local fan-out.

Notify deliveries use JetStream durable consumers, ack after the handler, and a KV effect ledger.
Handlers still need effect-specific idempotency because a crash between effect and ledger can replay.
Control/query use request/reply; mandatory silence, invalid responses and handler faults fail closed.
Branch registries share the bus and resolve handlers using the envelope branch.
Simulated vs real effects is unchanged: the bus changes delivery, not effect permissions.

## Compatibility evidence

- Full API suite green (149 tests) with the bus host attached, including an e2e (`bus-host.e2e.spec.ts`) where
  `notify-log` answers `notify.send` through NATS with the same result shape as in process, effect-key dedupe,
  and enable/disable pushing and cutting registrations.
- Core e2e (`bus_protocol_e2e.rs`): auth refusals, reserved ids/kinds, namespace enforcement, emission grants
  (403 without grant), source stamping, observer records with source, Control fail closed on a silent mandatory
  subscriber, unregister.

## Step 3: mandatory event bus (big-bang migration)

The API requires a reachable NATS JetStream server and Rust core. Set `IAM_BUS_NATS_URL`,
`IAM_BUS_NATS_PASSWORD`, `IAM_CORE_URL`, and `IAM_CORE_ADMIN_TOKEN` before starting it;
`IAM_BUS_NATS_USER` defaults to `api-host`. The core uses `IAM_CORE_NATS_URL` and
`IAM_CORE_NATS_PASSWORD`. Local-only development credentials are in `conf/nats-local.conf`.
There is no feature flag and no in-process fallback. If NATS is down, authentication refuses.
`scripts/demo-start.sh` starts NATS first and supervises NATS and the core with restart loops.

The old AppEvents fan-out and prototype PluginHost are removed. `ApplicationBus` is only a
bus facade: every event goes through the core and every service has a durable delivery address.
The registry's emit/control/query/callSlot methods require the bus. The only documented
exceptions are manifest `ui.screens` and core WASM `access.decide`, plus the direct Cedar
administration queries; their audit events stay on the bus (`access.decided`, `policy.admin`).
`policy.changed` announces a committed policy proposal on its working branch, not a main activation.

Notify delivery is at-least-once with explicit acknowledgement after the handler and a
JetStream KV effect ledger. A crash between the effect and its ledger entry can rerun the
handler: handlers must use stable idempotency keys. Audit rows have a unique event ID.
A business refusal (wrong password or lockout) stays a normal denial; a missing mandatory
subscriber, handler fault, timeout or bus outage never falls back to a weaker handler.
Branch is part of the envelope and effect namespace. A handler fault is persisted and audited;
a replacement remains faulted until an explicit admin disable/re-enable.

Tests that boot the API use `src/testing/test-bus.ts` (real NATS + core, unique spec ports);
registry unit tests use a fake bridge from `src/testing/fake-bus.ts`, not a production bypass.
Build the core and set `NATS_SERVER_BIN` before `npm test`. Missing test infrastructure fails
rather than silently using local handlers. CI runs only via `workflow_dispatch`.
