# Workflow Connections implementation plan

Approved scope: reusable Google Sheets / Jira / HTTP connections, secrets stored by reference, read-only connection tests, action Simulation by default, explicit Real confirmation, and no blind retry after an uncertain external creation.

One PR, separate commits:
1. Tenant-scoped versioned connection metadata in Dolt, immutable secret revisions in OpenBao KV v2. No plaintext fallback. Secret input is write-only; responses never include it. Unconfigured OpenBao disables secret saves and real execution rather than storing credentials in plugin settings.
2. Server-enforced action modes and connection resolution. Editor tests force Simulation. Computed blocks still compute, lyam writes remain on disposable/reviewed branches. Non-idempotent external attempts require manual reconciliation before any retry/rerun, including interruption recovery.
3. Connections screen and action panel following the approved mockups. Integrate with editor C after #84 reaches main; no duplicated editor redesign.
4. Unit/integration tests, read-only connection tests against local fixture services, full web/API checks, light/dark desktop/mobile browser inspection, self-review.

No live third-party account calls or changes to their contents are authorized by implementation approval alone. Tests use local fixtures. Actual credential setup and live effects stay explicit operator actions.
