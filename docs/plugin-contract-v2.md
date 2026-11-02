# Plugin contract v2 — plugins served by the core bus (plan step 2)

Status: step 2 of the event plan. The Rust core owns the bus (D1/D2); the API serves its plugins through it.
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
refused for external subscription, emission and declaration. Mode rules follow the kind: `mandatory` only on
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

`PluginRegistry.emit` and `callSlot` are facades: when the bus routes a kind they go through it, otherwise they
run in process exactly as before. A bus failure raises `bus-unavailable` WITHOUT an in-process fallback: the
delivery may have happened, so falling back would risk a double effect (D16). The caller retries the same
`effectKey`; the host ledger dedupes. The host connects only when `IAM_BUS_NATS_URL` + `IAM_BUS_NATS_PASSWORD` +
`IAM_CORE_ADMIN_TOKEN` are set; without them behaviour is exactly step 1.

## Step 2 boundaries (explicit)

- Only pure-async hooks (`notify.send`, `identity.changed`, `workflow.step`, `connector.provision`,
  `connector.import`, `audit.event`) are routed through the bus. Blocking hooks — authentication, risk, policy —
  stay in process: migrating them is the auth step (later). `callSlot`'s bus path exists but is dormant by
  construction and covered by a test-only Control kind.
- In workspace mode only the applied state (the `main` branch registry) is served over the bus. Preview branches
  keep the in-process path, unchanged from step 1.
- The host's effect ledger and the core's registrations are in memory (lost on restart); the durable ledger is a
  later step. Delivery stays at most once (step 1 limit).
- Simulated vs real effects: unchanged; the bus only changes WHO runs the plugin, not what an effect means.

## Compatibility evidence

- Full API suite green (149 tests) with the bus host attached, including an e2e (`bus-host.e2e.spec.ts`) where
  `notify-log` answers `notify.send` through NATS with the same result shape as in process, effect-key dedupe,
  and enable/disable pushing and cutting registrations.
- Core e2e (`bus_protocol_e2e.rs`): auth refusals, reserved ids/kinds, namespace enforcement, emission grants
  (403 without grant), source stamping, observer records with source, Control fail closed on a silent mandatory
  subscriber, unregister.
