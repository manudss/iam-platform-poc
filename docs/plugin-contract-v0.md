# Plugin contract v0

Two kinds of plugin.

## Blocking hook (Rust core, WASM)
- Module exports `decide(hour: i32, sensitive: i32) -> i32` (0 allow, 1 deny).
- Limits: fuel budget (CPU), no imports (no host access), any trap means error and the caller fails closed.
- Example: `plugins/examples/deny-off-hours.wat` denies sensitive access outside 08:00-19:59.
- v0 is deliberately tiny. A richer contract (JSON in linear memory, versioned) is a next step.

## Async plugin (NestJS)
- Interface in `apps/api/src/plugins/plugin.contract.ts`.
- Must be idempotent per (tenant, activation, effect, target). The host deduplicates by effect key.
- Example: `notify-manager` logs a would-be notification after a role change; it sends nothing.
- Activation effects (`apps/api/src/effects/`): notification to a local fictional sink and provisioning to a local demo target, idempotent per effect key with a PostgreSQL ledger and retry by redelivery (see README).

## Signed packages (blocking hook)
manifest.json {name, version, abi "decide-v0", wasm_sha256, publisher} + manifest.sig (Ed25519 over the exact manifest bytes) + plugin.wasm. The core verifies against `IAM_PLUGIN_TRUSTED_KEYS` and refuses to start otherwise. See README for what is not covered (signing CLI, rotation, revocation).

## Not done yet
Signing CLI and key management, async-plugin packaging, per-tenant enablement from Dolt, timeouts for async plugins, no-code workflow editor.
